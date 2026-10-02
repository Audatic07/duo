/**
 * duo GUI server: serves the desktop UI and its API on 127.0.0.1.
 *
 * Security model (this server can make agents edit files and run commands):
 *   - binds to 127.0.0.1 only;
 *   - every /api call needs the per-launch random token (Authorization: Bearer, or ?token= for
 *     EventSource and export pages), which the desktop shell hands to its own window only;
 *   - the Host header must be a loopback name (defeats DNS rebinding) and a cross-site Origin is
 *     refused, so no web page can drive it;
 *   - model output is sanitized in the UI before it is rendered.
 * Prints one JSON line {"ready":true,"url":...,"token":...} on stdout when it is listening.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { binVersion, runBin } from '../bins.ts';
import { CLAUDE_MODELS, codexCatalog, loadConfig, resolveClaudeBin, resolveCodexBin, saveConfig } from '../config.ts';
import { liveChecks, runDoctor } from '../doctor.ts';
import { sanitizeEnvironment } from '../env.ts';
import { CONFIG_PATH, DUO_HOME, PROJECT_ROOT, SCRATCH_DIR } from '../paths.ts';
import { IS_MAC, IS_WIN, openFolder } from '../platform.ts';
import { knownCodexRates } from '../pricing.ts';
import { refreshQuota } from '../quota-refresh.ts';
import { snapshot } from '../quota.ts';
import { CLAUDE_EFFORTS, CODEX_EFFORTS } from '../seats.ts';
import { workspaceOptions } from '../worktree.ts';
import { buildGui, GUI_DIR, GUI_DIST } from './build.ts';
import { Bus } from './bus.ts';
import { CLAUDE_ACCESS, CODEX_ACCESS, ChatManager } from './chats.ts';
import { gitState, listDirs } from './fsapi.ts';
import { PermissionBroker } from './permissions.ts';
import { RunManager } from './runs.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

sanitizeEnvironment();
const cfg = loadConfig();
const bins = { codex: resolveCodexBin(cfg), claude: resolveClaudeBin(cfg) };
const token = arg('token') ?? randomBytes(24).toString('base64url');
if (!process.env.DUO_PREBUILT) await buildGui(process.argv.includes('--rebuild'));

const PREFS_PATH = join(DUO_HOME, 'gui', 'prefs.json');
const MCP_SCRIPT = process.env.DUO_PERMISSION_MCP || join(import.meta.dirname, 'permission-mcp.ts');

const bus = new Bus();
const perms = new PermissionBroker(bus);
let chats: ChatManager;
let runs: RunManager;

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function hostOk(req: IncomingMessage): boolean {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host ?? '');
}

function authorized(req: IncomingMessage, url: URL): boolean {
  const h = req.headers.authorization;
  const given = h?.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  if (!given || !safeEqual(given, token)) return false;
  const origin = req.headers.origin;
  return !origin || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8 * 1024 * 1024) throw new HttpError(413, 'request too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function send(res: ServerResponse, status: number, data: unknown, type = 'application/json', extra: Record<string, string> = {}): void {
  const payload = type === 'application/json' ? JSON.stringify(data) : String(data);
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(payload);
}

const MIME: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.html': 'text/html', '.woff2': 'font/woff2' };

function serveStatic(res: ServerResponse, path: string): boolean {
  const name = path.replace(/^\/+/, '');
  const file = path === '/' ? join(GUI_DIR, 'index.html')
    : /^(app|chunk-|[\w-]+-[A-Z0-9]{8})[\w.-]*\.(js|css|map|woff2)$/.test(name) ? join(GUI_DIST, name)
    : path === '/icon.svg' ? join(PROJECT_ROOT, 'desktop', 'icon.svg')
    : '';
  if (!file || !existsSync(file) || !statSync(file).isFile()) return false;
  const text = /\.(html|js|css|map|svg)$/.test(file);
  res.writeHead(200, {
    'Content-Type': `${MIME[extname(file)] ?? 'application/octet-stream'}${text ? '; charset=utf-8' : ''}`,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...(file.endsWith('.html') ? { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" } : {}),
  });
  res.end(readFileSync(file));
  return true;
}

// ── preferences (UI state that must survive restarts; the window's origin changes with the port) ──

type Prefs = Record<string, unknown>;

function readPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(PREFS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writePrefs(patch: Prefs): Prefs {
  const next = { ...readPrefs(), ...patch };
  mkdirSync(join(DUO_HOME, 'gui'), { recursive: true });
  writeFileSync(PREFS_PATH, JSON.stringify(next, null, 2));
  return next;
}

function projects(prefs: Prefs): string[] {
  const seen = new Map<string, string>();
  const note = (p: string, at: string) => {
    if (!p || p.startsWith(SCRATCH_DIR) || p.startsWith(join(DUO_HOME, 'worktrees'))) return;
    if (!seen.has(p) || seen.get(p)! < at) seen.set(p, at);
  };
  for (const c of chats.list()) note(c.cwd, c.updatedAt);
  for (const r of runs.list()) note(r.cwd, r.createdAt);
  for (const p of (prefs.recentProjects as string[] | undefined) ?? []) note(p, '0');
  return [...seen.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([p]) => p).filter((p) => existsSync(p)).slice(0, 30);
}

function state() {
  const c = loadConfig();
  const prefs = readPrefs();
  return {
    version: JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version,
    platform: process.platform,
    home: process.env.HOME || process.env.USERPROFILE || '',
    dataDir: DUO_HOME,
    scratchDir: SCRATCH_DIR,
    configPath: CONFIG_PATH,
    gui: c.gui,
    presets: c.presets,
    defaults: c.defaults,
    warnPercent: c.warnPercent,
    access: {
      claude: Object.fromEntries(Object.entries(CLAUDE_ACCESS).map(([k, v]) => [k, v.label])),
      codex: Object.fromEntries(Object.entries(CODEX_ACCESS).map(([k, v]) => [k, v.label])),
    },
    models: { codex: codexCatalog(bins.codex).filter((m) => m.visibility !== 'hide'), claude: CLAUDE_MODELS },
    rates: knownCodexRates(),
    efforts: { codex: CODEX_EFFORTS, claude: CLAUDE_EFFORTS },
    versions: { codex: binVersion(bins.codex), claude: binVersion(bins.claude) },
    quota: snapshot(),
    chats: chats.list(),
    runs: runs.list(),
    projects: projects(prefs),
    prefs,
    permissions: perms.list(),
  };
}

let claudeUpdate: Promise<{ ok: boolean; output: string }> | undefined;

type Handler = (m: RegExpMatchArray, req: IncomingMessage, url: URL, res: ServerResponse) => Promise<unknown> | unknown;
const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/state$/, () => state()],
  ['GET', /^\/api\/quota$/, (_m, _r, url) => {
    if (url.searchParams.get('refresh')) refreshQuota(cfg);
    const q = snapshot();
    bus.emit({ t: 'quota', quota: q });
    return q;
  }],
  ['GET', /^\/api\/prefs$/, () => readPrefs()],
  ['PUT', /^\/api\/prefs$/, async (_m, req) => writePrefs(await body(req))],
  ['GET', /^\/api\/doctor$/, (_m, _r, url) => {
    const c = loadConfig();
    return url.searchParams.get('live') ? [...runDoctor(c), ...liveChecks(c)] : runDoctor(c);
  }],
  ['POST', /^\/api\/maintenance\/update-claude$/, async () => {
    claudeUpdate ??= new Promise((resolve) => {
      const r = runBin(bins.claude, ['update'], { encoding: 'utf8', timeout: 300_000 });
      resolve({ ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(-4000) });
    });
    const out = await claudeUpdate;
    claudeUpdate = undefined;
    return { ...out, version: binVersion(bins.claude) };
  }],
  ['GET', /^\/api\/fs\/dirs$/, (_m, _r, url) => listDirs(url.searchParams.get('path') ?? undefined, url.searchParams.get('hidden') === '1')],
  ['GET', /^\/api\/fs\/workspace$/, (_m, _r, url) => workspaceOptions(url.searchParams.get('cwd') ?? '')],
  ['GET', /^\/api\/git$/, (_m, _r, url) => gitState(url.searchParams.get('cwd') ?? '')],
  ['GET', /^\/api\/chats$/, () => chats.list()],
  ['POST', /^\/api\/chats$/, async (_m, req) => {
    const b = await body(req);
    if (b.noProject || !b.cwd) {
      b.cwd = join(SCRATCH_DIR, `chat-${Date.now().toString(36)}`);
      mkdirSync(b.cwd, { recursive: true });
    }
    return chats.create(b);
  }],
  ['GET', /^\/api\/chats\/([\w-]+)$/, (m) => ({ ...chats.get(m[1]), permissions: perms.list(m[1]), allowedTools: perms.allowedFor(m[1]) })],
  ['PATCH', /^\/api\/chats\/([\w-]+)$/, async (m, req) => chats.update(m[1], await body(req))],
  ['DELETE', /^\/api\/chats\/([\w-]+)$/, async (m) => { await chats.remove(m[1]); return { ok: true }; }],
  ['POST', /^\/api\/chats\/([\w-]+)\/send$/, async (m, req) => chats.send(m[1], String((await body(req)).text ?? ''))],
  ['POST', /^\/api\/chats\/([\w-]+)\/retry$/, (m) => chats.retry(m[1])],
  ['POST', /^\/api\/chats\/([\w-]+)\/stop$/, (m) => ({ stopped: chats.stop(m[1]) })],
  ['POST', /^\/api\/permissions\/([\w-]+)$/, async (m, req) => {
    const b = await body(req);
    if (!['allow', 'allow_session', 'deny'].includes(b.decision)) throw new HttpError(400, 'decision must be allow, allow_session or deny');
    return { ok: perms.decide(m[1], b.decision, b.message) };
  }],
  ['POST', /^\/api\/internal\/permission$/, async (_m, req) => {
    const b = await body(req);
    return perms.request(String(b.chat), String(b.tool), b.input);
  }],
  ['POST', /^\/api\/internal\/shutdown$/, () => {
    setTimeout(() => void shutdown(), 10);
    return { ok: true };
  }],
  ['GET', /^\/api\/runs$/, () => runs.list()],
  ['POST', /^\/api\/runs$/, async (_m, req) => runs.start(await body(req))],
  ['GET', /^\/api\/runs\/([\w.-]+)$/, (m) => runs.get(m[1])],
  ['DELETE', /^\/api\/runs\/([\w.-]+)$/, (m) => { runs.remove(m[1]); return { ok: true }; }],
  ['GET', /^\/api\/runs\/([\w.-]+)\/turns\/(\d+)$/, (m) => runs.turn(m[1], Number(m[2]))],
  ['GET', /^\/api\/runs\/([\w.-]+)\/diff$/, (m) => runs.diff(m[1])],
  ['POST', /^\/api\/runs\/([\w.-]+)\/cancel$/, (m) => ({ cancelled: runs.cancel(m[1]) })],
  ['POST', /^\/api\/runs\/([\w.-]+)\/workspace$/, async (m, req) => {
    const a = String((await body(req)).action ?? '');
    if (!['apply', 'keep', 'discard'].includes(a)) throw new HttpError(400, 'action must be apply, keep or discard');
    return runs.workspace(m[1], a as 'apply' | 'keep' | 'discard');
  }],
  ['POST', /^\/api\/runs\/([\w.-]+)\/continue$/, async (m, req) => {
    const b = await body(req);
    return runs.continue(m[1], String(b.note ?? ''), Math.max(1, Math.min(20, Number(b.rounds ?? 1))), b.chair || undefined);
  }],
  ['GET', /^\/api\/runs\/([\w.-]+)\/export$/, (m, _r, url, res) => {
    const md = url.searchParams.get('format') === 'md';
    send(res, 200, md ? runs.markdown(m[1]) : runs.html(m[1]), md ? 'text/markdown' : 'text/html', md ? { 'Content-Disposition': `attachment; filename="${m[1]}.md"` } : {});
    return undefined;
  }],
  ['PUT', /^\/api\/config$/, async (_m, req) => {
    const b = await body(req);
    const patch: Record<string, unknown> = {};
    for (const k of ['gui', 'presets', 'defaults', 'warnPercent'] as const) if (b[k] !== undefined) patch[k] = b[k];
    const next = saveConfig(patch as any);
    Object.assign(cfg, next);
    return state();
  }],
  ['POST', /^\/api\/open$/, async (_m, req) => {
    const p = String((await body(req)).path ?? '');
    // Folders only: opening a file could run it.
    if (!p || !existsSync(p) || !statSync(p).isDirectory()) throw new HttpError(400, 'not a folder');
    openFolder(p);
    return { ok: true };
  }],
];

const server: Server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (!hostOk(req)) throw new HttpError(421, 'bad host');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && serveStatic(res, url.pathname)) return;
      throw new HttpError(404, 'not found');
    }
    if (!authorized(req, url)) throw new HttpError(401, 'unauthorized');
    if (url.pathname === '/api/events') return bus.add(res);
    for (const [method, re, handler] of routes) {
      if (req.method !== method) continue;
      const m = url.pathname.match(re);
      if (!m) continue;
      const out = await handler(m, req, url, res);
      if (out !== undefined && !res.headersSent) send(res, 200, out);
      return;
    }
    throw new HttpError(404, 'no such endpoint');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : /^no (chat|run)|matches no|no runs/.test((e as Error).message) ? 404 : 400;
    if (!res.headersSent) send(res, status, { error: (e as Error).message });
  }
});

function ready(): void {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;
  chats = new ChatManager(bus, cfg, bins, perms, { url, token }, MCP_SCRIPT);
  runs = new RunManager(bus, cfg);
  process.stdout.write(JSON.stringify({ ready: true, url, token, platform: IS_WIN ? 'win32' : IS_MAC ? 'darwin' : process.platform }) + '\n');
}

// A stable port keeps the window's origin, so the browser storage it uses survives a restart; if the
// preferred port is taken, any free one will do.
const preferred = Number(arg('port') ?? 0);
server.once('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE' && preferred) server.listen(0, '127.0.0.1', ready);
  else throw e;
});
server.listen(preferred, '127.0.0.1', ready);

let closing = false;
async function shutdown(): Promise<void> {
  // A second signal, or sessions that will not stop, must not keep the process alive.
  if (closing) process.exit(0);
  closing = true;
  setTimeout(() => process.exit(0), 4000).unref();
  server.close();
  await Promise.all([chats?.close(), runs?.close()]);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
// The desktop shell closes our stdin when it goes away (it cannot send signals on Windows).
if (process.argv.includes('--parent-stdin')) {
  process.stdin.on('end', () => void shutdown());
  process.stdin.resume();
}

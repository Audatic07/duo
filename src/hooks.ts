/**
 * duo's hook into the processes claw-orchestrator launches.
 *
 * claw spawns `claudeBin` and `$CODEX_BIN` itself. duo hands it route names instead of paths
 * ("duo-codex://seat-A-…") and intercepts `child_process.spawn` to:
 *   1. launch what the platform actually needs (a native binary, or Node plus a script);
 *   2. add each Codex seat's own flags after `exec` / `exec resume` (codex drops root-level -c flags
 *      when the subcommand has its own, and claw always passes some), plus --ignore-rules for seats;
 *   3. send the Codex prompt through stdin: argv is capped at 32K characters on Windows and at
 *      128 KiB per argument on Linux, and debate prompts get longer than that;
 *   4. hand every line of the untouched event stream to whoever owns the process, which is what
 *      the trace and the live view are built from.
 * Any other spawn passes straight through.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import type { BinSpec } from './bins.ts';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process') as typeof import('node:child_process');

export type LineSink = (line: string) => void;

export interface CodexRoute {
  bin: BinSpec;
  /** `-c key=value` overrides, inserted after `exec` / `exec resume`. */
  overrides: string[];
  ignoreRules: boolean;
  onLine?: LineSink;
  onSpawn?: (p: ChildProcess) => void;
}

const codexRoutes = new Map<string, CodexRoute>();
const claudeBins = new Map<string, BinSpec>();
const claudeSinks = new Map<string, LineSink>();
let installed = false;

/** Register a Codex route; pass the returned name to claw as CODEX_BIN. */
export function codexRoute(id: string, route: CodexRoute): string {
  install();
  const name = `duo-codex://${id}`;
  codexRoutes.set(name, route);
  return name;
}

export function dropCodexRoute(name: string): void {
  codexRoutes.delete(name);
}

/** A route for claw's `claudeBin`. Lines are delivered per Claude session id (see claudeSink). */
export function claudeRoute(id: string, bin: BinSpec): string {
  install();
  const name = `duo-claude://${id}`;
  claudeBins.set(name, bin);
  return name;
}

/** Receive the raw stream of the Claude process started with --session-id/--resume `sessionId`. */
export function claudeSink(sessionId: string, sink: LineSink | undefined): void {
  if (sink) claudeSinks.set(sessionId, sink);
  else claudeSinks.delete(sessionId);
}

function claudeSessionOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '--session-id' || args[i] === '--resume') return args[i + 1];
  return undefined;
}

/**
 * Split a byte stream into lines without mangling multi-byte characters across chunks. It only adds
 * a listener: the stream's encoding stays as claw expects it.
 */
function tee(stream: NodeJS.ReadableStream | null | undefined, sink: LineSink): void {
  if (!stream) return;
  let buf = '';
  const decoder = new StringDecoder('utf8');
  stream.on('data', (chunk: string | Buffer) => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) safe(sink, line);
    }
  });
  stream.on('end', () => {
    buf += decoder.end();
    if (buf.trim()) safe(sink, buf);
    buf = '';
  });
}

function safe(sink: LineSink, line: string): void {
  try {
    sink(line);
  } catch {
    /* a listener must never break the stream claw reads */
  }
}

/** Insert the seat's flags after `exec` or `exec resume <id>` and move the prompt to stdin. */
export function rewriteCodexArgs(args: readonly string[], route: Pick<CodexRoute, 'overrides' | 'ignoreRules'>): { args: string[]; stdin?: string } {
  const out = [...args];
  if (out[0] !== 'exec') return { args: out };
  const extra = [...route.overrides.flatMap((kv) => ['-c', kv]), ...(route.ignoreRules ? ['--ignore-rules'] : [])];
  const at = out[1] === 'resume' ? 3 : 1;
  out.splice(at, 0, ...extra);
  // claw always appends the message last.
  const prompt = out.pop();
  out.push('-');
  return { args: out, stdin: prompt ?? '' };
}

function install(): void {
  if (installed) return;
  installed = true;
  const realSpawn = childProcess.spawn;
  const hooked = function spawn(this: unknown, command: string, a?: unknown, b?: unknown): ChildProcess {
    const args = (Array.isArray(a) ? a : []) as string[];
    const options = ((Array.isArray(a) ? b : a) ?? {}) as SpawnOptions;
    const codex = codexRoutes.get(command);
    if (codex) {
      const { args: rewritten, stdin } = rewriteCodexArgs(args, codex);
      const stdio = Array.isArray(options.stdio) ? [...options.stdio] : ['pipe', 'pipe', 'pipe'];
      if (stdin !== undefined) stdio[0] = 'pipe';
      const p = realSpawn(codex.bin.command, [...codex.bin.args, ...rewritten], {
        ...options,
        stdio: stdio as SpawnOptions['stdio'],
        env: { ...(options.env ?? process.env), ...codex.bin.env },
        windowsHide: true,
      });
      if (stdin !== undefined && p.stdin) {
        p.stdin.on('error', () => undefined);
        p.stdin.end(stdin);
      }
      if (codex.onLine) tee(p.stdout, codex.onLine);
      codex.onSpawn?.(p);
      return p;
    }
    const claude = claudeBins.get(command);
    if (claude) {
      const session = claudeSessionOf(args);
      const p = realSpawn(claude.command, [...claude.args, ...args], {
        ...options,
        env: { ...(options.env ?? process.env), ...claude.env },
        windowsHide: true,
      });
      if (session) tee(p.stdout, (line) => claudeSinks.get(session)?.(line));
      return p;
    }
    return (realSpawn as (...x: unknown[]) => ChildProcess).apply(this, [command, a, b].filter((x) => x !== undefined));
  } as typeof childProcess.spawn;
  childProcess.spawn = hooked;
  // claw imports `spawn` as an ES module binding; this makes those bindings see the hook.
  syncBuiltinESMExports();
}

export const _test = { claudeSessionOf };

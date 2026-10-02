/**
 * Run store: everything a run did, on disk, in a form you can audit and diff.
 *
 *   ~/.local/share/duo/runs/<run-id>/
 *     run.json                 spec, seats (+ thread/session ids), versions, git state, quota, outcome
 *     transcript.md            every message in order, human-readable
 *     report.md                the result (ledger-derived; plus the chair's synthesis if any)
 *     ledger.json              claims, stances, citation checks (debate)
 *     turns/NN-<seat>-r<round>-<kind>/
 *       prompt.md              exactly what the seat received
 *       reply.md               its final answer (the "answer" field when structured)
 *       reply.json             the parsed structured output
 *       thinking.md            reasoning summaries / thinking, when the model provides them
 *       tools.json             commands run, files read, with outputs
 *       meta.json              timing, tokens, cost, quota, ids, errors
 *       raw.jsonl              the untouched CLI event stream for this turn
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR } from './paths.ts';
import type { Workspace } from './worktree.ts';

export interface Usage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

export interface ToolCall {
  name: string;
  input: string;
  output?: string;
  exitCode?: number | null;
  error?: boolean;
}

export interface SeatRecord {
  id: string;
  spec: string;
  engine: 'codex' | 'claude';
  model: string;
  effort?: string;
  name?: string;
  role: 'participant' | 'chair' | 'reviewer' | 'writer';
  clawSession: string;
  codexThreadId?: string;
  claudeSessionId?: string;
  /** Running totals the CLIs report cumulatively; kept so a continued run can report per-turn deltas. */
  codexUsageTotals?: Usage;
  claudeCostTotal?: number;
}

export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetsAt: number;
}

export interface QuotaSnapshot {
  codex?: { windows: QuotaWindow[]; plan?: string; asOf: number; limitReached?: string | null };
  claude?: { windows: QuotaWindow[]; status?: string; asOf: number };
}

export interface TurnRecord {
  n: number;
  round: number;
  seat: string;
  kind: string;
  dir: string;
  startedAt: string;
  durationMs: number;
  reply: string;
  structured?: unknown;
  parseError?: string;
  thinking: string[];
  tools: ToolCall[];
  usage: Usage;
  codexCredits?: number;
  usd?: number;
  rateLimits?: unknown;
  verdict?: string;
  error?: string;
  /** Problems the CLI recovered from by itself (reconnects), kept for the trace. */
  warnings?: string[];
}

export interface RunMeta {
  id: string;
  protocol: string;
  title: string;
  prompt: string;
  cwd: string;
  createdAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  seats: SeatRecord[];
  options: Record<string, unknown>;
  versions: Record<string, string>;
  git?: { head?: string; branch?: string; dirty?: boolean };
  turns: Omit<TurnRecord, 'reply' | 'structured' | 'thinking' | 'tools'>[];
  outcome?: Record<string, unknown>;
  quota?: { before?: QuotaSnapshot; after?: QuotaSnapshot };
  totals?: Usage & { codexCredits: number; usd: number; durationMs: number; turns: number };
  error?: string;
  continuedFrom?: string;
  /** Pair runs: where the writer works, and what became of it (applied, kept, discarded). */
  workspace?: Workspace;
}

function slug(text: string, n = 40): string {
  return (text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, n).replace(/-+$/, '')) || 'run';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export class RunStore {
  readonly dir: string;
  meta: RunMeta;
  private turnCounter: number;

  private constructor(dir: string, meta: RunMeta) {
    this.dir = dir;
    this.meta = meta;
    this.turnCounter = meta.turns.length;
  }

  static create(meta: Omit<RunMeta, 'id' | 'createdAt' | 'status' | 'turns'>): RunStore {
    mkdirSync(RUNS_DIR, { recursive: true });
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const base = `${stamp}-${meta.protocol}-${slug(meta.title)}`;
    let id = base;
    for (let i = 2; existsSync(join(RUNS_DIR, id)); i++) id = `${base}-${i}`;
    const dir = join(RUNS_DIR, id);
    mkdirSync(join(dir, 'turns'), { recursive: true });
    const full: RunMeta = { ...meta, id, createdAt: now.toISOString(), status: 'running', turns: [] };
    const store = new RunStore(dir, full);
    store.save();
    writeFileSync(join(dir, 'transcript.md'), `# ${meta.title}\n\n- run: \`${id}\`\n- protocol: ${meta.protocol}\n- cwd: \`${meta.cwd}\`\n- seats: ${meta.seats.map((s) => `${s.id}=\`${s.spec}\``).join(', ')}\n\n## Brief\n\n${meta.prompt.trim()}\n`);
    try {
      writeFileSync(join(RUNS_DIR, LATEST), id + '\n');
    } catch {
      /* best effort */
    }
    return store;
  }

  static open(ref: string): RunStore {
    const dir = resolveRunDir(ref);
    return new RunStore(dir, JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')));
  }

  save(): void {
    const tmp = join(this.dir, 'run.json.tmp');
    writeFileSync(tmp, JSON.stringify(this.meta, null, 2) + '\n');
    renameSync(tmp, join(this.dir, 'run.json'));
  }

  /** Allocated when a send starts, so parallel seats never share a turn number. */
  allocTurn(): number {
    return ++this.turnCounter;
  }

  turnDir(n: number, seat: string, round: number, kind: string): string {
    const dir = join(this.dir, 'turns', `${pad(n)}-${seat}-r${round}-${kind}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  writeTurn(t: TurnRecord, prompt: string, raw: string): void {
    const d = t.dir;
    writeFileSync(join(d, 'prompt.md'), prompt.endsWith('\n') ? prompt : prompt + '\n');
    writeFileSync(join(d, 'reply.md'), t.reply ? (t.reply.endsWith('\n') ? t.reply : t.reply + '\n') : '');
    if (t.structured !== undefined) writeFileSync(join(d, 'reply.json'), JSON.stringify(t.structured, null, 2) + '\n');
    if (t.thinking.length) writeFileSync(join(d, 'thinking.md'), t.thinking.join('\n\n---\n\n') + '\n');
    if (t.tools.length) writeFileSync(join(d, 'tools.json'), JSON.stringify(t.tools, null, 2) + '\n');
    if (raw) writeFileSync(join(d, 'raw.jsonl'), raw.endsWith('\n') ? raw : raw + '\n');
    const { reply: _r, structured: _s, thinking: _t, tools: _x, ...meta } = t;
    const rel = d.slice(this.dir.length + 1);
    writeFileSync(join(d, 'meta.json'), JSON.stringify({ ...meta, dir: rel, tools: t.tools.length, thinkingBlocks: t.thinking.length }, null, 2) + '\n');
    this.meta.turns.push({ ...meta, dir: rel });
    this.meta.turns.sort((a, b) => a.n - b.n);
    this.save();
  }

  appendTranscript(header: string, body: string): void {
    appendFileSync(join(this.dir, 'transcript.md'), `\n## ${header}\n\n${body.trim()}\n`);
  }

  writeFile(name: string, content: string): string {
    const p = join(this.dir, name);
    writeFileSync(p, content.endsWith('\n') ? content : content + '\n');
    return p;
  }

  readFile(name: string): string | undefined {
    const p = join(this.dir, name);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  }
}

/** The newest run's id, in a plain file (symlinks need privileges on Windows). */
const LATEST = '.latest';

function isRunDir(name: string): boolean {
  return !name.startsWith('.') && name !== 'latest' && existsSync(join(RUNS_DIR, name, 'run.json'));
}

export function resolveRunDir(ref: string): string {
  if (ref === 'latest' || ref === 'last') {
    try {
      const id = readFileSync(join(RUNS_DIR, LATEST), 'utf8').trim();
      if (id && isRunDir(id)) return join(RUNS_DIR, id);
    } catch {
      /* fall back to the newest directory */
    }
    const newest = existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).filter(isRunDir).sort().pop() : undefined;
    if (newest) return join(RUNS_DIR, newest);
    throw new Error('no runs yet');
  }
  if (existsSync(join(ref, 'run.json'))) return ref;
  if (existsSync(join(RUNS_DIR, ref, 'run.json'))) return join(RUNS_DIR, ref);
  const matches = existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).filter((d) => d.includes(ref) && isRunDir(d)) : [];
  if (matches.length === 1) return join(RUNS_DIR, matches[0]);
  if (!matches.length) throw new Error(`no run matches "${ref}" (see: duo runs)`);
  throw new Error(`"${ref}" matches ${matches.length} runs: ${matches.slice(0, 5).join(', ')}`);
}

export function listRuns(limit: number): RunMeta[] {
  if (!existsSync(RUNS_DIR)) return [];
  const out: RunMeta[] = [];
  for (const d of readdirSync(RUNS_DIR).filter(isRunDir).sort().reverse().slice(0, limit)) {
    try {
      out.push(JSON.parse(readFileSync(join(RUNS_DIR, d, 'run.json'), 'utf8')) as RunMeta);
    } catch {
      /* a run.json being rewritten right now; it shows up on the next refresh */
    }
  }
  return out;
}

/** Runs whose process went away mid-run (crash, kill, power loss) still say "running" on disk. */
export function markInterrupted(isLive: (id: string) => boolean): void {
  for (const m of listRuns(500)) {
    if (m.status !== 'running' || isLive(m.id)) continue;
    try {
      const dir = join(RUNS_DIR, m.id);
      // Leave runs another process is still writing alone (a CLI run in a terminal).
      if (Date.now() - statSync(join(dir, 'run.json')).mtimeMs < 6 * 3600_000 && !m.options?.gui) continue;
      m.status = 'failed';
      m.outcome = { ...(m.outcome ?? {}), stop: 'interrupted: the duo process that ran it stopped' };
      writeFileSync(join(dir, 'run.json'), JSON.stringify(m, null, 2) + '\n');
    } catch {
      /* best effort */
    }
  }
}

export function deleteRun(ref: string): void {
  rmSync(resolveRunDir(ref), { recursive: true, force: true });
}

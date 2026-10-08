import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { binVersion, resolveClaudeBin, resolveCodexBin, type Config } from '../config.ts';
import { Engines, type LiveUpdate, type SeatSession, type SendOpts } from '../engine.ts';
import { classifyError, errorHint } from '../errors.ts';
import type { Block } from '../live.ts';
import { PROJECT_ROOT } from '../paths.ts';
import { formatDelta, formatWindows, snapshot } from '../quota.ts';
import { fmtTurnLine } from '../render.ts';
import { formatSeat, seatLabel, type Seat } from '../seats.ts';
import { RunStore, type QuotaSnapshot, type RunMeta, type TurnRecord } from '../store.ts';

export type RunEvent =
  | { kind: 'log'; text: string; }
  | { kind: 'turn_start'; seat: string; n: number; round: number; turnKind: string; }
  | { kind: 'live'; seat: string; n: number; round: number; turnKind: string; blocks: Block[]; }
  | { kind: 'turn'; seat: string; n: number; label: string; round: number; turnKind: string; durationMs: number; verdict?: string; error?: string; hint?: string; note?: string; }
  | { kind: 'round'; round: number; stats: unknown; }
  | { kind: 'done'; status: string; outcome: Record<string, unknown>; };

export interface RunOptions {
  protocol: string;
  title: string;
  brief: string;
  cwd: string;
  seats: Seat[];
  chair?: Seat;
  rounds: number;
  minRounds: number;
  anon: boolean;
  quiet: boolean;
  extra: Record<string, unknown>;
  /** False for a question with no project folder (the seats get an empty scratch folder). */
  workspace?: boolean;
  /** Live progress for the GUI; receives every event with the run id. */
  sink?: (e: RunEvent & { run: string; }) => void;
}

/** Thrown inside a protocol when the run was cancelled or cannot usefully continue. */
export class RunAborted extends Error {
  readonly status: 'cancelled' | 'failed';
  constructor(status: 'cancelled' | 'failed', reason: string) {
    super(reason);
    this.status = status;
  }
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    return undefined;
  }
}

function pkgVersion(path: string): string {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

const ROLE_ORDER: Record<string, number> = { writer: 0, participant: 1, reviewer: 2, chair: 3 };

const tty = process.stderr.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

export class RunContext {
  readonly store: RunStore;
  readonly engines: Engines;
  readonly quotaBefore: QuotaSnapshot;
  readonly cfg: Config;
  readonly opts: RunOptions;
  private readonly started = Date.now();
  /** Seats a protocol cannot do without; when fewer still work, the run stops early. */
  minSeats = 1;
  /** Shared turn budget for templates, including recovery attempts and concurrent sends. */
  turnLimit?: number;
  private attempts = 0;
  get sentTurns(): number { return this.attempts; }
  private canSend(): boolean { return this.turnLimit === undefined || this.attempts < this.turnLimit; }
  private countSend(): void {
    if (!this.canSend()) throw new Error('model turn limit reached');
    this.attempts++;
  }
  private readonly failedSeats = new Map<string, string>();
  private abortReason?: { status: 'cancelled' | 'failed'; reason: string; };
  private abortWaiters: (() => void)[] = [];
  private finished = false;

  private constructor(cfg: Config, opts: RunOptions, store: RunStore, quota: QuotaSnapshot, bins: Parameters<typeof makeEngines>[2]) {
    this.cfg = cfg;
    this.opts = opts;
    this.store = store;
    this.quotaBefore = quota;
    this.engines = makeEngines(store, cfg, bins, this);
  }

  static create(cfg: Config, opts: RunOptions, continuedFrom?: RunStore): RunContext {
    const bins = { codex: resolveCodexBin(cfg), claude: resolveClaudeBin(cfg) };
    const quota = snapshot();
    const head = opts.workspace === false ? undefined : git(opts.cwd, ['rev-parse', 'HEAD']);
    const meta: Omit<RunMeta, 'id' | 'createdAt' | 'status' | 'turns'> = {
      protocol: opts.protocol,
      title: opts.title,
      prompt: opts.brief,
      cwd: opts.cwd,
      seats: opts.seats.map((s, i) => ({ id: s.id, spec: formatSeat(s), engine: s.engine, model: s.model, effort: s.effort, name: s.name, role: opts.protocol === 'pair' && i === 0 ? 'writer' : 'participant', clawSession: '' })),
      options: { rounds: opts.rounds, minRounds: opts.minRounds, anon: opts.anon, chair: opts.chair ? formatSeat(opts.chair) : undefined, workspace: opts.workspace !== false, ...opts.extra },
      versions: {
        duo: pkgVersion(join(PROJECT_ROOT, 'package.json')),
        claw: pkgVersion(join(PROJECT_ROOT, 'node_modules/@enderfga/claw-orchestrator/package.json')),
        codex: binVersion(bins.codex),
        claude: binVersion(bins.claude),
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        codexBin: bins.codex.display,
        claudeBin: bins.claude.display,
      },
      git: head ? { head, branch: git(opts.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), dirty: !!git(opts.cwd, ['status', '--porcelain']) } : undefined,
      quota: { before: quota },
      continuedFrom: continuedFrom?.meta.id,
    };
    const store = RunStore.create(meta);
    const ctx = new RunContext(cfg, opts, store, quota, bins);
    ctx.log(`${bold(store.meta.id)}`);
    ctx.log(`seats ${opts.seats.map((s) => `${s.id}=${formatSeat(s)}`).join('  ')}${opts.chair ? `  chair=${formatSeat(opts.chair)}` : ''}`);
    const cq = formatWindows(quota.codex?.windows, cfg.warnPercent);
    const aq = formatWindows(quota.claude?.windows, cfg.warnPercent);
    ctx.log(`quota codex ${cq.text}${cq.low ? ' (LOW)' : ''} | claude ${aq.text}${aq.low ? ' (LOW)' : ''}`);
    return ctx;
  }

  emit(e: RunEvent): void {
    try {
      this.opts.sink?.({ ...e, run: this.store.meta.id } as RunEvent & { run: string; });
    } catch {
      /* a GUI listener must never break a run */
    }
  }

  log(msg: string): void {
    if (!this.opts.quiet) process.stderr.write(`${dim('[duo]')} ${msg}\n`);
    this.emit({ kind: 'log', text: msg });
  }

  seatLine(seat: Seat, t: TurnRecord, extra = ''): void {
    const hint = errorHint(t.error);
    if (!this.opts.quiet) process.stderr.write(`${dim('[duo]')} ${fmtTurnLine(t, seatLabel(seat))}${extra ? ' · ' + extra : ''}${t.error ? ` · ERROR ${t.error.slice(0, 160)}` : ''}${hint ? ` · ${hint}` : ''}\n`);
    this.emit({ kind: 'turn', seat: t.seat, n: t.n, label: seatLabel(seat), round: t.round, turnKind: t.kind, durationMs: t.durationMs, verdict: t.verdict, error: t.error, hint, note: extra || undefined });
  }

  // ── cancellation and early stop ─────────────────────────────────────────

  get aborted(): boolean {
    return !!this.abortReason;
  }

  /** Stop the run: every seat's process is stopped, and the protocol ends at its next check. */
  abort(status: 'cancelled' | 'failed', reason: string): void {
    if (this.abortReason || this.finished) return;
    this.abortReason = { status, reason };
    this.log(status === 'cancelled' ? 'cancelled by the user; stopping the seats' : `stopping: ${reason}`);
    for (const w of this.abortWaiters.splice(0)) w();
    void this.engines.stopAll();
  }

  cancel(): void {
    this.abort('cancelled', 'cancelled by the user');
  }

  /** Throw if the run was aborted; protocols call this between steps. */
  checkpoint(): void {
    if (this.abortReason) throw new RunAborted(this.abortReason.status, this.abortReason.reason);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.abortWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /**
   * A seat failed in a way retrying cannot fix (outdated CLI, login, unknown model, plan limit).
   * When too few seats are left for the protocol to mean anything, stop the others right away
   * instead of letting them spend quota on a run that cannot finish.
   */
  private seatFailed(ss: SeatSession, t: TurnRecord): void {
    const seatName = `${ss.seat.id} (${ss.seat.engine}:${ss.seat.model})`;
    this.failedSeats.set(ss.seat.id, t.error ?? 'failed');
    const live = this.opts.seats.filter((s) => !this.failedSeats.has(s.id)).length;
    const hint = errorHint(t.error);
    if (ss.record.role === 'chair' && !ss.record.customRole) return;
    if (live < this.minSeats) this.abort('failed', `${seatName} failed: ${t.error}${hint ? ` — ${hint}` : ''}`);
  }

  /**
   * Send with the right recovery for what went wrong:
   *   - fatal (outdated CLI, login, unknown model) and quota errors: no retry, the seat is out;
   *   - capacity errors: one retry of the same message after a pause;
   *   - a reply that breaks the format, or that `check` rejects: one retry that names the problem;
   *   - timeouts: no retry.
   * A dead CLI process is restarted inside Engines.send and never reaches this level.
   */
  async send(ss: SeatSession, message: string, o: SendOpts, check?: (t: TurnRecord) => string | boolean | undefined): Promise<TurnRecord> {
    this.checkpoint();
    this.countSend();
    const t = await this.engines.send(ss, message, o);
    if (this.aborted) return t;
    const cls = classifyError(t.error);
    if (cls === 'fatal' || cls === 'quota') {
      this.seatFailed(ss, t);
      return t;
    }
    if (cls === 'timeout' || cls === 'aborted') return t;
    if (cls === 'capacity' || cls === 'dead_session') {
      if (!this.canSend()) return t;
      this.log(`${ss.seat.id} ${o.kind}: ${t.error!.slice(0, 160)}; retrying in 30s`);
      await this.sleep(30_000);
      this.checkpoint();
      this.countSend();
      const again = await this.engines.send(ss, message, { ...o, kind: `${o.kind}-retry` });
      const c2 = classifyError(again.error);
      if (c2 === 'fatal' || c2 === 'quota' || c2 === 'capacity') this.seatFailed(ss, again);
      return again;
    }
    const verdict = check?.(t);
    const problem = t.error ?? (typeof verdict === 'string' ? verdict : verdict === false ? (t.parseError ?? 'it did not match the required format') : undefined);
    if (!problem || !this.canSend()) return t;
    this.log(`${ss.seat.id} ${o.kind}: ${problem.slice(0, 160)}; retrying once`);
    const note = `Your previous reply could not be used: ${problem.slice(0, 400)}. Reply again to the message above, following its instructions and the required format exactly.`;
    this.checkpoint();
    this.countSend();
    return this.engines.send(ss, note, { ...o, kind: `${o.kind}-retry` });
  }

  recordSeats(sessions: SeatSession[]): void {
    const byId = new Map(sessions.map((s) => [s.record.id + s.record.role, s.record]));
    this.store.meta.seats = [
      ...this.store.meta.seats.filter((s) => !byId.has(s.id + s.role) && (s.clawSession || !sessions.some((ss) => ss.seat.id === s.id))),
      ...sessions.map((s) => s.record),
    ].sort((a, b) => (ROLE_ORDER[a.role] ?? 1) - (ROLE_ORDER[b.role] ?? 1) || a.id.localeCompare(b.id));
    this.store.save();
  }

  /** The next round number after everything recorded so far (chairs speak after the last round). */
  nextRound(): number {
    return Math.max(0, ...this.store.meta.turns.map((t) => t.round)) + 1;
  }

  async finish(status: RunMeta['status'], outcome: Record<string, unknown>, sessions: SeatSession[]): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.recordSeats(sessions);
    const after = snapshot();
    const turns = this.store.meta.turns;
    const sum = (f: (t: (typeof turns)[number]) => number | undefined) => turns.reduce((a, t) => a + (f(t) ?? 0), 0);
    this.store.meta.totals = {
      input: sum((t) => t.usage.input),
      cached: sum((t) => t.usage.cached),
      output: sum((t) => t.usage.output),
      reasoning: sum((t) => t.usage.reasoning),
      codexCredits: Math.round(sum((t) => t.codexCredits) * 1000) / 1000,
      usd: Math.round(sum((t) => t.usd) * 10000) / 10000,
      durationMs: Date.now() - this.started,
      turns: turns.length,
    };
    this.store.meta.quota = { before: this.quotaBefore, after };
    this.store.meta.status = status;
    this.store.meta.outcome = outcome;
    this.store.meta.finishedAt = new Date().toISOString();
    this.store.save();
    await this.engines.close();
    const tot = this.store.meta.totals;
    this.log(`done in ${(tot.durationMs / 1000).toFixed(0)}s · ${tot.turns} turns · ${tot.codexCredits} Codex credits · ~$${tot.usd} Claude API-equivalent`);
    this.log(`quota codex ${formatDelta(this.quotaBefore.codex?.windows, after.codex?.windows)} | claude ${formatDelta(this.quotaBefore.claude?.windows, after.claude?.windows)}`);
    this.emit({ kind: 'done', status, outcome });
  }

  /** Finish a run that threw: cancellations and early stops keep their reason. */
  async fail(e: unknown, sessions: SeatSession[], partial: Record<string, unknown> = {}): Promise<void> {
    const reason = this.abortReason ?? (e instanceof RunAborted ? { status: e.status, reason: e.message } : undefined);
    if (reason) await this.finish(reason.status, { ...partial, stop: `${reason.status === 'cancelled' ? 'cancelled' : 'failed'}: ${reason.reason}` }, sessions);
    else await this.finish('failed', { ...partial, stop: `error: ${(e as Error).message}` }, sessions);
  }

  /** Why the run stopped early, if it did. */
  get stopReason(): string | undefined {
    return this.abortReason ? `${this.abortReason.status === 'cancelled' ? 'cancelled' : 'failed'}: ${this.abortReason.reason}` : undefined;
  }

  get abortStatus(): 'cancelled' | 'failed' | undefined {
    return this.abortReason?.status;
  }
}

function makeEngines(store: RunStore, cfg: Config, bins: ConstructorParameters<typeof Engines>[2], ctx: RunContext): Engines {
  return new Engines(store, cfg, bins, {
    onTurnStart: (seat, n, round, kind) => ctx.emit({ kind: 'turn_start', seat, n, round, turnKind: kind }),
    onLive: (u: LiveUpdate) => ctx.emit({ kind: 'live', seat: u.seat, n: u.n, round: u.round, turnKind: u.kind, blocks: u.blocks }),
  });
}

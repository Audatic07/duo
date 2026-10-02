/**
 * Seats on top of claw-orchestrator's SessionManager.
 *
 * claw drives the CLIs (thread/session resume, sandbox restating on resume, persistent Claude
 * subprocesses, the run ledger). duo adds, through the spawn hook (hooks.ts):
 *   - per-seat Codex config (verbosity, reasoning summary, web search, service tier, raw cfg) and
 *     --ignore-rules, so a peer can never auto-escape its sandbox;
 *   - the untouched event stream of every turn, captured in memory per seat, which is what the
 *     trace, the parsed reply and the live view are built from;
 *   - transparent restarts: a Claude process that died between turns is started again with the
 *     same conversation, instead of failing every later turn with "Session not ready".
 */
import { SessionManager, nullLogger } from '@enderfga/claw-orchestrator';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BinSpec } from './bins.ts';
import type { Config } from './config.ts';
import { DEPTH_VAR } from './env.ts';
import { classifyError } from './errors.ts';
import { claudeRoute, claudeSink, codexRoute, dropCodexRoute } from './hooks.ts';
import { CLAW_LEDGER_DIR, CLAW_WF_DIR } from './paths.ts';
import { codexCredits } from './pricing.ts';
import { saveClaudeQuota } from './quota.ts';
import { codexOverrides, formatSeat, type Seat } from './seats.ts';
import type { RunStore, SeatRecord, TurnRecord, Usage } from './store.ts';
import { extractJson, parseClaudeStream, parseCodexStream, type ParsedTurn } from './tap.ts';
import { ClaudeTranslator, CodexTranslator, type Block } from './live.ts';

/** What a seat may do in the workspace. Discussion seats read; a pair-mode writer writes. */
export type SeatAccess =
  | { kind: 'read' }
  | { kind: 'write'; codexSandbox: 'workspace-write' | 'danger-full-access'; network?: boolean; claudeMode: 'acceptEdits' | 'bypassPermissions'; claudeSandbox?: boolean };

export interface SeatSession {
  seat: Seat;
  record: SeatRecord;
  clawName: string;
  structured: boolean;
  /** Codex usage is cumulative per thread; keep the last total to report per-turn deltas. */
  codexTotals?: Usage;
  claudeCostTotal?: number;
  /** Raw stream lines of the turn in flight. */
  capture: string[];
  /** Starts the claw session again, resuming the thread/session (after a crash). */
  restart: () => Promise<void>;
  /** Live translation of the turn in flight, for the GUI. */
  live?: { n: number; round: number; kind: string; translator: ClaudeTranslator | CodexTranslator; pending: Set<Block>; timer?: ReturnType<typeof setTimeout> };
  codexRouteName?: string;
  claudeSinkId?: string;
}

export interface SendOpts {
  round: number;
  kind: string;
  timeoutSec?: number;
}

export interface LiveUpdate {
  seat: string;
  n: number;
  round: number;
  kind: string;
  blocks: Block[];
}

export interface EngineHooks {
  /** A turn started (for elapsed-time displays). */
  onTurnStart?: (seat: string, n: number, round: number, kind: string) => void;
  /** Streaming blocks of a turn in flight, throttled. */
  onLive?: (u: LiveUpdate) => void;
}

export class Engines {
  private manager: SessionManager;
  private readonly tapsDir: string;
  private readonly runTag: string;
  private readonly run: RunStore;
  private readonly cfg: Config;
  private readonly bins: { codex: BinSpec; claude: BinSpec };
  private readonly sessions = new Set<SeatSession>();
  private readonly hooks: EngineHooks;
  private stopped = false;

  constructor(run: RunStore, cfg: Config, bins: { codex: BinSpec; claude: BinSpec }, hooks: EngineHooks = {}) {
    this.run = run;
    this.cfg = cfg;
    this.bins = bins;
    this.hooks = hooks;
    this.tapsDir = join(run.dir, 'taps');
    mkdirSync(this.tapsDir, { recursive: true });
    this.runTag = createHash('sha1').update(run.meta.id).digest('hex').slice(0, 8);
    // Keep claw's durable state next to duo's; mark every child so a seat can never start duo.
    process.env.CLAWO_RUNS_DIR = CLAW_LEDGER_DIR;
    process.env.CLAWO_WF_DIR = CLAW_WF_DIR;
    process.env.CLAWO_NO_EMBEDDED_SERVER = '1';
    process.env[DEPTH_VAR] = '1';
    this.manager = new SessionManager(
      {
        claudeBin: claudeRoute(`run-${this.runTag}`, this.bins.claude),
        maxConcurrentSessions: 32,
        sessionTtlMinutes: 24 * 60,
      },
      nullLogger,
    );
  }

  async openSeat(
    seat: Seat,
    role: SeatRecord['role'],
    opts: {
      schema?: object;
      system: string;
      cwd: string;
      access?: SeatAccess;
      /** Hide the user's installed Codex skills from the seat (discussion seats do not need them). */
      hideSkills?: boolean;
      resume?: Pick<SeatRecord, 'codexThreadId' | 'claudeSessionId' | 'codexUsageTotals' | 'claudeCostTotal'>;
    },
  ): Promise<SeatSession> {
    const access = opts.access ?? { kind: 'read' };
    const suffix = role === 'chair' ? 'chair' : role === 'reviewer' ? `${seat.id}-rev` : seat.id;
    const clawName = `duo-${this.runTag}-${suffix}`;
    const jsonSchema = opts.schema ? JSON.stringify(opts.schema) : undefined;
    const record: SeatRecord = {
      id: seat.id,
      spec: formatSeat(seat),
      engine: seat.engine,
      model: seat.model,
      effort: seat.effort,
      name: seat.name,
      role,
      clawSession: clawName,
      codexThreadId: opts.resume?.codexThreadId,
      claudeSessionId: opts.resume?.claudeSessionId,
    };
    const ss: SeatSession = {
      seat,
      record,
      clawName,
      structured: !!opts.schema,
      codexTotals: opts.resume?.codexUsageTotals,
      claudeCostTotal: opts.resume?.claudeCostTotal,
      capture: [],
      restart: async () => undefined,
    };
    const tapFile = join(this.tapsDir, `${suffix}.jsonl`);
    const onLine = (line: string) => {
      ss.capture.push(line);
      try {
        appendFileSync(tapFile, line + '\n');
      } catch {
        /* the trace is best effort; the turn is not */
      }
      this.feedLive(ss, line);
    };
    const common = {
      name: clawName,
      cwd: opts.cwd,
      model: seat.model,
      effort: seat.effort as any,
      jsonSchema,
      appendSystemPrompt: opts.system,
      skipPersistence: true,
      permissionMode: 'dontAsk' as const,
    };

    if (seat.engine === 'codex') {
      const overrides = [
        ...codexOverrides(seat),
        `shell_environment_policy.set={${DEPTH_VAR}="1"}`,
        ...(opts.hideSkills ? ['skills.include_instructions=false'] : []),
        ...(access.kind === 'write' && access.codexSandbox === 'workspace-write' && access.network ? ['sandbox_workspace_write.network_access=true'] : []),
      ];
      const route = codexRoute(`${this.runTag}-${suffix}`, { bin: this.bins.codex, overrides, ignoreRules: true, onLine });
      ss.codexRouteName = route;
      const start = async () => {
        await withCodexBin(route, () => this.manager.startSession({
          ...common,
          engine: 'codex',
          sandboxMode: access.kind === 'write' ? access.codexSandbox : 'read-only',
          ignoreUserConfig: true,
          ...(ss.record.codexThreadId ? { resumeSessionId: ss.record.codexThreadId } : {}),
        }));
      };
      await start();
      ss.restart = async () => {
        await this.manager.stopSession(clawName).catch(() => undefined);
        await start();
      };
    } else {
      const sessionId = opts.resume?.claudeSessionId ?? randomUUID();
      record.claudeSessionId = sessionId;
      ss.claudeSinkId = sessionId;
      claudeSink(sessionId, onLine);
      const tools = access.kind === 'write'
        ? undefined
        : ['Read', 'Grep', 'Glob', ...(seat.web ? ['WebSearch'] : []), ...(seat.fetch ? ['WebFetch'] : [])];
      let resumed = !!opts.resume?.claudeSessionId;
      const start = async () => {
        await this.manager.startSession({
          ...common,
          engine: 'claude',
          ...(tools ? { tools } : {}),
          ...(access.kind === 'write' ? { permissionMode: access.claudeMode as any } : {}),
          ...(access.kind === 'write' && access.claudeSandbox ? { settings: JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } }) } : {}),
          addDir: seat.addDirs.length ? seat.addDirs : undefined,
          crossSessionInbound: 'refuse',
          ...(resumed ? { claudeResumeId: sessionId } : { customSessionId: sessionId }),
        });
      };
      await start();
      ss.restart = async () => {
        await this.manager.stopSession(clawName).catch(() => undefined);
        // Once a turn has run, the conversation exists and must be resumed rather than recreated.
        resumed = true;
        await start();
      };
    }
    this.sessions.add(ss);
    return ss;
  }

  private feedLive(ss: SeatSession, line: string): void {
    const live = ss.live;
    if (!live || !this.hooks.onLive) return;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    for (const b of live.translator.apply([ev])) live.pending.add(b);
    if (live.timer || !live.pending.size) return;
    live.timer = setTimeout(() => this.flushLive(ss), 150);
  }

  private flushLive(ss: SeatSession): void {
    const live = ss.live;
    if (!live) return;
    clearTimeout(live.timer);
    live.timer = undefined;
    if (!live.pending.size) return;
    const blocks = [...live.pending].map((b) => ({ ...b }));
    live.pending.clear();
    this.hooks.onLive?.({ seat: ss.record.role === 'chair' ? 'chair' : ss.seat.id, n: live.n, round: live.round, kind: live.kind, blocks });
  }

  /** One turn: send, then rebuild the full record from the raw stream. */
  async send(ss: SeatSession, message: string, o: SendOpts): Promise<TurnRecord> {
    const n = this.run.allocTurn();
    const seatKey = ss.record.role === 'chair' ? 'chair' : ss.seat.id;
    const dir = this.run.turnDir(n, seatKey, o.round, o.kind);
    const startedAt = new Date();
    const started = Date.now();
    const timeoutSec = o.timeoutSec ?? ss.seat.timeoutSec ?? this.cfg.timeoutSec[ss.seat.engine];
    ss.capture = [];
    ss.live = { n, round: o.round, kind: o.kind, translator: ss.seat.engine === 'claude' ? new ClaudeTranslator() : new CodexTranslator(), pending: new Set() };
    this.hooks.onTurnStart?.(seatKey, n, o.round, o.kind);

    const attempt = async (): Promise<{ output: string; error?: string; sessionId?: string }> => {
      try {
        const res = await this.manager.sendMessage(ss.clawName, message, { timeout: timeoutSec * 1000, parentRunId: this.run.meta.id, nodeKind: o.kind });
        return { output: res.output ?? '', error: res.error, sessionId: res.sessionId };
      } catch (e) {
        return { output: '', error: (e as Error).message };
      }
    };
    let res = await attempt();
    if (!this.stopped && classifyError(res.error) === 'dead_session') {
      // The process behind the seat is gone; start it again on the same conversation and resend.
      try {
        await ss.restart();
        ss.capture = [];
        res = await attempt();
      } catch (e) {
        res = { output: '', error: `restart failed: ${(e as Error).message}` };
      }
    }
    // Let the last lines of a persistent process's stream land.
    await new Promise((r) => setTimeout(r, ss.seat.engine === 'claude' ? 150 : 30));
    this.flushLive(ss);
    if (ss.live?.translator instanceof CodexTranslator) {
      const changed = ss.live.translator.finalize();
      if (changed.length) this.hooks.onLive?.({ seat: seatKey, n, round: o.round, kind: o.kind, blocks: changed.map((b) => ({ ...b })) });
    }
    ss.live = undefined;

    const raw = ss.capture.join('\n');
    ss.capture = [];
    const parsed: ParsedTurn = ss.seat.engine === 'codex' ? parseCodexStream(raw) : parseClaudeStream(raw);
    const durationMs = Date.now() - started;
    const usage = this.turnUsage(ss, parsed);
    const reply = parsed.reply || res.output;
    let structured: unknown;
    let parseError: string | undefined;
    if (ss.structured && reply) {
      try {
        structured = parsed.structured ?? extractJson(reply);
      } catch (e) {
        parseError = (e as Error).message;
      }
    }
    if (parsed.threadId) ss.record.codexThreadId = parsed.threadId;
    if (parsed.sessionId) ss.record.claudeSessionId = parsed.sessionId;
    if (ss.codexTotals) ss.record.codexUsageTotals = ss.codexTotals;
    if (ss.seat.engine === 'claude' && parsed.rateLimits) saveClaudeQuota(parsed.rateLimits);

    let usd: number | undefined;
    if (ss.seat.engine === 'claude' && parsed.costUsd !== undefined) {
      // Claude reports the session's running total; keep the per-turn share.
      const prev = ss.claudeCostTotal ?? 0;
      usd = parsed.costUsd >= prev ? parsed.costUsd - prev : parsed.costUsd;
      ss.claudeCostTotal = parsed.costUsd;
      ss.record.claudeCostTotal = parsed.costUsd;
    }
    // A reply the CLI completed is a success even if claw saw a recoverable error on the way.
    const transportError = res.error && !(parsed.completed && reply) ? res.error : undefined;
    const turn: TurnRecord = {
      n,
      round: o.round,
      seat: seatKey,
      kind: o.kind,
      dir,
      startedAt: startedAt.toISOString(),
      durationMs,
      reply,
      structured,
      parseError,
      thinking: [...parsed.thinking, ...parsed.interim.map((x) => `(interim) ${x}`)],
      tools: parsed.tools,
      usage,
      codexCredits: ss.seat.engine === 'codex' ? codexCredits(ss.seat.model, usage, ss.seat.tier) : undefined,
      usd,
      rateLimits: parsed.rateLimits,
      verdict: typeof (structured as any)?.verdict === 'string' ? (structured as any).verdict : undefined,
      error: parsed.error || transportError || (!reply ? (this.stopped ? 'duo: run cancelled' : 'empty reply') : undefined),
      warnings: parsed.warnings.length ? parsed.warnings : undefined,
    };
    this.run.writeTurn(turn, message, raw);
    return turn;
  }

  private turnUsage(ss: SeatSession, p: ParsedTurn): Usage {
    const u = p.usage ?? { input: 0, cached: 0, output: 0, reasoning: 0 };
    if (!p.usageIsCumulative) return u;
    const prev = ss.codexTotals;
    if (!p.usage) return u;
    ss.codexTotals = u;
    if (!prev || u.input < prev.input) return u;
    return {
      input: u.input - prev.input,
      cached: Math.max(0, u.cached - prev.cached),
      output: Math.max(0, u.output - prev.output),
      reasoning: Math.max(0, u.reasoning - prev.reasoning),
    };
  }

  /** Stop every seat now (cancel, or a fatal failure that makes the run pointless). */
  async stopAll(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.sessions].map((ss) => this.manager.stopSession(ss.clawName).catch(() => undefined)));
  }

  async close(): Promise<void> {
    for (const ss of this.sessions) {
      if (ss.codexRouteName) dropCodexRoute(ss.codexRouteName);
      if (ss.claudeSinkId) claudeSink(ss.claudeSinkId, undefined);
    }
    try {
      await this.manager.shutdown();
    } catch {
      /* already down */
    }
  }
}

let codexBinLock: Promise<unknown> = Promise.resolve();

/**
 * claw's SessionManager reads process.env.CODEX_BIN when it constructs a Codex session. Chats and
 * runs open sessions concurrently in the GUI server, so the handoff is serialized.
 */
export function withCodexBin<T>(route: string, fn: () => Promise<T>): Promise<T> {
  const next = codexBinLock.then(async () => {
    process.env.CODEX_BIN = route;
    return fn();
  });
  codexBinLock = next.catch(() => undefined);
  return next;
}

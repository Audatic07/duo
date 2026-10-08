/**
 * Continue a finished run in a new run directory that resumes the same Codex threads and Claude
 * sessions (so the models keep their context and the cache stays warm). Debates rebuild their claim
 * ledger by replaying the recorded structured replies, then run more rounds.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { SeatSession } from '../engine.ts';
import { ClaimLedger } from '../ledger.ts';
import { systemRules } from '../prompts.ts';
import { asDebateTurn, DEBATE_SCHEMA, type DebateTurn } from '../schemas.ts';
import { parseSeat, type Seat } from '../seats.ts';
import { RunStore } from '../store.ts';
import { ask } from './ask.ts';
import { RunContext, type RunOptions } from './common.ts';
import { debate } from './debate.ts';
import { schemaError } from '../templates/validate.ts';
import { templateOperationSettings } from '../templates/operations.ts';
import { nativeSchema } from '../templates/builtins.ts';
import type { CoordinationTemplate } from '../templates/types.ts';
import { templateSchema } from '../templates/definitions.ts';

export interface ContinueOptions {
  rounds: number;
  quiet: boolean;
  chair?: Seat;
  safe: boolean;
  sink?: RunOptions['sink'];
  /** Receives the new run's context as soon as it exists (for cancel, and to show the new id). */
  onContext?: (ctx: RunContext) => void;
}

export async function continueRun(cfg: Config, ref: string, note: string, o: ContinueOptions): Promise<string> {
  if (!Number.isInteger(o.rounds) || o.rounds < 1 || o.rounds > 1000) throw new Error('rounds must be 1–1000');
  const prev = RunStore.open(ref);
  const pm = prev.meta;
  if (pm.protocol === 'pair') {
    const { continuePair } = await import('./pair.ts');
    return continuePair(cfg, prev, note, o);
  }
  if (!['debate', 'ask'].includes(pm.protocol)) throw new Error(`continue supports debate, ask and pair runs (this is a ${pm.protocol} run)`);
  const participants = [...new Map(pm.seats.filter((s) => s.role === 'participant' && !s.customRole && (s.clawSession || s.codexThreadId || s.claudeSessionId)).map((s) => [s.id, s])).values()];
  const seats: Seat[] = participants.map((r) => parseSeat(r.spec, r.id, cfg.defaults, { safe: o.safe }));
  // Keep the original pool for authored preparer/chair assignments; only participants resume.
  const pool = pm.options.template ? [...new Map(pm.seats.filter((s) => s.id !== 'Z').map((s) => [s.id, s])).values()]
    .sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id))
    .map((r) => parseSeat(r.spec, r.id, cfg.defaults, { safe: o.safe })) : seats;
  const anon = !!pm.options.anon;
  const ctx = RunContext.create(cfg, {
    protocol: pm.protocol,
    title: `${pm.title.replace(/ \(continued\)$/, '')} (continued)`,
    brief: pm.protocol === 'ask' ? note : pm.prompt,
    cwd: pm.cwd,
    seats: pool,
    chair: o.chair,
    rounds: o.rounds,
    minRounds: 1,
    anon,
    quiet: o.quiet,
    extra: { continuedFrom: pm.id, note, ...(pm.options.template ? { template: pm.options.template } : {}) },
    workspace: pm.options.workspace !== false,
    sink: o.sink,
  }, prev);
  o.onContext?.(ctx);

  const sessions: SeatSession[] = [];
  try {
    for (const seat of seats) {
      const rec = participants.find((r) => r.id === seat.id)!;
      if (!rec.codexThreadId && !rec.claudeSessionId) throw new Error(`seat ${seat.id} has no recorded thread/session to resume`);
      sessions.push(await ctx.engines.openSeat(seat, 'participant', {
        schema: nativeSchema(ctx, 'participant', pm.protocol === 'debate' ? DEBATE_SCHEMA : undefined),
        system: systemRules(seat, { protocol: pm.protocol, cwd: pm.cwd, seats, anon, structured: pm.protocol === 'debate', workspace: pm.options.workspace !== false }),
        cwd: pm.cwd,
        resume: rec,
        hideSkills: true,
      }));
    }
  } catch (e) {
    await ctx.fail(e, sessions);
    throw e;
  }

  if (pm.protocol === 'ask') {
    const lastRound = Math.max(0, ...pm.turns.map((t) => t.round));
    return ask(ctx, { sessions, round: lastRound + 1 });
  }

  // Debate: replay every structured turn of the whole chain of runs (a continuation of a
  // continuation starts several rounds in) to rebuild the ledger exactly.
  const chain: RunStore[] = [];
  for (let r: RunStore | undefined = prev; r;) {
    chain.unshift(r);
    const from: string | undefined = r.meta.continuedFrom;
    try {
      r = from ? RunStore.open(from) : undefined;
    } catch {
      r = undefined;
    }
  }
  const ledger = new ClaimLedger(seats.map((s) => s.id), pm.cwd);
  const latest: Record<string, DebateTurn> = {};
  let lastRound = 0;
  for (const run of chain) {
    const turns = run.meta.turns.filter((x) => seats.some((s) => s.id === x.seat) && /^(position|critique|ledger-review)(-retry)?$/.test(x.kind));
    for (const round of [...new Set(turns.map((t) => t.round))].sort((a, b) => a - b)) {
      if (round <= lastRound) continue;
      // Only the returned attempt counts; earlier invalid replies may also contain JSON.
      const finalAttempts = new Map(turns.filter((x) => x.round === round).map((t) => [t.seat, t]));
      let discussion = false;
      let review = false;
      for (const t of finalAttempts.values()) {
        if (t.error) continue;
        const f = join(run.dir, t.dir, 'reply.json');
        if (!existsSync(f)) continue;
        const structured = JSON.parse(readFileSync(f, 'utf8'));
        const dt = asDebateTurn(structured);
        if (!dt) continue;
        if (t.kind.startsWith('ledger-review')) {
          const settings = templateOperationSettings(run.meta.options.template as CoordinationTemplate | undefined, 'debate.resolve', t.templateStep);
          const policy = { allowedStances: settings.decisions === 'graded' ? ['agree', 'partial', 'disagree', 'unsure'] : ['agree', 'disagree'], requireAllClaims: !!settings.requireAllClaims, requireReasons: !!settings.requireReasons };
          const schema = templateSchema(run.meta.options.template as CoordinationTemplate | undefined, 'participant', DEBATE_SCHEMA) as Record<string, unknown>;
          if (schemaError(schema, structured) || ledger.reviewError(t.seat, dt, policy) || !latest[t.seat]) continue;
          ledger.review(t.seat, round, dt, policy);
          latest[t.seat] = { ...latest[t.seat], verdict: dt.verdict, stances: dt.stances, open_points: dt.open_points, confidence: dt.confidence };
          review = true;
        } else {
          latest[t.seat] = dt;
          ledger.update(t.seat, round, dt);
          discussion = true;
        }
      }
      if (discussion) ledger.closeRound(round);
      if (review) ledger.closeReview(round);
      lastRound = round;
    }
  }
  return debate(ctx, { sessions, ledger, latest, startRound: lastRound + 1, note: note || undefined });
}

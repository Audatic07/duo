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
  const prev = RunStore.open(ref);
  const pm = prev.meta;
  if (pm.protocol === 'pair') {
    const { continuePair } = await import('./pair.ts');
    return continuePair(cfg, prev, note, o);
  }
  if (!['debate', 'ask'].includes(pm.protocol)) throw new Error(`continue supports debate, ask and pair runs (this is a ${pm.protocol} run)`);
  const participants = pm.seats.filter((s) => s.role === 'participant');
  const seats: Seat[] = participants.map((r) => parseSeat(r.spec, r.id, cfg.defaults, { safe: o.safe }));
  const anon = !!pm.options.anon;
  const ctx = RunContext.create(cfg, {
    protocol: pm.protocol,
    title: `${pm.title.replace(/ \(continued\)$/, '')} (continued)`,
    brief: pm.protocol === 'ask' ? note : pm.prompt,
    cwd: pm.cwd,
    seats,
    chair: o.chair,
    rounds: o.rounds,
    minRounds: 1,
    anon,
    quiet: o.quiet,
    extra: { continuedFrom: pm.id, note },
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
        schema: pm.protocol === 'debate' ? DEBATE_SCHEMA : undefined,
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
  for (let r: RunStore | undefined = prev; r; ) {
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
    const turns = run.meta.turns.filter((x) => x.seat !== 'chair' && !x.error);
    for (const round of [...new Set(turns.map((t) => t.round))].sort((a, b) => a - b)) {
      if (round <= lastRound) continue;
      for (const t of turns.filter((x) => x.round === round)) {
        const f = join(run.dir, t.dir, 'reply.json');
        if (!existsSync(f)) continue;
        const dt = asDebateTurn(JSON.parse(readFileSync(f, 'utf8')));
        if (!dt) continue;
        latest[t.seat] = dt;
        ledger.update(t.seat, round, dt);
      }
      ledger.closeRound(round);
      lastRound = round;
    }
  }
  return debate(ctx, { sessions, ledger, latest, startRound: lastRound + 1, note: note || undefined });
}

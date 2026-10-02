/**
 * Debate: blind positions, then cross-examination rounds over a claim ledger until every seat
 * signs the others' answers with nothing disputed, nobody moves any more, or the round cap hits.
 *
 *   R1       every seat answers independently (in parallel, no visibility)
 *   R2..Rn   each seat sees peers' answers + claims (+ citation checks, + stances on its own
 *            claims), takes a stance per claim, concedes or holds, revises
 *   report   ledger-derived report; optional chair synthesis from a fresh session
 */
import { CLAIM_HARD_CAP, ClaimLedger } from '../ledger.ts';
import { chairBrief, chairRules, debateOpening, debateRound, participantName, systemRules, type RulesContext } from '../prompts.ts';
import { debateReport, renderDebateTurn, usageSection } from '../render.ts';
import { asDebateTurn, DEBATE_SCHEMA, type DebateTurn } from '../schemas.ts';
import type { SeatSession } from '../engine.ts';
import type { RunContext } from './common.ts';
import type { TurnRecord } from '../store.ts';

export async function debate(ctx: RunContext, resume?: { sessions: SeatSession[]; ledger: ClaimLedger; latest: Record<string, DebateTurn>; startRound: number; note?: string }): Promise<string> {
  const { seats, rounds, minRounds, anon, cwd, brief } = ctx.opts;
  const rules: RulesContext = { protocol: 'debate', cwd, seats, anon, structured: true, workspace: ctx.opts.workspace };
  const sessions: SeatSession[] = resume?.sessions ?? [];
  ctx.minSeats = 2;
  try {
    if (!resume) {
      for (const seat of seats) sessions.push(await ctx.engines.openSeat(seat, 'participant', { schema: DEBATE_SCHEMA, system: systemRules(seat, rules), cwd, hideSkills: true }));
    }
  } catch (e) {
    await ctx.fail(e, sessions);
    throw e;
  }
  ctx.recordSeats(sessions);
  const ledger = resume?.ledger ?? new ClaimLedger(seats.map((s) => s.id), cwd);
  const latest: Record<string, DebateTurn> = resume?.latest ?? {};
  const names = Object.fromEntries(seats.map((s) => [s.id, participantName(s, false)]));
  let active = [...sessions];
  let stop = 'reached the round limit';
  const first = resume?.startRound ?? 1;
  const last = first + rounds - 1;
  // From round 2 a reply must take stances: without them the ledger cannot tell agreement from
  // talking past each other (weaker models tend to skip them).
  const check = (round: number, me: string) => (t: TurnRecord): string | undefined => {
    const dt = asDebateTurn(t.structured);
    if (!dt) return t.parseError ?? 'the reply did not match the required JSON format';
    const peerClaims = ledger.openClaims().filter((c) => c.owner !== me).length;
    if (round > 1 && peerClaims > 0 && dt.stances.length === 0) return `it took no stances, but ${peerClaims} peer claim(s) above still need your stance (agree, partial, disagree or unsure, by global id such as B:c2)`;
    return undefined;
  };

  const overCap: Record<string, number> = {};
  try {
    for (let r = first; r <= last; r++) {
      ctx.checkpoint();
      ctx.log(`round ${r}${r === 1 ? ' (blind)' : ''}: ${active.map((s) => s.seat.id).join(', ')}`);
      const turns = await Promise.all(
        active.map((ss) => {
          let msg = r === 1
            ? debateOpening(brief, last)
            : debateRound(ss.seat, r, last, seats.filter((p) => p.id !== ss.seat.id && latest[p.id]), latest, ledger, anon, r >= 3);
          if (overCap[ss.seat.id]) msg = `Note: only your first ${CLAIM_HARD_CAP} claims were recorded last round (${overCap[ss.seat.id]} dropped). Merge claims so the ones that matter are among them.\n\n${msg}`;
          if (resume?.note && r === first) msg = `Moderator note from the user: ${resume.note}\n\n${msg}`;
          return ctx.send(ss, msg, { round: r, kind: r === 1 ? 'position' : 'critique' }, check(r, ss.seat.id));
        }),
      );
      ctx.checkpoint();
      const dropped: string[] = [];
      turns.forEach((t, i) => {
        const ss = active[i];
        const dt = asDebateTurn(t.structured);
        if (!dt) {
          dropped.push(ss.seat.id);
          ctx.seatLine(ss.seat, t, 'unusable reply — seat dropped');
          return;
        }
        latest[ss.seat.id] = dt;
        overCap[ss.seat.id] = ledger.update(ss.seat.id, r, dt);
        const mine = dt.claims.length;
        ctx.seatLine(ss.seat, t, `${mine} claims${dt.stances.length ? `, ${dt.stances.length} stances` : ''}${dt.concessions.length ? `, ${dt.concessions.length} concessions` : ''}`);
        ctx.store.appendTranscript(`[R${r}] ${names[ss.seat.id]} — ${t.kind} (${(t.durationMs / 1000).toFixed(0)}s)`, renderDebateTurn(dt, ss.seat.id));
      });
      active = active.filter((s) => !dropped.includes(s.seat.id));
      const stats = ledger.closeRound(r);
      ctx.store.writeFile('ledger.json', JSON.stringify(ledger.toJSON(), null, 2));
      ctx.emit({ kind: 'round', round: r, stats });
      ctx.log(`R${r} ledger: ${stats.claims} claims · ${stats.agreed} agreed · ${stats.partial} partial · ${stats.disputed} disputed · ${stats.unaddressed} open · citations failed ${stats.citationsFailed}/${stats.citationsChecked} · verdicts ${Object.entries(stats.verdicts).map(([s, v]) => `${s}=${v}`).join(' ')}`);
      if (active.length < 2) {
        const why = turns.map((t, i) => (t.error ? `${active[i]?.seat.id ?? t.seat}: ${t.error.slice(0, 300)}` : '')).filter(Boolean).join('; ');
        stop = active.length ? `stopped: only one seat still responding${why ? ` (${why})` : ''}` : `failed: no seat produced a usable reply${why ? ` (${why})` : ''}`;
        break;
      }
      const ids = active.map((s) => s.seat.id);
      if (r >= Math.max(minRounds, 2) && ledger.converged(ids)) {
        stop = `converged in round ${r} (all verdicts agree, every claim agreed)`;
        break;
      }
      if (r >= first + 2 && !ledger.movedIn(r)) {
        stop = `stalled in round ${r} (no stance changed and nothing conceded)`;
        break;
      }
      if (r === last) {
        const open = ledger.openClaims().length;
        stop = ledger.verdictsAgree(ids)
          ? `NOT converged: verdicts say agree but ${open} claim(s) are still disputed, partial or unaddressed — the seats may be agreeing with each other's earlier positions; compare the final positions`
          : `NOT converged after ${ledger.rounds.length} round(s): ${open} open claim(s)`;
      }
    }

    let report = debateReport(ctx.store.meta, ledger, latest, names, stop);
    if (ctx.opts.chair && Object.keys(latest).length) {
      ctx.checkpoint();
      const chairSeat = { ...ctx.opts.chair, id: 'Z' };
      const chair = await ctx.engines.openSeat(chairSeat, 'chair', { system: chairRules(chairSeat, cwd), cwd, hideSkills: true });
      sessions.push(chair);
      ctx.log(`chair ${chairSeat.engine}:${chairSeat.model} synthesizing`);
      const body = [
        '<debate_record>',
        report,
        '</debate_record>',
      ].join('\n');
      const t = await ctx.send(chair, chairBrief('debate', brief, body, Object.values(names).join(' and ')), { round: ctx.nextRound(), kind: 'synthesis' });
      ctx.seatLine(chairSeat, t);
      if (t.reply) {
        report = `# ${ctx.store.meta.title}\n\n_Chair: ${chairSeat.engine}:${chairSeat.model}@${chairSeat.effort ?? 'default'} — synthesized from the debate record below._\n\n${t.reply.trim()}\n\n---\n\n${report}`;
        ctx.store.appendTranscript('[chair] synthesis', t.reply);
      }
    }
    await ctx.finish(stop.startsWith('failed') ? 'failed' : 'completed', {
      stop,
      converged: stop.startsWith('converged'),
      rounds: ledger.rounds.length,
      verdicts: ledger.verdicts,
      final: ledger.rounds[ledger.rounds.length - 1] ?? null,
    }, sessions);
    report += '\n\n' + usageSection(ctx.store.meta);
    ctx.store.writeFile('report.md', report);
    return report;
  } catch (e) {
    await ctx.fail(e, sessions, { converged: false, rounds: ledger.rounds.length, verdicts: ledger.verdicts, final: ledger.rounds[ledger.rounds.length - 1] ?? null });
    if (!ctx.abortStatus) throw e;
    const report = debateReport(ctx.store.meta, ledger, latest, names, ctx.stopReason ?? 'stopped') + '\n\n' + usageSection(ctx.store.meta);
    ctx.store.writeFile('report.md', report);
    return report;
  }
}

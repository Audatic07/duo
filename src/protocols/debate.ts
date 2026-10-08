/**
 * Debate: blind positions, then cross-examination rounds over a claim ledger until every seat
 * signs the others' answers with nothing disputed, nobody moves any more, or the round cap hits.
 *
 *   R1       every seat answers independently (in parallel, no visibility)
 *   R2..Rn   each seat sees peers' answers + claims (+ citation checks, + stances on its own
 *            claims), takes a stance per claim, concedes or holds, revises
 *   review   every seat decides agree/disagree on every peer claim in the frozen final ledger
 *   report   ledger-derived report; optional chair synthesis from a fresh session
 */
import { CLAIM_HARD_CAP, ClaimLedger } from '../ledger.ts';
import { chairBrief, chairRules, debateLedgerContext, debateLedgerReview, debateOpening, debateRound, participantName, systemRules, type RulesContext } from '../prompts.ts';
import { debateReport, renderDebateTurn, usageSection } from '../render.ts';
import { asDebateTurn, DEBATE_SCHEMA, type DebateTurn } from '../schemas.ts';
import type { SeatSession } from '../engine.ts';
import type { RunContext } from './common.ts';
import { nativeChair, nativeSchema, nativeSeats, runBuiltin } from '../templates/builtins.ts';
import type { TurnRecord } from '../store.ts';
import { schemaError } from '../templates/validate.ts';
import { templateOperationSettings } from '../templates/operations.ts';
import { templateSchema } from '../templates/definitions.ts';
import type { CoordinationTemplate, WorkflowState } from '../templates/types.ts';

export async function debate(ctx: RunContext, resume?: { sessions: SeatSession[]; ledger: ClaimLedger; latest: Record<string, DebateTurn>; startRound: number; note?: string; }): Promise<string> {
  const { anon, cwd, brief } = ctx.opts;
  const seats = nativeSeats(ctx, 'participant');
  const template = ctx.opts.extra.template as CoordinationTemplate | undefined;
  const roundSettings = templateOperationSettings(template, 'debate.round');
  const rounds = Number(roundSettings.rounds) || ctx.opts.rounds;
  let minRounds = Number(roundSettings.minRounds) || ctx.opts.minRounds;
  const rules: RulesContext = { protocol: 'debate', cwd, seats, anon, structured: true, workspace: ctx.opts.workspace };
  const sessions: SeatSession[] = resume?.sessions ?? [];
  ctx.minSeats = 2;
  try {
    if (seats.length < Math.max(2, template?.limits.minSeats ?? 2)) throw new Error('debate needs at least two assigned participants (and the template’s minimum model count)');
    if (!resume) {
      for (const seat of seats) sessions.push(await ctx.engines.openSeat(seat, 'participant', { schema: templateSchema(template, 'participant', DEBATE_SCHEMA), system: systemRules(seat, rules), cwd, hideSkills: true }));
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
  let last = first + rounds - 1;
  // From round 2 a reply must take stances: without them the ledger cannot tell agreement from
  // talking past each other (weaker models tend to skip them).
  const check = (round: number, me: string) => (t: TurnRecord): string | undefined => {
    const dt = asDebateTurn(t.structured);
    if (!dt) return t.parseError ?? 'the reply did not match the required JSON format';
    const peerClaims = ledger.openClaims().filter((c) => c.owner !== me).length;
    if (roundSettings.requireStances && round > 1 && peerClaims > 0 && dt.stances.length === 0) return `it took no stances, but ${peerClaims} peer claim(s) above still need your stance (agree, partial, disagree or unsure, by global id such as B:c2)`;
    return undefined;
  };

  const overCap: Record<string, number> = {};
  let r = first;
  let report = '';
  let reviewed = false;
  const resolve = async (flow: WorkflowState) => {
    const settings = templateOperationSettings(template, 'debate.resolve', flow.step);
    const policy = { allowedStances: settings.decisions === 'graded' ? ['agree', 'partial', 'disagree', 'unsure'] : ['agree', 'disagree'], requireAllClaims: !!settings.requireAllClaims, requireReasons: !!settings.requireReasons };
    flow.vars.reviewComplete = false;
    reviewed = false;
    const missing = seats.filter((s) => !active.some((ss) => ss.seat.id === s.id));
    if (missing.length) {
      stop = `failed: final claim-ledger review needs every participant; no usable reply from ${missing.map((s) => s.id).join(', ')}`;
      return;
    }
    if (seats.some((s) => !latest[s.id])) {
      stop = 'failed: final claim-ledger review requires a discussion position from every participant';
      return;
    }
    ctx.checkpoint();
    if (ctx.turnLimit !== undefined && ctx.sentTurns + active.length > ctx.turnLimit) {
      stop = 'failed: model turn limit leaves no budget for every participant to review the final claim ledger';
      return;
    }
    const round = ctx.nextRound();
    ctx.log(`final claim-ledger review: ${active.map((ss) => ss.seat.id).join(', ')}`);
    const reviewCheck = (seat: string) => (t: TurnRecord): string | undefined => {
      if (t.error) return t.error;
      const error = schemaError(templateSchema(template, 'participant', DEBATE_SCHEMA) as Record<string, unknown>, t.structured);
      if (error) return t.parseError ?? error;
      return ledger.reviewError(seat, asDebateTurn(t.structured)!, policy);
    };
    // Generate every prompt before sending or applying decisions: all seats see one snapshot.
    const contexts = active.map((ss) => debateLedgerContext(ss.seat, seats, latest, ledger, anon, settings.decisions === 'graded'));
    const prompts = contexts.map(debateLedgerReview);
    const turns = await Promise.all(active.map((ss, i) => ctx.send(ss, prompts[i], { round, kind: 'ledger-review', templateContext: contexts[i] }, reviewCheck(ss.seat.id))));
    ctx.checkpoint();
    const failures: string[] = [];
    turns.forEach((t, i) => {
      const ss = active[i];
      const error = reviewCheck(ss.seat.id)(t);
      if (error) {
        failures.push(`${ss.seat.id}: ${error}`);
        ctx.seatLine(ss.seat, t, `final ledger review failed — ${error}`);
        return;
      }
      const dt = asDebateTurn(t.structured)!;
      ledger.review(ss.seat.id, round, dt, policy);
      // Preserve the exact answers and claims the other seats reviewed.
      latest[ss.seat.id] = { ...latest[ss.seat.id], verdict: dt.verdict, stances: dt.stances, open_points: dt.open_points, confidence: dt.confidence };
      ctx.seatLine(ss.seat, t, `${dt.stances.length} final claim decisions`);
      ctx.store.appendTranscript(`[ledger review] ${names[ss.seat.id]} (${(t.durationMs / 1000).toFixed(0)}s)`, renderDebateTurn(dt, ss.seat.id));
    });
    const stats = ledger.closeReview(round);
    reviewed = !failures.length;
    flow.vars.reviewComplete = reviewed;
    flow.vars.reviewAddressed = stats.unaddressed === 0;
    flow.vars.ledger = ledger.toJSON();
    ctx.store.writeFile('ledger.json', JSON.stringify(ledger.toJSON(), null, 2));
    ctx.emit({ kind: 'round', round, stats });
    if (failures.length) {
      stop = `failed: final claim-ledger review incomplete (${failures.join('; ')})`;
    } else if (ledger.converged(seats.map((s) => s.id))) {
      stop = `converged after ${ledger.rounds.length} discussion round(s) and final claim-ledger review (all verdicts agree, every claim agreed)`;
    } else {
      stop = `NOT converged after ${ledger.rounds.length} discussion round(s) and final claim-ledger review: ${stats.disputed} disputed claim(s)${stats.partial ? `; ${stats.partial} partially agreed` : ''}${stats.unaddressed ? `; ${stats.unaddressed} undecided` : ''}${ledger.verdictsAgree(seats.map((s) => s.id)) ? '' : '; final positions differ'}${stop.startsWith('stalled') ? `; ${stop}` : ''}`;
    }
    ctx.log(`final ledger: ${stats.agreed} agreed · ${stats.disputed} disputed · ${stop}`);
  };
  try {
    const workflow = await runBuiltin(ctx, 'debate', {
      'debate.round': async (flow) => {
        ctx.checkpoint();
        Object.assign(roundSettings, templateOperationSettings(template, 'debate.round', flow.step));
        last = first + (Number(roundSettings.rounds) || ctx.opts.rounds) - 1;
        minRounds = Number(roundSettings.minRounds) || ctx.opts.minRounds;
        ctx.log(`round ${r}${r === 1 ? ' (blind)' : ''}: ${active.map((s) => s.seat.id).join(', ')}`);
        flow.vars.ledger = ledger.toJSON();
        const turns = await Promise.all(
          active.map((ss) => {
            let msg = r === 1
              ? debateOpening(brief, last)
              : debateRound(ss.seat, r, last, seats.filter((p) => p.id !== ss.seat.id && latest[p.id]), latest, ledger, anon, r >= Number(roundSettings.focusOpenAfter));
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
        flow.vars.ledger = ledger.toJSON();
        ctx.store.writeFile('ledger.json', JSON.stringify(ledger.toJSON(), null, 2));
        ctx.emit({ kind: 'round', round: r, stats });
        ctx.log(`R${r} ledger: ${stats.claims} claims · ${stats.agreed} agreed · ${stats.partial} partial · ${stats.disputed} disputed · ${stats.unaddressed} open · citations failed ${stats.citationsFailed}/${stats.citationsChecked} · verdicts ${Object.entries(stats.verdicts).map(([s, v]) => `${s}=${v}`).join(' ')}`);
        if (active.length < 2) {
          const why = turns.map((t, i) => (t.error ? `${active[i]?.seat.id ?? t.seat}: ${t.error.slice(0, 300)}` : '')).filter(Boolean).join('; ');
          stop = active.length ? `failed: only one seat still responding${why ? ` (${why})` : ''}` : `failed: no seat produced a usable reply${why ? ` (${why})` : ''}`;
          flow.vars.done = true; return;
        }
        const ids = active.map((s) => s.seat.id);
        if (roundSettings.stopOnConvergence && r >= Math.max(minRounds, 2) && ledger.converged(ids)) {
          stop = `converged in round ${r} (all verdicts agree, every claim agreed)`;
          flow.vars.done = true; return;
        }
        if (roundSettings.stopOnStall && r >= first + Number(roundSettings.stallAfter) - 1 && !ledger.movedIn(r)) {
          stop = `stalled in round ${r} (no stance changed and nothing conceded)`;
          flow.vars.done = true; return;
        }
        if (r === last) {
          const open = ledger.openClaims().length;
          stop = `discussion round limit reached: ${open} claim(s) to resolve`;
        }
        if (r >= last) flow.vars.done = true;
        r++;
      },
      'debate.resolve': resolve,
      'debate.report': () => {
        report = debateReport(ctx.store.meta, ledger, latest, names, stop);
      },
      'debate.chair': async () => {
        const chairSeat = nativeChair(ctx);
        if (chairSeat && Object.keys(latest).length && !stop.startsWith('failed')) {
          ctx.checkpoint();
          const chair = await ctx.engines.openSeat(chairSeat, 'chair', { schema: nativeSchema(ctx, 'chair'), system: chairRules(chairSeat, cwd), cwd, hideSkills: true });
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
      },
      'debate.finish': async (flow) => {
        const settings = templateOperationSettings(template, 'debate.finish', flow.step);
        if (settings.requireLedgerReview && !reviewed && !stop.startsWith('failed')) stop = 'failed: the template requires a completed final ledger review';
        if (settings.requireAddressedClaims && ledger.active().some((c) => ledger.status(c) === 'unaddressed')) stop = `failed: ${stop.startsWith('failed') ? stop.slice(8) + '; ' : ''}the template requires every active claim to be addressed`;
        if (!report || stop.startsWith('failed')) report = debateReport(ctx.store.meta, ledger, latest, names, stop);
        await ctx.finish(stop.startsWith('failed') ? 'failed' : 'completed', {
          stop,
          converged: stop.startsWith('converged'),
          rounds: ledger.rounds.length,
          verdicts: ledger.verdicts,
          final: ledger.resolution ?? ledger.rounds[ledger.rounds.length - 1] ?? null,
        }, sessions);
        report += '\n\n' + usageSection(ctx.store.meta);
        ctx.store.writeFile('report.md', report);
      },
    }, async (state) => {
      const settings = templateOperationSettings(template, 'debate.finish');
      const failed = state.stop!.status === 'failed' || (settings.requireLedgerReview && !reviewed) || (settings.requireAddressedClaims && ledger.active().some((c) => ledger.status(c) === 'unaddressed'));
      stop = failed ? `failed: debate workflow ended before its completion requirements were met (${state.stop!.reason})` : state.stop!.reason;
      await ctx.finish(failed ? 'failed' : 'completed', {
        stop, completion: state.stop!.status, converged: !failed && state.stop!.status === 'completed' && ledger.converged(seats.map((s) => s.id)), rounds: ledger.rounds.length, verdicts: ledger.verdicts,
        final: ledger.resolution ?? ledger.rounds[ledger.rounds.length - 1] ?? null,
      }, sessions);
      report = debateReport(ctx.store.meta, ledger, latest, names, stop) + '\n\n' + usageSection(ctx.store.meta);
      ctx.store.writeFile('report.md', report);
    });
    return workflow.stop ? ctx.store.readFile('report.md') ?? report : report;
  } catch (e) {
    await ctx.fail(e, sessions, { converged: false, rounds: ledger.rounds.length, verdicts: ledger.verdicts, final: ledger.resolution ?? ledger.rounds[ledger.rounds.length - 1] ?? null });
    if (!ctx.abortStatus) throw e;
    const report = debateReport(ctx.store.meta, ledger, latest, names, ctx.stopReason ?? 'stopped') + '\n\n' + usageSection(ctx.store.meta);
    ctx.store.writeFile('report.md', report);
    return report;
  }
}

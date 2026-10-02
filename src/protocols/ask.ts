/**
 * Ask: the same question to every seat in parallel, answers side by side; an optional chair
 * compares them. With one seat this is a fully traced single call.
 */
import type { SeatSession } from '../engine.ts';
import { chairBrief, chairRules, participantName, systemRules, type RulesContext } from '../prompts.ts';
import { usageSection } from '../render.ts';
import type { RunContext } from './common.ts';

export async function ask(ctx: RunContext, resume?: { sessions: SeatSession[]; round: number }): Promise<string> {
  const { seats, cwd, brief } = ctx.opts;
  const rules: RulesContext = { protocol: seats.length > 1 ? 'parallel consultation' : 'consultation', cwd, seats, anon: ctx.opts.anon, structured: false, workspace: ctx.opts.workspace };
  const names = Object.fromEntries(seats.map((s) => [s.id, participantName(s, false)]));
  const sessions: SeatSession[] = resume?.sessions ?? [];
  const round = resume?.round ?? 1;
  try {
    if (!resume) for (const seat of seats) sessions.push(await ctx.engines.openSeat(seat, 'participant', { system: systemRules(seat, rules), cwd, hideSkills: true }));
    ctx.recordSeats(sessions);
    ctx.log(`asking ${sessions.map((s) => s.seat.id).join(', ')}`);
    const message = resume ? brief : `<question>\n${brief.trim()}\n</question>`;
    const turns = await Promise.all(sessions.map((ss) => ctx.send(ss, message, { round, kind: 'answer' })));
    const out = [`# ${ctx.store.meta.title}`];
    turns.forEach((t, i) => {
      const s = sessions[i].seat;
      ctx.seatLine(s, t);
      ctx.store.appendTranscript(`[R${round}] ${names[s.id]}`, t.reply || `(error: ${t.error})`);
      out.push('', `## ${names[s.id]}`, '', t.reply?.trim() || `_(no answer: ${t.error})_`);
    });
    let report = out.join('\n');
    const answered = turns.filter((t) => t.reply && !t.error).length;
    if (ctx.opts.chair && answered > 1) {
      ctx.checkpoint();
      const chairSeat = { ...ctx.opts.chair, id: 'Z' };
      const chair = await ctx.engines.openSeat(chairSeat, 'chair', { system: chairRules(chairSeat, cwd), cwd, hideSkills: true });
      sessions.push(chair);
      ctx.log(`chair ${chairSeat.engine}:${chairSeat.model} comparing`);
      const t = await ctx.send(chair, chairBrief('parallel consultation', brief, `<answers>\n${report}\n</answers>`, Object.values(names).join(' and ')), { round: ctx.nextRound(), kind: 'synthesis' });
      ctx.seatLine(chairSeat, t);
      if (t.reply) report = `# ${ctx.store.meta.title}\n\n_Chair: ${chairSeat.engine}:${chairSeat.model}@${chairSeat.effort ?? 'default'}_\n\n${t.reply.trim()}\n\n---\n\n${report}`;
    }
    await ctx.finish(answered ? 'completed' : 'failed', { answered, of: sessions.length }, sessions);
    report += '\n\n' + usageSection(ctx.store.meta);
    ctx.store.writeFile('report.md', report);
    return report;
  } catch (e) {
    await ctx.fail(e, sessions);
    if (!ctx.abortStatus) throw e;
    return `# ${ctx.store.meta.title}\n\n${ctx.stopReason}\n`;
  }
}

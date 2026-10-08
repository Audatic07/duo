/**
 * Council (after Karpathy's llm-council): independent answers, then anonymized peer ranking in
 * fresh sessions (a reviewer never sees its own answer and cannot tell which model wrote what),
 * Borda aggregation, and a chair synthesis that keeps dissent.
 */
import { createHash } from 'node:crypto';
import type { SeatSession } from '../engine.ts';
import { chairBrief, chairRules, councilReview, participantName, systemRules, type RulesContext } from '../prompts.ts';
import { usageSection } from '../render.ts';
import { asRankingTurn, RANKING_SCHEMA, type RankingTurn } from '../schemas.ts';
import { nativeChair, nativeSchema, nativeSeats, runBuiltin } from '../templates/builtins.ts';
import type { RunContext } from './common.ts';

/** Deterministic per-reviewer shuffle, so position bias does not favour one seat everywhere. */
function shuffled<T>(items: T[], seed: string): T[] {
  return items
    .map((x, i) => ({ x, k: createHash('sha1').update(seed + i).digest('hex') }))
    .sort((a, b) => a.k.localeCompare(b.k))
    .map((o) => o.x);
}

export async function council(ctx: RunContext): Promise<string> {
  const { anon, cwd, brief } = ctx.opts;
  const seats = nativeSeats(ctx, 'participant');
  if (seats.length < 2) throw new Error('council needs at least two seats');
  ctx.minSeats = 2;
  const rules: RulesContext = { protocol: 'council', cwd, seats, anon: true, structured: false, workspace: ctx.opts.workspace };
  const names = Object.fromEntries(seats.map((s) => [s.id, participantName(s, false)]));
  const sessions: SeatSession[] = [];
  const answers: Record<string, string> = {};
  let answered: typeof seats = [];
  const mappings: Record<string, Record<string, string>> = {};
  const rankings: Record<string, RankingTurn> = {};
  let table: { seat: string; avg: number; votes: number; errs: number; }[] = [];
  let report = '';
  try {
    const workflow = await runBuiltin(ctx, 'council', {
      'council.answers': async () => {
        for (const seat of seats) sessions.push(await ctx.engines.openSeat(seat, 'participant', { schema: nativeSchema(ctx, 'participant'), system: systemRules(seat, rules), cwd, hideSkills: true }));
        ctx.recordSeats(sessions);

        ctx.log(`stage 1 (independent answers): ${seats.map((s) => s.id).join(', ')}`);
        const t1 = await Promise.all(sessions.map((ss) => ctx.send(ss, `<question>\n${brief.trim()}\n</question>\n\nAnswer independently and completely.`, { round: 1, kind: 'answer' })));
        t1.forEach((t, i) => {
          ctx.seatLine(sessions[i].seat, t);
          if (t.reply && !t.error) {
            answers[sessions[i].seat.id] = t.reply;
            ctx.store.appendTranscript(`[stage 1] ${names[sessions[i].seat.id]}`, t.reply);
          }
        });
        ctx.checkpoint();
        answered = seats.filter((s) => answers[s.id]);
        if (answered.length < 2) throw new Error(`fewer than two seats answered (${t1.filter((t) => t.error).map((t) => `${t.seat}: ${t.error!.slice(0, 200)}`).join('; ')})`);

      },
      'council.rank': async () => {
        ctx.log('stage 2 (anonymized peer ranking, own answer excluded)');
        const reviewerRules: RulesContext = { ...rules, protocol: 'council peer review', structured: true };
        const reviewers: SeatSession[] = [];
        for (const seat of nativeSeats(ctx, 'reviewer', answered)) reviewers.push(await ctx.engines.openSeat(seat, 'reviewer', { schema: nativeSchema(ctx, 'reviewer', RANKING_SCHEMA), system: systemRules(seat, reviewerRules), cwd, hideSkills: true }));
        sessions.push(...reviewers);
        const t2 = await Promise.all(
          reviewers.map((rv) => {
            const others = shuffled(answered.filter((s) => s.id !== rv.seat.id), rv.seat.id);
            const map: Record<string, string> = {};
            const responses = others.map((s, i) => ((map[`R${i + 1}`] = s.id), { label: `R${i + 1}`, text: answers[s.id] }));
            mappings[rv.seat.id] = map;
            return ctx.send(rv, councilReview(brief, responses), { round: 2, kind: 'rank' }, (t) => !!asRankingTurn(t.structured));
          }),
        );
        t2.forEach((t, i) => {
          const r = asRankingTurn(t.structured);
          ctx.seatLine(reviewers[i].seat, t, r ? `ranking ${r.ranking.join(' > ')}` : 'unusable reply');
          if (r) rankings[reviewers[i].seat.id] = r;
        });

      },
      'council.aggregate': async () => {
        // Borda: a reviewer ranking k responses gives (k-1-pos)/(k-1) to each; average per seat.
        const score: Record<string, number[]> = {};
        const critiques: Record<string, { by: string; strengths: string; weaknesses: string; }[]> = {};
        const errors: Record<string, { by: string; text: string; }[]> = {};
        for (const [reviewer, r] of Object.entries(rankings)) {
          const map = mappings[reviewer];
          const k = Object.keys(map).length;
          r.ranking.forEach((label, pos) => {
            const seat = map[label.trim()];
            if (seat) (score[seat] ??= []).push(k > 1 ? (k - 1 - pos) / (k - 1) : 1);
          });
          for (const c of r.critiques) {
            const seat = map[c.response.trim()];
            if (seat) (critiques[seat] ??= []).push({ by: reviewer, strengths: c.strengths, weaknesses: c.weaknesses });
          }
          for (const e of r.errors) {
            for (const [label, seat] of Object.entries(map)) if (new RegExp(`\\b${label}\\b`).test(e)) (errors[seat] ??= []).push({ by: reviewer, text: e });
          }
        }
        table = answered
          .map((s) => ({ seat: s.id, avg: score[s.id]?.length ? score[s.id].reduce((a, b) => a + b, 0) / score[s.id].length : NaN, votes: score[s.id]?.length ?? 0, errs: errors[s.id]?.length ?? 0 }))
          .sort((a, b) => (b.avg || 0) - (a.avg || 0));
        ctx.store.writeFile('council.json', JSON.stringify({ mappings, rankings, table }, null, 2));

        const out = [`# Council: ${ctx.store.meta.title}`, '', '## Peer ranking (anonymized, own answer excluded)', '', '| rank | seat | score (0–1) | reviews | errors flagged |', '|---|---|---|---|---|'];
        table.forEach((r, i) => out.push(`| ${i + 1} | ${names[r.seat]} | ${Number.isFinite(r.avg) ? r.avg.toFixed(2) : '—'} | ${r.votes} | ${r.errs} |`));
        for (const r of table) {
          out.push('', `## ${names[r.seat]}`, '', answers[r.seat].trim());
          for (const c of critiques[r.seat] ?? []) out.push('', `> **Review by ${names[c.by]}** — strengths: ${c.strengths} — weaknesses: ${c.weaknesses}`);
          for (const e of errors[r.seat] ?? []) out.push(`> ✗ error flagged by ${names[e.by]}: ${e.text}`);
        }
        report = out.join('\n');

      },
      'council.chair': async () => {
        const chairSeat = nativeChair(ctx);
        if (chairSeat) {
          ctx.checkpoint();
          const chair = await ctx.engines.openSeat(chairSeat, 'chair', { schema: nativeSchema(ctx, 'chair'), system: chairRules(chairSeat, cwd), cwd, hideSkills: true });
          sessions.push(chair);
          ctx.log(`stage 3: chair ${chairSeat.engine}:${chairSeat.model} synthesizing`);
          const t = await ctx.send(chair, chairBrief('council', brief, `<council_record>\n${report}\n</council_record>`, Object.values(names).join(', ')), { round: 3, kind: 'synthesis' });
          ctx.seatLine(chairSeat, t);
          if (t.reply) report = `# ${ctx.store.meta.title}\n\n_Chair: ${chairSeat.engine}:${chairSeat.model}@${chairSeat.effort ?? 'default'}_\n\n${t.reply.trim()}\n\n---\n\n${report}`;
        }
      },
      'council.finish': async () => {
        await ctx.finish('completed', { ranking: table.map((r) => ({ seat: r.seat, score: r.avg })) }, sessions);
        report += '\n\n' + usageSection(ctx.store.meta);
        ctx.store.writeFile('report.md', report);
      },
    });
    return workflow.stop ? ctx.store.readFile('report.md') ?? report : report;
  } catch (e) {
    await ctx.fail(e, sessions);
    if (!ctx.abortStatus) throw e;
    return `# ${ctx.store.meta.title}\n\n${ctx.stopReason}\n`;
  }
}

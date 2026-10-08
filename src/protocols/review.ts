/**
 * Review: independent findings, mechanical location checks, then cross-validation where every
 * reviewer confirms or rejects the others' findings. The merge keeps support counts so consensus
 * findings, contested ones and solo ones are visibly different.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { checkEvidence, type CitationResult } from '../citations.ts';
import type { SeatSession } from '../engine.ts';
import { chairBrief, chairRules, participantName, reviewCrossCheck, reviewOpening, systemRules, type RulesContext } from '../prompts.ts';
import { reviewReport, usageSection, type MergedFinding } from '../render.ts';
import { asReviewTurn, REVIEW_SCHEMA, type ReviewTurn } from '../schemas.ts';
import type { TurnRecord } from '../store.ts';
import { nativeChair, nativeSchema, nativeSeats, runBuiltin } from '../templates/builtins.ts';
import type { RunContext } from './common.ts';

export interface ReviewTarget {
  kind: 'uncommitted' | 'base' | 'commit' | 'files' | 'plan';
  value?: string;
  files?: string[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '--no-pager', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** The material under review, as text for the prompt (read-only git commands only). */
export function buildTarget(cwd: string, t: ReviewTarget, maxChars: number): { label: string; text: string; } {
  let label: string;
  let text: string;
  switch (t.kind) {
    case 'commit':
      label = `commit ${t.value}`;
      text = git(cwd, ['show', '--no-color', '--no-ext-diff', '--stat', '--patch', t.value!]);
      break;
    case 'base':
      label = `changes on this branch relative to ${t.value}`;
      text = git(cwd, ['diff', '--no-color', '--no-ext-diff', `${t.value}...HEAD`]);
      break;
    case 'files':
      label = `files: ${t.files!.join(', ')}`;
      text = t.files!.map((f) => `### ${f}\n\`\`\`\n${readFileSync(f, 'utf8')}\n\`\`\``).join('\n\n');
      break;
    case 'plan':
      label = `plan ${t.value}`;
      text = existsSync(t.value!) ? readFileSync(t.value!, 'utf8') : t.value!;
      break;
    default: {
      label = 'uncommitted changes (staged, unstaged, untracked)';
      let hasHead = true;
      try {
        git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
      } catch {
        hasHead = false;
      }
      text = hasHead ? git(cwd, ['diff', '--no-color', '--no-ext-diff', 'HEAD']) : git(cwd, ['diff', '--no-color', '--cached']);
      const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
      if (untracked.length) text += `\n# Untracked files (read them directly):\n${untracked.map((u) => `#   ${u}`).join('\n')}\n`;
    }
  }
  if (!text.trim()) throw new Error(`nothing to review (${label} is empty)`);
  if (text.length > maxChars) text = text.slice(0, maxChars) + `\n\n[truncated at ${maxChars} chars; read the remaining files directly]\n`;
  const fence = t.kind === 'files' || t.kind === 'plan' ? '' : 'diff';
  return { label, text: fence ? `${label}\n\`\`\`${fence}\n${text}\n\`\`\`` : `${label}\n\n${text}` };
}

function locationCheck(f: ReviewTurn['findings'][number], cwd: string): CitationResult {
  return checkEvidence({ type: 'file', ref: f.location, quote: f.quote }, cwd);
}

export async function review(ctx: RunContext, target: ReviewTarget, focus?: string): Promise<string> {
  const { anon, cwd } = ctx.opts;
  const seats = nativeSeats(ctx, 'participant');
  const rules: RulesContext = { protocol: 'code review', cwd, seats, anon, structured: true };
  const sessions: SeatSession[] = [];
  let text: string;
  try {
    ({ text } = buildTarget(cwd, target, ctx.cfg.maxDiffChars));
    for (const seat of seats) sessions.push(await ctx.engines.openSeat(seat, 'participant', { schema: nativeSchema(ctx, 'participant', REVIEW_SCHEMA), system: systemRules(seat, rules), cwd, hideSkills: true }));
  } catch (e) {
    await ctx.fail(e, sessions);
    throw e;
  }
  ctx.recordSeats(sessions);
  const names = Object.fromEntries(seats.map((s) => [s.id, participantName(s, false)]));
  const valid = (t: TurnRecord) => !!asReviewTurn(t.structured);
  const latest: Record<string, ReviewTurn> = {};
  const r1: Record<string, ReviewTurn> = {};
  const checks: Record<string, CitationResult> = {};
  const merged: MergedFinding[] = [];
  let report = '';
  let crossCheck = false;
  try {
    const workflow = await runBuiltin(ctx, 'review', {
      'review.independent': async () => {
        ctx.checkpoint();
        ctx.log(`round 1 (independent): ${seats.map((s) => s.id).join(', ')}`);
        const t1 = await Promise.all(sessions.map((ss) => ctx.send(ss, reviewOpening(text, focus), { round: 1, kind: 'review' }, valid)));
        t1.forEach((t, i) => {
          const rv = asReviewTurn(t.structured);
          ctx.seatLine(sessions[i].seat, t, rv ? `${rv.findings.length} findings · ${rv.verdict}` : 'unusable reply');
          if (!rv) return;
          latest[sessions[i].seat.id] = r1[sessions[i].seat.id] = rv;
          ctx.store.appendTranscript(`[R1] ${names[sessions[i].seat.id]} — review`, renderReview(rv, sessions[i].seat.id));
        });
        for (const [seat, rv] of Object.entries(r1)) for (const f of rv.findings) checks[`${seat}:${f.id}`] = locationCheck(f, cwd);

      },
      'review.crosscheck': async () => {
        ctx.checkpoint();
        const live = sessions.filter((s) => r1[s.seat.id]);
        crossCheck = live.length >= 2 && ctx.opts.rounds >= 2;
        if (crossCheck) {
          ctx.log(`round 2 (cross-validation): ${live.map((s) => s.seat.id).join(', ')}`);
          const t2 = await Promise.all(live.map((ss) => ctx.send(ss, reviewCrossCheck(ss.seat, seats.filter((p) => p.id !== ss.seat.id), r1, checks, anon), { round: 2, kind: 'crosscheck' }, valid)));
          t2.forEach((t, i) => {
            const rv = asReviewTurn(t.structured);
            ctx.seatLine(live[i].seat, t, rv ? `${rv.findings.length} findings · ${rv.assessments.length} assessments · ${rv.verdict}` : 'unusable reply');
            if (!rv) return;
            latest[live[i].seat.id] = rv;
            ctx.store.appendTranscript(`[R2] ${names[live[i].seat.id]} — cross-validation`, renderReview(rv, live[i].seat.id));
          });
        }

      },
      'review.merge': async () => {
        // Merge: final finding lists, with every other reviewer's assessment attached.
        for (const [owner, rv] of Object.entries(latest)) {
          for (const f of rv.findings) {
            const gid = `${owner}:${f.id}`;
            const m: MergedFinding = { gid, owner, f, location: checks[gid] ?? locationCheck(f, cwd), confirms: [], rejects: [], unsure: [], status: 'solo' };
            for (const [seat, other] of Object.entries(latest)) {
              if (seat === owner) continue;
              const a = other.assessments.find((x) => x.finding.replace(/\s+/g, '') === gid);
              if (!a) continue;
              (a.stance === 'confirm' ? m.confirms : a.stance === 'reject' ? m.rejects : m.unsure).push({ seat, reason: a.reason });
            }
            const reviewers = Object.keys(latest).length - 1;
            const newInR2 = crossCheck && !r1[owner]?.findings.some((x) => x.id === f.id);
            m.status = reviewers === 0 ? 'solo'
              : newInR2 ? 'unreviewed'
                : m.rejects.length && !m.confirms.length ? 'rejected'
                  : m.rejects.length ? 'contested'
                    : m.confirms.length === reviewers ? 'consensus'
                      : 'unreviewed';
            merged.push(m);
          }
        }
        ctx.store.writeFile('findings.json', JSON.stringify(merged, null, 2));
        report = reviewReport(ctx.store.meta, merged, latest, names);

      },
      'review.chair': async () => {
        const chairSeat = nativeChair(ctx);
        if (chairSeat && merged.length) {
          ctx.checkpoint();
          const chair = await ctx.engines.openSeat(chairSeat, 'chair', { schema: nativeSchema(ctx, 'chair'), system: chairRules(chairSeat, cwd), cwd, hideSkills: true });
          sessions.push(chair);
          ctx.log(`chair ${chairSeat.engine}:${chairSeat.model} synthesizing`);
          const t = await ctx.send(chair, chairBrief('code review', `Review of ${text.split('\n')[0]}${focus ? `; focus: ${focus}` : ''}`, `<review_record>\n${report}\n</review_record>`, Object.values(names).join(' and ')), { round: ctx.nextRound(), kind: 'synthesis' });
          ctx.seatLine(chairSeat, t);
          if (t.reply) report = `# ${ctx.store.meta.title}\n\n_Chair: ${chairSeat.engine}:${chairSeat.model}@${chairSeat.effort ?? 'default'}_\n\n${t.reply.trim()}\n\n---\n\n${report}`;
        }
      },
      'review.finish': async () => {
        const counts = merged.reduce<Record<string, number>>((a, m) => ((a[m.status] = (a[m.status] ?? 0) + 1), a), {});
        await ctx.finish(Object.keys(latest).length ? 'completed' : 'failed', { findings: merged.length, ...counts, verdicts: Object.fromEntries(Object.entries(latest).map(([s, r]) => [s, r.verdict])) }, sessions);
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

function renderReview(rv: ReviewTurn, seat: string): string {
  const out = [`**Verdict:** ${rv.verdict} — ${rv.summary}`];
  for (const f of rv.findings) out.push('', `- \`${seat}:${f.id}\` **[${f.severity}] ${f.title}** at \`${f.location}\``, `  - problem: ${f.problem}`, `  - scenario: ${f.scenario}`, `  - fix: ${f.fix}`);
  if (rv.assessments.length) out.push('', '**Assessments**', ...rv.assessments.map((a) => `- \`${a.finding}\` ${a.stance}: ${a.reason}`));
  return out.join('\n');
}

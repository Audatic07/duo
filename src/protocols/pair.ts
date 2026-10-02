/**
 * Pair: one seat writes the code, the other reviews it, in cycles, until both agree the request is
 * done.
 *
 *   cycle n   the writer works in an isolated workspace (a git worktree, or in place with a
 *             snapshot) and reports what it did; duo optionally runs the user's check command; the
 *             reviewer verifies the diff against the request and approves or files findings.
 *   finish    converged when the writer reports done, the reviewer approves with no P0/P1 finding
 *             open, and the check (if any) passes. It also stops when the writer is blocked, when
 *             the two deadlock on a finding, or at the cycle cap.
 *   result    the workspace stays until the user applies it to their folder, keeps the branch, or
 *             discards it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { SeatAccess, SeatSession } from '../engine.ts';
import { pairReview, pairRevise, pairTask, participantName, reviewerRules, writerRules, type CheckResult, type PairRulesContext } from '../prompts.ts';
import { usageSection } from '../render.ts';
import { asPairReviewTurn, asPairWriterTurn, PAIR_REVIEW_SCHEMA, PAIR_WRITER_SCHEMA, type PairReviewTurn, type PairWriterTurn } from '../schemas.ts';
import { parseSeat, type Seat } from '../seats.ts';
import { RunStore, type TurnRecord } from '../store.ts';
import { prepareWorkspace, runCheck, workspaceDiff, type Workspace } from '../worktree.ts';
import { RunContext, type RunOptions } from './common.ts';
import type { ContinueOptions } from './continue.ts';

export type WriterAccess = 'sandboxed' | 'sandboxed-network' | 'full';

export interface PairSettings {
  isolation: 'worktree' | 'in-place';
  writerAccess: WriterAccess;
  /** A command duo runs after each writer turn; it must pass before the run can finish. */
  check?: string;
}

export interface TrackedFinding {
  id: string;
  severity: string;
  title: string;
  location: string;
  problem: string;
  fix: string;
  opened: number;
  status: 'open' | 'resolved';
  disputes: number;
  history: { cycle: number; event: string; note?: string }[];
}

export interface PairCycle {
  cycle: number;
  writer?: { n: number; status: string; summary: string; changes: number; tests: PairWriterTurn['tests']; error?: string };
  check?: { exitCode: number | null; timedOut: boolean; durationMs: number };
  diff?: { files: number; stat: string };
  review?: { n: number; verdict: string; summary: string; open: number; blocking: number; requirements: PairReviewTurn['requirements']; error?: string };
}

export interface PairState {
  settings: PairSettings;
  writer: string;
  reviewer: string;
  cycles: PairCycle[];
  findings: TrackedFinding[];
  checks: (CheckResult & { cycle: number })[];
}

const BLOCKING = new Set(['P0', 'P1']);

export function writerSeatAccess(a: WriterAccess): SeatAccess {
  return {
    kind: 'write',
    codexSandbox: a === 'full' ? 'danger-full-access' : 'workspace-write',
    network: a === 'sandboxed-network',
    claudeMode: a === 'full' ? 'bypassPermissions' : 'acceptEdits',
    claudeSandbox: a !== 'full',
  };
}

class Findings {
  readonly all = new Map<string, TrackedFinding>();

  constructor(prev?: TrackedFinding[]) {
    for (const f of prev ?? []) this.all.set(f.id, f);
  }

  open(): TrackedFinding[] {
    return [...this.all.values()].filter((f) => f.status === 'open');
  }

  blocking(): TrackedFinding[] {
    return this.open().filter((f) => BLOCKING.has(f.severity));
  }

  writerResponded(cycle: number, w: PairWriterTurn): void {
    for (const r of w.responses) {
      const f = this.all.get(r.finding.trim());
      if (!f) continue;
      f.history.push({ cycle, event: r.action, note: r.note });
      if (r.action === 'disputed') f.disputes++;
    }
  }

  reviewed(cycle: number, rv: PairReviewTurn): void {
    const listed = new Set<string>();
    for (const x of rv.findings) {
      const id = x.id.trim();
      listed.add(id);
      const f = this.all.get(id);
      if (!f) {
        this.all.set(id, { id, severity: x.severity, title: x.title, location: x.location, problem: x.problem, fix: x.fix, opened: cycle, status: 'open', disputes: 0, history: [{ cycle, event: 'opened' }] });
        continue;
      }
      const wasResolved = f.status === 'resolved';
      Object.assign(f, { severity: x.severity, title: x.title, location: x.location, problem: x.problem, fix: x.fix, status: 'open' });
      f.history.push({ cycle, event: wasResolved ? 'reopened' : 'still open' });
    }
    const resolved = new Set(rv.resolved.map((r) => r.trim()));
    for (const f of this.all.values()) {
      if (f.status !== 'open' || listed.has(f.id)) continue;
      // Not listed any more: resolved, whether or not the reviewer said so explicitly.
      f.status = 'resolved';
      f.history.push({ cycle, event: resolved.has(f.id) ? 'resolved' : 'dropped' });
    }
  }

  /** A blocking finding the writer disputed twice and the reviewer still keeps open. */
  deadlocked(): TrackedFinding | undefined {
    return this.blocking().find((f) => f.disputes >= 2);
  }
}

export async function pair(ctx: RunContext, settings: PairSettings, resume?: { sessions: [SeatSession, SeatSession]; workspace: Workspace; state: PairState; note?: string; startCycle: number }): Promise<string> {
  const { seats, rounds: maxNew, anon, brief } = ctx.opts;
  if (seats.length !== 2) throw new Error('pair needs exactly two seats: the writer, then the reviewer');
  const [writerSeat, reviewerSeat] = seats;
  ctx.minSeats = 2;
  const names = { [writerSeat.id]: participantName(writerSeat, false), [reviewerSeat.id]: participantName(reviewerSeat, false) };
  const sessions: SeatSession[] = resume ? [...resume.sessions] : [];
  const state: PairState = resume?.state ?? { settings, writer: writerSeat.id, reviewer: reviewerSeat.id, cycles: [], findings: [], checks: [] };
  const findings = new Findings(state.findings);
  let ws: Workspace | undefined = resume?.workspace;
  const save = () => {
    state.findings = [...findings.all.values()];
    ctx.store.writeFile('pair.json', JSON.stringify(state, null, 2));
    if (ws) {
      ctx.store.meta.workspace = { ...ws };
      ctx.store.save();
    }
  };
  const first = resume?.startCycle ?? 1;
  const last = first + maxNew - 1;
  let stop = `NOT converged after ${last} cycle(s)`;
  let converged = false;
  let lastReview: PairReviewTurn | undefined;
  let lastReviewRaw: string | undefined;
  let lastCheck: CheckResult | undefined;

  try {
    if (!ws) {
      ctx.log(`preparing the workspace (${settings.isolation})`);
      ws = prepareWorkspace(ctx.opts.cwd, ctx.store.meta.id, ctx.store.meta.title, settings.isolation);
      ctx.log(ws.mode === 'worktree' ? `worktree ${ws.path} on branch ${ws.branch} (from ${ws.base.slice(0, 10)})` : `working in place in ${ws.cwd} (snapshot ${ws.base.slice(0, 10)})`);
      save();
    }
    const rulesCtx: PairRulesContext = { cwd: ws.cwd, writer: writerSeat, reviewer: reviewerSeat, anon, check: settings.check };
    if (!resume) {
      sessions.push(await ctx.engines.openSeat(writerSeat, 'writer', { schema: PAIR_WRITER_SCHEMA, system: writerRules(rulesCtx), cwd: ws.cwd, access: writerSeatAccess(settings.writerAccess) }));
      sessions.push(await ctx.engines.openSeat(reviewerSeat, 'participant', { schema: PAIR_REVIEW_SCHEMA, system: reviewerRules(rulesCtx), cwd: ws.cwd, hideSkills: true }));
    }
    ctx.recordSeats(sessions);
    const [writer, reviewer] = sessions;
    const writerValid = (t: TurnRecord) => (asPairWriterTurn(t.structured) ? undefined : t.parseError ?? 'the reply did not match the report format');
    const reviewValid = (t: TurnRecord) => (asPairReviewTurn(t.structured) ? undefined : t.parseError ?? 'the reply did not match the review format');

    if (resume) {
      const prevCycle = state.cycles[state.cycles.length - 1];
      lastReview = prevCycle?.review ? { verdict: prevCycle.review.verdict as PairReviewTurn['verdict'], summary: prevCycle.review.summary, requirements: prevCycle.review.requirements, findings: findings.open(), resolved: [], confidence: NaN } : undefined;
      lastCheck = state.checks[state.checks.length - 1];
    }

    for (let cycle = first; cycle <= last; cycle++) {
      ctx.checkpoint();
      const c: PairCycle = { cycle };
      state.cycles.push(c);
      save();

      // ── writer ──
      ctx.log(`cycle ${cycle}: ${writerSeat.id} writes`);
      const wmsg = cycle === 1
        ? pairTask(brief, settings.check)
        : pairRevise({ cycle, maxCycles: last, review: lastReview, rawReview: lastReviewRaw, check: lastCheck && lastCheck.exitCode !== 0 ? lastCheck : undefined, note: cycle === first ? resume?.note : undefined });
      const wt = await ctx.send(writer, wmsg, { round: cycle, kind: cycle === 1 ? 'implement' : 'revise' }, writerValid);
      ctx.checkpoint();
      const w = asPairWriterTurn(wt.structured);
      c.writer = { n: wt.n, status: w?.status ?? (wt.error ? 'error' : 'unknown'), summary: w?.summary ?? wt.reply.slice(0, 4000), changes: w?.changes.length ?? 0, tests: w?.tests ?? [], error: wt.error };
      ctx.seatLine(writerSeat, wt, w ? `${w.status} · ${w.changes.length} files · ${w.tests.length} checks${w.responses.length ? ` · ${w.responses.length} responses` : ''}` : 'no usable report');
      ctx.store.appendTranscript(`[cycle ${cycle}] ${names[writerSeat.id]} — ${wt.kind}`, w ? renderWriter(w) : wt.reply || `(error: ${wt.error})`);
      if (w) findings.writerResponded(cycle, w);
      if (!w && wt.error) {
        stop = `failed: the writer (${writerSeat.engine}:${writerSeat.model}) failed: ${wt.error.slice(0, 400)}`;
        break;
      }
      if (w?.status === 'blocked') {
        stop = `blocked: ${w.blocker ?? 'the writer could not continue'}`;
        save();
        break;
      }

      // ── check and diff ──
      if (settings.check) {
        ctx.log(`cycle ${cycle}: running \`${settings.check}\``);
        lastCheck = await runCheck(settings.check, ws.cwd);
        state.checks.push({ ...lastCheck, cycle });
        c.check = { exitCode: lastCheck.exitCode, timedOut: lastCheck.timedOut, durationMs: lastCheck.durationMs };
        ctx.log(`check ${lastCheck.timedOut ? 'timed out' : lastCheck.exitCode === 0 ? 'passed' : `failed (exit ${lastCheck.exitCode})`} in ${(lastCheck.durationMs / 1000).toFixed(0)}s`);
        ctx.checkpoint();
      }
      const d = workspaceDiff(ws, Math.floor(ctx.cfg.maxDiffChars / 2));
      c.diff = { files: d.files.length, stat: d.stat };
      save();

      // ── reviewer ──
      ctx.log(`cycle ${cycle}: ${reviewerSeat.id} reviews ${d.files.length} changed file(s)`);
      const rmsg = pairReview({ request: brief, cycle, maxCycles: last, report: w, rawReply: wt.reply, stat: d.stat, diff: d.diff, check: lastCheck, open: findings.open() });
      const rt = await ctx.send(reviewer, rmsg, { round: cycle, kind: 'review' }, reviewValid);
      ctx.checkpoint();
      const rv = asPairReviewTurn(rt.structured);
      lastReview = rv;
      lastReviewRaw = rt.reply;
      if (rv) findings.reviewed(cycle, rv);
      const blocking = findings.blocking().length;
      c.review = { n: rt.n, verdict: rv?.verdict ?? (rt.error ? 'error' : 'unknown'), summary: rv?.summary ?? rt.reply.slice(0, 4000), open: findings.open().length, blocking, requirements: rv?.requirements ?? [], error: rt.error };
      ctx.seatLine(reviewerSeat, rt, rv ? `${rv.verdict} · ${findings.open().length} open (${blocking} blocking)` : 'no usable review');
      ctx.store.appendTranscript(`[cycle ${cycle}] ${names[reviewerSeat.id]} — review`, rv ? renderReview(rv) : rt.reply || `(error: ${rt.error})`);
      ctx.emit({ kind: 'round', round: cycle, stats: { cycle, verdict: c.review.verdict, open: c.review.open, blocking, files: d.files.length, check: c.check } });
      save();
      if (!rv && rt.error) {
        stop = `failed: the reviewer (${reviewerSeat.engine}:${reviewerSeat.model}) failed: ${rt.error.slice(0, 400)}`;
        break;
      }

      const checkOk = !settings.check || (lastCheck?.exitCode === 0 && !lastCheck.timedOut);
      if (rv?.verdict === 'approve' && blocking === 0 && checkOk && w?.status === 'done') {
        converged = true;
        stop = `converged in cycle ${cycle}: the writer reports done, the reviewer approved${settings.check ? ', and the check passed' : ''}`;
        break;
      }
      const dead = findings.deadlocked();
      if (dead) {
        stop = `deadlocked in cycle ${cycle}: the writer disputes ${dead.id} ("${dead.title}") and the reviewer keeps it open — your call`;
        break;
      }
      if (cycle === last) {
        const why = [blocking ? `${blocking} blocking finding(s) open` : '', !checkOk ? 'the check is failing' : '', rv?.verdict === 'approve' ? '' : 'the reviewer has not approved'].filter(Boolean).join(', ');
        stop = `NOT converged after ${cycle} cycle(s)${why ? `: ${why}` : ''}`;
      }
    }

    save();
    let report = pairReport(ctx, state, ws, stop, names);
    await ctx.finish(stop.startsWith('failed') ? 'failed' : 'completed', {
      stop,
      converged,
      cycles: state.cycles.length,
      open: findings.open().length,
      blocking: findings.blocking().length,
      workspace: ws.mode,
    }, sessions);
    report += '\n\n' + usageSection(ctx.store.meta);
    ctx.store.writeFile('report.md', report);
    return report;
  } catch (e) {
    save();
    await ctx.fail(e, sessions, { converged: false, cycles: state.cycles.length, open: findings.open().length });
    if (!ctx.abortStatus || !ws) throw e;
    const report = pairReport(ctx, state, ws, ctx.stopReason ?? 'stopped', names) + '\n\n' + usageSection(ctx.store.meta);
    ctx.store.writeFile('report.md', report);
    return report;
  }
}

function renderWriter(w: PairWriterTurn): string {
  const out = [`**Status:** ${w.status}${w.blocker ? ` — blocked: ${w.blocker}` : ''}`, '', w.summary.trim()];
  if (w.changes.length) out.push('', '**Changes**', ...w.changes.map((c) => `- \`${c.path}\` ${c.description}`));
  if (w.tests.length) out.push('', '**Checks**', ...w.tests.map((t) => `- \`${t.command}\` → ${t.outcome}${t.details ? ` — ${t.details}` : ''}`));
  if (w.responses.length) out.push('', '**Responses to findings**', ...w.responses.map((r) => `- \`${r.finding}\` ${r.action}: ${r.note}`));
  return out.join('\n');
}

function renderReview(rv: PairReviewTurn): string {
  const out = [`**Verdict:** ${rv.verdict} — ${rv.summary}`];
  if (rv.requirements.length) out.push('', '**Requirements**', ...rv.requirements.map((r) => `- ${r.met === 'yes' ? '✓' : r.met === 'partly' ? '◐' : '✗'} ${r.requirement}${r.evidence ? ` — ${r.evidence}` : ''}`));
  if (rv.findings.length) out.push('', '**Findings**', ...rv.findings.map((f) => `- \`${f.id}\` **[${f.severity}] ${f.title}** at \`${f.location}\`\n  - problem: ${f.problem}\n  - fix: ${f.fix}`));
  if (rv.resolved.length) out.push('', `**Resolved:** ${rv.resolved.map((r) => `\`${r}\``).join(', ')}`);
  return out.join('\n');
}

function pairReport(ctx: RunContext, state: PairState, ws: Workspace, stop: string, names: Record<string, string>): string {
  const lastWriter = [...state.cycles].reverse().find((c) => c.writer?.summary)?.writer;
  const lastReview = [...state.cycles].reverse().find((c) => c.review?.summary)?.review;
  const out = [
    `# Pair: ${ctx.store.meta.title}`,
    '',
    `**Outcome:** ${stop}`,
    '',
    `**Writer:** ${names[state.writer]} · **Reviewer:** ${names[state.reviewer]}`,
    '',
    ws.mode === 'worktree'
      ? `**Workspace:** git worktree \`${ws.path}\` on branch \`${ws.branch}\` (from \`${ws.base.slice(0, 10)}\`). Apply it to your folder, keep the branch, or discard it from the run view (or \`duo apply ${ctx.store.meta.id}\`).`
      : `**Workspace:** in place in \`${ws.cwd}\`; duo's snapshot \`${ws.base.slice(0, 10)}\` is the baseline for the diff.`,
  ];
  if (lastWriter) out.push('', '## What the writer did', '', lastWriter.summary.trim());
  if (lastReview) {
    out.push('', `## Reviewer's verdict: ${lastReview.verdict}`, '', lastReview.summary.trim());
    if (lastReview.requirements.length) out.push('', '| requirement | met | evidence |', '|---|---|---|', ...lastReview.requirements.map((r) => `| ${r.requirement.replace(/\|/g, '\\|')} | ${r.met} | ${r.evidence.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`));
  }
  const fs = state.findings;
  if (fs.length) {
    out.push('', '## Findings', '', '| id | severity | status | opened | history | finding |', '|---|---|---|---|---|---|');
    for (const f of [...fs].sort((a, b) => (a.status === b.status ? a.severity.localeCompare(b.severity) : a.status === 'open' ? -1 : 1))) {
      out.push(`| \`${f.id}\` | ${f.severity} | **${f.status}** | ${f.opened} | ${f.history.map((h) => `${h.cycle}:${h.event}`).join(', ')} | ${f.title.replace(/\|/g, '\\|')} — \`${f.location}\` |`);
    }
  }
  out.push('', '## Cycles', '', '| cycle | writer | files | check | review | open (blocking) |', '|---|---|---|---|---|---|');
  for (const c of state.cycles) {
    const chk = c.check ? (c.check.timedOut ? 'timed out' : c.check.exitCode === 0 ? 'passed' : `failed (${c.check.exitCode})`) : '—';
    out.push(`| ${c.cycle} | ${c.writer?.status ?? '—'} | ${c.diff?.files ?? '—'} | ${chk} | ${c.review?.verdict ?? '—'} | ${c.review ? `${c.review.open} (${c.review.blocking})` : '—'} |`);
  }
  const lastDiff = [...state.cycles].reverse().find((c) => c.diff)?.diff;
  if (lastDiff?.stat) out.push('', '## Changed files', '', '```', lastDiff.stat, '```');
  return out.join('\n');
}

/** Run more cycles on the same workspace and the same two sessions, with a note from the user. */
export async function continuePair(cfg: Config, prev: RunStore, note: string, o: ContinueOptions): Promise<string> {
  const pm = prev.meta;
  const ws = pm.workspace;
  if (!ws || ws.state !== 'active') throw new Error(`the workspace of ${pm.id} is ${ws ? (ws.state === 'moved' ? `continued in ${ws.movedTo}` : ws.state) : 'missing'}; ${ws?.state === 'moved' ? 'continue that run instead' : 'start a new pair run instead'}`);
  if (ws.mode === 'worktree' && !existsSync(ws.path)) throw new Error(`the worktree ${ws.path} no longer exists`);
  const statePath = join(prev.dir, 'pair.json');
  if (!existsSync(statePath)) throw new Error(`${pm.id} has no pair state to continue from`);
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as PairState;
  const recs = [pm.seats.find((s) => s.role === 'writer'), pm.seats.find((s) => s.role === 'participant')];
  if (!recs[0] || !recs[1]) throw new Error(`${pm.id} is missing its writer or reviewer seat`);
  const seats: Seat[] = recs.map((r) => parseSeat(r!.spec, r!.id, cfg.defaults, { safe: o.safe }));
  const opts: RunOptions = {
    protocol: 'pair',
    title: `${pm.title.replace(/ \(continued\)$/, '')} (continued)`,
    brief: pm.prompt,
    cwd: pm.cwd,
    seats,
    rounds: o.rounds,
    minRounds: 1,
    anon: !!pm.options.anon,
    quiet: o.quiet,
    extra: { continuedFrom: pm.id, note, pair: state.settings },
    sink: o.sink,
  };
  const ctx = RunContext.create(cfg, opts, prev);
  o.onContext?.(ctx);
  // The workspace now belongs to the new run.
  prev.meta.workspace = { ...ws, state: 'moved', movedTo: ctx.store.meta.id };
  prev.save();
  const sessions: SeatSession[] = [];
  try {
    const rulesCtx: PairRulesContext = { cwd: ws.cwd, writer: seats[0], reviewer: seats[1], anon: opts.anon, check: state.settings.check };
    sessions.push(await ctx.engines.openSeat(seats[0], 'writer', { schema: PAIR_WRITER_SCHEMA, system: writerRules(rulesCtx), cwd: ws.cwd, access: writerSeatAccess(state.settings.writerAccess), resume: recs[0]! }));
    sessions.push(await ctx.engines.openSeat(seats[1], 'participant', { schema: PAIR_REVIEW_SCHEMA, system: reviewerRules(rulesCtx), cwd: ws.cwd, hideSkills: true, resume: recs[1]! }));
  } catch (e) {
    await ctx.fail(e, sessions);
    throw e;
  }
  const startCycle = Math.max(0, ...state.cycles.map((c) => c.cycle)) + 1;
  return pair(ctx, state.settings, { sessions: sessions as [SeatSession, SeatSession], workspace: { ...ws, state: 'active', movedTo: undefined }, state: { ...state, cycles: [...state.cycles] }, note: note || undefined, startCycle });
}

/** Read a pair run's settings out of its options (GUI and CLI both store them there). */
export function pairSettingsOf(options: Record<string, unknown>): PairSettings {
  const p = (options.pair ?? {}) as Partial<PairSettings>;
  return { isolation: p.isolation === 'in-place' ? 'in-place' : 'worktree', writerAccess: p.writerAccess === 'full' || p.writerAccess === 'sandboxed-network' ? p.writerAccess : 'sandboxed', check: p.check?.trim() || undefined };
}

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { SeatSession, SendOpts } from '../src/engine.ts';
import type { DebateTurn } from '../src/schemas.ts';
import type { TurnRecord } from '../src/store.ts';
import type { CoordinationTemplate } from '../src/templates/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'duo-debate-'));
Object.assign(process.env, {
  DUO_HOME: join(tmp, 'home'), DUO_CONFIG: join(tmp, 'config.json'),
  CODEX_HOME: join(tmp, 'codex'), CLAUDE_CONFIG_DIR: join(tmp, 'claude'),
  DUO_CODEX_BIN: join(import.meta.dirname, 'fakes/codex.mjs'),
  DUO_CLAUDE_BIN: join(import.meta.dirname, 'fakes/claude.mjs'),
});
const { RunContext } = await import('../src/protocols/common.ts');
const { loadConfig } = await import('../src/config.ts');
const { parseSeat, formatSeat } = await import('../src/seats.ts');
const { debate } = await import('../src/protocols/debate.ts');
const { continueRun } = await import('../src/protocols/continue.ts');
const { builtinTemplate } = await import('../src/templates/builtins.ts');
const cfg = loadConfig();
after(() => rmSync(tmp, { recursive: true, force: true }));

type Reply = (seat: string, o: SendOpts, prompt: string) => DebateTurn | undefined;
function attach(ctx: ReturnType<typeof RunContext.create>, reply: Reply) {
  const calls: { seat: string; prompt: string; kind: string; round: number }[] = [];
  ctx.engines.openSeat = async (seat, role, options) => ({
    seat, record: { id: seat.id, role, spec: formatSeat(seat), engine: seat.engine, model: seat.model, clawSession: seat.id,
      codexThreadId: options.resume?.codexThreadId ?? (seat.engine === 'codex' ? `thread-${seat.id}` : undefined),
      claudeSessionId: options.resume?.claudeSessionId ?? (seat.engine === 'claude' ? `session-${seat.id}` : undefined) },
  } as SeatSession);
  ctx.engines.send = async (ss, prompt, o) => {
    calls.push({ seat: ss.seat.id, prompt, kind: o.kind, round: o.round });
    const structured = reply(ss.seat.id, o, prompt);
    const n = ctx.store.allocTurn();
    const t: TurnRecord = {
      n, seat: ss.seat.id, round: o.round, kind: o.kind, dir: ctx.store.turnDir(n, ss.seat.id, o.round, o.kind),
      startedAt: new Date().toISOString(), durationMs: 1, reply: structured ? JSON.stringify(structured) : '', structured,
      verdict: structured?.verdict, thinking: [], tools: [], usage: { input: 0, cached: 0, output: 0, reasoning: 0 },
      templateStep: o.templateStep,
    };
    ctx.store.writeTurn(t, prompt, '');
    return t;
  };
  return calls;
}
function context(rounds: number, n = 2, template?: CoordinationTemplate) {
  const seats = Array.from({ length: n }, (_, i) => parseSeat(i % 2 ? 'claude:sonnet@low' : 'codex:gpt-6-sol@low', String.fromCharCode(65 + i), cfg.defaults));
  return RunContext.create(cfg, { protocol: 'debate', title: 'Final ledger review', brief: 'Resolve the claims', cwd: tmp,
    seats, rounds, minRounds: 1, quiet: true, anon: true, workspace: false, extra: template ? { template } : {} });
}
function turn(seat: string, round: number): DebateTurn {
  return { answer: `${seat} position in round ${round}`, claims: ['c1', 'c2'].map((id) => ({ id, text: `${seat} ${id}`, kind: 'judgment', confidence: 0.8, evidence: [] })),
    stances: [], verdict: round === 1 ? 'n/a' : 'agree', concessions: [], open_points: [], assumptions: [], confidence: 0.8 };
}
function ledger(ctx: ReturnType<typeof RunContext.create>) { return JSON.parse(ctx.store.readFile('ledger.json')!); }
function finalTurn(ctx: ReturnType<typeof RunContext.create>, seat: string, stance = 'agree'): DebateTurn {
  return { ...turn(seat, 0), answer: 'A proposed revision that must not replace the frozen position', claims: [], verdict: stance,
    stances: ledger(ctx).claims.filter((c: any) => !c.withdrawn && c.owner !== seat).map((c: any) => ({ claim: c.gid, stance, reason: `Final decision on ${c.text}` })) };
}

test('native participant selectors cannot produce a successful debate with fewer than two participants', async () => {
  for (const count of [0, 1]) {
    const template = builtinTemplate('debate');
    template.assignments = count ? [{ role: 'participant', select: { count } }] : [{ role: 'chair', select: { ids: ['A'] } }];
    const ctx = context(1, 2, template);
    const calls = attach(ctx, (seat, o) => turn(seat, o.round));
    await assert.rejects(debate(ctx), /at least two assigned participants/);
    assert.equal(ctx.store.meta.status, 'failed');
    assert.equal(calls.length, 0);
  }
});

test('a one-round debate reviews all final claims from every participant on the same frozen ledger', async () => {
  const ctx = context(1, 3);
  const calls = attach(ctx, (seat, o) => o.kind === 'ledger-review' ? finalTurn(ctx, seat) : turn(seat, o.round));
  const report = await debate(ctx);
  const l = ledger(ctx);
  assert.equal(ctx.store.meta.status, 'completed');
  assert.equal(ctx.store.meta.outcome?.converged, true);
  assert.equal(ctx.store.meta.outcome?.rounds, 1, 'the review does not consume a discussion round');
  assert.equal(l.rounds.length, 1);
  assert.equal(l.resolution.round, 2);
  assert.equal(l.resolution.unaddressed, 0);
  assert.equal(l.claims.length, 6);
  for (const c of l.claims) {
    assert.equal(c.status, 'agreed');
    assert.equal(c.withdrawn, false, 'empty review claims cannot withdraw the original claims');
    assert.equal(Object.keys(c.stances).length, 2);
    assert.ok(Object.values(c.stances).every((s: any) => s.round === 2 && s.reason));
  }
  const reviews = calls.filter((c) => c.kind === 'ledger-review');
  assert.equal(reviews.length, 3);
  const snapshots = reviews.map((c) => c.prompt.split('<claim_ledger>')[1].split('</claim_ledger>')[0]);
  assert.ok(snapshots.every((s) => s === snapshots[0]), 'a sibling review is never relayed into another final prompt');
  assert.ok(reviews.every((c) => c.prompt.includes('Participant A') && c.prompt.includes('A:c1') && c.prompt.includes('B:c2') && c.prompt.includes('C:c2')));
  assert.match(report, /Ledger review/);
  assert.doesNotMatch(report.split('\n')[2], /unaddressed/);
  assert.match(report, /A position in round 1/);
  assert.doesNotMatch(report, /A proposed revision/);
});

test('last-round revisions and new claims get explicit final decisions before the report', async () => {
  const ctx = context(2);
  const calls = attach(ctx, (seat, o) => {
    if (o.kind === 'ledger-review') {
      const t = finalTurn(ctx, seat);
      if (seat === 'A') { t.stances.find((s) => s.claim === 'B:c3')!.stance = 'disagree'; t.verdict = 'partial'; }
      return t;
    }
    const t = turn(seat, o.round);
    if (o.round === 2) {
      t.claims[0].text += ' revised';
      t.stances = [{ claim: `${seat === 'A' ? 'B' : 'A'}:c1`, stance: 'agree', reason: 'Earlier claim' }];
      if (seat === 'B') t.claims.push({ ...t.claims[0], id: 'c3', text: 'New claim from the last round' });
    }
    return t;
  });
  const report = await debate(ctx);
  const l = ledger(ctx);
  assert.equal(ctx.store.meta.status, 'completed');
  assert.equal(ctx.store.meta.outcome?.converged, false);
  assert.equal(l.resolution.unaddressed, 0);
  assert.equal(l.resolution.disputed, 1);
  assert.ok(l.claims.every((c: any) => ['agreed', 'disputed'].includes(c.status)));
  const review = calls.find((c) => c.seat === 'A' && c.kind === 'ledger-review')!;
  assert.match(review.prompt, /B c1 revised/);
  assert.match(review.prompt, /B:c3/);
  assert.match(report, /New claim from the last round/);
  assert.match(report, /\*\*disagree\*\* — Final decision/);
});

test('an incomplete or undecided final review retries and the corrected decisions determine the outcome', async () => {
  const ctx = context(1);
  const calls = attach(ctx, (seat, o) => {
    if (!o.kind.startsWith('ledger-review')) return turn(seat, o.round);
    const t = finalTurn(ctx, seat);
    if (o.kind === 'ledger-review') {
      if (seat === 'A') t.stances.pop(); else t.stances[0].stance = 'unsure';
    }
    return t;
  });
  await debate(ctx);
  assert.equal(ctx.store.meta.status, 'completed');
  assert.equal(ctx.store.meta.outcome?.converged, true);
  assert.equal(calls.filter((c) => c.kind === 'ledger-review-retry').length, 2);
  assert.match(calls.find((c) => c.seat === 'A' && c.kind.endsWith('-retry'))!.prompt, /B:c2/);
  assert.match(calls.find((c) => c.seat === 'B' && c.kind.endsWith('-retry'))!.prompt, /agree or disagree/);
  assert.equal(ledger(ctx).resolution.unaddressed, 0);
});

test('a final review that stays incomplete fails without fabricating agreement or disagreement', async () => {
  const ctx = context(1);
  const calls = attach(ctx, (seat, o) => {
    const t = o.kind.startsWith('ledger-review') ? finalTurn(ctx, seat) : turn(seat, o.round);
    if (seat === 'A') t.stances = [];
    return t;
  });
  await debate(ctx);
  assert.equal(ctx.store.meta.status, 'failed');
  assert.equal(ctx.store.meta.outcome?.converged, false);
  assert.match(String(ctx.store.meta.outcome?.stop), /final claim-ledger review incomplete.*B:c1, B:c2/);
  assert.equal(calls.filter((c) => c.kind === 'ledger-review-retry').length, 1);
  assert.deepEqual(ledger(ctx).claims.find((c: any) => c.gid === 'B:c1').stances, {});
});

for (const ending of ['converged', 'stalled']) test(`the final ledger review still runs after discussion ${ending}`, async () => {
  const ctx = context(6);
  const calls = attach(ctx, (seat, o) => {
    if (o.kind === 'ledger-review') return finalTurn(ctx, seat, ending === 'converged' ? 'disagree' : 'agree');
    const t = turn(seat, o.round);
    if (o.round > 1) t.stances = finalTurn(ctx, seat, ending === 'converged' ? 'agree' : 'disagree').stances;
    t.verdict = o.round === 1 ? 'n/a' : ending === 'converged' ? 'agree' : 'disagree';
    return t;
  });
  await debate(ctx);
  assert.equal(ctx.store.meta.outcome?.rounds, ending === 'converged' ? 2 : 3);
  assert.equal(ctx.store.meta.outcome?.converged, ending === 'stalled', 'the final decisions take precedence over discussion verdicts');
  assert.equal(calls.filter((c) => c.kind === 'ledger-review').length, 2);
  assert.equal(ledger(ctx).resolution.unaddressed, 0);
  if (ending === 'converged') assert.match(calls.find((c) => c.kind === 'ledger-review')!.prompt, /status: agreed/);
});

test('unusable participant replies cannot produce a completed debate', async () => {
  const ctx = context(2);
  const calls = attach(ctx, (seat, o) => seat === 'B' ? undefined : turn(seat, o.round));
  await debate(ctx);
  assert.equal(ctx.store.meta.status, 'failed');
  assert.equal(ctx.store.meta.outcome?.converged, false);
  assert.equal(calls.filter((c) => c.kind === 'ledger-review').length, 0);
});

for (const limit of ['maxTurns', 'maxSteps'] as const) test(`a debate template stopped by ${limit} cannot complete without final decisions`, async () => {
  const template = builtinTemplate('debate');
  template.limits[limit] = limit === 'maxTurns' ? 2 : 1;
  const ctx = context(1, 2, template);
  const calls = attach(ctx, (seat, o) => turn(seat, o.round));
  await debate(ctx);
  assert.equal(ctx.store.meta.status, 'failed');
  assert.equal(ctx.store.meta.outcome?.converged, false);
  assert.match(String(ctx.store.meta.outcome?.stop), /limit/);
  assert.equal(calls.length, 2, 'no extra model calls beyond the template budget');
});

test('the chair receives the final ledger decisions after every participant has reviewed', async () => {
  const ctx = context(1);
  ctx.opts.chair = parseSeat('claude:sonnet@low', 'Z', cfg.defaults);
  const calls = attach(ctx, (seat, o) => {
    if (o.kind === 'ledger-review') return finalTurn(ctx, seat, seat === 'A' ? 'disagree' : 'agree');
    return turn(seat, o.round);
  });
  await debate(ctx);
  assert.equal(ctx.store.meta.status, 'completed');
  const chair = calls.find((c) => c.kind === 'synthesis')!;
  assert.ok(chair.round > calls.find((c) => c.kind === 'ledger-review')!.round);
  assert.match(chair.prompt, /2 disputed claim\(s\)/);
  assert.match(chair.prompt, /\*\*disagree\*\* — Final decision/);
  assert.equal(calls.filter((c) => c.kind === 'ledger-review').length, 2, 'report and finish do not repeat the review');
});

test('copied templates and repeated continuation preserve frozen claims and replay only accepted final reviews', async () => {
  const old = builtinTemplate('debate');
  old.id = 'my-debate';
  const ctx = context(1, 2, old);
  attach(ctx, (seat, o) => {
    const t = o.kind.startsWith('ledger-review') ? finalTurn(ctx, seat) : turn(seat, o.round);
    if (o.kind === 'ledger-review' && seat === 'A') t.claims = [{ ...turn(seat, 1).claims[0], id: 'rogue', text: 'Rejected review claim' }];
    return t;
  });
  await debate(ctx);
  assert.equal(ctx.store.meta.outcome?.converged, true);
  let prev = ctx;
  for (let i = 0; i < 2; i++) {
    let next!: ReturnType<typeof RunContext.create>;
    let prompts: ReturnType<typeof attach> = [];
    await continueRun(cfg, prev.store.meta.id, 'Check again', { rounds: 1, quiet: true, safe: false, onContext: (c) => {
      next = c;
      prompts = attach(c, (seat, o) => {
        if (o.kind.startsWith('ledger-review')) return finalTurn(c, seat);
        const t = turn(seat, o.round);
        t.stances = [{ claim: `${seat === 'A' ? 'B' : 'A'}:c1`, stance: 'agree', reason: 'Still agrees' }];
        return t;
      });
    } });
    const l = ledger(next);
    assert.equal(next.store.meta.status, 'completed');
    assert.equal(next.store.meta.outcome?.converged, true);
    assert.deepEqual(next.store.meta.options.template, old);
    assert.equal(l.rounds.length, i + 2);
    assert.equal(l.resolution.round, 4 + 2 * i);
    assert.equal(l.claims.length, 4, 'review claims never replace or withdraw discussion claims');
    assert.ok(l.claims.every((c: any) => !c.withdrawn && c.status === 'agreed'));
    assert.match(prompts[0].prompt, /B:c2/);
    assert.doesNotMatch(prompts[0].prompt, /rogue|Rejected review claim/);
    const a = l.claims.find((c: any) => c.gid === 'A:c2');
    assert.equal(a.history.filter((s: any) => s.round === 2).length, 1, 'replay only keeps the valid review attempt');
    prev = next;
  }
});

test('the workflow controls review execution; report and finish never inject a hidden stage', async () => {
  for (const required of [true, false]) {
    const template = builtinTemplate('debate');
    delete template.steps.resolve;
    const branch = template.steps.continue;
    if (branch.type === 'branch') branch.cases[0].next = 'report';
    const finish = template.steps.finish;
    if (finish.type === 'operation') finish.settings = { requireLedgerReview: required, requireAddressedClaims: required };
    const ctx = context(1, 2, template);
    const calls = attach(ctx, (seat, o) => turn(seat, o.round));
    await debate(ctx);
    assert.equal(calls.length, 2, 'only the two blind turns occur');
    assert.equal(ctx.store.meta.status, required ? 'failed' : 'completed', 'the template’s completion requirements determine the outcome');
    assert.equal(ledger(ctx).resolution, undefined);
  }
});

test('stage settings and prompt edits execute as authored and survive continuation', async () => {
  const template = builtinTemplate('debate');
  const round = template.steps.round, resolve = template.steps.resolve;
  if (round.type === 'operation') round.settings = { ...round.settings, rounds: 1 };
  if (resolve.type === 'operation') {
    resolve.settings = { ...resolve.settings, decisions: 'graded' };
    resolve.prompts!['ledger-review'] = 'Custom review for {{seat}}: {{requiredClaims}}\n{{claimLedger}}\n{{finalPositions}}';
  }
  const ctx = context(4, 2, template);
  const calls = attach(ctx, (seat, o) => o.kind.startsWith('ledger-review') ? finalTurn(ctx, seat, 'partial') : turn(seat, o.round));
  await debate(ctx);
  assert.equal(ctx.store.meta.status, 'completed');
  assert.equal(ctx.store.meta.outcome?.rounds, 1, 'the saved stage limit overrides the run default');
  assert.equal(ledger(ctx).resolution.partial, 4);
  assert.match(calls.find((c) => c.kind === 'ledger-review')!.prompt, /^Custom review for A: B:c1, B:c2/);
  assert.doesNotMatch(calls.find((c) => c.kind === 'ledger-review')!.prompt, /Discussion rounds are complete/);
  let next!: ReturnType<typeof RunContext.create>;
  await continueRun(cfg, ctx.store.meta.id, 'Continue the graded review', { rounds: 3, quiet: true, safe: false, onContext: (c) => {
    next = c;
    attach(c, (seat, o) => {
      if (o.kind.startsWith('ledger-review')) return finalTurn(c, seat, 'partial');
      assert.ok(ledger(ctx).claims.every((x: any) => x.stances[seat] || x.owner === seat));
      const t = turn(seat, o.round);
      t.stances = [{ claim: `${seat === 'A' ? 'B' : 'A'}:c1`, stance: 'partial', reason: 'Retained partial stance' }];
      return t;
    });
  } });
  const l = ledger(next);
  assert.equal(l.rounds.length, 2);
  assert.ok(l.claims.some((c: any) => c.history.some((h: any) => h.round === 2 && h.stance === 'partial')), 'continuation replays the recorded stage’s graded decisions');
});

test('custom interactions cannot rewrite the native ledger when a copied debate continues', async () => {
  const template = builtinTemplate('debate');
  const chair = template.steps.chair;
  if (chair.type === 'operation') chair.next = 'discussion-note';
  template.steps['discussion-note'] = { type: 'turn', role: 'participant', prompt: 'Reflect on the decisions without changing the ledger.', next: 'finish' };
  const reply = (ctx: ReturnType<typeof RunContext.create>): Reply => (seat, o) => {
    if (o.kind.startsWith('ledger-review')) return finalTurn(ctx, seat);
    const t = turn(seat, o.round);
    if (o.kind === 'discussion-note') t.claims = [{ ...t.claims[0], id: 'rogue', text: 'An extra interaction outside the native ledger' }];
    if (o.kind === 'critique') t.stances = [{ claim: `${seat === 'A' ? 'B' : 'A'}:c1`, stance: 'agree', reason: 'Earlier claim' }];
    return t;
  };
  const ctx = context(1, 2, template);
  attach(ctx, reply(ctx));
  await debate(ctx);
  let next!: ReturnType<typeof RunContext.create>;
  await continueRun(cfg, ctx.store.meta.id, 'Continue the ledger', { rounds: 1, quiet: true, safe: false, onContext: (c) => { next = c; attach(c, reply(c)); } });
  assert.equal(next.store.meta.status, 'completed');
  assert.equal(ledger(next).claims.length, 4);
  assert.ok(ledger(next).claims.every((c: any) => c.id !== 'rogue' && !c.withdrawn));
});

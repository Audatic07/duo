import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { CoordinationTemplate } from '../src/templates/types.ts';

const tmp = mkdtempSync(join(tmpdir(), 'duo-templates-'));
const log = join(tmp, 'calls.jsonl');
Object.assign(process.env, { DUO_HOME: join(tmp, 'home'), DUO_CONFIG: join(tmp, 'config.json'), CODEX_HOME: join(tmp, 'codex'), CLAUDE_CONFIG_DIR: join(tmp, 'claude'), DUO_CODEX_BIN: join(import.meta.dirname, 'fakes/codex.mjs'), DUO_CLAUDE_BIN: join(import.meta.dirname, 'fakes/claude.mjs'), FAKE_LOG: log });
delete process.env.DUO_DEPTH;
const { validateTemplate, templateErrors, matches, schemaError } = await import('../src/templates/validate.ts');
const { builtinTemplate, BUILTIN_IDS } = await import('../src/templates/builtins.ts');
const { initialState, routed, selected } = await import('../src/templates/runtime.ts');
const { runTemplate } = await import('../src/templates/run.ts');
const { listTemplates, getTemplate, saveTemplate, deleteTemplate } = await import('../src/templates/catalog.ts');
const { loadMemory, clearMemory, retain, saveMemory } = await import('../src/templates/memory.ts');
const { generateTemplate } = await import('../src/templates/generate.ts');
const { RunContext } = await import('../src/protocols/common.ts');
const { continueRun } = await import('../src/protocols/continue.ts');
const { loadConfig } = await import('../src/config.ts');
const { seatIds, parseSeat } = await import('../src/seats.ts');
const example = validateTemplate(JSON.parse(readFileSync(join(import.meta.dirname, '../docs/templates/example.json'), 'utf8')));
const cfg = loadConfig();
const seats = [parseSeat('codex:gpt-6-sol@high', 'A', cfg.defaults), parseSeat('claude:sonnet@low', 'B', cfg.defaults)];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
function context(t = example) {
  return RunContext.create(cfg, { protocol: t.library ?? 'custom', title: t.name, brief: 'Pick a storage design', cwd: tmp, seats: [...seats], rounds: 3, minRounds: 1, quiet: true, anon: false, workspace: false, extra: { template: t } });
}
after(() => rmSync(tmp, { recursive: true, force: true }));

test('all built-in templates and the worked example validate', () => {
  for (const id of BUILTIN_IDS) assert.deepEqual(templateErrors(builtinTemplate(id)), []);
  assert.deepEqual(templateErrors(example), []);
});
test('operation edits are validated and nullable response fields preserve native contracts', () => {
  const t = builtinTemplate('debate');
  const resolve = t.steps.resolve;
  if (resolve.type !== 'operation') throw new Error('fixture');
  resolve.settings!.decisions = 'unsupported';
  assert.ok(templateErrors(t).some((e) => e.includes('invalid setting decisions')));
  resolve.settings!.decisions = 'binary';
  resolve.prompts = { unknown: '{{brief}}' };
  assert.ok(templateErrors(t).some((e) => e.includes('unsupported prompt kind')));
  assert.equal(schemaError({ type: ['string', 'null'] }, null), undefined);
  assert.equal(schemaError({ type: ['string', 'null'] }, 'a citation'), undefined);
  assert.match(schemaError({ type: ['string', 'null'] }, 3)!, /expected string/);
});

test('a saved library draft executes edited prompts, routes, schemas and starting model assignments', async () => {
  const t = builtinTemplate('ask'); t.id = 'authored-ask';
  t.assignments = [{ role: 'participant', select: { ids: ['B'] } }];
  t.roles.participant.schema = { type: 'object', properties: { answer: { type: 'string' }, tag: { type: ['string', 'null'] } }, required: ['answer', 'tag'], additionalProperties: false };
  t.roles.preparer = { instructions: 'Prepare context.' };
  t.assignments.push({ role: 'preparer', select: { ids: ['A'] } });
  t.start = 'prepare';
  t.steps.prepare = { type: 'turn', role: 'preparer', prompt: 'Independent preparer for {{brief}}', next: 'answers' };
  const answers = t.steps.answers;
  if (answers.type !== 'operation') throw new Error('fixture');
  answers.prompts = { answer: 'Authored answer for {{seat}}: {{brief}}' };
  answers.input = [{ from: 'prepare', parts: ['reply'], anonymous: true }];
  const saved = saveTemplate(t);
  assert.deepEqual(getTemplate(t.id), saved);
  const ctx = context(getTemplate(t.id));
  await runTemplate(ctx, getTemplate(t.id));
  assert.equal(ctx.store.meta.status, 'completed');
  assert.deepEqual(ctx.store.meta.turns.map((turn) => [turn.kind, turn.seat]), [['prepare', 'A'], ['answer', 'B']]);
  const turn = ctx.store.meta.turns[1];
  assert.ok(Object.hasOwn(JSON.parse(readFileSync(join(ctx.store.dir, turn.dir, 'reply.json'), 'utf8')), 'tag'), 'the edited schema is sent to the CLI');
  const prompt = readFileSync(join(ctx.store.dir, turn.dir, 'prompt.md'), 'utf8');
  assert.match(prompt, /^Authored answer for B: Pick a storage design/);
  assert.match(prompt, /<messages source="prepare">\nResponse 1\ncodex answer:/);
  assert.doesNotMatch(prompt, /<question>/);
  let continued!: ReturnType<typeof RunContext.create>;
  await continueRun(cfg, ctx.store.meta.id, 'Continue this authored method', { rounds: 1, quiet: true, safe: false, onContext: (c) => { continued = c; } });
  assert.equal(continued.store.meta.status, 'completed');
  assert.deepEqual(continued.store.meta.turns.map((turn) => [turn.kind, turn.seat]), [['prepare', 'A'], ['answer', 'B']], 'continuation retains the authored role pool');
});

test('an explicit native chair assignment selects a fresh chair from the added model seats', async () => {
  const t = builtinTemplate('ask'); t.id = 'assigned-chair';
  t.assignments = [{ role: 'participant', select: { ids: ['A', 'B'] } }, { role: 'chair', select: { ids: ['C'], count: 1 } }];
  const ctx = context(t);
  ctx.opts.seats.push(parseSeat('codex:gpt-6-sol@high', 'C', cfg.defaults));
  await runTemplate(ctx, t);
  assert.equal(ctx.store.meta.status, 'completed');
  assert.deepEqual(ctx.store.meta.turns.map((turn) => [turn.kind, turn.seat]), [['answer', 'A'], ['answer', 'B'], ['synthesis', 'chair']]);
  assert.ok(ctx.store.meta.seats.some((s) => s.id === 'C' && s.role === 'chair'));
  let continued!: ReturnType<typeof RunContext.create>;
  await continueRun(cfg, ctx.store.meta.id, 'Continue with the assigned chair', { rounds: 1, quiet: true, safe: false, onContext: (c) => { continued = c; } });
  assert.equal(continued.store.meta.status, 'completed');
  assert.ok(continued.store.meta.seats.some((s) => s.id === 'C' && s.role === 'chair'));
});
test('validation rejects malformed graphs, prototype references, code and unsafe permissions', () => {
  const mutations: ((t: any) => void)[] = [
    (t) => delete t.id, (t) => t.version = 2, (t) => t.start = 'missing',
    (t) => t.roles.proposer.access = 'full', (t) => t.steps.propose.next = 'missing',
    (t) => t.steps.propose.type = 'constructor', (t) => t.library = 'constructor',
    (t) => t.steps.propose = { type: 'operation', use: 'shell.exec', next: 'done' },
    (t) => t.steps.challenge.input[0].from = 'missing', (t) => t.limits.maxTurns = 0,
    (t) => t.transitions[0].when = { path: '__proto__.polluted', op: 'exists' },
    (t) => t.roles.decider.schema.properties.done.type = 'eval',
    (t) => t.memory.decisions.readBy = ['missing'], (t) => t.memory.decisions.maxChars = -1,
    (t) => t.memory.decisions.paths = ['constructor'], (t) => t.steps.propose.javascript = 'alert(1)',
  ];
  for (const mutate of mutations) { const t = clone(example); mutate(t); assert.ok(templateErrors(t).length); assert.throws(() => validateTemplate(t)); }
});
test('missing state never pretends to meet criteria; conditions are data-only', () => {
  assert.equal(matches({ path: 'missing', op: 'ne', value: false }, {}), false);
  assert.equal(matches({ path: 'a', op: 'every', value: true }, { a: [] }), false);
  assert.equal(matches({ all: [{ path: 'n', op: 'gte', value: 2 }, { not: { path: 'missing', op: 'exists' } }] }, { n: 2 }), true);
  assert.equal(matches({ path: 'n', op: 'gte', value: 2 }, { n: '3' }), false);
  assert.match(schemaError(example.roles.decider.schema!, { done: true })!, /missing answer/);
});
test('selectors enforce eligibility and single-role ownership', () => {
  const t = clone(example);
  t.assignments.push({ role: 'decider', select: { engine: 'codex', count: 1 } });
  const state = initialState(t, seats);
  assert.deepEqual(state.roles, { proposer: [], skeptic: ['B'], decider: ['A'] });
  t.assignments[0].select.ids = ['C']; assert.throws(() => initialState(t, seats), /enough seats/);
});
test('a selector count chooses a subset of the eligible seat ids', () => {
  const t = clone(example);
  t.assignments = [{ role: 'proposer', select: { ids: ['A', 'B'], count: 1 } }];
  assert.deepEqual(initialState(t, seats).roles.proposer, ['A']);
});
test('malformed JSON values return validation errors rather than throwing', () => {
  const awkward = { toString: null, valueOf: null };
  const mutations: ((t: any) => void)[] = [
    (t) => t.library = awkward, (t) => t.start = awkward,
    (t) => t.steps.propose.type = awkward, (t) => t.steps.propose.next = awkward,
    (t) => t.steps.propose = { type: 'operation', use: 7, next: 'done' },
    (t) => t.steps.challenge.input[0].from = awkward,
    (t) => t.assignments[0].role = awkward,
    (t) => t.roles.decider.schema.required = [awkward],
  ];
  for (const mutate of mutations) {
    const t = clone(example); mutate(t);
    assert.ok(templateErrors(t).length);
  }
});
test('a route cannot silently resolve an ambiguous role and step name', () => {
  const t = clone(example);
  t.roles.propose = { instructions: 'Answer.' };
  assert.ok(templateErrors(t).some((e) => e.includes('names both a role and a step')));
});
test('native copies cannot launch additional writers outside the native workspace', () => {
  for (const id of BUILTIN_IDS) {
    const t = builtinTemplate(id);
    t.roles.extraWriter = { instructions: 'Edit files.', access: 'sandboxed' };
    t.workspace = { isolation: 'worktree' };
    assert.ok(templateErrors(t).some((e) => e.includes('fully custom method')));
  }
});
test('a fully custom writer stays in its nested worktree until the result is applied', async () => {
  const { finishWorkspace } = await import('../src/worktree.ts');
  const repo = join(tmp, 'custom-writer');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'original.txt'), 'original\n');
  execFileSync('git', ['init', '-q', repo]); execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
  const t = clone(example); delete t.memory; delete t.transitions; delete t.exceptions;
  t.id = 'custom-writer'; t.roles = { implementer: { instructions: 'Implement the brief.', access: 'sandboxed' } };
  t.assignments = [{ role: 'implementer', select: { ids: ['A'] } }];
  t.workspace = { isolation: 'worktree' }; t.limits.minSeats = 1;
  t.start = 'write'; t.steps = { write: { type: 'turn', role: 'implementer', prompt: '{{brief}}', next: 'done' }, done: { type: 'finish', status: 'completed', reason: 'Implemented' } };
  const ctx = RunContext.create(cfg, { protocol: 'custom', title: t.name, brief: 'Add a file', cwd: join(repo, 'src'), seats: [seats[0]], rounds: 1, minRounds: 1, quiet: true, anon: false, workspace: true, extra: { template: t } });
  await runTemplate(ctx, t);
  const ws = ctx.store.meta.workspace!;
  try {
    assert.equal(ctx.store.meta.status, 'completed');
    assert.equal(ws.cwd, join(ws.path, 'src'));
    assert.ok(existsSync(join(ws.cwd, 'duo-fake.txt')));
    assert.ok(!existsSync(join(repo, 'src', 'duo-fake.txt')));
    const result = finishWorkspace(ws, 'apply', ctx.store.meta.title);
    assert.ok(result.ok, result.message);
    assert.ok(existsSync(join(repo, 'src', 'duo-fake.txt')));
  } finally { if (existsSync(ws.path)) finishWorkspace(ws, 'discard', ctx.store.meta.title); }
});
test('routes enforce source, parts, fan-out, self-exclusion and anonymity', () => {
  const state = initialState(example, seats);
  state.history = [
    { role: 'proposer', seat: 'A', step: 'propose', reply: 'old', data: { decision: 'old' } },
    { role: 'proposer', seat: 'A', step: 'propose', reply: 'secret A', data: { decision: 'keep' } },
    { role: 'proposer', seat: 'B', step: 'propose', reply: 'secret B', data: { decision: 'peer' } },
  ];
  const t = clone(example); const node = t.steps.challenge;
  if (node.type !== 'turn') throw new Error('fixture');
  node.input = [{ from: 'propose', excludeSelf: true, anonymous: true, parts: ['data'], limit: 1 }];
  const body = routed(t, state, 'challenge', 'A');
  assert.match(body, /Response 1/); assert.match(body, /peer/); assert.doesNotMatch(body, /secret|keep|proposer \/ B/);
});
test('custom method changes A’s role, uses fresh context and persists only selected fields across runs', async () => {
  const t = clone(example); t.id = 'persistent-test'; t.memory!.decisions.maxEntries = 1;
  const first = context(t); await runTemplate(first, t);
  assert.equal(first.store.meta.status, 'completed'); assert.equal(first.store.meta.outcome?.converged, true);
  assert.equal(first.store.meta.turns.length, 3);
  const records = first.store.meta.seats.filter((s) => s.id === 'A');
  assert.deepEqual(records.map((s) => s.role).sort(), ['decider', 'proposer']);
  assert.notEqual(records.find((s) => s.role === 'proposer')!.codexThreadId, records.find((s) => s.role === 'decider')!.codexThreadId);
  const memory = loadMemory(t, 'decisions'); assert.equal(memory.length, 1); assert.deepEqual(JSON.parse(memory[0].text), { decision: 'fake' });
  const second = context(t); await runTemplate(second, t);
  const prompts = calls().filter((c) => c.prompt).slice(-3).map((c) => c.prompt);
  assert.doesNotMatch(prompts[0], /memory channel=/); assert.doesNotMatch(prompts[1], /memory channel=/); assert.match(prompts[2], /memory channel="decisions"/);
  assert.equal(loadMemory(t, 'decisions').length, 1);
  assert.ok(first.store.readFile('template.json')); assert.ok(first.store.readFile('coordination.json'));
  clearMemory(t, 'decisions'); assert.deepEqual(loadMemory(t, 'decisions'), []);
});
test('memory evicts old entries and bounds retained text', () => {
  const c = { ...example.memory!.decisions, maxEntries: 2, maxChars: 6 };
  const entries = ['111', '222', '333333333'].map((text) => ({ run: 'x', seat: 'A', step: 'decide', at: 'now', text }));
  assert.deepEqual(retain(entries, c).map((e) => e.text), ['333333']);
});
test('bounded loops stop without falsely claiming successful completion', async () => {
  const t = clone(example); delete t.memory; delete t.transitions;
  t.steps.propose = { type: 'turn', role: 'proposer', prompt: '{{brief}}', next: 'propose' };
  t.completion = { when: { path: 'visits.propose', op: 'gt', value: 100 }, reason: 'done' };
  t.limits.maxSteps = 3; t.limits.maxTurns = 10;
  const ctx = context(t); await runTemplate(ctx, t);
  assert.equal(ctx.store.meta.turns.length, 3); assert.equal(ctx.store.meta.outcome?.completion, 'limit'); assert.equal(ctx.store.meta.outcome?.converged, false);
});
test('invalid output retries once, then exception routing preserves the failure', async () => {
  const t = clone(example); delete t.transitions; delete t.memory;
  t.roles.proposer.schema = { type: 'integer' };
  t.exceptions = [{ when: { path: 'vars.error', op: 'exists' }, next: 'blocked' }];
  t.steps.blocked = { type: 'finish', status: 'blocked', reason: 'Needs attention: {{vars.error}}' };
  const ctx = context(t); const report = await runTemplate(ctx, t);
  assert.equal(ctx.store.meta.turns.length, 2); assert.equal(ctx.store.meta.outcome?.completion, 'blocked'); assert.equal(ctx.store.meta.outcome?.converged, false);
  assert.match(report, /Needs attention: A: reply: expected integer/);
});
test('an error branch can inspect the failure, then a successful recovery clears it', async () => {
  const t = clone(example); delete t.transitions; delete t.memory;
  t.roles.proposer.schema = { type: 'integer' };
  t.steps.propose.onError = { action: 'goto', next: 'recover' };
  t.steps.recover = { type: 'branch', cases: [{ when: { path: 'vars.error', op: 'exists' }, next: 'done' }], otherwise: 'blocked' };
  const ctx = context(t); await runTemplate(ctx, t);
  const state = JSON.parse(ctx.store.readFile('coordination.json')!);
  assert.equal(state.stop.status, 'completed');
  assert.equal(state.vars.error, undefined);
});
test('one-turn budget permits one call and prevents format-repair overruns', async () => {
  const t = clone(example); delete t.transitions; delete t.memory;
  t.roles.proposer.schema = { type: 'integer' }; t.limits.maxTurns = 1;
  t.steps.propose.onError = { action: 'goto', next: 'blocked' };
  const ctx = context(t); await runTemplate(ctx, t);
  assert.equal(ctx.store.meta.turns.length, 1); assert.equal(ctx.store.meta.outcome?.completion, 'blocked');
});
test('template catalog validates, persists and protects built-ins', () => {
  assert.throws(() => saveTemplate(builtinTemplate('ask')), /read-only/);
  const t = clone(example); t.id = 'saved-example'; saveTemplate(t);
  assert.deepEqual(getTemplate(t.id), t); assert.ok(listTemplates().some((e) => e.template.id === t.id && !e.builtin));
});
test('natural-language builder uses the selected model, repairs a draft and leaves it unexecuted', async () => {
  process.env.FAKE_TEMPLATE_FILE = join(import.meta.dirname, '../docs/templates/example.json');
  process.env.FAKE_TEMPLATE_INVALID_FIRST = '1';
  try {
    const result = await generateTemplate(cfg, { model: 'claude:sonnet@low', description: 'A proposes and B challenges, then A decides. Keep a short decision record.' });
    assert.equal(result.template.id, example.id); assert.match(result.explanation, /validated/);
    const authorCalls = calls().filter((c) => c.cli === 'claude' && c.prompt && /draft failed validation/.test(c.prompt));
    assert.equal(authorCalls.length, 1); assert.ok(!existsSync(join(tmp, 'home/templates', `${example.id}.json`)), 'draft is not saved or run');
  } finally { delete process.env.FAKE_TEMPLATE_FILE; delete process.env.FAKE_TEMPLATE_INVALID_FIRST; }
});


test('completion supports all models’ structured results and state-to-state comparison', () => {
  assert.equal(matches({ path: 'outputs.review', op: 'every', where: { path: 'data.approved', op: 'eq', value: true } }, { outputs: { review: [{ data: { approved: true } }, { data: { approved: false } }] } }), false);
  assert.equal(matches({ path: 'a', op: 'gt', valuePath: 'b' }, { a: 3, b: 2 }), true);
  assert.equal(matches({ path: 'a', op: 'ne', valuePath: 'missing' }, { a: 3 }), false);
  assert.equal(matches({ path: 'a', op: 'eq', value: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }), true);
});
test('score-based assignment chooses eligible models with stable ties', () => {
  const state = initialState(example, seats);
  state.outputs.score = seats.map((s, i) => ({ seat: s.id, role: 'proposer', step: 'score', reply: '', data: { score: i + 1 } }));
  assert.equal(selected({ count: 1, rankBy: { step: 'score', path: 'data.score' } }, seats, state.roles, state)[0].id, 'B');
  assert.equal(selected({ engine: 'codex', count: 1, rankBy: { step: 'score', path: 'data.score' } }, seats, state.roles, state)[0].id, 'A');
});
test('models qualify for role transitions independently', async () => {
  const t = clone(example); delete t.memory;
  t.assignments = [{ role: 'proposer', select: {} }];
  t.transitions = [{ from: 'proposer', to: 'decider', when: { all: [{ path: 'model.engine', op: 'eq', value: 'claude' }, { path: 'visits.propose', op: 'gte', value: 1 }] } }];
  t.steps.propose = { type: 'turn', role: 'proposer', prompt: '{{brief}}', next: 'decide' };
  const ctx = context(t); await runTemplate(ctx, t);
  const state = JSON.parse(ctx.store.readFile('coordination.json')!);
  assert.deepEqual(state.roles.proposer, ['A']); assert.deepEqual(state.roles.decider, ['B']);
  assert.equal(ctx.store.meta.turns.find((r) => r.kind === 'decide')!.seat, 'B');
});
test('run memory stays in its run and reducing saved retention prunes disk contents', () => {
  const t = clone(example); t.id = 'retention-test';
  const entry = { run: 'r', seat: 'A', step: 'decide', at: 'now', text: '123456789' };
  t.memory!.decisions.scope = 'run';
  const local = saveMemory(t, 'decisions', [], [entry]); assert.equal(local.length, 1); assert.deepEqual(loadMemory(t, 'decisions'), []);
  t.memory!.decisions.scope = 'template'; saveMemory(t, 'decisions', [], [entry]);
  t.memory!.decisions.maxChars = 4; saveTemplate(t);
  const stored = JSON.parse(readFileSync(join(tmp, 'home/template-memory/retention-test.decisions.json'), 'utf8'));
  assert.equal(stored[0].text, '1234');
});
test('memory clearing respects a competing writer’s lock', () => {
  const t = clone(example); t.id = 'locked-test'; saveMemory(t, 'decisions', [], []);
  const lock = join(tmp, 'home/template-memory/locked-test.decisions.json.lock'); writeFileSync(lock, '');
  try { assert.throws(() => clearMemory(t, 'decisions'), /busy/); }
  finally { rmSync(lock); }
  clearMemory(t, 'decisions');
});
test('saving removed channels or deleting a template clears its retained memory', () => {
  const t = clone(example); t.id = 'removed-memory'; saveTemplate(t);
  const entry = { run: 'r', seat: 'A', step: 'decide', at: 'now', text: 'a decision' };
  saveMemory(t, 'decisions', [], [entry]);
  const revised = clone(t); revised.memory!.decisions.scope = 'run'; saveTemplate(revised);
  assert.deepEqual(loadMemory(t, 'decisions'), []);
  saveTemplate(t); saveMemory(t, 'decisions', [], [entry]);
  deleteTemplate(t.id);
  assert.deepEqual(loadMemory(t, 'decisions'), []);
  assert.throws(() => getTemplate(t.id), /No template/);
});
test('a native library stopped by its template budget finalizes and closes cleanly', async () => {
  const t = builtinTemplate('ask'); t.id = 'bounded-ask'; t.limits.maxSteps = 1;
  const ctx = context(t); const report = await runTemplate(ctx, t);
  assert.equal(ctx.store.meta.status, 'completed'); assert.equal(ctx.store.meta.outcome?.completion, 'limit'); assert.equal(ctx.store.meta.outcome?.converged, false);
  assert.match(report, /limit reached/);
});
test('custom cancellation stops a slow CLI and preserves the recorded workflow state', async () => {
  process.env.FAKE_CODEX_MODE = 'slow';
  try {
    const t = clone(example); delete t.memory;
    const ctx = context(t); const timer = setTimeout(() => ctx.cancel(), 300);
    const started = Date.now(); await runTemplate(ctx, t); clearTimeout(timer);
    assert.ok(Date.now() - started < 5000); assert.equal(ctx.store.meta.status, 'cancelled');
    assert.match(ctx.store.readFile('coordination.json')!, /cancelled/);
  } finally { delete process.env.FAKE_CODEX_MODE; }
});
test('seat ids stay valid past 25 models and reserve the chair id', () => {
  const ids = seatIds(32); assert.equal(ids[25], 'AA'); assert.equal(ids[31], 'AG'); assert.ok(!ids.includes('Z')); assert.equal(new Set(ids).size, 32);
});


test('custom roles named chair and reviewer retain separate model identities', async () => {
  const t = clone(example); delete t.memory; delete t.transitions;
  t.roles = { chair: { instructions: 'Answer independently.' } };
  t.assignments = [{ role: 'chair', select: {} }];
  t.start = 'answer'; t.steps = { answer: { type: 'turn', role: 'chair', prompt: '{{brief}}', next: 'done' }, done: { type: 'finish', status: 'completed', reason: 'done' } };
  const ctx = context(t); const report = await runTemplate(ctx, t);
  assert.deepEqual(ctx.store.meta.turns.map((r) => r.seat), ['A','B']);
  assert.match(report, /codex:gpt-6-sol/); assert.match(report, /claude:sonnet/);
});


test('native parallel calls cannot exceed the template’s turn budget', async () => {
  const t = builtinTemplate('ask'); t.id = 'limited-ask'; t.limits.maxTurns = 1;
  const ctx = context(t); await runTemplate(ctx, t);
  assert.equal(ctx.sentTurns, 1); assert.equal(ctx.store.meta.outcome?.completion, 'limit'); assert.equal(ctx.store.meta.outcome?.converged, false);
});


test('role instructions in a built-in copy supplement its native prompts', async () => {
  const t = builtinTemplate('ask'); t.id = 'instructed-ask'; t.roles.participant.instructions = 'Include one concrete counterexample.';
  const ctx = context(t); await runTemplate(ctx, t);
  const first = ctx.store.meta.turns[0];
  const prompt = readFileSync(join(ctx.store.dir, first.dir, 'prompt.md'), 'utf8');
  assert.match(prompt, /Include one concrete counterexample/);
});

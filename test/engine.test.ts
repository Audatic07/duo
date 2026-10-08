/**
 * End to end through claw-orchestrator and duo's spawn hook, with fake CLIs (test/fakes) standing in
 * for Codex and Claude Code: no network, no quota, any OS.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// realpath: on macOS the temp folder is a symlink, and the CLIs report the resolved path.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'duo-engine-')));
const LOG = join(tmp, 'calls.jsonl');
Object.assign(process.env, {
  DUO_HOME: join(tmp, 'home'),
  DUO_CONFIG: join(tmp, 'config.json'),
  CODEX_HOME: join(tmp, 'codex-home'),
  CLAUDE_CONFIG_DIR: join(tmp, 'claude-home'),
  DUO_CODEX_BIN: join(import.meta.dirname, 'fakes', 'codex.mjs'),
  DUO_CLAUDE_BIN: join(import.meta.dirname, 'fakes', 'claude.mjs'),
  FAKE_LOG: LOG,
});
delete process.env.DUO_DEPTH;

const { loadConfig } = await import('../src/config.ts');
const { RunContext } = await import('../src/protocols/common.ts');
const { ask } = await import('../src/protocols/ask.ts');
const { debate } = await import('../src/protocols/debate.ts');
const { pair } = await import('../src/protocols/pair.ts');
const { parseSeat } = await import('../src/seats.ts');
const { finishWorkspace } = await import('../src/worktree.ts');

const cfg = loadConfig();
const D = cfg.defaults;
const calls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function ctxFor(protocol: string, specs: string[], o: { cwd?: string; rounds?: number; brief?: string } = {}) {
  const seats = specs.map((s, i) => parseSeat(s, String.fromCharCode(65 + i), D));
  return RunContext.create(cfg, { protocol, title: `${protocol} test`, brief: o.brief ?? 'What is 2+2?', cwd: o.cwd ?? tmp, seats, rounds: o.rounds ?? 2, minRounds: 1, anon: false, quiet: true, extra: {} });
}

after(() => rmSync(tmp, { recursive: true, force: true }));

test('ask: both CLIs answer; the Codex prompt goes through stdin with the seat flags after exec', async () => {
  rmSync(LOG, { force: true });
  const ctx = ctxFor('ask', ['codex:gpt-6-sol@high+verbosity=low', 'claude:sonnet@low']);
  await ask(ctx);
  const m = ctx.store.meta;
  assert.equal(m.status, 'completed');
  assert.equal(m.turns.length, 2);
  for (const t of m.turns) assert.ok(!t.error, `turn ${t.seat}: ${t.error}`);
  const cx = calls().find((c) => c.cli === 'codex' && c.args);
  assert.equal(cx.args[0], 'exec');
  assert.equal(cx.args[cx.args.length - 1], '-', 'the prompt is read from stdin');
  assert.match(cx.prompt, /What is 2\+2\?/);
  const flags = cx.args.slice(1, 12).join(' ');
  assert.match(flags, /model_verbosity="low"/);
  assert.match(flags, /skills\.include_instructions=false/);
  assert.ok(cx.args.includes('--ignore-rules'));
  const codexTurn = m.turns.find((t) => t.seat === 'A')!;
  assert.equal(codexTurn.usage.input, 1000);
  assert.ok((codexTurn.codexCredits ?? 0) > 0, 'priced from the rate card');
});

test('debate: each turn records only its own tool calls (no carry-over from the previous turn)', async () => {
  const ctx = ctxFor('debate', ['codex:gpt-6-sol@high', 'claude:sonnet@low'], { rounds: 2 });
  await debate(ctx);
  const m = ctx.store.meta;
  const codexTurns = m.turns.filter((t) => t.seat === 'A');
  assert.equal(codexTurns.length, 3, 'two discussion rounds and a final ledger review');
  for (const t of codexTurns) {
    const tools = JSON.parse(readFileSync(join(ctx.store.dir, t.dir, 'tools.json'), 'utf8'));
    assert.equal(tools.length, 1, `turn ${t.n} has exactly its own one command`);
  }
});

test('a Codex reconnect is a warning, not an error', async () => {
  process.env.FAKE_CODEX_MODE = 'reconnect';
  try {
    const ctx = ctxFor('ask', ['codex:gpt-6-sol@low']);
    await ask(ctx);
    const t = ctx.store.meta.turns[0];
    assert.equal(t.error, undefined);
    assert.match(t.warnings?.[0] ?? '', /Reconnecting/);
  } finally {
    delete process.env.FAKE_CODEX_MODE;
  }
});

test('a fatal seat error stops the run at once instead of letting the other seat burn quota', async () => {
  process.env.FAKE_CLAUDE_MODE = 'old';
  process.env.FAKE_CODEX_MODE = 'slow';
  try {
    const started = Date.now();
    const ctx = ctxFor('debate', ['codex:gpt-6-sol@high', 'claude:opus@high'], { rounds: 3 });
    await debate(ctx);
    const m = ctx.store.meta;
    assert.ok(Date.now() - started < 15_000, 'the slow Codex turn was stopped, not waited for');
    assert.equal(m.status, 'failed');
    assert.match(String(m.outcome?.stop), /or newer is required/);
    assert.match(String(m.outcome?.stop), /Update Claude Code/);
    assert.equal(m.turns.filter((t) => t.kind.endsWith('-retry')).length, 0, 'no pointless retry');
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
    delete process.env.FAKE_CODEX_MODE;
  }
});

test('a Claude process that died between turns is restarted on the same conversation', async () => {
  process.env.FAKE_CLAUDE_MODE = 'die-after-1';
  try {
    const ctx = ctxFor('debate', ['claude:sonnet@low', 'codex:gpt-6-sol@low'], { rounds: 2 });
    await debate(ctx);
    const m = ctx.store.meta;
    const claudeTurns = m.turns.filter((t) => t.seat === 'A');
    assert.equal(claudeTurns.length, 3, 'the recovered conversation also completes its ledger review');
    assert.ok(claudeTurns.every((t) => !t.error), JSON.stringify(claudeTurns.map((t) => t.error)));
    const resumed = calls().filter((c) => c.cli === 'claude' && c.args?.includes('--resume'));
    assert.ok(resumed.length >= 1, 'restarted with --resume');
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }
});

test('pair: the writer works in a worktree, the reviewer approves, and Apply brings the change home', async () => {
  const repo = join(tmp, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  const ctx = ctxFor('pair', ['codex:gpt-6-sol@high', 'claude:opus@high'], { cwd: repo, rounds: 3, brief: 'Add a file that says hello.' });
  await pair(ctx, { isolation: 'worktree', writerAccess: 'sandboxed' });
  const m = ctx.store.meta;
  assert.equal(m.status, 'completed', String(m.outcome?.stop));
  assert.equal(m.outcome?.converged, true, String(m.outcome?.stop));
  const ws = m.workspace!;
  assert.equal(ws.mode, 'worktree');
  const same = (a: string, b: string) => realpathSync.native(a).toLowerCase() === realpathSync.native(b).toLowerCase();
  assert.ok(same(ws.cwd, ws.path), 'selecting the repository root keeps the writer at the worktree root');
  const writerCall = calls().find((c) => c.cli === 'codex' && c.cwd && existsSync(c.cwd) && same(c.cwd, ws.cwd));
  assert.ok(writerCall, `the writer ran in the worktree: ${JSON.stringify({ workspace: ws, calls: calls().slice(-2) })}`);
  assert.ok(existsSync(join(ws.path, 'duo-fake.txt')), `the writer wrote inside the worktree: ${JSON.stringify({ workspace: ws, args: writerCall.args })}`);
  assert.ok(!existsSync(join(repo, 'duo-fake.txt')), 'the user folder is untouched until Apply');
  const r = finishWorkspace(ws, 'apply', m.title);
  assert.ok(r.ok, r.message);
  assert.ok(existsSync(join(repo, 'duo-fake.txt')), 'applied to the user folder');
  assert.ok(!existsSync(ws.path), 'the worktree is gone');
});

test('continued ask and debate runs retain their template snapshot and model sessions', async () => {
  const { continueRun } = await import('../src/protocols/continue.ts');
  for (const protocol of ['ask', 'debate']) {
    const ctx = ctxFor(protocol, ['codex:gpt-6-sol@low', 'claude:sonnet@low']);
    if (protocol === 'ask') await ask(ctx); else await debate(ctx);
    let next: ReturnType<typeof RunContext.create> | undefined;
    await continueRun(cfg, ctx.store.meta.id, 'Focus on the unresolved constraint', { rounds: 2, quiet: true, safe: false, onContext: (c) => { next = c; } });
    assert.equal(next!.store.meta.status, 'completed');
    assert.deepEqual(next!.store.meta.options.template, ctx.store.meta.options.template);
    for (const seat of ctx.store.meta.seats.filter((s) => s.role === 'participant')) {
      const resumed = next!.store.meta.seats.find((s) => s.id === seat.id && s.role === 'participant')!;
      assert.equal(resumed.codexThreadId, seat.codexThreadId); assert.equal(resumed.claudeSessionId, seat.claudeSessionId);
    }
    assert.ok(next!.store.meta.turns[0].round > ctx.store.meta.turns[0].round);
  }
});
test('a copied pair template continues on the same workspace with the same definition', async () => {
  const { continueRun } = await import('../src/protocols/continue.ts');
  const { builtinTemplate } = await import('../src/templates/builtins.ts');
  const repo = join(tmp, 'continued-pair');
  execFileSync('git', ['init', '-q', repo]); writeFileSync(join(repo, 'README.md'), '# demo\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  const ctx = ctxFor('pair', ['codex:gpt-6-sol@low', 'claude:sonnet@low'], { cwd: repo, rounds: 1 });
  ctx.opts.extra.template = { ...builtinTemplate('pair'), id: 'pair-copy' };
  await pair(ctx, { isolation: 'worktree', writerAccess: 'sandboxed' });
  let next: ReturnType<typeof RunContext.create> | undefined;
  await continueRun(cfg, ctx.store.meta.id, 'Check the existing implementation again', { rounds: 1, quiet: true, safe: false, onContext: (c) => { next = c; } });
  assert.equal(next!.store.meta.status, 'completed');
  assert.deepEqual(next!.store.meta.options.template, ctx.store.meta.options.template);
  assert.equal(next!.store.meta.workspace!.path, ctx.store.meta.workspace!.path);
  assert.equal(next!.store.meta.turns[0].round, 2);
  const result = finishWorkspace(next!.store.meta.workspace!, 'discard', next!.store.meta.title); assert.ok(result.ok, result.message);
});

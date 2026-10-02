import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexOverrides, formatSeat, parseSeat, SeatError } from '../src/seats.ts';

const D = { codexModel: 'gpt-6-sol', claudeModel: 'opus', claudeEffort: 'high' };

test('full codex spec with options', () => {
  const s = parseSeat('codex:gpt-6-astra@xhigh+verbosity=high+summary=detailed+web=live+fast', 'A', D);
  assert.equal(s.engine, 'codex');
  assert.equal(s.model, 'gpt-6-astra');
  assert.equal(s.effort, 'xhigh');
  assert.equal(s.verbosity, 'high');
  assert.equal(s.summary, 'detailed');
  assert.equal(s.web, 'live');
  assert.equal(s.tier, 'fast');
  assert.deepEqual(codexOverrides(s), ['model_reasoning_effort="xhigh"', 'model_verbosity="high"', 'model_reasoning_summary="detailed"', 'web_search="live"', 'service_tier="fast"']);
});

test('every Codex effort level reaches the CLI (claw drops none and minimal)', () => {
  assert.deepEqual(codexOverrides(parseSeat('codex:gpt-6-luna@minimal', 'A', D)), ['model_reasoning_effort="minimal"']);
  assert.deepEqual(codexOverrides(parseSeat('codex:gpt-6-luna@none', 'A', D)), ['model_reasoning_effort="none"']);
});

test('defaults fill model and effort', () => {
  assert.equal(parseSeat('codex', 'A', D).model, 'gpt-6-sol');
  const c = parseSeat('claude', 'B', D);
  assert.equal(c.model, 'opus');
  assert.equal(c.effort, 'high');
  assert.equal(parseSeat('cx:gpt-6-luna', 'A', D).engine, 'codex');
});

test('format round-trips', () => {
  const spec = 'claude:sonnet@medium+web+dir=/tmp/x+name=Skeptic';
  assert.equal(formatSeat(parseSeat(spec, 'A', D)), spec);
});

test('rejects bad efforts, unknown options and engine mismatches', () => {
  assert.throws(() => parseSeat('claude:opus@ultra', 'A', D), SeatError);
  assert.throws(() => parseSeat('codex:gpt-6-sol+bogus', 'A', D), SeatError);
  assert.throws(() => parseSeat('claude:opus+verbosity=high', 'A', D), SeatError);
  assert.throws(() => parseSeat('codex:x+fetch', 'A', D), SeatError);
  assert.throws(() => parseSeat('mistral:large', 'A', D), SeatError);
});

test('raw cfg is allowed but never for sandbox/approval/shell keys', () => {
  assert.deepEqual(parseSeat('codex:gpt-6-sol+cfg:model_supports_reasoning_summaries=true', 'A', D).cfg, { model_supports_reasoning_summaries: 'true' });
  for (const k of ['sandbox_mode', 'approval_policy', 'shell_environment_policy.inherit', 'mcp_servers.x.command', 'sandbox_workspace_write.network_access']) {
    assert.throws(() => parseSeat(`codex:gpt-6-sol+cfg:${k}="x"`, 'A', D), SeatError, k);
  }
});

test('safe mode refuses cfg passthrough and WebFetch', () => {
  assert.throws(() => parseSeat('codex:gpt-6-sol+cfg:model_verbosity="high"', 'A', D, { safe: true }), /duo-safe/);
  assert.throws(() => parseSeat('claude:opus+fetch', 'A', D, { safe: true }), /duo-safe/);
  assert.equal(parseSeat('claude:opus+web', 'A', D, { safe: true }).web, 'on');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyError, errorHint } from '../src/errors.ts';
import { _test, rewriteCodexArgs } from '../src/hooks.ts';
import { codexCredits, codexRate } from '../src/pricing.ts';
import { parseCodexStream } from '../src/tap.ts';

test('errors from real runs are classified so duo neither retries the hopeless nor gives up on the transient', () => {
  assert.equal(classifyError("API Error: 400 Claude Code 2.1.259 does not support this model; version 2.1.280 or newer is required. Run 'claude update'"), 'fatal');
  assert.equal(classifyError('Failed to authenticate: OAuth session expired and could not be refreshed'), 'fatal');
  assert.equal(classifyError('Session not ready. Call start() first.'), 'dead_session');
  assert.equal(classifyError('Reconnecting... 4/5 (stream disconnected before completion: idle timeout waiting for websocket)'), 'transient');
  assert.equal(classifyError('Selected model is at capacity. Please try a different model.'), 'capacity');
  assert.equal(classifyError("You've hit your usage limit. Try again later."), 'quota');
  assert.equal(classifyError(undefined), undefined);
  assert.match(errorHint('version 2.1.280 or newer is required')!, /Update Claude Code/);
  assert.match(errorHint('OAuth session expired')!, /Log in/);
});

test('Codex flags go after exec / exec resume, and the prompt moves to stdin', () => {
  const route = { overrides: ['model_verbosity="low"'], ignoreRules: true };
  assert.deepEqual(rewriteCodexArgs(['exec', '--json', '-C', '/w', 'hello'], route), { args: ['exec', '-c', 'model_verbosity="low"', '--ignore-rules', '--json', '-C', '/w', '-'], stdin: 'hello' });
  assert.deepEqual(rewriteCodexArgs(['exec', 'resume', 'T1', '--json', '- leading dash prompt'], route), { args: ['exec', 'resume', 'T1', '-c', 'model_verbosity="low"', '--ignore-rules', '--json', '-'], stdin: '- leading dash prompt' });
  assert.deepEqual(rewriteCodexArgs(['login', 'status'], route), { args: ['login', 'status'] });
  assert.equal(_test.claudeSessionOf(['-p', '--resume', 'abc', '--model', 'opus']), 'abc');
  assert.equal(_test.claudeSessionOf(['-p', '--session-id', 'xyz']), 'xyz');
});

test('a model newer than the rate card is priced by its family and flagged, not shown as free', () => {
  assert.deepEqual(codexRate('gpt-6.1-sol'), { rate: [50, 2.5, 250], estimated: false });
  const est = codexRate('gpt-6.2-luna');
  assert.equal(est?.estimated, true);
  assert.deepEqual(est?.rate, [2.5, 0.25, 12.5]);
  assert.equal(codexRate('o9-mini'), undefined);
  const u = { input: 1_000_000, cached: 500_000, output: 100_000, reasoning: 0 };
  assert.equal(codexCredits('gpt-6-sol', u), (500_000 * 50 + 500_000 * 5 + 100_000 * 250) / 1e6);
  assert.equal(codexCredits('gpt-6-sol', u, 'fast'), 2 * codexCredits('gpt-6-sol', u)!);
});

test('a Codex turn that completed after reconnects is a success with warnings', () => {
  const raw = [
    { type: 'thread.started', thread_id: 't' },
    { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' },
    { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } },
  ].map((e) => JSON.stringify(e)).join('\n');
  const t = parseCodexStream(raw);
  assert.equal(t.error, undefined);
  assert.equal(t.reply, 'done');
  assert.equal(t.warnings.length, 1);
  const failed = parseCodexStream([{ type: 'turn.failed', error: { message: 'Selected model is at capacity.' } }].map((e) => JSON.stringify(e)).join('\n'));
  assert.equal(failed.error, 'Selected model is at capacity.');
});

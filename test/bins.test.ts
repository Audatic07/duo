import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBinAsync } from '../src/bins.ts';

const script = (code: string) => ({ command: process.execPath, args: ['-e', code], env: { DUO_TEST_BIN_VALUE: 'literal value' }, display: 'test Node script' });

test('async CLI calls preserve BinSpec arguments, environment and failure output', async () => {
  const result = await runBinAsync(script('console.log(process.env.DUO_TEST_BIN_VALUE); console.error("failure details"); process.exitCode = 7;'), [], 3000);
  assert.equal(result.ok, false);
  assert.equal(result.stdout.trim(), 'literal value');
  assert.equal(result.stderr.trim(), 'failure details');
  assert.ok(result.error);
});

test('async CLI startup failures are returned to the caller', async () => {
  const result = await runBinAsync({ command: 'duo-test-nonexistent-executable', args: [], env: {}, display: 'missing' }, [], 3000);
  assert.equal(result.ok, false);
  assert.match(result.error!, /ENOENT/);
});

test('async CLI calls time out and can be aborted during server shutdown', async () => {
  const bin = script('setInterval(() => {}, 1000)');
  const timed = await runBinAsync(bin, [], 100);
  assert.equal(timed.ok, false);
  const controller = new AbortController();
  const pending = runBinAsync(bin, [], 3000, controller.signal);
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.ok, false);
  assert.match(aborted.error!, /abort/i);
});

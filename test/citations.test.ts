import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkEvidence, parseRef } from '../src/citations.ts';

const WS = join(import.meta.dirname, 'fixtures/workspace');
const file = (ref: string, quote: string | null = null) => checkEvidence({ type: 'file', ref, quote }, WS).status;

test('ref formats', () => {
  assert.deepEqual(parseRef('stats.py:10'), { path: 'stats.py', start: 10, end: 10 });
  assert.deepEqual(parseRef('stats.py:8-10'), { path: 'stats.py', start: 8, end: 10 });
  assert.deepEqual(parseRef('stats.py#L8-L10'), { path: 'stats.py', start: 8, end: 10 });
  assert.deepEqual(parseRef('`stats.py`'), { path: 'stats.py', start: undefined, end: undefined });
});

test('paths with spaces and Windows drives (seen in real runs)', () => {
  assert.deepEqual(parseRef('literature research/history_survival_audit.py:284'), { path: 'literature research/history_survival_audit.py', start: 284, end: 284 });
  assert.deepEqual(parseRef('literature research/results.json:303-304'), { path: 'literature research/results.json', start: 303, end: 304 });
  assert.deepEqual(parseRef('C:\\repo\\src\\a.ts:12-14'), { path: 'C:\\repo\\src\\a.ts', start: 12, end: 14 });
  assert.deepEqual(parseRef('notes:2024.md'), { path: 'notes:2024.md', start: undefined, end: undefined });
  assert.equal(parseRef('https://arxiv.org/abs/2605.07755'), undefined);
});

test('verified quote at the cited lines (with slack and wrapped quotes)', () => {
  assert.equal(file('stats.py:10', 'return s[len(s) // 2]'), 'verified');
  assert.equal(file('stats.py:8-10', 's = sorted(xs) ... return s[len(s) // 2]'), 'verified');
  assert.equal(file('stats.py:4', '`return 0`'), 'verified');
});

test('wrong lines, missing quote, missing file', () => {
  assert.equal(file('stats.py:1', 'return s[len(s) // 2]'), 'wrong_lines');
  assert.equal(file('stats.py:10', 'return statistics.median(xs)'), 'quote_not_found');
  assert.equal(file('stats.py:400'), 'wrong_lines');
  assert.equal(file('nope.py:1', 'x'), 'file_missing');
});

test('non-file evidence is not checked', () => {
  assert.equal(checkEvidence({ type: 'command', ref: 'pytest', quote: null }, WS).status, 'not_checked');
});

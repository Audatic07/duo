import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractJson, parseClaudeStream, parseCodexStream } from '../src/tap.ts';

const fx = (f: string) => readFileSync(join(import.meta.dirname, 'fixtures', f), 'utf8');

test('codex exec --json stream (real capture)', () => {
  const t = parseCodexStream(fx('codex-stream.jsonl'));
  assert.match(t.threadId ?? '', /^[0-9a-f-]{36}$/);
  assert.ok(t.usage && t.usage.input > 0 && t.usageIsCumulative);
  assert.ok(t.tools.length > 0 && t.tools.every((x) => x.name === 'shell'));
  const parsed = extractJson(t.reply) as { answer: string };
  assert.equal(typeof parsed.answer, 'string');
});

test('claude stream-json slice (real capture)', () => {
  const t = parseClaudeStream(fx('claude-stream.jsonl'));
  assert.match(t.sessionId ?? '', /^[0-9a-f-]{36}$/);
  assert.ok(t.rateLimits, 'rate_limit_event captured');
  assert.ok(t.usage && t.usage.input > 0 && !t.usageIsCumulative);
  assert.equal(typeof (t.structured as { answer?: string })?.answer, 'string');
  assert.ok(t.tools.length > 0 && t.tools.every((x) => x.output !== undefined), 'tool results attached');
});

test('extractJson tolerates fences and prose', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here:\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('note {"a":3} end'), { a: 3 });
  assert.throws(() => extractJson('no json'));
});

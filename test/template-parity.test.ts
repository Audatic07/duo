import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'duo-parity-'));
process.env.DUO_HOME = join(tmp, 'data'); process.env.DUO_CONFIG = join(tmp, 'config.json');
const { runScenario, SCENARIOS } = await import('./helpers/protocol-scenarios.ts');
const { ask } = await import('../src/protocols/ask.ts');
const { debate } = await import('../src/protocols/debate.ts');
const { review } = await import('../src/protocols/review.ts');
const { council } = await import('../src/protocols/council.ts');
const { pair } = await import('../src/protocols/pair.ts');
const expected = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/templates/legacy-protocols.json'), 'utf8'));
const debates = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/templates/debate-ledger-review.json'), 'utf8'));
after(() => rmSync(tmp, { recursive: true, force: true }));
for (const scenario of SCENARIOS) test(`protocol snapshot: ${scenario} preserves every system prompt, turn, outcome and domain artifact`, async () => {
  assert.deepEqual(await runScenario(scenario, tmp, { ask, debate, review, council, pair }), scenario.startsWith('debate-') ? debates[scenario] : expected[scenario]);
});

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ClaimLedger } from '../src/ledger.ts';
import { asDebateTurn, type DebateTurn } from '../src/schemas.ts';

const WS = join(import.meta.dirname, 'fixtures/workspace');

/**
 * Regression: a real luna-vs-haiku debate where both seats said "agree" in round 3 while holding
 * opposite final positions (each had moved to the other's previous view). The ledger must not call
 * that converged.
 */
test('crossed-over debate is not converged', () => {
  const dir = join(import.meta.dirname, 'fixtures/crossover');
  const ledger = new ClaimLedger(['A', 'B'], WS);
  const files = readdirSync(dir).sort();
  for (const round of [1, 2, 3]) {
    for (const f of files.filter((x) => x.includes(`-r${round}-`))) {
      const seat = f.split('-')[1];
      ledger.update(seat, round, asDebateTurn(JSON.parse(readFileSync(join(dir, f), 'utf8')))!);
    }
    ledger.closeRound(round);
  }
  assert.equal(ledger.verdictsAgree(['A', 'B']), true, 'both claimed agreement');
  assert.equal(ledger.converged(['A', 'B']), false, 'but claims were left unaddressed');
  assert.ok(ledger.openClaims().some((c) => c.owner === 'B'));
});

function turn(claims: [string, string][], stances: [string, string][], verdict: string): DebateTurn {
  return {
    answer: 'x',
    claims: claims.map(([id, text]) => ({ id, text, kind: 'fact', confidence: 0.9, evidence: [] })),
    stances: stances.map(([claim, stance]) => ({ claim, stance, reason: 'r' })),
    concessions: [],
    verdict,
    open_points: [],
    assumptions: [],
    confidence: 0.9,
  };
}

test('genuine convergence, stance flips and withdrawal', () => {
  const l = new ClaimLedger(['A', 'B'], WS);
  l.update('A', 1, turn([['c1', 'p'], ['c2', 'q']], [], 'n/a'));
  l.update('B', 1, turn([['c1', 'r']], [], 'n/a'));
  l.closeRound(1);
  l.update('A', 2, turn([['c1', 'p']], [['B:c1', 'disagree']], 'partial'));
  l.update('B', 2, turn([['c1', 'r']], [['A:c1', 'agree'], ['A:c2', 'disagree']], 'partial'));
  l.closeRound(2);
  assert.equal(l.converged(['A', 'B']), false);
  assert.equal(l.claims.get('A:c2')!.withdrawn, true, 'A dropped c2 in round 2');
  l.update('A', 3, turn([['c1', 'p']], [['B:c1', 'agree']], 'agree'));
  l.update('B', 3, turn([['c1', 'r']], [['A:c1', 'agree']], 'agree'));
  l.closeRound(3);
  assert.equal(l.converged(['A', 'B']), true);
  assert.deepEqual(l.changedMinds().map((f) => `${f.seat} ${f.claim} ${f.from}->${f.to}`), ['A B:c1 disagree->agree']);
});

test('a materially changed claim loses its old stances', () => {
  const l = new ClaimLedger(['A', 'B'], WS);
  l.update('A', 1, turn([['c1', 'p']], [], 'n/a'));
  l.update('B', 2, turn([], [['A:c1', 'agree']], 'agree'));
  assert.equal(l.status(l.claims.get('A:c1')!), 'agreed');
  l.update('A', 2, turn([['c1', 'p, but different']], [], 'agree'));
  assert.equal(l.status(l.claims.get('A:c1')!), 'unaddressed');
});

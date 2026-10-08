import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('CLI rejects invalid round bounds and timeout before launching a model run', () => {
  const temp = mkdtempSync(join(tmpdir(), 'duo-cli-'));
  const root = join(import.meta.dirname, '..');
  try {
    for (const [flags, expected] of [
      [['--rounds', '1001'], /--rounds must/],
      [['--min-rounds', 'bad'], /--min-rounds must/],
      [['--rounds', '2', '--min-rounds', '3'], /cannot exceed/],
      [['--timeout', '0'], /--timeout must/],
    ] as const) {
      const r = spawnSync(process.execPath, [join(root, 'bin/duo.js'), 'debate', '--no-project', '-s', 'codex:gpt-6-sol', '-s', 'claude:sonnet', ...flags, 'Test'], {
        env: { ...process.env, DUO_DEPTH: '', DUO_HOME: join(temp, 'data'), DUO_CONFIG: join(temp, 'config.json'), CODEX_HOME: join(temp, 'codex'), CLAUDE_CONFIG_DIR: join(temp, 'claude'), DUO_CODEX_BIN: join(root, 'test/fakes/codex.mjs'), DUO_CLAUDE_BIN: join(root, 'test/fakes/claude.mjs') }, encoding: 'utf8', timeout: 10000, windowsHide: true,
      });
      assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, expected);
    }
    const runs = join(temp, 'data', 'runs');
    assert.equal(existsSync(runs) ? readdirSync(runs).length : 0, 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

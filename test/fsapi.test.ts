import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitState } from '../src/server/fsapi.ts';

test('Changes treats NUL-delimited rename sources as paths, even when they look like status entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'duo-git-state-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  try {
    git('init', '--quiet');
    const source = ' M source with spaces.txt';
    const target = 'renamed with spaces.txt';
    writeFileSync(join(dir, source), 'rename me\n');
    git('add', '--all');
    git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'initial');
    renameSync(join(dir, source), join(dir, target));
    writeFileSync(join(dir, 'untracked.txt'), 'hello');
    git('add', '--', target, source);
    const state = gitState(dir);
    assert.equal(state.repo, true);
    if (state.repo) assert.deepEqual(state.files, [{ status: 'R', path: target }, { status: '??', path: 'untracked.txt' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'duo-worktree-'));
process.env.DUO_HOME = join(tmp, 'home');
const { prepareWorkspace, discardWorkspace } = await import('../src/worktree.ts');
const repo = join(tmp, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'src', 'example.txt'), 'example\n');
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, 'add', '-A']);
execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
after(() => rmSync(tmp, { recursive: true, force: true }));

test('a selected subfolder stays at the same relative path inside its worktree', () => {
  const ws = prepareWorkspace(join(repo, 'src'), 'nested', 'nested folder', 'worktree');
  try {
    assert.equal(relative(ws.path, ws.cwd), 'src');
    assert.equal(realpathSync.native(ws.repo!), realpathSync.native(repo));
  } finally {
    discardWorkspace(ws);
  }
});

test('a directory alias resolves into the worktree instead of escaping to the original folder', () => {
  const alias = join(tmp, 'alias');
  // Junctions need no elevated symlink permission on Windows.
  symlinkSync(realpathSync.native(repo), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const ws = prepareWorkspace(join(alias, 'src'), 'alias', 'aliased folder', 'worktree');
  try {
    assert.equal(relative(ws.path, ws.cwd), 'src');
    assert.notEqual(realpathSync.native(ws.cwd), realpathSync.native(join(repo, 'src')));
  } finally {
    discardWorkspace(ws);
  }
});

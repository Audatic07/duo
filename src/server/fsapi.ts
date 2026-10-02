/** Folder browsing and git state for the GUI's project picker and Changes panel. */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { IS_WIN } from '../platform.ts';

/** Windows drive roots that exist (C:\, D:\, ...), for browsing above a drive. */
function drives(): string[] {
  const out: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\`;
    if (existsSync(d)) out.push(d);
  }
  return out;
}

export function listDirs(path?: string, showHidden = false) {
  if (IS_WIN && path === '::drives') {
    return { path: '', parent: undefined, home: homedir(), git: false, dirs: drives().map((d) => ({ name: d, path: d, git: false })) };
  }
  const p = resolve(path || homedir());
  if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error(`not a folder: ${p}`);
  const dirs: { name: string; path: string; git: boolean }[] = [];
  for (const d of readdirSync(p, { withFileTypes: true })) {
    if (!(showHidden || !d.name.startsWith('.')) || d.name === 'node_modules' || d.name === '$RECYCLE.BIN' || d.name === 'System Volume Information') continue;
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try {
        isDir = statSync(join(p, d.name)).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) dirs.push({ name: d.name, path: join(p, d.name), git: existsSync(join(p, d.name, '.git')) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const up = dirname(p);
  return { path: p, parent: up !== p ? up : IS_WIN ? '::drives' : undefined, home: homedir(), git: existsSync(join(p, '.git')), dirs };
}

function git(cwd: string, args: string[], max = 4 * 1024 * 1024): string {
  return execFileSync('git', ['-C', cwd, '--no-pager', ...args], { encoding: 'utf8', maxBuffer: max, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}

export function gitState(cwd: string) {
  if (!cwd || !existsSync(cwd)) return { repo: false as const };
  try {
    git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return { repo: false as const };
  }
  let branch = '';
  try {
    branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch {
    branch = '(no commits)';
  }
  let head = '';
  try {
    head = git(cwd, ['log', '-1', '--format=%h %s']).trim();
  } catch {
    /* no commits yet */
  }
  const files = git(cwd, ['status', '--porcelain=v1', '-z'])
    .split('\0')
    .filter(Boolean)
    .filter((l) => /^[ MADRCU?!]{2} /.test(l))
    .map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
  let diff = '';
  try {
    diff = git(cwd, ['diff', '--no-color', '--no-ext-diff', 'HEAD']);
  } catch {
    diff = git(cwd, ['diff', '--no-color', '--no-ext-diff', '--cached']);
  }
  const limit = 400_000;
  return { repo: true as const, branch, head, files, diff: diff.length > limit ? diff.slice(0, limit) + '\n… (diff truncated)\n' : diff };
}

/**
 * Operating-system specifics in one place: where duo keeps its files, how to find an executable,
 * how to run a Node script, and how to show a folder. Everything else stays platform-neutral.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

const home = homedir();

/** Per-user application data: XDG on Linux, Application Support on macOS, LocalAppData on Windows. */
export function dataHome(): string {
  if (IS_WIN) return process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  if (IS_MAC) return join(home, 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME || join(home, '.local', 'share');
}

/** Per-user configuration: XDG on Linux; on macOS and Windows it sits next to the data. */
export function configHome(): string {
  if (IS_WIN) return process.env.APPDATA || join(home, 'AppData', 'Roaming');
  if (IS_MAC) return join(home, 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || join(home, '.config');
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isExecutable(p: string): boolean {
  if (!isFile(p)) return false;
  if (IS_WIN) return true;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH lookup that honours PATHEXT on Windows (claude.exe, codex.cmd, ...). */
export function which(name: string): string | undefined {
  const exts = IS_WIN ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (isExecutable(p)) return p;
    }
  }
  return undefined;
}

/**
 * How to run a Node script with the runtime duo itself runs on. Inside the desktop app that is
 * Electron's bundled Node, which acts as plain Node only with ELECTRON_RUN_AS_NODE set.
 */
export function nodeRunner(): { command: string; env: Record<string, string> } {
  return { command: process.execPath, env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

/** Show a folder in the system file manager. */
export function openFolder(path: string): void {
  if (!existsSync(path)) throw new Error(`no such folder: ${path}`);
  const [cmd, args] = IS_WIN ? ['explorer.exe', [path]] : IS_MAC ? ['open', [path]] : ['xdg-open', [path]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

/** "~/src/app" for display; the full path elsewhere. */
export function tildify(p: string): string {
  return p === home ? '~' : p.startsWith(home + (IS_WIN ? '\\' : '/')) ? '~' + p.slice(home.length) : p;
}

export function expandHome(p: string): string {
  return p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? join(home, p.slice(2)) : p;
}

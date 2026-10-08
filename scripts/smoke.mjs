// Starts the desktop shell without showing a window and checks that the app loads end to end.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = join(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'duo-desktop-smoke-'));
mkdirSync(join(temp, 'desktop'));
const args = [...(process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : []), join(root, 'desktop', 'main.cjs')];
const child = spawn(electron, args, { env: {
  ...process.env,
  DUO_DESKTOP_SMOKE: '1', DUO_NODE: process.execPath,
  DUO_SMOKE_USER_DATA: join(temp, 'desktop'),
  DUO_HOME: join(temp, 'data'), DUO_CONFIG: join(temp, 'config.json'),
  CODEX_HOME: join(temp, 'codex'), CLAUDE_CONFIG_DIR: join(temp, 'claude'),
  DUO_CODEX_BIN: join(root, 'test', 'fakes', 'codex.mjs'),
  DUO_CLAUDE_BIN: join(root, 'test', 'fakes', 'claude.mjs'),
}, stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  process.stderr.write('Desktop smoke timed out after 120 seconds.\n');
  child.kill('SIGKILL');
}, 120_000);
child.stdout.on('data', (d) => {
  out = (out + d).slice(-16000);
  process.stdout.write(d);
});
child.on('error', (e) => {
  process.stderr.write(`Could not launch Electron: ${e.message}\n`);
});
child.on('close', (code) => {
  clearTimeout(timer);
  rmSync(temp, { recursive: true, force: true });
  process.exit(!timedOut && code === 0 && /DUO_DESKTOP_SMOKE OK/.test(out) ? 0 : code || 1);
});

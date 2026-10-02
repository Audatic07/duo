// Starts the desktop shell without showing a window and checks that the app loads end to end.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = join(import.meta.dirname, '..');
const child = spawn(electron, [join(root, 'desktop', 'main.cjs')], { env: { ...process.env, DUO_DESKTOP_SMOKE: '1', DUO_NODE: process.env.DUO_NODE || process.execPath }, stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (d) => {
  out += d;
  process.stdout.write(d);
});
child.on('exit', (code) => process.exit(/DUO_DESKTOP_SMOKE OK/.test(out) ? 0 : code || 1));

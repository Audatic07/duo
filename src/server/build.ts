/** Bundle the GUI (Preact + TSX) with esbuild; rebuilt only when a source file is newer than the bundle. */
import { build } from 'esbuild';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../paths.ts';

export const GUI_DIR = join(PROJECT_ROOT, 'gui');
export const GUI_DIST = join(GUI_DIR, 'dist');

function newest(dir: string): number {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

export async function buildGui(force = false): Promise<void> {
  const out = join(GUI_DIST, 'app.js');
  if (!force && existsSync(out) && statSync(out).mtimeMs >= newest(join(GUI_DIR, 'src'))) return;
  await build({
    entryPoints: [join(GUI_DIR, 'src/main.tsx')],
    bundle: true,
    outdir: GUI_DIST,
    entryNames: 'app',
    format: 'esm',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    target: 'es2022',
    minify: true,
    sourcemap: 'linked',
    legalComments: 'none',
    logLevel: 'silent',
    loader: { '.woff2': 'file', '.woff': 'file' },
    assetNames: '[name]-[hash]',
  });
}

/** Bundle the GUI, checking every imported dependency and generated asset before reusing it. */
import { build } from 'esbuild';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PROJECT_ROOT } from '../paths.ts';

export const GUI_DIR = join(PROJECT_ROOT, 'gui');
export const GUI_DIST = join(GUI_DIR, 'dist');

type Stamp = { path: string; size: number; mtime: number; };
function stamp(root: string, path: string): Stamp {
  const stat = statSync(resolve(root, path));
  return { path, size: stat.size, mtime: stat.mtimeMs };
}
export async function buildGui(force = false, root = PROJECT_ROOT): Promise<void> {
  const dist = join(root, 'gui', 'dist');
  const cache = join(dist, 'build-cache.json');
  if (!force) try {
    const saved = JSON.parse(readFileSync(cache, 'utf8'));
    if (saved.version === 1 && saved.files.length && saved.files.every((f: Stamp) => {
      const now = stamp(root, f.path);
      return now.size === f.size && now.mtime === f.mtime;
    })) return;
  } catch { /* Missing, changed or incomplete bundles are rebuilt. */ }
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, 'gui', 'src/main.tsx')],
    bundle: true,
    outdir: dist,
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
    metafile: true,
  });
  const paths = [...Object.keys(result.metafile.inputs), ...Object.keys(result.metafile.outputs), relative(root, import.meta.filename)];
  writeFileSync(cache, JSON.stringify({ version: 1, files: paths.map((path) => stamp(root, path)) }));
}

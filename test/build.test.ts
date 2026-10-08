import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildGui } from '../src/server/build.ts';

test('GUI caching follows imports outside gui/src and repairs missing CSS assets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'duo-build-'));
  const shared = join(root, 'src', 'shared.ts');
  const out = join(root, 'gui', 'dist', 'app.js');
  const css = join(root, 'gui', 'dist', 'app.css');
  try {
    mkdirSync(join(root, 'gui', 'src'), { recursive: true });
    mkdirSync(join(root, 'src'));
    writeFileSync(shared, 'export const value = "first";');
    writeFileSync(join(root, 'gui', 'src', 'main.tsx'), 'import {value} from "../../src/shared.ts"; import "./styles.css"; console.log(value);');
    writeFileSync(join(root, 'gui', 'src', 'styles.css'), 'body { color: red; }');
    await buildGui(false, root);
    const first = statSync(out).mtimeMs;
    await buildGui(false, root);
    assert.equal(statSync(out).mtimeMs, first, 'unchanged dependencies reuse the bundle');
    writeFileSync(shared, 'export const value = "updated";');
    const future = new Date(Date.now() + 2000); utimesSync(shared, future, future);
    await buildGui(false, root);
    assert.match(readFileSync(out, 'utf8'), /updated/);
    rmSync(css);
    await buildGui(false, root);
    assert.match(readFileSync(css, 'utf8'), /color:red/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

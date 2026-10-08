/** Assemble a portable source release with its lockfile and built GUI; never publish or tag. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a stable semantic version for a release.');
if (lock.version !== version || lock.packages[''].version !== version) throw new Error('Package and lockfile versions disagree.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('The release tag must match package.json.');
for (const path of ['gui/dist/app.js', 'gui/dist/app.css', `docs/releases/${version}.md`])
  if (!existsSync(join(root, path))) throw new Error(`Missing ${path}. Run npm run release:prepare first.`);

const dist = join(root, 'dist'); mkdirSync(dist, { recursive: true });
const staging = mkdtempSync(join(tmpdir(), 'duo-release-'));
const name = `duo-${version}`;
const archive = `${name}-source.tar.gz`;
try {
  const folder = join(staging, name); mkdirSync(folder);
  // This allowlist keeps dependencies, personal configuration and local data out of releases.
  for (const path of ['bin', 'desktop', 'docs', 'gui', 'src', 'skills', 'scripts', 'test', '.github', '.gitignore', '.npmrc', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.gui.json', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE']) {
    cpSync(join(root, path), join(folder, path), { recursive: true, filter: (p) => !p.endsWith('.log') });
  }
  const libraries = ['preact', '@preact/signals', '@preact/signals-core', 'dompurify', 'marked', 'highlight.js', '@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono'];
  const notices = ['# Bundled GUI dependencies', '', 'The following packages are bundled into the GUI. Their original license notices are included below. Other runtime dependencies are installed by npm and carry their own license files.', ''];
  for (const library of libraries) {
    const dir = join(root, 'node_modules', library);
    const info = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const name = library.replaceAll('/', '-').replaceAll('@', '');
    const license = `LICENSES/${name}.txt`;
    mkdirSync(join(folder, 'LICENSES'), { recursive: true });
    cpSync(join(dir, 'LICENSE'), join(folder, license));
    notices.push(`- ${library} ${info.version}: ${info.license} ([license](${license}))`);
  }
  writeFileSync(join(folder, 'THIRD_PARTY_NOTICES.md'), notices.join('\n') + '\n');
  execFileSync('tar', ['-czf', join(dist, archive), '-C', staging, name], { stdio: 'inherit', windowsHide: true });
  const hash = createHash('sha256').update(readFileSync(join(dist, archive))).digest('hex');
  writeFileSync(join(dist, 'SHA256SUMS'), `${hash}  ${archive}\n`);
  cpSync(join(root, 'docs', 'releases', `${version}.md`), join(dist, 'release-notes.md'));
  process.stdout.write(`Prepared ${join(dist, archive)}\nSHA-256: ${hash}\nRelease notes: ${join(dist, 'release-notes.md')}\n`);
} finally { rmSync(staging, { recursive: true, force: true }); }

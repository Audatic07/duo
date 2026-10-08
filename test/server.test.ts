import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = join(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'duo-server-'));
const token = 'server-regression';
const example = JSON.parse(readFileSync(join(root, 'docs/templates/example.json'), 'utf8'));
const child = spawn(process.execPath, [join(root, 'src/server/main.ts'), '--port', '0', '--token', token, '--parent-stdin'], {
  cwd: root,
  env: { ...process.env, DUO_DEPTH: '', DUO_PREBUILT: '1', DUO_HOME: join(temp, 'data'), DUO_CONFIG: join(temp, 'config.json'), CODEX_HOME: join(temp, 'codex'), CLAUDE_CONFIG_DIR: join(temp, 'claude'), DUO_CODEX_BIN: join(root, 'test/fakes/codex.mjs'), DUO_CLAUDE_BIN: join(root, 'test/fakes/claude.mjs'), FAKE_TEMPLATE_FILE: join(root, 'docs/templates/example.json') },
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let err = ''; child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
after(async () => {
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited; clearTimeout(timer);
  rmSync(temp, { recursive: true, force: true });
});
const origin = await new Promise<string>((resolve, reject) => {
  let out = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`server startup timed out: ${err}`)); }, 15000);
  child.once('error', (e) => { clearTimeout(timer); reject(e); });
  child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${err}`)); });
  child.stdout.on('data', (d) => {
    out += d;
    for (const line of out.split('\n')) if (line.startsWith('{')) {
      try { const ready = JSON.parse(line); if (ready.ready) { clearTimeout(timer); resolve(ready.url); } } catch { /* incomplete line */ }
    }
  });
});
async function api(path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(10000) });
  return { status: res.status, data: await res.json() as any };
}
function raw(path: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = request(origin, { path, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.end();
  });
}

test('local APIs reject absent tokens, foreign origins and non-loopback hosts', async () => {
  assert.equal(await raw('/api/templates'), 401);
  assert.equal((await api('/api/templates', 'GET', undefined, { Origin: 'https://example.com' })).status, 401);
  assert.equal(await raw('/api/templates', { Host: 'example.com', Authorization: `Bearer ${token}` }), 421);
  assert.equal((await api('/api/templates')).status, 200);
});
test('a malformed request URL cannot crash the local engine', async () => {
  assert.equal(await raw('http://['), 400);
  assert.equal((await api('/api/templates')).status, 200);
});
test('malformed template JSON produces repairable validation errors through the API', async () => {
  const t = structuredClone(example);
  t.steps.propose = { type: 'operation', use: 42, next: 'done' };
  const r = await api('/api/templates/validate', 'POST', t);
  assert.equal(r.status, 200); assert.ok(r.data.errors.length);
  const invalid = await fetch(origin + '/api/templates', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{' });
  assert.equal(invalid.status, 400);
});
test('template catalog API saves, loads and deletes user methods while protecting built-ins', async () => {
  const t = { ...example, id: 'api-method' };
  assert.equal((await api('/api/templates', 'POST', t)).status, 200);
  assert.deepEqual((await api('/api/templates/api-method')).data, t);
  assert.ok((await api('/api/templates')).data.some((e: any) => e.template.id === t.id && !e.builtin));
  assert.equal((await api('/api/templates/ask', 'DELETE')).status, 400);
  assert.equal((await api('/api/templates/api-method', 'DELETE')).status, 200);
  assert.match((await api('/api/templates/api-method')).data.error, /No template/);
});
test('invalid run and continuation limits or a file used as a folder fail before a run starts', async () => {
  const base = { protocol: 'debate', seats: ['codex:gpt-6-sol', 'claude:sonnet'], noProject: true, brief: 'Test', rounds: 2 };
  assert.match((await api('/api/runs', 'POST', { ...base, minRounds: 3 })).data.error, /cannot exceed/);
  const file = join(temp, 'file.txt'); writeFileSync(file, 'not a folder');
  assert.match((await api('/api/runs', 'POST', { ...base, noProject: false, cwd: file })).data.error, /not a directory/);
  assert.match((await api('/api/runs/nonexistent/continue', 'POST', { rounds: 'bad' })).data.error, /rounds must/);
  assert.deepEqual((await api('/api/runs')).data, []);
});
test('API custom runs finish with their definition and workflow state recorded', async () => {
  const start = await api('/api/runs', 'POST', { protocol: 'custom', template: example, seats: ['codex:gpt-6-sol', 'claude:sonnet'], noProject: true, brief: 'Compare designs' });
  assert.equal(start.status, 200);
  let run: any;
  const deadline = Date.now() + 8000;
  do {
    run = (await api(`/api/runs/${start.data.id}`)).data;
    if (run.meta.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  assert.equal(run.meta.status, 'completed');
  assert.deepEqual(run.template, example);
  assert.equal(run.coordination.stop.status, 'completed');
});
test('API model authoring returns a validated draft without adding it to the catalog', async () => {
  const result = await api('/api/templates/generate', 'POST', { description: 'A proposes, B challenges, A decides.', model: 'codex:gpt-6-sol' });
  assert.equal(result.status, 200); assert.deepEqual(result.data.template, example);
  assert.deepEqual((await api(`/api/runs/${result.data.run}`)).data.draftTemplate, example, 'the draft can be reopened from its authoring run');
  assert.equal((await api('/api/templates')).data.some((e: any) => e.template.id === example.id), false);
});

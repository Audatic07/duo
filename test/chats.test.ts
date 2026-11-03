import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const temp = mkdtempSync(join(tmpdir(), 'duo-chats-'));
Object.assign(process.env, { DUO_HOME: temp, DUO_CONFIG: join(temp, 'config.json') });
const { ChatManager } = await import('../src/server/chats.ts');
const { Bus } = await import('../src/server/bus.ts');
const { PermissionBroker } = await import('../src/server/permissions.ts');
const { loadConfig } = await import('../src/config.ts');
const { claudeSink } = await import('../src/hooks.ts');
after(() => rmSync(temp, { recursive: true, force: true }));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(t: import('node:test').TestContext, engine: 'claude' | 'codex' = 'claude') {
  const bus = new Bus();
  const events: any[] = [];
  t.mock.method(bus, 'emit', (e: any) => { events.push(structuredClone(e)); });
  const perms = new PermissionBroker(bus);
  const bin = { command: process.execPath, args: [], env: {}, display: 'mock' };
  const cm = new ChatManager(bus, loadConfig(), { claude: bin, codex: bin }, perms, { url: 'http://127.0.0.1:1', token: 'private-test-token' }, 'mock-mcp.ts');
  const manager = (cm as any).manager;
  const stopped: string[] = [];
  t.mock.method(manager, 'startSession', async () => ({}));
  t.mock.method(manager, 'stopSession', async (name: string) => { stopped.push(name); });
  t.mock.method(manager, 'hasSession', () => true);
  const chat = cm.create({ engine, cwd: temp });
  t.after(() => cm.close());
  return { cm, chat, manager, events, stopped, perms };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'chat operation timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('stopping during session startup retires the late session without sending a prompt', async (t) => {
  const { cm, chat, manager, stopped } = setup(t);
  const gate = deferred();
  t.mock.method(manager, 'startSession', async () => { await gate.promise; return {}; });
  const send = t.mock.method(manager, 'sendMessage', async () => ({}));
  const turn = cm.send(chat.id, 'hello');
  assert.equal(cm.stop(chat.id), true);
  gate.resolve();
  await waitFor(() => turn.status !== 'running');
  assert.equal(turn.status, 'stopped');
  assert.equal(send.mock.callCount(), 0);
  assert.equal(stopped.length, 1, 'late startup must not leave an idle CLI behind');
});

test('cancellation during a dead-session restart does not send a second prompt', async (t) => {
  const { cm, chat, manager, stopped } = setup(t);
  const restart = deferred();
  let starts = 0;
  t.mock.method(manager, 'startSession', async () => { if (++starts === 2) await restart.promise; return {}; });
  const send = t.mock.method(manager, 'sendMessage', async () => ({ error: 'Session not ready. Call start() first.' }));
  const turn = cm.send(chat.id, 'hello');
  await waitFor(() => starts === 2);
  cm.stop(chat.id);
  restart.resolve();
  await waitFor(() => turn.status !== 'running');
  assert.equal(turn.status, 'stopped');
  assert.equal(send.mock.callCount(), 1);
  assert.ok(stopped.length >= 2, 'the replacement session is retired too');
});

test('deleting a streaming chat cannot recreate its file or publish a late chat summary', async (t) => {
  const { cm, chat, manager, events, perms } = setup(t);
  const reply = deferred<any>();
  const send = t.mock.method(manager, 'sendMessage', () => reply.promise);
  cm.send(chat.id, 'hello');
  await waitFor(() => send.mock.callCount() === 1);
  const permission = perms.request(chat.id, 'Bash', { command: 'echo test' });
  perms.decide(perms.list(chat.id)[0].id, 'allow_session');
  await permission;
  const removing = cm.remove(chat.id);
  reply.resolve({});
  await removing;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(existsSync(join(temp, 'gui/chats', `${chat.id}.json`)), false);
  assert.equal(cm.list().some((c) => c.id === chat.id), false);
  assert.deepEqual(perms.allowedFor(chat.id), []);
  const removed = events.findIndex((e) => e.t === 'chat_removed' && e.id === chat.id);
  assert.ok(removed >= 0);
  assert.equal(events.slice(removed + 1).some((e) => e.chat?.id === chat.id || e.chat === chat.id), false);
});

test('closing while a session starts waits for it and stops the late CLI', async (t) => {
  const { cm, chat, manager, stopped } = setup(t);
  const gate = deferred();
  t.mock.method(manager, 'startSession', async () => { await gate.promise; return {}; });
  t.mock.method(manager, 'sendMessage', async () => ({}));
  const turn = cm.send(chat.id, 'hello');
  const closing = cm.close();
  gate.resolve();
  await closing;
  assert.equal(turn.status, 'stopped');
  assert.equal(stopped.length, 1);
  assert.throws(() => cm.send(chat.id, 'after shutdown'), /closing/);
});

test('a failed chat turn retains partial text and reports an error', async (t) => {
  const { cm, chat, manager } = setup(t);
  t.mock.method(manager, 'sendMessage', async () => {
    // Exercise the same stream hook used by real Claude subprocesses.
    (cm as any).onLine(chat.id, JSON.stringify({ type: 'assistant', message: { id: 'partial', content: [{ type: 'text', text: 'Partial answer' }] } }));
    return { error: 'Failed to authenticate: OAuth session expired' };
  });
  const turn = cm.send(chat.id, 'hello');
  await waitFor(() => turn.status !== 'running');
  assert.equal(turn.status, 'error');
  assert.match(turn.error!, /OAuth session expired/);
  assert.equal(turn.blocks[0].text, 'Partial answer');
  assert.equal(JSON.parse(readFileSync(join(temp, 'gui/chats', `${chat.id}.json`), 'utf8')).turns[0].status, 'error');
});

test('explicit successful CLI completion supersedes recoverable transport errors in both chat engines', async (t) => {
  for (const engine of ['claude', 'codex'] as const) {
    const { cm, chat, manager } = setup(t, engine);
    t.mock.method(manager, 'sendMessage', async () => {
      const events = engine === 'claude'
        ? [{ type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: 'Complete answer' }] } }, { type: 'result', subtype: 'success', is_error: false }]
        : [{ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' }, { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Complete answer' } }, { type: 'turn.completed', usage: {} }];
      for (const e of events) (cm as any).onLine(chat.id, JSON.stringify(e));
      return { error: 'transport closed after completion' };
    });
    const turn = cm.send(chat.id, 'hello');
    await waitFor(() => turn.status !== 'running');
    assert.equal(turn.status, 'done');
    assert.equal(turn.error, undefined);
    assert.ok(turn.blocks.some((b) => b.text === 'Complete answer'));
    await cm.close();
  }
});

test('permission MCP files restrict access to the launch token, including an existing loose file', async (t) => {
  const { cm, chat, manager } = setup(t);
  const path = join(temp, 'gui/mcp', `${chat.id}.json`);
  writeFileSync(path, '{}', { mode: 0o644 });
  chmodSync(path, 0o644);
  t.mock.method(manager, 'sendMessage', async () => ({}));
  const turn = cm.send(chat.id, 'hello');
  await waitFor(() => turn.status !== 'running');
  assert.match(readFileSync(path, 'utf8'), /private-test-token/);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  await cm.close();
  assert.equal(existsSync(path), false, 'shutdown removes the token-bearing file');
  if (chat.claudeSessionId) claudeSink(chat.claudeSessionId, undefined);
});

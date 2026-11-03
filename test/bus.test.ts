import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { test } from 'node:test';
import { Bus } from '../src/server/bus.ts';

class Client extends EventEmitter {
  writableLength = 0;
  destroyed = false;
  frames: string[] = [];
  writeHead() {}
  write(data: string) { this.frames.push(data); return this.writableLength === 0; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}

test('SSE disconnects a stalled reader without delaying healthy readers', (t) => {
  const bus = new Bus();
  const slow = new Client();
  const fast = new Client();
  t.after(() => { slow.destroy(); fast.destroy(); });
  bus.add(slow as unknown as ServerResponse);
  bus.add(fast as unknown as ServerResponse);
  slow.writableLength = 2 * 1024 * 1024;
  bus.emit({ t: 'chat_blocks', blocks: [] });
  assert.equal(slow.destroyed, true, 'pending bytes must be bounded per reader');
  assert.match(fast.frames.at(-1)!, /chat_blocks/);
  const count = slow.frames.length;
  bus.emit({ t: 'quota' });
  assert.equal(slow.frames.length, count, 'closed readers are removed');
  assert.match(fast.frames.at(-1)!, /quota/);
});

test('heartbeat writes also evict stalled readers and release their timer', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const bus = new Bus();
  const client = new Client();
  t.after(() => client.destroy());
  bus.add(client as unknown as ServerResponse);
  client.writableLength = 2 * 1024 * 1024;
  t.mock.timers.tick(20_000);
  assert.equal(client.destroyed, true);
  const count = client.frames.length;
  t.mock.timers.tick(40_000);
  assert.equal(client.frames.length, count);
});

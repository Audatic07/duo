#!/usr/bin/env node
// Stand-in for Claude Code's `-p --input-format stream-json --output-format stream-json` in tests.
import { createInterface } from 'node:readline';
import { instance, record, valueOf } from './common.mjs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('2.1.999 (Claude Code)');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'fake' }));
  process.exit(0);
}
const sid = valueOf(args, '--session-id') ?? valueOf(args, '--resume') ?? 'fake-session';
const schema = valueOf(args, '--json-schema');
const mode = process.env.FAKE_CLAUDE_MODE ?? '';
record({ cli: 'claude', args, cwd: process.cwd() });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-fake' });

let turns = 0;
let cost = 0;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.type !== 'user') continue;
  turns++;
  const prompt = (msg.message?.content ?? []).map((c) => c.text ?? '').join('');
  record({ cli: 'claude', turn: turns, session: sid, prompt });
  if (mode === 'old') {
    out({ type: 'result', subtype: 'success', is_error: true, result: "API Error: 400 Claude Code 2.1.259 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.", session_id: sid, user_message_uuids: [msg.uuid], usage: {}, total_cost_usd: 0 });
    continue;
  }
  const text = `claude answer ${turns}: ${prompt.length} chars`;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: `m${turns}` } } });
  out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  out({ type: 'assistant', message: { id: `m${turns}`, content: [{ type: 'text', text }] }, session_id: sid });
  cost += 0.01;
  const structured = schema ? instance(JSON.parse(schema), { answer: text }) : undefined;
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: structured ? JSON.stringify(structured) : text, structured_output: structured, session_id: sid, user_message_uuids: [msg.uuid], usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 20 }, total_cost_usd: cost });
  // Simulate a CLI that goes away between turns (crash, update, laptop sleep).
  if (mode === 'die-after-1' && !args.includes('--resume')) process.exit(0);
}

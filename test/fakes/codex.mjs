#!/usr/bin/env node
// Stand-in for `codex exec --json` in tests: records how it was called and answers in Codex's event format.
import { readFileSync, writeFileSync } from 'node:fs';
import { instance, record, valueOf } from './common.mjs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 0.0.0-fake');
  process.exit(0);
}
if (args[0] === 'login') {
  console.error('Logged in using ChatGPT');
  process.exit(0);
}
if (args[0] === 'debug') {
  console.log(JSON.stringify({ models: [{ slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }] }));
  process.exit(0);
}
if (args[0] !== 'exec') process.exit(2);
const resume = args[1] === 'resume';
const thread = resume ? args[2] : `thread-${process.pid}-${Date.now()}`;
const prompt = args[args.length - 1] === '-' ? readFileSync(0, 'utf8') : args[args.length - 1];
const mode = process.env.FAKE_CODEX_MODE ?? '';
record({ cli: 'codex', args, prompt, cwd: process.cwd(), depth: process.env.DUO_DEPTH ?? null });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

out({ type: 'thread.started', thread_id: thread });
out({ type: 'turn.started' });
if (mode === 'fatal') {
  out({ type: 'error', message: 'unexpected status 400 Bad Request: model_not_found' });
  out({ type: 'turn.failed', error: { message: 'model_not_found: the model does not exist' } });
  process.exit(1);
}
if (mode === 'slow') await new Promise((r) => setTimeout(r, 20_000));
if (mode === 'reconnect') out({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion: idle timeout waiting for websocket)' });

out({ type: 'item.started', item: { id: 'cmd', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' } });
out({ type: 'item.completed', item: { id: 'cmd', type: 'command_execution', command: 'ls', aggregated_output: 'README.md\n', exit_code: 0, status: 'completed' } });

// A writer with a writable sandbox makes a real change, so pair mode has something to diff.
const sandbox = valueOf(args, '--sandbox') ?? (args.find((a) => a.startsWith('sandbox_mode=')) ?? '').split('=')[1]?.replace(/"/g, '');
if (sandbox === 'workspace-write' || sandbox === 'danger-full-access') writeFileSync('duo-fake.txt', `written by the fake writer\n${prompt.split('\n')[0]}\n`);

const schemaPath = valueOf(args, '--output-schema');
const text = schemaPath ? JSON.stringify(instance(JSON.parse(readFileSync(schemaPath, 'utf8')), { answer: `codex answer: ${prompt.length} chars` })) : `codex answer: ${prompt.length} chars`;
out({ type: 'item.completed', item: { id: 'msg', type: 'agent_message', text } });
out({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10 } });

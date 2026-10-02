/**
 * Minimal MCP stdio server with one tool, `approve`, used as Claude Code's --permission-prompt-tool.
 * Claude Code calls it whenever it would ask a person; this forwards the question to the duo GUI
 * server and returns the user's answer in the format Claude Code expects:
 *   {"behavior":"allow","updatedInput":{...}}  or  {"behavior":"deny","message":"..."}
 * Uses node:http rather than fetch, whose default 5-minute header timeout would cut off a user
 * who takes longer to decide.
 */
import { request } from 'node:http';
import { createInterface } from 'node:readline';

const API = new URL(process.env.DUO_API_URL ?? 'http://127.0.0.1:0');
const TOKEN = process.env.DUO_API_TOKEN ?? '';
const CHAT = process.env.DUO_CHAT_ID ?? '';

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ask(args: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({ chat: CHAT, tool: args.tool_name, input: args.input ?? {}, toolUseId: args.tool_use_id });
  return new Promise((resolve) => {
    const req = request(
      { host: API.hostname, port: API.port, path: '/api/internal/permission', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ behavior: 'deny', message: `duo returned an unreadable answer (HTTP ${res.statusCode})` });
          }
        });
      },
    );
    req.setTimeout(0);
    req.on('error', (e) => resolve({ behavior: 'deny', message: `duo GUI unreachable: ${e.message}` }));
    req.end(body);
  });
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let m: { id?: number | string; method?: string; params?: Record<string, any> };
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  switch (m.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'duo', version: '1.0.0' } } });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          tools: [{
            name: 'approve',
            description: 'Ask the user, in the duo window, whether a tool call may run.',
            inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
          }],
        },
      });
      return;
    case 'tools/call': {
      const decision = await ask(m.params?.arguments ?? {});
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
      return;
    }
    case 'ping':
      send({ jsonrpc: '2.0', id: m.id, result: {} });
      return;
    default:
      if (m.id !== undefined && m.method) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
});

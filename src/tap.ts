/**
 * Parsers for the raw CLI streams captured by the seat shims. claw-orchestrator's own event
 * surface is normalized and drops things we want in a trace (Codex reasoning, Claude thinking,
 * rate-limit events, per-tool outputs), so duo reads the untouched streams instead.
 */
import { classifyError } from './errors.ts';
import type { ToolCall, Usage } from './store.ts';

const MAX_TOOL_OUTPUT = 6000;

export interface ParsedTurn {
  reply: string;
  /** Interim messages (Codex "commentary" before the final answer). */
  interim: string[];
  thinking: string[];
  tools: ToolCall[];
  usage?: Usage;
  /** Codex: cumulative for the thread. Claude: this turn. */
  usageIsCumulative: boolean;
  costUsd?: number;
  threadId?: string;
  sessionId?: string;
  model?: string;
  rateLimits?: unknown;
  error?: string;
  /** Problems the CLI recovered from (Codex reconnects); kept for the trace, not failures. */
  warnings: string[];
  /** The CLI reported the turn as finished (turn.completed / result). */
  completed: boolean;
  structured?: unknown;
}

function clip(s: string, n = MAX_TOOL_OUTPUT): string {
  return s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s;
}

function lines(raw: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* non-JSON noise */
    }
  }
  return out;
}

/** `codex exec --json` events for one turn (one process). */
export function parseCodexStream(raw: string): ParsedTurn {
  const t: ParsedTurn = { reply: '', interim: [], thinking: [], tools: [], usageIsCumulative: true, warnings: [], completed: false };
  const messages: string[] = [];
  const errors: string[] = [];
  for (const ev of lines(raw)) {
    switch (ev.type) {
      case 'thread.started':
        t.threadId = ev.thread_id;
        break;
      case 'turn.completed': {
        t.completed = true;
        const u = ev.usage || {};
        t.usage = {
          input: u.input_tokens ?? 0,
          cached: u.cached_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          reasoning: u.reasoning_output_tokens ?? 0,
        };
        break;
      }
      case 'turn.failed':
        errors.push(String(ev.error?.message ?? ev.message ?? JSON.stringify(ev)).slice(0, 2000));
        break;
      case 'error': {
        // Codex reports its own reconnect attempts as `error` events and then carries on.
        const msg = String(ev.error?.message ?? ev.message ?? JSON.stringify(ev)).slice(0, 2000);
        (classifyError(msg) === 'transient' ? t.warnings : errors).push(msg);
        break;
      }
      case 'item.completed': {
        const it = ev.item || {};
        switch (it.type) {
          case 'agent_message':
            if (it.text) messages.push(it.text);
            break;
          case 'reasoning':
            if (it.text) t.thinking.push(it.text);
            break;
          case 'command_execution':
            t.tools.push({ name: 'shell', input: String(it.command ?? ''), output: clip(String(it.aggregated_output ?? '')), exitCode: it.exit_code ?? null, error: it.exit_code ? it.exit_code !== 0 : false });
            break;
          case 'file_change':
            t.tools.push({ name: 'patch', input: JSON.stringify(it.changes ?? []).slice(0, 2000), error: it.status === 'failed' });
            break;
          case 'mcp_tool_call':
            t.tools.push({ name: `${it.server}.${it.tool}`, input: JSON.stringify(it.arguments ?? {}).slice(0, 2000), output: clip(JSON.stringify(it.result ?? it.error ?? '')), error: !!it.error });
            break;
          case 'web_search':
            t.tools.push({ name: 'web_search', input: String(it.query ?? '') });
            break;
          case 'error':
            t.warnings.push(String(it.message ?? 'error'));
            break;
        }
        break;
      }
    }
  }
  // The last agent message is the answer; earlier ones are progress notes ("I'll check the file…").
  t.reply = messages.length ? messages[messages.length - 1] : '';
  t.interim = messages.slice(0, -1);
  // A turn that completed despite errors along the way succeeded; those become warnings.
  if (errors.length && t.completed && t.reply) t.warnings.push(...errors);
  else if (errors.length) t.error = errors[errors.length - 1];
  return t;
}

/** Claude Code `--output-format stream-json` events for one turn (a slice of a session's stream). */
export function parseClaudeStream(raw: string): ParsedTurn {
  const t: ParsedTurn = { reply: '', interim: [], thinking: [], tools: [], usageIsCumulative: false, warnings: [], completed: false };
  const pending = new Map<string, ToolCall>();
  for (const ev of lines(raw)) {
    if (ev.session_id && !t.sessionId) t.sessionId = ev.session_id;
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' && ev.model) t.model = ev.model;
        break;
      case 'rate_limit_event':
        t.rateLimits = ev.rate_limit_info;
        break;
      case 'assistant':
        for (const b of ev.message?.content || []) {
          if (b.type === 'thinking' && b.thinking) t.thinking.push(b.thinking);
          else if (b.type === 'tool_use') {
            const call: ToolCall = { name: b.name, input: JSON.stringify(b.input ?? {}).slice(0, 2000) };
            pending.set(b.id, call);
            t.tools.push(call);
          } else if (b.type === 'text' && b.text) t.interim.push(b.text);
        }
        break;
      case 'user':
        for (const b of ev.message?.content || []) {
          if (b.type !== 'tool_result') continue;
          const call = pending.get(b.tool_use_id);
          if (!call) continue;
          const content = Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? '').join('\n') : String(b.content ?? '');
          call.output = clip(content);
          call.error = !!b.is_error;
        }
        break;
      case 'result': {
        t.completed = true;
        const u = ev.usage || {};
        t.usage = {
          input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          cached: u.cache_read_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          reasoning: 0,
        };
        t.costUsd = ev.total_cost_usd;
        if (ev.structured_output !== undefined) t.structured = ev.structured_output;
        t.reply = typeof ev.result === 'string' ? ev.result : '';
        if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) t.error = String(ev.result || ev.subtype || 'error');
        break;
      }
    }
  }
  if (!t.reply && t.interim.length) t.reply = t.interim[t.interim.length - 1];
  t.interim = t.interim.filter((x) => x !== t.reply);
  return t;
}

/** Pull a JSON object out of a model reply (tolerates code fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const s = text.trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(s.slice(first, last + 1));
  throw new Error('no JSON object found');
}

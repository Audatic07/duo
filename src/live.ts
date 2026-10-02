/**
 * Live view of a turn: translate the raw CLI events into UI blocks as they arrive (streaming text,
 * reasoning, tool calls with outputs, patches, plans). Chats and runs both use it.
 */
import { classifyError } from './errors.ts';

export interface Block {
  id: string;
  kind: 'text' | 'thinking' | 'tool' | 'patch' | 'todo' | 'note';
  text?: string;
  name?: string;
  input?: string;
  output?: string;
  status?: 'running' | 'done' | 'error';
  exitCode?: number | null;
  /** Codex: progress notes before the final answer are commentary. */
  phase?: 'commentary' | 'final';
}

const MAX_OUT = 20_000;
const clip = (s: string) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n…[${s.length - MAX_OUT} more chars in the trace]` : s);

export interface TurnFacts {
  usage?: { input: number; cached: number; output: number; reasoning: number };
  costUsd?: number;
  threadId?: string;
  sessionId?: string;
  rateLimits?: unknown;
  error?: string;
  model?: string;
}

abstract class Translator {
  readonly blocks: Block[] = [];
  readonly facts: TurnFacts = {};
  protected readonly byId = new Map<string, Block>();

  protected upsert(id: string, init: Omit<Block, 'id'>, changed: Set<Block>): Block {
    let b = this.byId.get(id);
    if (!b) {
      b = { id, ...init };
      this.byId.set(id, b);
      this.blocks.push(b);
    }
    changed.add(b);
    return b;
  }

  /** Apply raw events; return the blocks that changed. */
  apply(events: Record<string, any>[]): Block[] {
    const changed = new Set<Block>();
    for (const ev of events) this.one(ev, changed);
    return [...changed];
  }

  protected abstract one(ev: Record<string, any>, changed: Set<Block>): void;
}

export class ClaudeTranslator extends Translator {
  private msgId = 'm';
  private readonly indexKey = new Map<number, string>();

  protected one(ev: Record<string, any>, changed: Set<Block>): void {
    if (ev.session_id && !this.facts.sessionId) this.facts.sessionId = ev.session_id;
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init' && ev.model) this.facts.model = ev.model;
        return;
      case 'rate_limit_event':
        this.facts.rateLimits = ev.rate_limit_info;
        return;
      case 'stream_event': {
        const e = ev.event || {};
        if (e.type === 'message_start') {
          this.msgId = e.message?.id ?? `m${Date.now()}`;
          this.indexKey.clear();
        } else if (e.type === 'content_block_start') {
          const cb = e.content_block || {};
          if (cb.type === 'text') this.indexKey.set(e.index, this.upsert(`${this.msgId}:${e.index}`, { kind: 'text', text: cb.text ?? '', status: 'running' }, changed).id);
          else if (cb.type === 'thinking') this.indexKey.set(e.index, this.upsert(`${this.msgId}:${e.index}`, { kind: 'thinking', text: '', status: 'running' }, changed).id);
          else if (cb.type === 'tool_use' || cb.type === 'server_tool_use') this.indexKey.set(e.index, this.upsert(cb.id, { kind: 'tool', name: cb.name, input: '', status: 'running' }, changed).id);
        } else if (e.type === 'content_block_delta') {
          const key = this.indexKey.get(e.index);
          const b = key ? this.byId.get(key) : undefined;
          if (!b) return;
          const d = e.delta || {};
          if (d.type === 'text_delta') b.text = (b.text ?? '') + d.text;
          else if (d.type === 'thinking_delta') b.text = (b.text ?? '') + d.thinking;
          else if (d.type === 'input_json_delta') b.input = (b.input ?? '') + d.partial_json;
          changed.add(b);
        } else if (e.type === 'content_block_stop') {
          const key = this.indexKey.get(e.index);
          const b = key ? this.byId.get(key) : undefined;
          if (b && b.kind !== 'tool') {
            b.status = 'done';
            changed.add(b);
          }
        }
        return;
      }
      case 'assistant': {
        const id = ev.message?.id ?? this.msgId;
        (ev.message?.content || []).forEach((c: any, i: number) => {
          if (c.type === 'text') Object.assign(this.upsert(`${id}:${i}`, { kind: 'text' }, changed), { text: c.text, status: 'done' });
          else if (c.type === 'thinking' && c.thinking) Object.assign(this.upsert(`${id}:${i}`, { kind: 'thinking' }, changed), { text: c.thinking, status: 'done' });
          else if (c.type === 'tool_use' || c.type === 'server_tool_use') {
            const b = this.upsert(c.id, { kind: 'tool', name: c.name, status: 'running' }, changed);
            b.input = JSON.stringify(c.input ?? {}, null, 2);
          }
        });
        return;
      }
      case 'user':
        for (const c of ev.message?.content || []) {
          if (c.type !== 'tool_result') continue;
          const b = this.byId.get(c.tool_use_id);
          if (!b) continue;
          const content = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? (x.type === 'image' ? '[image]' : '')).join('\n') : String(c.content ?? '');
          b.output = clip(content);
          b.status = c.is_error ? 'error' : 'done';
          changed.add(b);
        }
        return;
      case 'result': {
        const u = ev.usage || {};
        this.facts.usage = {
          input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          cached: u.cache_read_input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          reasoning: 0,
        };
        this.facts.costUsd = ev.total_cost_usd;
        if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) this.facts.error = String(ev.result || ev.subtype || 'error');
        for (const b of this.blocks) if (b.status === 'running') { b.status = 'done'; changed.add(b); }
        return;
      }
    }
  }
}

export class CodexTranslator extends Translator {
  protected one(ev: Record<string, any>, changed: Set<Block>): void {
    switch (ev.type) {
      case 'thread.started':
        this.facts.threadId = ev.thread_id;
        return;
      case 'turn.completed': {
        const u = ev.usage || {};
        this.facts.usage = { input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, output: u.output_tokens ?? 0, reasoning: u.reasoning_output_tokens ?? 0 };
        // Errors on the way did not stop the turn.
        this.facts.error = undefined;
        return;
      }
      case 'turn.failed':
      case 'error': {
        const msg = String(ev.error?.message ?? ev.message ?? 'error');
        // Codex announces its own reconnect attempts as errors and then carries on.
        const transient = ev.type === 'error' && classifyError(msg) === 'transient';
        if (!transient) this.facts.error = msg;
        Object.assign(this.upsert(transient ? 'reconnect' : `err-${this.blocks.length}`, { kind: 'note' }, changed), { text: msg, status: transient ? 'done' : 'error' });
        return;
      }

      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const it = ev.item || {};
        const done = ev.type === 'item.completed';
        const id = String(it.id ?? `i${this.blocks.length}`);
        switch (it.type) {
          case 'agent_message':
            Object.assign(this.upsert(id, { kind: 'text' }, changed), { text: it.text ?? '', status: done ? 'done' : 'running' });
            return;
          case 'reasoning':
            if (it.text) Object.assign(this.upsert(id, { kind: 'thinking' }, changed), { text: it.text, status: done ? 'done' : 'running' });
            return;
          case 'command_execution': {
            const b = this.upsert(id, { kind: 'tool', name: 'shell' }, changed);
            b.input = String(it.command ?? '');
            if (it.aggregated_output !== undefined) b.output = clip(String(it.aggregated_output));
            b.exitCode = it.exit_code ?? null;
            b.status = !done ? 'running' : it.exit_code ? 'error' : 'done';
            return;
          }
          case 'file_change': {
            const b = this.upsert(id, { kind: 'patch' }, changed);
            b.text = (it.changes || []).map((c: any) => `${c.kind ?? 'update'} ${c.path}`).join('\n');
            b.status = !done ? 'running' : it.status === 'failed' ? 'error' : 'done';
            return;
          }
          case 'mcp_tool_call': {
            const b = this.upsert(id, { kind: 'tool', name: `${it.server}.${it.tool}` }, changed);
            b.input = JSON.stringify(it.arguments ?? {}, null, 2);
            if (done) b.output = clip(JSON.stringify(it.result ?? it.error ?? '', null, 2));
            b.status = !done ? 'running' : it.error ? 'error' : 'done';
            return;
          }
          case 'web_search':
            Object.assign(this.upsert(id, { kind: 'tool', name: 'web_search' }, changed), { input: String(it.query ?? ''), status: done ? 'done' : 'running' });
            return;
          case 'todo_list':
            Object.assign(this.upsert(id, { kind: 'todo' }, changed), { text: JSON.stringify(it.items ?? []), status: done ? 'done' : 'running' });
            return;
          case 'error':
            Object.assign(this.upsert(id, { kind: 'note' }, changed), { text: String(it.message ?? 'error'), status: 'error' });
            return;
        }
      }
    }
  }

  /** After the turn: every agent message but the last was a progress note. */
  finalize(): Block[] {
    const texts = this.blocks.filter((b) => b.kind === 'text');
    texts.forEach((b, i) => (b.phase = i === texts.length - 1 ? 'final' : 'commentary'));
    for (const b of this.blocks) if (b.status === 'running') b.status = 'done';
    return texts;
  }
}

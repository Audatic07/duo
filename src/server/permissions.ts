/**
 * "Ask" mode for Claude chats: Claude Code routes every permission decision it would normally put
 * to a person through --permission-prompt-tool, which duo points at a tiny MCP server
 * (permission-mcp.ts). That server long-polls this broker, and the broker waits for a click in the GUI.
 */
import { randomUUID } from 'node:crypto';
import type { Bus } from './bus.ts';

export interface PermissionRequest {
  id: string;
  chat: string;
  tool: string;
  input: unknown;
  at: string;
}

export type Decision = { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string };

const TIMEOUT_MS = 30 * 60_000;

export class PermissionBroker {
  private readonly pending = new Map<string, { req: PermissionRequest; resolve: (d: Decision) => void; timer: NodeJS.Timeout }>();
  private readonly allowedTools = new Map<string, Set<string>>();
  private readonly bus: Bus;

  constructor(bus: Bus) {
    this.bus = bus;
  }

  request(chat: string, tool: string, input: unknown): Promise<Decision> {
    if (this.allowedTools.get(chat)?.has(tool)) return Promise.resolve({ behavior: 'allow', updatedInput: input });
    const req: PermissionRequest = { id: randomUUID(), chat, tool, input, at: new Date().toISOString() };
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.decide(req.id, 'deny', 'No answer in the duo window within 30 minutes.'), TIMEOUT_MS);
      this.pending.set(req.id, { req, resolve, timer });
      this.bus.emit({ t: 'permission', request: req });
    });
  }

  decide(id: string, decision: 'allow' | 'allow_session' | 'deny', message?: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (decision === 'allow_session') {
      const set = this.allowedTools.get(p.req.chat) ?? new Set<string>();
      set.add(p.req.tool);
      this.allowedTools.set(p.req.chat, set);
    }
    p.resolve(decision === 'deny' ? { behavior: 'deny', message: message || 'The user denied this action.' } : { behavior: 'allow', updatedInput: p.req.input });
    this.bus.emit({ t: 'permission_resolved', id, chat: p.req.chat, decision });
    return true;
  }

  list(chat?: string): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.req).filter((r) => !chat || r.chat === chat);
  }

  /** A stopped turn cannot use its pending answers any more. */
  cancelChat(chat: string): void {
    for (const r of this.list(chat)) this.decide(r.id, 'deny', 'The turn was stopped.');
  }

  allowedFor(chat: string): string[] {
    return [...(this.allowedTools.get(chat) ?? [])];
  }

  forgetAllowed(chat: string): void {
    this.allowedTools.delete(chat);
  }
}

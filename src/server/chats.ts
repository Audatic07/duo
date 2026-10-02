/**
 * Interactive chats with Claude Code or Codex, the part of the GUI that replaces the two desktop
 * apps. One claw SessionManager hosts every chat; the spawn hook hands each chat its CLI's raw
 * event stream, which is translated into blocks for the window as it arrives.
 */
import { SessionManager, nullLogger } from '@enderfga/claw-orchestrator';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BinSpec } from '../bins.ts';
import type { Config } from '../config.ts';
import { withCodexBin } from '../engine.ts';
import { DEPTH_VAR } from '../env.ts';
import { classifyError, errorHint } from '../errors.ts';
import { claudeRoute, claudeSink, codexRoute, dropCodexRoute } from '../hooks.ts';
import { ClaudeTranslator, CodexTranslator, type Block } from '../live.ts';
import { DUO_HOME } from '../paths.ts';
import { nodeRunner } from '../platform.ts';
import { codexCredits } from '../pricing.ts';
import { saveClaudeQuota, snapshot } from '../quota.ts';
import { codexOverrides, parseSeat, type Seat } from '../seats.ts';
import type { Usage } from '../store.ts';
import type { Bus } from './bus.ts';
import type { PermissionBroker } from './permissions.ts';

const GUI_DIR = join(DUO_HOME, 'gui');
const CHATS_DIR = join(GUI_DIR, 'chats');
const TAPS_DIR = join(GUI_DIR, 'taps');
const MCP_DIR = join(GUI_DIR, 'mcp');

export type Engine = 'claude' | 'codex';

/** Claude permission modes, as the GUI names them. "ask", "edits" and "auto" route prompts to the window. */
export const CLAUDE_ACCESS: Record<string, { mode: string; prompts: boolean; label: string }> = {
  plan: { mode: 'plan', prompts: false, label: 'Plan (read-only)' },
  ask: { mode: 'manual', prompts: true, label: 'Ask before acting' },
  edits: { mode: 'acceptEdits', prompts: true, label: 'Auto-accept edits' },
  auto: { mode: 'auto', prompts: true, label: 'Auto mode' },
  full: { mode: 'bypassPermissions', prompts: false, label: 'Full access' },
};

export const CODEX_ACCESS: Record<string, { sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'; label: string }> = {
  'read-only': { sandbox: 'read-only', label: 'Read-only' },
  workspace: { sandbox: 'workspace-write', label: 'Workspace write' },
  full: { sandbox: 'danger-full-access', label: 'Full access' },
};

export interface ChatTurn {
  id: string;
  user: string;
  at: string;
  spec: string;
  access: string;
  blocks: Block[];
  status: 'running' | 'done' | 'error' | 'stopped';
  durationMs?: number;
  usage?: Usage;
  credits?: number;
  usd?: number;
  error?: string;
  hint?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  engine: Engine;
  spec: string;
  access: string;
  cwd: string;
  useCodexConfig: boolean;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  claudeSessionId?: string;
  claudeStarted?: boolean;
  codexThreadId?: string;
  codexTotals?: Usage;
  claudeCost?: number;
  turns: ChatTurn[];
}

export type ChatSummary = Omit<ChatSession, 'turns' | 'codexTotals'> & { turnCount: number; running: boolean; lastText?: string; draft?: boolean };

interface LiveTurn {
  turn: ChatTurn;
  translator: ClaudeTranslator | CodexTranslator;
  pending: Set<Block>;
  timer?: ReturnType<typeof setTimeout>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ChatManager {
  private readonly manager: SessionManager;
  private readonly sessions = new Map<string, ChatSession>();
  /** Chats created in the window but not sent to yet: kept in memory only, so empty chats never pile up. */
  private readonly drafts = new Set<string>();
  private readonly live = new Map<string, { clawName: string; key: string; route?: string }>();
  private readonly running = new Map<string, { turn: ChatTurn; stop: () => void }>();
  private readonly current = new Map<string, LiveTurn>();
  private readonly bus: Bus;
  private readonly cfg: Config;
  private readonly bins: { codex: BinSpec; claude: BinSpec };
  private readonly perms: PermissionBroker;
  private readonly api: { url: string; token: string };
  private readonly mcpScript: string;

  constructor(bus: Bus, cfg: Config, bins: { codex: BinSpec; claude: BinSpec }, perms: PermissionBroker, api: { url: string; token: string }, mcpScript: string) {
    this.bus = bus;
    this.cfg = cfg;
    this.bins = bins;
    this.perms = perms;
    this.api = api;
    this.mcpScript = mcpScript;
    for (const d of [CHATS_DIR, TAPS_DIR, MCP_DIR]) mkdirSync(d, { recursive: true });
    this.manager = new SessionManager(
      { claudeBin: claudeRoute('gui', bins.claude), maxConcurrentSessions: 64, sessionTtlMinutes: 12 * 60 },
      nullLogger,
    );
    this.load();
  }

  private load(): void {
    for (const f of readdirSync(CHATS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const path = join(CHATS_DIR, f);
      try {
        const s = JSON.parse(readFileSync(path, 'utf8')) as ChatSession;
        // Earlier versions saved a chat as soon as it was opened; an empty one carries nothing.
        if (!s.turns.length && Date.now() - statSync(path).mtimeMs > 10 * 60_000) {
          rmSync(path, { force: true });
          continue;
        }
        // A turn that was running when the app closed can't be finished any more.
        for (const t of s.turns) if (t.status === 'running') t.status = 'stopped';
        this.sessions.set(s.id, s);
      } catch {
        /* skip a corrupt file */
      }
    }
  }

  private save(s: ChatSession): void {
    if (this.drafts.has(s.id)) return;
    const path = join(CHATS_DIR, `${s.id}.json`);
    writeFileSync(path + '.tmp', JSON.stringify(s));
    renameSync(path + '.tmp', path);
  }

  summary(s: ChatSession): ChatSummary {
    const { turns, codexTotals: _t, ...rest } = s;
    const last = turns[turns.length - 1];
    const lastText = last?.blocks.filter((b) => b.kind === 'text').pop()?.text;
    return { ...rest, turnCount: turns.length, running: this.running.has(s.id), lastText: lastText?.slice(0, 140), draft: this.drafts.has(s.id) || undefined };
  }

  list(): ChatSummary[] {
    return [...this.sessions.values()]
      .filter((s) => !this.drafts.has(s.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => this.summary(s));
  }

  get(id: string): ChatSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no chat ${id}`);
    return s;
  }

  private validate(engine: Engine, spec: string, access: string): Seat {
    const seat = parseSeat(spec, 'A', this.cfg.defaults);
    if (seat.engine !== engine) throw new Error(`a ${engine} chat needs a ${engine} seat (got ${spec})`);
    const table = engine === 'claude' ? CLAUDE_ACCESS : CODEX_ACCESS;
    if (!table[access]) throw new Error(`unknown access "${access}" for ${engine} (${Object.keys(table).join(', ')})`);
    return seat;
  }

  create(o: { engine: Engine; spec?: string; access?: string; cwd: string; useCodexConfig?: boolean; title?: string }): ChatSession {
    const d = o.engine === 'claude' ? this.cfg.gui.claude : this.cfg.gui.codex;
    const spec = o.spec ?? d.spec;
    const access = o.access ?? d.access;
    this.validate(o.engine, spec, access);
    if (!existsSync(o.cwd)) throw new Error(`folder does not exist: ${o.cwd}`);
    const now = new Date().toISOString();
    const s: ChatSession = {
      id: randomUUID(),
      title: o.title ?? 'New chat',
      engine: o.engine,
      spec,
      access,
      cwd: o.cwd,
      useCodexConfig: o.useCodexConfig ?? this.cfg.gui.codex.useConfig,
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    this.sessions.set(s.id, s);
    this.drafts.add(s.id);
    return s;
  }

  update(id: string, patch: Partial<Pick<ChatSession, 'title' | 'spec' | 'access' | 'useCodexConfig' | 'cwd' | 'pinned'>>): ChatSession {
    const s = this.get(id);
    if (patch.spec !== undefined || patch.access !== undefined) this.validate(s.engine, patch.spec ?? s.spec, patch.access ?? s.access);
    if (patch.cwd !== undefined && !existsSync(patch.cwd)) throw new Error(`folder does not exist: ${patch.cwd}`);
    Object.assign(s, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    if (patch.title === undefined && patch.pinned === undefined) s.updatedAt = new Date().toISOString();
    this.save(s);
    if (!this.drafts.has(s.id)) this.bus.emit({ t: 'chat', chat: this.summary(s) });
    return s;
  }

  async remove(id: string): Promise<void> {
    this.running.get(id)?.stop();
    const l = this.live.get(id);
    if (l) {
      await this.manager.stopSession(l.clawName).catch(() => undefined);
      if (l.route) dropCodexRoute(l.route);
    }
    const s = this.sessions.get(id);
    if (s?.claudeSessionId) claudeSink(s.claudeSessionId, undefined);
    this.live.delete(id);
    this.sessions.delete(id);
    this.drafts.delete(id);
    rmSync(join(CHATS_DIR, `${id}.json`), { force: true });
    rmSync(join(MCP_DIR, `${id}.json`), { force: true });
    this.bus.emit({ t: 'chat_removed', id });
  }

  private mcpConfig(chat: string): string {
    const path = join(MCP_DIR, `${chat}.json`);
    const node = nodeRunner();
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        duo: {
          type: 'stdio',
          command: node.command,
          args: [this.mcpScript],
          env: { ...node.env, DUO_API_URL: this.api.url, DUO_API_TOKEN: this.api.token, DUO_CHAT_ID: chat },
        },
      },
    }));
    return path;
  }

  /** Raw stream line from this chat's CLI: keep it for the trace and update the live view. */
  private onLine(chatId: string, line: string): void {
    try {
      appendFileSync(join(TAPS_DIR, `${chatId}.jsonl`), line + '\n');
    } catch {
      /* trace is best effort */
    }
    const cur = this.current.get(chatId);
    if (!cur) return;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    for (const b of cur.translator.apply([ev])) cur.pending.add(b);
    if (!cur.timer && cur.pending.size) cur.timer = setTimeout(() => this.flush(chatId), 90);
  }

  private flush(chatId: string): void {
    const cur = this.current.get(chatId);
    if (!cur) return;
    clearTimeout(cur.timer);
    cur.timer = undefined;
    if (!cur.pending.size) return;
    const changed = [...cur.pending];
    cur.pending.clear();
    cur.turn.blocks = cur.translator.blocks;
    this.bus.emit({ t: 'chat_blocks', chat: chatId, turn: cur.turn.id, blocks: changed });
  }

  /** Start (or restart with the new settings, resuming the conversation) the claw session behind a chat. */
  private async ensureLive(s: ChatSession, force = false): Promise<string> {
    const key = `${s.spec}|${s.access}|${s.useCodexConfig}|${s.cwd}`;
    const cur = this.live.get(s.id);
    if (!force && cur && cur.key === key && this.manager.hasSession(cur.clawName)) return cur.clawName;
    if (cur) {
      await this.manager.stopSession(cur.clawName).catch(() => undefined);
      if (cur.route) dropCodexRoute(cur.route);
    }
    this.live.delete(s.id);
    const seat = this.validate(s.engine, s.spec, s.access);
    const clawName = `gui-${s.id.slice(0, 8)}-${Date.now().toString(36)}`;
    let route: string | undefined;
    if (seat.engine === 'codex') {
      route = codexRoute(`chat-${s.id}-${Date.now().toString(36)}`, {
        bin: this.bins.codex,
        overrides: [...codexOverrides(seat), `shell_environment_policy.set={${DEPTH_VAR}="1"}`],
        ignoreRules: false,
        onLine: (line) => this.onLine(s.id, line),
      });
      await withCodexBin(route, () => this.manager.startSession({
        name: clawName,
        engine: 'codex',
        cwd: s.cwd,
        model: seat.model,
        effort: seat.effort as any,
        sandboxMode: CODEX_ACCESS[s.access].sandbox,
        ignoreUserConfig: !s.useCodexConfig,
        skipPersistence: true,
        permissionMode: 'dontAsk',
        ...(s.codexThreadId ? { resumeSessionId: s.codexThreadId } : {}),
      }));
    } else {
      const a = CLAUDE_ACCESS[s.access];
      if (!s.claudeSessionId) s.claudeSessionId = randomUUID();
      claudeSink(s.claudeSessionId, (line) => this.onLine(s.id, line));
      await this.manager.startSession({
        name: clawName,
        engine: 'claude',
        cwd: s.cwd,
        model: seat.model,
        effort: seat.effort as any,
        permissionMode: a.mode as any,
        skipPersistence: true,
        crossSessionInbound: 'refuse',
        ...(s.claudeStarted ? { claudeResumeId: s.claudeSessionId } : { customSessionId: s.claudeSessionId }),
        ...(a.prompts ? { permissionPromptTool: 'mcp__duo__approve', mcpConfig: this.mcpConfig(s.id) } : {}),
        ...(seat.addDirs.length ? { addDir: seat.addDirs } : {}),
      });
    }
    this.live.set(s.id, { clawName, key, route });
    return clawName;
  }

  send(id: string, text: string): ChatTurn {
    const s = this.get(id);
    if (this.running.has(id)) throw new Error('this chat is still working; stop it or wait');
    if (!text.trim()) throw new Error('empty message');
    const turn: ChatTurn = { id: randomUUID().slice(0, 8), user: text, at: new Date().toISOString(), spec: s.spec, access: s.access, blocks: [], status: 'running' };
    s.turns.push(turn);
    s.updatedAt = turn.at;
    if (s.title === 'New chat') s.title = text.replace(/\s+/g, ' ').trim().slice(0, 70);
    // The first message turns a draft into a real chat.
    this.drafts.delete(s.id);
    this.save(s);
    this.bus.emit({ t: 'chat_turn', chat: id, turn });
    this.bus.emit({ t: 'chat', chat: { ...this.summary(s), running: true } });
    void this.runTurn(s, turn, text);
    return turn;
  }

  /** Send the last message again (after an error, a stop, or to try another model). */
  retry(id: string): ChatTurn {
    const s = this.get(id);
    const last = s.turns[s.turns.length - 1];
    if (!last) throw new Error('nothing to retry');
    return this.send(id, last.user);
  }

  stop(id: string): boolean {
    const r = this.running.get(id);
    if (!r) return false;
    r.stop();
    return true;
  }

  private async runTurn(s: ChatSession, turn: ChatTurn, text: string): Promise<void> {
    const started = Date.now();
    let stopped = false;
    let clawName = '';
    this.running.set(s.id, { turn, stop: () => { stopped = true; } });
    try {
      clawName = await this.ensureLive(s);
    } catch (e) {
      return this.endTurn(s, turn, started, { error: `could not start ${s.engine}: ${(e as Error).message}` });
    }
    if (stopped) return this.endTurn(s, turn, started, { stopped: true });

    const fresh = () => {
      const translator = s.engine === 'claude' ? new ClaudeTranslator() : new CodexTranslator();
      this.current.set(s.id, { turn, translator, pending: new Set() });
      return translator;
    };
    let translator = fresh();
    this.running.set(s.id, {
      turn,
      stop: () => {
        stopped = true;
        this.perms.cancelChat(s.id);
        const l = this.live.get(s.id);
        this.live.delete(s.id);
        void this.manager.stopSession(clawName).catch(() => undefined);
        if (l?.route) dropCodexRoute(l.route);
      },
    });

    const attempt = async (): Promise<string | undefined> => {
      try {
        const res = await this.manager.sendMessage(clawName, text, { timeout: 6 * 3600_000 });
        return res.error;
      } catch (e) {
        return (e as Error).message;
      }
    };
    let error = await attempt();
    if (!stopped && classifyError(error) === 'dead_session') {
      // The CLI process behind the chat went away (crash, update, sleep); start it again on the same conversation.
      try {
        if (s.engine === 'claude' && translator.facts.sessionId) s.claudeStarted = true;
        if (s.engine === 'claude' && s.turns.length > 1) s.claudeStarted = true;
        clawName = await this.ensureLive(s, true);
        translator = fresh();
        error = await attempt();
      } catch (e) {
        error = `restart failed: ${(e as Error).message}`;
      }
    }
    await sleep(150);
    this.flush(s.id);
    if (translator instanceof CodexTranslator) {
      const changed = translator.finalize();
      if (changed.length) this.bus.emit({ t: 'chat_blocks', chat: s.id, turn: turn.id, blocks: changed });
    }
    this.current.delete(s.id);
    turn.blocks = translator.blocks;
    const f = translator.facts;
    if (f.threadId) s.codexThreadId = f.threadId;
    if (s.engine === 'claude' && f.sessionId) s.claudeStarted = true;
    if (f.rateLimits) saveClaudeQuota(f.rateLimits);
    this.endTurn(s, turn, started, { stopped, error: f.error ?? error, usage: f.usage, costUsd: f.costUsd });
  }

  private endTurn(s: ChatSession, turn: ChatTurn, started: number, o: { stopped?: boolean; error?: string; usage?: Usage; costUsd?: number }): void {
    this.running.delete(s.id);
    turn.durationMs = Date.now() - started;
    if (o.usage) {
      if (s.engine === 'codex') {
        // codex reports usage cumulatively per thread
        const prev = s.codexTotals;
        s.codexTotals = o.usage;
        turn.usage = prev && o.usage.input >= prev.input
          ? { input: o.usage.input - prev.input, cached: Math.max(0, o.usage.cached - prev.cached), output: Math.max(0, o.usage.output - prev.output), reasoning: Math.max(0, o.usage.reasoning - prev.reasoning) }
          : o.usage;
        const seat = parseSeat(turn.spec, 'A', this.cfg.defaults);
        turn.credits = codexCredits(seat.model, turn.usage, seat.tier);
      } else {
        turn.usage = o.usage;
      }
    }
    if (o.costUsd !== undefined) {
      const prev = s.claudeCost ?? 0;
      turn.usd = o.costUsd >= prev ? o.costUsd - prev : o.costUsd;
      s.claudeCost = o.costUsd;
    }
    const answered = turn.blocks.some((b) => b.kind === 'text' && b.text);
    turn.status = o.stopped ? 'stopped' : o.error && !answered ? 'error' : 'done';
    if (!o.stopped && o.error) {
      turn.error = o.error;
      turn.hint = errorHint(o.error);
    }
    s.updatedAt = new Date().toISOString();
    this.save(s);
    this.bus.emit({ t: 'chat_turn_end', chat: s.id, turn });
    this.bus.emit({ t: 'chat', chat: this.summary(s) });
    this.bus.emit({ t: 'quota', quota: snapshot() });
  }

  async close(): Promise<void> {
    for (const r of this.running.values()) r.stop();
    await this.manager.shutdown().catch(() => undefined);
  }
}

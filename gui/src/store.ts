import { batch, signal } from '@preact/signals';
import { api, desktop, subscribe } from './api.ts';
import type { AppState, Block, ChatSession, ChatSummary, ChatTurn, DoctorCheck, Engine, LiveTurn, Prefs, Protocol, RunDetails, RunSummary, StartRun } from './types.ts';

export type View =
  | { kind: 'home'; }
  | { kind: 'chat'; panes: string[]; }
  | { kind: 'run'; id: string; }
  | { kind: 'new-run'; draft?: Partial<StartRun>; };

export type Modal =
  | null
  | { kind: 'folder'; onPick: (p: string) => void; start?: string; }
  | { kind: 'settings'; tab?: 'general' | 'presets' | 'setup' | 'about'; }
  | { kind: 'shortcuts'; }
  | { kind: 'confirm'; title: string; body: string; action: string; danger?: boolean; onConfirm: () => void; };

export const app = signal<AppState | null>(null);
export const connected = signal(false);
export const chats = signal<Record<string, ChatSession>>({});
export const runs = signal<Record<string, RunDetails>>({});
export const runLogs = signal<Record<string, string[]>>({});
/** Turns in flight per run, from live events: run id -> turn number -> blocks. */
export const runLive = signal<Record<string, Record<number, LiveTurn>>>({});
export const view = signal<View>(loadView());
export const modal = signal<Modal>(null);
export const paletteOpen = signal(false);
export const toasts = signal<{ id: number; text: string; kind: 'error' | 'info' | 'success'; action?: { label: string; run: () => void; }; }[]>([]);
export const gitTick = signal(0);
export const doctor = signal<DoctorCheck[] | null>(null);

// ── preferences (kept by the engine, so they survive restarts) ─────────────

export const prefs = signal<Prefs>({});
let prefsTimer: number | undefined;

export function setPrefs(patch: Partial<Prefs>): void {
  prefs.value = { ...prefs.value, ...patch };
  clearTimeout(prefsTimer);
  prefsTimer = window.setTimeout(() => void api('/api/prefs', { method: 'PUT', body: prefs.value }).catch(() => undefined), 300);
}

/** The project new chats and runs use; '' means "no folder" (a general question). */
export const project = signal<string>('');
export const rightPanel = signal<'none' | 'changes' | 'trace'>('none');
export const sidebarOpen = signal(true);

export function setProject(p: string): void {
  project.value = p;
  const recent = p ? [p, ...(prefs.value.recentProjects ?? []).filter((x) => x !== p)].slice(0, 12) : prefs.value.recentProjects;
  setPrefs({ project: p, recentProjects: recent });
}

export function setRight(p: 'none' | 'changes' | 'trace'): void {
  rightPanel.value = rightPanel.value === p ? 'none' : p;
  setPrefs({ right: rightPanel.value });
}

export function toggleSidebar(): void {
  sidebarOpen.value = !sidebarOpen.value;
  setPrefs({ sidebar: sidebarOpen.value });
}

function loadView(): View {
  try {
    const v = JSON.parse(sessionStorage.getItem('duo.view') ?? '');
    if (v?.kind) return v;
  } catch {
    /* default */
  }
  return { kind: 'home' };
}

export function go(v: View): void {
  view.value = v;
  try {
    sessionStorage.setItem('duo.view', JSON.stringify(v));
  } catch {
    /* ignore */
  }
  if (v.kind === 'chat') for (const id of v.panes) if (!chats.value[id]) void loadChat(id);
  if (v.kind === 'run') void loadRun(v.id);
}

// ── toasts ───────────────────────────────────────────────────────────────

let toastId = 0;
export function toast(text: string, kind: 'error' | 'info' | 'success' = 'error', action?: { label: string; run: () => void; }): void {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, text, kind, action }];
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), kind === 'error' ? 9000 : action ? 7000 : 3500);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export async function guard<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    toast((e as Error).message);
    return undefined;
  }
}

export function confirmAction(o: { title: string; body: string; action: string; danger?: boolean; }, onConfirm: () => void): void {
  modal.value = { kind: 'confirm', ...o, onConfirm };
}

// ── notifications (only when the window is in the background) ──────────────

function notify(title: string, body: string, route?: string): void {
  if (!app.value?.gui.notify || document.hasFocus()) return;
  if (desktop) {
    void desktop.notify({ title, body, route });
    return;
  }
  if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body });
}

desktop?.onNavigate((route) => {
  const [kind, id] = route.split(':');
  if (kind === 'run' && id) go({ kind: 'run', id });
  if (kind === 'chat' && id) go({ kind: 'chat', panes: [id] });
});

// ── loading ──────────────────────────────────────────────────────────────

function applyTheme(t: string): void {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export async function loadState(): Promise<void> {
  const s = await api<AppState>('/api/state');
  const first = !app.value;
  app.value = s;
  if (first) {
    prefs.value = s.prefs ?? {};
    const p = prefs.value;
    project.value = p.project !== undefined ? p.project : s.projects[0] ?? '';
    rightPanel.value = p.right ?? 'none';
    sidebarOpen.value = p.sidebar !== false;
  }
  applyTheme(s.gui.theme);
  const v = view.value;
  if (v.kind === 'chat') for (const id of v.panes) void loadChat(id);
  if (v.kind === 'run') void loadRun(v.id);
}

export async function loadChat(id: string): Promise<void> {
  const c = await api<ChatSession>(`/api/chats/${id}`).catch(() => undefined);
  if (c) {
    chats.value = { ...chats.value, [id]: c };
  } else if (view.value.kind === 'chat') {
    const panes = view.value.panes.filter((p) => p !== id);
    go(panes.length ? { kind: 'chat', panes } : { kind: 'home' });
  }
}

const runTimers = new Map<string, number>();
export async function loadRun(id: string): Promise<void> {
  const r = await api<RunDetails>(`/api/runs/${encodeURIComponent(id)}`).catch((e: Error) => {
    if (view.value.kind === 'run' && view.value.id === id) {
      toast(e.message);
      go({ kind: 'home' });
    }
    return undefined;
  });
  if (r) runs.value = { ...runs.value, [id]: r };
}

function refetchRunSoon(id: string): void {
  if (!runs.value[id] && !(view.value.kind === 'run' && view.value.id === id)) return;
  clearTimeout(runTimers.get(id));
  runTimers.set(id, window.setTimeout(() => void loadRun(id), 350));
}

// ── chats ────────────────────────────────────────────────────────────────

export async function newChat(engine: Engine, o: { spec?: string; access?: string; cwd?: string; } = {}): Promise<ChatSession | undefined> {
  const cwd = o.cwd ?? project.value;
  const c = await guard(api<ChatSession>('/api/chats', { method: 'POST', body: { engine, cwd: cwd || undefined, noProject: !cwd, spec: o.spec, access: o.access } }));
  if (!c) return undefined;
  chats.value = { ...chats.value, [c.id]: { ...c, permissions: [], allowedTools: [] } };
  return c;
}

export async function openNewChat(engine: Engine, text?: string): Promise<void> {
  const c = await newChat(engine);
  if (!c) return;
  go({ kind: 'chat', panes: [c.id] });
  if (text?.trim()) await sendTo(c.id, text);
}

export async function openSideBySide(text?: string): Promise<void> {
  const a = await newChat('claude');
  const b = a && (await newChat('codex'));
  if (!a || !b) return;
  go({ kind: 'chat', panes: [a.id, b.id] });
  if (text?.trim()) await Promise.all([sendTo(a.id, text), sendTo(b.id, text)]);
}

/** Put the other engine next to this chat. */
export async function compareWith(chatId: string): Promise<void> {
  const c = chats.value[chatId];
  if (!c) return;
  const other: Engine = c.engine === 'claude' ? 'codex' : 'claude';
  const n = await newChat(other, { cwd: c.cwd });
  if (n) go({ kind: 'chat', panes: c.engine === 'claude' ? [chatId, n.id] : [n.id, chatId] });
}

export async function sendTo(chatId: string, text: string): Promise<boolean> {
  const t = await guard(api<ChatTurn>(`/api/chats/${chatId}/send`, { method: 'POST', body: { text } }));
  return !!t;
}

export function retryChat(chatId: string): void {
  void guard(api(`/api/chats/${chatId}/retry`, { method: 'POST' }));
}

export function stopChat(chatId: string): void {
  void guard(api(`/api/chats/${chatId}/stop`, { method: 'POST' }));
}

export async function patchChat(chatId: string, patch: Record<string, unknown>): Promise<void> {
  const c = await guard(api<ChatSession>(`/api/chats/${chatId}`, { method: 'PATCH', body: patch }));
  if (c) chats.value = { ...chats.value, [chatId]: { ...chats.value[chatId], ...c } };
}

export async function deleteChat(chatId: string): Promise<void> {
  await guard(api(`/api/chats/${chatId}`, { method: 'DELETE' }));
}

export function decide(requestId: string, decision: 'allow' | 'allow_session' | 'deny'): void {
  void guard(api(`/api/permissions/${requestId}`, { method: 'POST', body: { decision } }));
}

// ── runs ─────────────────────────────────────────────────────────────────

export async function startRun(req: StartRun): Promise<void> {
  const r = await guard(api<{ id: string; }>('/api/runs', { method: 'POST', body: req }));
  if (!r) return;
  setPrefs({ lastSeats: { ...(prefs.value.lastSeats ?? {}), [req.protocol]: { seats: req.seats, chair: req.chair } } });
  go({ kind: 'run', id: r.id });
}

export function cancelRun(id: string): void {
  void guard(api(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })).then((r) => r && toast('Stopping the seats…', 'info'));
}

export async function deleteRun(id: string): Promise<void> {
  const ok = await guard(api(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  if (ok && view.value.kind === 'run' && view.value.id === id) go({ kind: 'home' });
}

export async function continueRun(id: string, note: string, rounds: number): Promise<void> {
  const r = await guard(api<{ id: string; }>(`/api/runs/${encodeURIComponent(id)}/continue`, { method: 'POST', body: { note, rounds } }));
  if (r) go({ kind: 'run', id: r.id });
}

export async function workspaceAction(id: string, action: 'apply' | 'keep' | 'discard'): Promise<void> {
  const r = await guard(api<{ message: string; }>(`/api/runs/${encodeURIComponent(id)}/workspace`, { method: 'POST', body: { action } }));
  if (r) {
    toast(r.message, 'success');
    gitTick.value++;
    void loadRun(id);
  }
}

export async function refreshQuota(): Promise<void> {
  const q = await guard(api<AppState['quota']>('/api/quota?refresh=1'));
  if (q && app.value) app.value = { ...app.value, quota: q };
}

export async function saveSettings(patch: Record<string, unknown>): Promise<void> {
  const s = await guard(api<AppState>('/api/config', { method: 'PUT', body: patch }));
  if (s) {
    app.value = s;
    applyTheme(s.gui.theme);
    toast('Settings saved', 'success');
  }
}

export async function loadDoctor(live = false): Promise<void> {
  doctor.value = null;
  doctor.value = (await guard(api<DoctorCheck[]>(`/api/doctor${live ? '?live=1' : ''}`))) ?? [];
}

export async function updateClaude(): Promise<void> {
  toast('Updating Claude Code…', 'info');
  const r = await guard(api<{ ok: boolean; output: string; version: string; }>('/api/maintenance/update-claude', { method: 'POST' }));
  if (!r) return;
  toast(r.ok ? `Claude Code is ${r.version}` : `Update failed: ${r.output.slice(-300)}`, r.ok ? 'success' : 'error');
  void loadDoctor();
  void loadState();
}

// ── live events ──────────────────────────────────────────────────────────

function upsertSummary<T extends { id: string; }>(list: T[], item: T, sortKey: keyof T): T[] {
  const rest = list.filter((x) => x.id !== item.id);
  return [item, ...rest].sort((a, b) => String(b[sortKey]).localeCompare(String(a[sortKey])));
}

function withTurn(chatId: string, turnId: string, fn: (t: ChatTurn) => ChatTurn): void {
  const c = chats.value[chatId];
  if (!c) return;
  const turns = c.turns.map((t) => (t.id === turnId ? fn(t) : t));
  chats.value = { ...chats.value, [chatId]: { ...c, turns } };
}

export function mergeBlocks(existing: Block[], changed: Block[]): Block[] {
  const out = [...existing];
  for (const b of changed) {
    const i = out.findIndex((x) => x.id === b.id);
    if (i >= 0) out[i] = b;
    else out.push(b);
  }
  return out;
}

function liveTurn(run: string, n: number, fn: (t: LiveTurn | undefined) => LiveTurn | undefined): void {
  const all = runLive.value[run] ?? {};
  const next = fn(all[n]);
  if (!next) return;
  runLive.value = { ...runLive.value, [run]: { ...all, [n]: next } };
}

const PROTOCOL_NAMES: Record<Protocol, string> = { debate: 'Debate', review: 'Review', council: 'Council', ask: 'Ask', pair: 'Pair', custom: 'Custom' };

function onEvent(e: any): void {
  const s = app.value;
  switch (e.t) {
    case 'chat':
      if (s) app.value = { ...s, chats: upsertSummary<ChatSummary>(s.chats, e.chat, 'updatedAt') };
      if (chats.value[e.chat.id]) chats.value = { ...chats.value, [e.chat.id]: { ...chats.value[e.chat.id], ...e.chat } };
      break;
    case 'chat_removed':
      if (s) app.value = { ...s, chats: s.chats.filter((c) => c.id !== e.id) };
      if (view.value.kind === 'chat' && view.value.panes.includes(e.id)) {
        const panes = view.value.panes.filter((p) => p !== e.id);
        go(panes.length ? { kind: 'chat', panes } : { kind: 'home' });
      }
      break;
    case 'chat_turn': {
      const c = chats.value[e.chat];
      if (c && !c.turns.some((t) => t.id === e.turn.id)) chats.value = { ...chats.value, [e.chat]: { ...c, turns: [...c.turns, e.turn] } };
      break;
    }
    case 'chat_blocks':
      withTurn(e.chat, e.turn, (t) => ({ ...t, blocks: mergeBlocks(t.blocks, e.blocks) }));
      break;
    case 'chat_turn_end': {
      withTurn(e.chat, e.turn.id, () => e.turn);
      gitTick.value++;
      const c = chats.value[e.chat];
      if ((e.turn.durationMs ?? 0) > 15_000 && c) notify(`${c.engine === 'claude' ? 'Claude' : 'Codex'} ${e.turn.status === 'error' ? 'hit an error' : 'finished'}`, c.title, `chat:${c.id}`);
      break;
    }
    case 'quota':
      if (s) app.value = { ...s, quota: e.quota };
      break;
    case 'permission': {
      const c = chats.value[e.request.chat];
      if (c) chats.value = { ...chats.value, [c.id]: { ...c, permissions: [...c.permissions, e.request] } };
      if (s) app.value = { ...s, permissions: [...s.permissions, e.request] };
      if (c) notify('Approval needed', `${c.engine === 'claude' ? 'Claude' : 'Codex'} wants to use ${e.request.tool}`, `chat:${c.id}`);
      break;
    }
    case 'permission_resolved': {
      const c = chats.value[e.chat];
      if (c) chats.value = { ...chats.value, [c.id]: { ...c, permissions: c.permissions.filter((p) => p.id !== e.id) } };
      if (s) app.value = { ...s, permissions: s.permissions.filter((p) => p.id !== e.id) };
      if (e.decision === 'allow_session') void loadChat(e.chat);
      break;
    }
    case 'run_started':
      if (s) app.value = { ...s, runs: upsertSummary<RunSummary>(s.runs, e.run, 'createdAt') };
      break;
    case 'run_removed':
      if (s) app.value = { ...s, runs: s.runs.filter((r) => r.id !== e.id) };
      break;
    case 'run_event':
      switch (e.kind) {
        case 'log':
        case 'error': {
          const logs = runLogs.value[e.run] ?? [];
          runLogs.value = { ...runLogs.value, [e.run]: [...logs, e.kind === 'error' ? `ERROR ${e.text}` : e.text].slice(-500) };
          if (e.kind === 'error') toast(e.text);
          break;
        }
        case 'turn_start':
          liveTurn(e.run, e.n, () => ({ n: e.n, seat: e.seat, round: e.round, kind: e.turnKind, startedAt: Date.now(), blocks: [] }));
          break;
        case 'live':
          liveTurn(e.run, e.n, (t) => ({ ...(t ?? { n: e.n, seat: e.seat, round: e.round, kind: e.turnKind, startedAt: Date.now(), blocks: [] }), blocks: mergeBlocks(t?.blocks ?? [], e.blocks) }));
          break;
        case 'turn':
          liveTurn(e.run, e.n, (t) => (t ? { ...t, done: true, error: e.error, hint: e.hint } : undefined));
          refetchRunSoon(e.run);
          break;
        default:
          refetchRunSoon(e.run);
      }
      break;
    case 'run_finished': {
      if (s) app.value = { ...s, runs: upsertSummary<RunSummary>(s.runs, e.run, 'createdAt') };
      refetchRunSoon(e.run.id);
      gitTick.value++;
      const stop = String(e.run.outcome?.stop ?? e.run.status);
      if (e.run.status !== 'running') notify(`${PROTOCOL_NAMES[e.run.protocol as Protocol] ?? 'Run'} ${e.run.status === 'failed' ? 'failed' : e.run.status === 'cancelled' ? 'cancelled' : 'finished'}`, `${e.run.title}\n${stop.slice(0, 140)}`, `run:${e.run.id}`);
      break;
    }
  }
}

export function start(): void {
  subscribe(
    (e) => batch(() => onEvent(e)),
    (ok) => {
      const was = connected.value;
      connected.value = ok;
      if (ok && !was) void loadState().catch((err) => toast(err.message));
    },
  );
}

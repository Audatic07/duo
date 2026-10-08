import type { CoordinationTemplate, WorkflowState } from '../../src/templates/types.ts';
export type Engine = 'claude' | 'codex';
export type Protocol = 'debate' | 'review' | 'council' | 'ask' | 'pair' | 'custom';

export interface Block {
  id: string;
  kind: 'text' | 'thinking' | 'tool' | 'patch' | 'todo' | 'note';
  text?: string;
  name?: string;
  input?: string;
  output?: string;
  status?: 'running' | 'done' | 'error';
  exitCode?: number | null;
  phase?: 'commentary' | 'final';
}

export interface Usage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

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

export interface ChatSummary {
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
  turnCount: number;
  running: boolean;
  lastText?: string;
  draft?: boolean;
}

export interface ChatSession extends Omit<ChatSummary, 'turnCount' | 'running' | 'lastText'> {
  turns: ChatTurn[];
  permissions: PermissionRequest[];
  allowedTools: string[];
}

export interface PermissionRequest {
  id: string;
  chat: string;
  tool: string;
  input: any;
  at: string;
}

export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetsAt: number;
}

export interface QuotaSnapshot {
  codex?: { windows: QuotaWindow[]; plan?: string; asOf: number; limitReached?: string | null; };
  claude?: { windows: QuotaWindow[]; status?: string; asOf: number; };
}

export interface CodexModel {
  slug: string;
  display: string;
  description: string;
  defaultEffort?: string;
  efforts: string[];
}

export interface RunSummary {
  id: string;
  protocol: Protocol;
  title: string;
  cwd: string;
  status: string;
  createdAt: string;
  finishedAt?: string;
  seats: string[];
  outcome?: Record<string, any>;
  totals?: Usage & { codexCredits: number; usd: number; durationMs: number; turns: number; };
  continuedFrom?: string;
  workspace?: { mode: 'worktree' | 'in-place'; state: string; branch?: string; };
}

export interface RunTurnMeta {
  n: number;
  round: number;
  seat: string;
  kind: string;
  dir: string;
  startedAt: string;
  durationMs: number;
  usage: Usage;
  codexCredits?: number;
  usd?: number;
  verdict?: string;
  error?: string;
  warnings?: string[];
}

export interface Workspace {
  mode: 'worktree' | 'in-place';
  cwd: string;
  path: string;
  repo?: string;
  branch?: string;
  base: string;
  state: 'active' | 'applied' | 'kept' | 'discarded' | 'moved';
  movedTo?: string;
  outcome?: string;
}

export interface SeatRecord {
  id: string;
  spec: string;
  engine: Engine;
  model: string;
  effort?: string;
  role: string;
  customRole?: boolean;
  codexThreadId?: string;
  claudeSessionId?: string;
}

export interface PairFinding {
  id: string;
  severity: string;
  title: string;
  location: string;
  problem: string;
  fix: string;
  opened: number;
  status: 'open' | 'resolved';
  disputes: number;
  history: { cycle: number; event: string; note?: string; }[];
}

export interface PairCycle {
  cycle: number;
  writer?: { n: number; status: string; summary: string; changes: number; tests: { command: string; outcome: string; details: string; }[]; error?: string; };
  check?: { exitCode: number | null; timedOut: boolean; durationMs: number; };
  diff?: { files: number; stat: string; };
  review?: { n: number; verdict: string; summary: string; open: number; blocking: number; requirements: { requirement: string; met: string; evidence: string; }[]; error?: string; };
}

export interface PairState {
  settings: { isolation: 'worktree' | 'in-place'; writerAccess: string; check?: string; };
  writer: string;
  reviewer: string;
  cycles: PairCycle[];
  findings: PairFinding[];
  checks: { cycle: number; command: string; exitCode: number | null; output: string; durationMs: number; timedOut: boolean; }[];
}

export interface RunDetails {
  meta: {
    id: string;
    protocol: Protocol;
    title: string;
    prompt: string;
    cwd: string;
    createdAt: string;
    finishedAt?: string;
    status: string;
    seats: SeatRecord[];
    options: Record<string, any>;
    versions: Record<string, string>;
    turns: RunTurnMeta[];
    outcome?: Record<string, any>;
    totals?: RunSummary['totals'];
    quota?: { before?: QuotaSnapshot; after?: QuotaSnapshot; };
    continuedFrom?: string;
    workspace?: Workspace;
  };
  running: boolean;
  report?: string;
  transcript?: string;
  ledger?: any;
  findings?: any[];
  council?: any;
  pair?: PairState;
  template?: CoordinationTemplate;
  draftTemplate?: CoordinationTemplate;
  coordination?: WorkflowState;
  dir: string;
}

/** A turn in flight (or just finished) in a run, built from live events. */
export interface LiveTurn {
  n: number;
  seat: string;
  round: number;
  kind: string;
  startedAt: number;
  blocks: Block[];
  done?: boolean;
  error?: string;
  hint?: string;
}

export interface Preset {
  seats: string[];
  chair?: string;
  rounds?: number;
  description?: string;
}

export interface GuiDefaults {
  claude: { spec: string; access: string; };
  codex: { spec: string; access: string; useConfig: boolean; };
  theme: 'system' | 'light' | 'dark';
  notify: boolean;
}

export interface Prefs {
  project?: string;
  recentProjects?: string[];
  right?: 'none' | 'changes' | 'trace';
  sidebar?: boolean;
  sidebarFilter?: 'all' | 'chats' | 'runs';
  lastSeats?: Partial<Record<Protocol, { seats: string[]; chair?: string; }>>;
  seenTour?: boolean;
}

export interface DoctorCheck {
  id: string;
  label: string;
  level: 'ok' | 'fail' | 'warn' | 'info';
  detail: string;
  fix?: string;
}

export interface AppState {
  version: string;
  platform: string;
  home: string;
  dataDir: string;
  scratchDir: string;
  configPath: string;
  gui: GuiDefaults;
  presets: Record<string, Preset>;
  defaults: { preset: string; codexModel: string; claudeModel: string; };
  warnPercent: number;
  access: { claude: Record<string, string>; codex: Record<string, string>; };
  models: { codex: CodexModel[]; claude: { alias: string; note: string; }[]; };
  rates: Record<string, [number, number, number]>;
  efforts: { codex: string[]; claude: string[]; };
  versions: { codex: string; claude: string; };
  quota: QuotaSnapshot;
  chats: ChatSummary[];
  runs: RunSummary[];
  projects: string[];
  prefs: Prefs;
  permissions: PermissionRequest[];
}

export interface StartRun {
  protocol: Protocol;
  template?: CoordinationTemplate | string;
  seats: string[];
  chair?: string;
  rounds?: number;
  minRounds?: number;
  anon?: boolean;
  cwd: string;
  noProject?: boolean;
  brief?: string;
  title?: string;
  review?: { kind: 'uncommitted' | 'base' | 'commit' | 'files' | 'plan'; value?: string; files?: string[]; focus?: string; };
  pair?: { isolation: 'worktree' | 'in-place'; writerAccess: 'sandboxed' | 'sandboxed-network' | 'full'; check?: string; };
}

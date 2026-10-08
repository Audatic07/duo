/** Versioned, data-only coordination programs. No JavaScript, shell or eval in a template. */
export type Condition =
  | { all: Condition[]; } | { any: Condition[]; } | { not: Condition; }
  | { path: string; op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'includes' | 'every' | 'some'; value?: unknown; valuePath?: string; where?: Condition; };
export interface Selector { ids?: string[]; engine?: 'codex' | 'claude'; model?: string; fromRole?: string; count?: number; rankBy?: { step: string; path: string; direction?: 'asc' | 'desc'; }; }
export interface Role { instructions: string; access?: 'read' | 'sandboxed' | 'sandboxed-network'; schema?: Record<string, unknown>; }
export interface Assignment { role: string; select: Selector; }
export interface Route {
  from: string; // role id, or a step id
  parts?: ('reply' | 'data')[];
  history?: 'latest' | 'all';
  excludeSelf?: boolean;
  limit?: number;
  anonymous?: boolean;
  maxChars?: number;
}
export type Step = (
  | { type: 'turn'; role: string; prompt: string; input?: Route[]; count?: number; parallel?: boolean; session?: 'fresh' | 'role'; next: string; }
  | { type: 'assign'; role: string; select: Selector; mode?: 'replace' | 'add'; next: string; }
  | { type: 'branch'; cases: { when: Condition; next: string; }[]; otherwise: string; }
  | { type: 'finish'; status: 'completed' | 'failed' | 'blocked' | 'limit'; reason: string; }
  | { type: 'operation'; use: string; next: string; prompts?: Record<string, string>; settings?: Record<string, boolean | number | string>; input?: Route[]; }
) & { onError?: { action: 'fail' | 'skip' | 'goto'; next?: string; }; };
export interface MemoryChannel {
  scope: 'run' | 'template';
  readBy: string[];
  writeFrom: string[];
  parts: ('reply' | 'data')[];
  /** For data, persist only these paths (omit for the entire structured value). */
  paths?: string[];
  maxEntries: number;
  maxChars: number;
}
export interface CoordinationTemplate {
  version: 1;
  id: string;
  name: string;
  description?: string;
  /** Host operations for built-in algorithms. Omit for a fully user-defined program. */
  library?: 'ask' | 'review' | 'council' | 'debate' | 'pair';
  roles: Record<string, Role>;
  assignments: Assignment[];
  transitions?: { from: string; to: string; when: Condition; select?: Selector; once?: boolean; }[];
  start: string;
  steps: Record<string, Step>;
  completion?: { when: Condition; reason: string; };
  exceptions?: { when: Condition; next: string; }[];
  limits: { maxSteps: number; maxTurns: number; maxDurationSec: number; maxContextChars: number; minSeats?: number; };
  memory?: Record<string, MemoryChannel>;
  workspace?: { isolation: 'worktree' | 'in-place'; };
}
export interface Message { seat: string; role: string; step: string; reply: string; data?: unknown; error?: string; }
export interface WorkflowState {
  step: string;
  visits: Record<string, number>;
  outputs: Record<string, Message[]>;
  history: Message[];
  roles: Record<string, string[]>;
  vars: Record<string, unknown>;
  memory: Record<string, MemoryEntry[]>;
  stop?: { status: 'completed' | 'failed' | 'blocked' | 'limit'; reason: string; };
}
export type Operations = Record<string, (state: WorkflowState) => Promise<void> | void>;

export interface MemoryEntry { run: string; seat: string; step: string; at: string; text: string; }

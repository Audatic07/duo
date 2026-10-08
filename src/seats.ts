import { seatId } from './seat-ids.ts';
/**
 * Seats: who takes part in a run, on which engine, model and effort.
 *
 *   engine[:model][@effort][+option[=value]]...
 *
 *   codex:gpt-6-astra@xhigh+verbosity=high+summary=detailed
 *   codex:gpt-6-sol@high+web=live+cfg:model_supports_reasoning_summaries=true
 *   claude:opus@max+web
 *   claude:sonnet@medium+name=Skeptic+persona=@~/personas/skeptic.md
 */
import { readFileSync } from 'node:fs';
import { expandHome } from './platform.ts';

export type Engine = 'codex' | 'claude';

export const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const VERBOSITY = ['low', 'medium', 'high'];
const SUMMARY = ['auto', 'concise', 'detailed', 'none'];
const WEB_MODES = ['live', 'cached', 'indexed', 'disabled'];

const ENGINE_ALIASES: Record<string, Engine> = {
  codex: 'codex', cx: 'codex', gpt: 'codex', openai: 'codex',
  claude: 'claude', cl: 'claude', anthropic: 'claude',
};

/**
 * Codex config keys a seat may never set: they would widen the sandbox, approvals, network, or what
 * the process can run. Seats are read-only discussion participants by design.
 */
const CFG_DENY = new Set([
  'sandbox_mode', 'sandbox_workspace_write', 'approval_policy', 'approvals_reviewer', 'permissions',
  'default_permissions', 'shell_environment_policy', 'mcp_servers', 'hooks', 'notify', 'model_provider',
  'model_providers', 'projects', 'profile', 'profiles', 'skills', 'plugins', 'marketplaces', 'network',
  'experimental_use_unified_exec_tool', 'zsh_path', 'js_repl', 'otel', 'history',
]);

export interface Seat {
  /** A, B, C... in the order given; used in claim ids and file names. */
  id: string;
  engine: Engine;
  model: string;
  effort?: string;
  name?: string;
  persona?: string;
  timeoutSec?: number;
  // codex
  verbosity?: string;
  summary?: string;
  web?: string;
  tier?: string;
  cfg: Record<string, string>;
  // claude
  fetch?: boolean;
  addDirs: string[];
}

export interface SeatDefaults {
  codexModel: string;
  claudeModel: string;
  claudeEffort?: string;
  codexEffort?: string;
}

export class SeatError extends Error {}

export function parseSeat(spec: string, id: string, defaults: SeatDefaults, opts: { safe?: boolean } = {}): Seat {
  const trimmed = spec.trim();
  if (!trimmed) throw new SeatError('empty seat spec');
  const [head, ...optParts] = trimmed.split('+');
  const m = /^([a-z]+)(?::([^@]+))?(?:@([a-z]+))?$/i.exec(head);
  if (!m) throw new SeatError(`bad seat "${spec}": expected engine[:model][@effort][+option...]`);
  const engine = ENGINE_ALIASES[m[1].toLowerCase()];
  if (!engine) throw new SeatError(`unknown engine "${m[1]}" in "${spec}" (use codex or claude)`);

  const seat: Seat = {
    id,
    engine,
    model: m[2] || (engine === 'codex' ? defaults.codexModel : defaults.claudeModel),
    effort: m[3]?.toLowerCase() || (engine === 'codex' ? defaults.codexEffort : defaults.claudeEffort),
    cfg: {},
    addDirs: [],
  };
  const ladder = engine === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS;
  if (seat.effort && !ladder.includes(seat.effort)) {
    throw new SeatError(`effort "${seat.effort}" is not valid for ${engine} (${ladder.join(', ')})`);
  }

  for (const raw of optParts) {
    const eq = raw.indexOf('=');
    const key = (eq < 0 ? raw : raw.slice(0, eq)).trim();
    const value = eq < 0 ? '' : raw.slice(eq + 1).trim();
    applyOption(seat, key, value, spec, !!opts.safe);
  }
  return seat;
}

function need(value: string, key: string, spec: string): string {
  if (!value) throw new SeatError(`option "${key}" needs a value in "${spec}"`);
  return value;
}

function oneOf(value: string, allowed: string[], key: string, spec: string): string {
  if (!allowed.includes(value)) throw new SeatError(`${key}=${value} in "${spec}": expected ${allowed.join(' | ')}`);
  return value;
}

function applyOption(seat: Seat, key: string, value: string, spec: string, safe: boolean): void {
  const codexOnly = (k: string) => {
    if (seat.engine !== 'codex') throw new SeatError(`option "${k}" is Codex-only (in "${spec}")`);
  };
  const claudeOnly = (k: string) => {
    if (seat.engine !== 'claude') throw new SeatError(`option "${k}" is Claude-only (in "${spec}")`);
  };
  if (key.startsWith('cfg:')) {
    codexOnly('cfg:');
    if (safe) throw new SeatError('raw Codex config (cfg:) is disabled in duo-safe');
    const cfgKey = key.slice(4);
    if (!/^[A-Za-z0-9_.-]+$/.test(cfgKey)) throw new SeatError(`bad config key "${cfgKey}"`);
    if (CFG_DENY.has(cfgKey.split('.')[0])) throw new SeatError(`config key "${cfgKey}" is not allowed on a seat`);
    seat.cfg[cfgKey] = need(value, key, spec);
    return;
  }
  switch (key) {
    case 'name': seat.name = need(value, key, spec); return;
    case 'persona': {
      const v = need(value, key, spec);
      seat.persona = v.startsWith('@') ? readFileSync(expandHome(v.slice(1)), 'utf8').trim() : v;
      return;
    }
    case 'timeout': {
      const n = Number(need(value, key, spec));
      if (!Number.isFinite(n) || n <= 0) throw new SeatError(`timeout must be seconds (in "${spec}")`);
      seat.timeoutSec = n;
      return;
    }
    case 'verbosity': codexOnly(key); seat.verbosity = oneOf(need(value, key, spec), VERBOSITY, key, spec); return;
    case 'summary': codexOnly(key); seat.summary = oneOf(need(value, key, spec), SUMMARY, key, spec); return;
    case 'tier': codexOnly(key); seat.tier = need(value, key, spec); return;
    case 'fast': codexOnly(key); seat.tier = 'fast'; return;
    case 'web':
      if (seat.engine === 'codex') seat.web = value ? oneOf(value, WEB_MODES, key, spec) : 'live';
      else seat.web = 'on';
      return;
    case 'fetch':
      claudeOnly(key);
      if (safe) throw new SeatError('WebFetch (fetch) is disabled in duo-safe');
      seat.fetch = true;
      return;
    case 'dir': claudeOnly(key); seat.addDirs.push(expandHome(need(value, key, spec))); return;
    default:
      throw new SeatError(`unknown option "${key}" in "${spec}"`);
  }
}

/** Canonical, round-trippable spec (minus persona text, which can be long). */
export function formatSeat(seat: Seat): string {
  let s = `${seat.engine}:${seat.model}${seat.effort ? '@' + seat.effort : ''}`;
  if (seat.verbosity) s += `+verbosity=${seat.verbosity}`;
  if (seat.summary) s += `+summary=${seat.summary}`;
  if (seat.web) s += seat.engine === 'codex' ? `+web=${seat.web}` : '+web';
  if (seat.tier) s += `+tier=${seat.tier}`;
  if (seat.fetch) s += '+fetch';
  for (const d of seat.addDirs) s += `+dir=${d}`;
  for (const [k, v] of Object.entries(seat.cfg)) s += `+cfg:${k}=${v}`;
  if (seat.name) s += `+name=${seat.name}`;
  if (seat.timeoutSec) s += `+timeout=${seat.timeoutSec}`;
  return s;
}

/** Short label for tables and transcripts: "A codex:gpt-6-sol@high". */
export function seatLabel(seat: Seat): string {
  return seat.name ? `${seat.id} ${seat.name} (${seat.engine}:${seat.model}@${seat.effort ?? 'default'})`
    : `${seat.id} ${seat.engine}:${seat.model}@${seat.effort ?? 'default'}`;
}

/** Human name used when talking to peers ("Codex (gpt-6-sol)"). */
export function seatPeerName(seat: Seat): string {
  const vendor = seat.engine === 'codex' ? 'Codex' : 'Claude';
  return seat.name ? `${seat.name} — ${vendor} ${seat.model}` : `${vendor} ${seat.model}`;
}

export function seatIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => seatId(i));
}

/** The Codex `-c key=value` overrides a seat implies (values are TOML). */
export function codexOverrides(seat: Seat): string[] {
  const out: string[] = [];
  const q = (s: string) => JSON.stringify(s);
  // claw passes efforts from low upwards itself and silently drops `none` and `minimal`; set the
  // seat's effort here too, so every level on Codex's ladder reaches the model as chosen.
  if (seat.effort) out.push(`model_reasoning_effort=${q(seat.effort)}`);
  if (seat.verbosity) out.push(`model_verbosity=${q(seat.verbosity)}`);
  if (seat.summary) out.push(`model_reasoning_summary=${q(seat.summary)}`);
  if (seat.web) out.push(`web_search=${q(seat.web)}`);
  if (seat.tier) out.push(`service_tier=${q(seat.tier)}`);
  for (const [k, v] of Object.entries(seat.cfg)) out.push(`${k}=${v}`);
  return out;
}

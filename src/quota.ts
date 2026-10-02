/**
 * Subscription quota, read without spending anything: Codex writes its account's rate-limit
 * snapshot into every session log, and Claude Code emits a rate_limit_event on every turn (duo
 * caches the latest one it has seen).
 */
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR, CODEX_HOME } from './paths.ts';
import type { QuotaSnapshot, QuotaWindow } from './store.ts';

const CLAUDE_CACHE = join(CACHE_DIR, 'claude-quota.json');

function tail(path: string, bytes = 512_000): string {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function sortedDesc(dir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(dir).filter((d) => pattern.test(d)).sort().reverse();
  } catch {
    return [];
  }
}

/** Newest Codex session logs, by modification time. */
export function recentRollouts(limit = 12): string[] {
  const root = join(CODEX_HOME, 'sessions');
  const found: string[] = [];
  outer: for (const y of sortedDesc(root, /^\d{4}$/)) {
    for (const m of sortedDesc(join(root, y), /^\d{2}$/)) {
      for (const d of sortedDesc(join(root, y, m), /^\d{2}$/)) {
        const dir = join(root, y, m, d);
        for (const f of readdirSync(dir)) if (f.startsWith('rollout-') && f.endsWith('.jsonl')) found.push(join(dir, f));
        if (found.length >= limit) break outer;
      }
    }
  }
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, limit);
}

function codexFromRollout(path: string): QuotaSnapshot['codex'] | undefined {
  const text = tail(path);
  const rows = text.split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!rows[i].includes('"rate_limits"')) continue;
    try {
      const rec = JSON.parse(rows[i]);
      const rl = rec.payload?.type === 'token_count' ? rec.payload.rate_limits : undefined;
      if (!rl) continue;
      const windows: QuotaWindow[] = [];
      for (const key of ['primary', 'secondary']) {
        const w = rl[key];
        if (!w) continue;
        windows.push({ label: windowLabel(w.window_minutes), usedPercent: w.used_percent ?? 0, resetsAt: w.resets_at });
      }
      return { windows, plan: rl.plan_type, asOf: statSync(path).mtimeMs / 1000, limitReached: rl.rate_limit_reached_type ?? null };
    } catch {
      /* partial line */
    }
  }
  return undefined;
}

function windowLabel(minutes: number): string {
  if (minutes === 300) return '5h';
  if (minutes === 10080) return 'weekly';
  return `${minutes}m`;
}

export function codexQuota(): QuotaSnapshot['codex'] {
  for (const p of recentRollouts()) {
    const q = codexFromRollout(p);
    if (q) return q;
  }
  return undefined;
}

export function claudeQuotaFromEvent(info: any): QuotaSnapshot['claude'] {
  const windows: QuotaWindow[] = [];
  const uw = info?.unifiedWindows || {};
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', 'weekly']] as const) {
    const w = uw[key];
    if (w) windows.push({ label, usedPercent: Math.round(100 * (w.utilization ?? 0)), resetsAt: w.resetsAt });
  }
  if (!windows.length && info?.utilization !== undefined) {
    windows.push({ label: String(info.rateLimitType ?? 'window'), usedPercent: Math.round(100 * info.utilization), resetsAt: info.resetsAt });
  }
  return { windows, status: info?.status, asOf: Date.now() / 1000 };
}

export function saveClaudeQuota(info: unknown): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CLAUDE_CACHE, JSON.stringify({ at: Date.now(), info }, null, 2));
}

export function claudeQuota(): QuotaSnapshot['claude'] {
  if (!existsSync(CLAUDE_CACHE)) return undefined;
  try {
    const c = JSON.parse(readFileSync(CLAUDE_CACHE, 'utf8'));
    return { ...claudeQuotaFromEvent(c.info)!, asOf: c.at / 1000 };
  } catch {
    return undefined;
  }
}

export function snapshot(): QuotaSnapshot {
  return { codex: codexQuota(), claude: claudeQuota() };
}

export function fmtWhen(epochSec: number): string {
  const t = new Date(epochSec * 1000);
  const now = new Date();
  const hm = t.toTimeString().slice(0, 5);
  if (t.toDateString() === now.toDateString()) return hm;
  const days = (t.getTime() - now.getTime()) / 86400_000;
  if (days > -6 && days < 6) return `${t.toLocaleDateString('en-US', { weekday: 'short' })} ${hm}`;
  return `${t.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${hm}`;
}

export function fmtAgo(epochSec: number): string {
  const s = Math.max(0, Date.now() / 1000 - epochSec);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** A snapshot older than its window's reset time says nothing about current usage. */
function hasReset(w: QuotaWindow): boolean {
  return !!w.resetsAt && w.resetsAt * 1000 < Date.now();
}

export function formatWindows(windows: QuotaWindow[] | undefined, warn: number): { text: string; low: boolean } {
  if (!windows?.length) return { text: 'unknown', low: false };
  let low = false;
  const text = windows
    .map((w) => {
      if (hasReset(w)) return `${w.label} reset at ${fmtWhen(w.resetsAt)} (was ${w.usedPercent.toFixed(0)}%)`;
      low ||= w.usedPercent >= warn;
      return `${w.label} ${w.usedPercent.toFixed(0)}% used (resets ${fmtWhen(w.resetsAt)})`;
    })
    .join(' · ');
  return { text, low };
}

export function formatDelta(before: QuotaWindow[] | undefined, after: QuotaWindow[] | undefined): string {
  if (!after?.length) return 'unknown';
  return after
    .map((w) => {
      const b = before?.find((x) => x.label === w.label);
      // A "before" taken in an earlier window is not comparable.
      return b && !hasReset(b) ? `${w.label} ${b.usedPercent.toFixed(0)}%→${w.usedPercent.toFixed(0)}%` : `${w.label} ${w.usedPercent.toFixed(0)}%`;
    })
    .join(' · ');
}

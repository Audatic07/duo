import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUO_HOME } from '../paths.ts';
import type { CoordinationTemplate, MemoryChannel, MemoryEntry, Message } from './types.ts';
import { readPath } from './validate.ts';

const memoryDir = join(DUO_HOME, 'template-memory');
export function retain(entries: MemoryEntry[], channel: MemoryChannel): MemoryEntry[] {
  const result = entries.slice(-channel.maxEntries).map((e) => ({ ...e, text: e.text.slice(0, channel.maxChars) }));
  let chars = result.reduce((n, e) => n + e.text.length, 0);
  while (chars > channel.maxChars && result.length > 1) chars -= result.shift()!.text.length;
  return result;
}
function file(t: CoordinationTemplate, id: string): string { return join(memoryDir, `${t.id}.${id}.json`); }
export function loadMemory(t: CoordinationTemplate, id: string): MemoryEntry[] {
  const c = t.memory![id];
  if (c.scope === 'run' || !existsSync(file(t, id))) return [];
  const data: unknown = JSON.parse(readFileSync(file(t, id), 'utf8'));
  if (!Array.isArray(data) || data.some((e) => !e || typeof e.text !== 'string' || typeof e.run !== 'string' || typeof e.seat !== 'string' || typeof e.step !== 'string' || typeof e.at !== 'string')) throw new Error(`Invalid stored memory channel ${id}`);
  return retain(data, c);
}
export function memoryEntries(messages: Message[], c: MemoryChannel, run: string): MemoryEntry[] {
  return messages.filter((m) => !m.error).map((m) => {
    const data = c.paths ? Object.fromEntries(c.paths.map((p) => [p, readPath(m.data, p)])) : m.data;
    const text = c.parts.map((p) => p === 'reply' ? m.reply : data === undefined ? '' : JSON.stringify(data)).filter(Boolean).join('\n');
    return { run, seat: m.seat, step: m.step, at: new Date().toISOString(), text };
  }).filter((e) => e.text);
}
/** File writes and clears share a lock across independent CLI processes. */
function locked<T>(t: CoordinationTemplate, id: string, work: () => T): T {
  mkdirSync(memoryDir, { recursive: true });
  const path = file(t, id);
  let lock: number;
  try { lock = openSync(path + '.lock', 'wx'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    throw new Error(`Memory channel ${id} is busy. If its writer was interrupted, remove the stale lock at ${path}.lock before retrying.`);
  }
  try { return work(); } finally { closeSync(lock); rmSync(path + '.lock', { force: true }); }
}
/** Merge under an exclusive lock; concurrent CLI runs cannot silently overwrite each other. */
export function saveMemory(t: CoordinationTemplate, id: string, current: MemoryEntry[], additions: MemoryEntry[]): MemoryEntry[] {
  const c = t.memory![id];
  if (c.scope === 'run') return retain([...current, ...additions], c);
  return locked(t, id, () => {
    const path = file(t, id);
    const result = retain([...loadMemory(t, id), ...additions], c);
    writeFileSync(path + '.tmp', JSON.stringify(result, null, 2) + '\n');
    renameSync(path + '.tmp', path);
    return result;
  });
}
export function clearMemory(t: CoordinationTemplate, id: string): void {
  if (!Object.hasOwn(t.memory ?? {}, id)) throw new Error(`Unknown memory channel ${id}`);
  locked(t, id, () => rmSync(file(t, id), { force: true }));
}

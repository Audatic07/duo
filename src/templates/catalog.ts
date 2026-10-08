import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DUO_HOME } from '../paths.ts';
import { BUILTIN_IDS, builtinTemplate } from './builtins.ts';
import type { CoordinationTemplate } from './types.ts';
import { clearMemory, loadMemory, saveMemory } from './memory.ts';
import { validateTemplate } from './validate.ts';

export const TEMPLATES_DIR = join(DUO_HOME, 'templates');
export function listTemplates(): { template: CoordinationTemplate; builtin: boolean; }[] {
  const result = BUILTIN_IDS.map((id) => ({ template: builtinTemplate(id), builtin: true }));
  if (existsSync(TEMPLATES_DIR)) for (const name of readdirSync(TEMPLATES_DIR).filter((p) => /^[a-zA-Z][\w-]*\.json$/.test(p))) {
    try { result.push({ template: validateTemplate(JSON.parse(readFileSync(join(TEMPLATES_DIR, name), 'utf8'))), builtin: false }); }
    catch { /* An invalid manually edited file should not hide the rest of the library. */ }
  }
  return result;
}
export function getTemplate(id: string): CoordinationTemplate {
  if (BUILTIN_IDS.includes(id as any)) return builtinTemplate(id as (typeof BUILTIN_IDS)[number]);
  if (!/^[a-zA-Z][\w-]{0,63}$/.test(id)) throw new Error('Invalid template id');
  const path = join(TEMPLATES_DIR, `${id}.json`);
  if (!existsSync(path)) throw new Error(`No template ${id}`);
  return validateTemplate(JSON.parse(readFileSync(path, 'utf8')));
}
export function saveTemplate(value: unknown): CoordinationTemplate {
  const t = validateTemplate(value);
  if (BUILTIN_IDS.includes(t.id as any)) throw new Error('Built-in templates are read-only; save a copy with a new id');
  mkdirSync(TEMPLATES_DIR, { recursive: true });
  const path = join(TEMPLATES_DIR, `${t.id}.json`);
  if (existsSync(path)) {
    const previous = getTemplate(t.id);
    for (const [channel, rules] of Object.entries(previous.memory ?? {}))
      if (rules.scope === 'template' && t.memory?.[channel]?.scope !== 'template') clearMemory(previous, channel);
  }
  for (const [channel, rules] of Object.entries(t.memory ?? {})) if (rules.scope === 'template') saveMemory(t, channel, loadMemory(t, channel), []);
  writeFileSync(path + '.tmp', JSON.stringify(t, null, 2) + '\n'); renameSync(path + '.tmp', path);
  return t;
}
export function deleteTemplate(id: string): void {
  const t = getTemplate(id);
  if (BUILTIN_IDS.includes(t.id as any)) throw new Error('Built-in templates are read-only');
  for (const [channel, rules] of Object.entries(t.memory ?? {})) if (rules.scope === 'template') clearMemory(t, channel);
  rmSync(join(TEMPLATES_DIR, `${id}.json`), { force: true });
}

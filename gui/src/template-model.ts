import type { Condition, CoordinationTemplate, Step } from '../../src/templates/types.ts';
import { builtinDefinition, type Builtin } from '../../src/templates/definitions.ts';
import { OPERATION_CATALOG, operationStep } from '../../src/templates/operations.ts';

export const STARTER: CoordinationTemplate = {
  version: 1, id: 'my-method', name: 'My method',
  roles: { contributor: { instructions: 'Answer the user’s brief independently.' } },
  assignments: [{ role: 'contributor', select: {} }], start: 'answer',
  steps: { answer: { type: 'turn', role: 'contributor', prompt: '{{brief}}', next: 'done' }, done: { type: 'finish', status: 'completed', reason: 'All contributors answered' } },
  limits: { maxSteps: 20, maxTurns: 20, maxDurationSec: 1800, maxContextChars: 20000 },
};

export const title = (id: string) => id.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const slug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
export function uniqueId(base: string, ids: string[]): string {
  let id = base, n = 2;
  while (ids.includes(id)) id = `${base}-${n++}`;
  return id;
}
export const freshCondition = (): Condition => ({ path: 'visits.answer', op: 'gte', value: 1 });
export function chooseLibrary(t: CoordinationTemplate, library?: Builtin): CoordinationTemplate {
  return { ...(library ? builtinDefinition(library) : structuredClone(STARTER)), id: t.id, name: t.name, description: t.description };
}
export function defaultStep(type: Step['type'], t: CoordinationTemplate, next: string): Step {
  const role = Object.keys(t.roles)[0];
  switch (type) {
    case 'turn': return { type, role, prompt: '{{brief}}', next };
    case 'assign': return { type, role, select: {}, next };
    case 'branch': return { type, cases: [{ when: { path: `visits.${t.start}`, op: 'gte', value: 1 }, next }], otherwise: next };
    case 'finish': return { type, status: 'completed', reason: 'Method completed' };
    case 'operation': return operationStep(Object.keys(OPERATION_CATALOG).find((use) => use.startsWith(`${t.library}.`))!, next);
  }
}

/** Rename identifiers and all their structural/state references without touching instructions or prose. */
export function renameItem(t: CoordinationTemplate, kind: 'role' | 'step' | 'memory', old: string, name: string): CoordinationTemplate {
  const id = slug(name);
  if (!/^[a-z][\w-]*$/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)) throw new Error('Use a name beginning with a letter.');
  const keys = kind === 'memory' ? Object.keys(t.memory ?? {}) : [...Object.keys(t.roles), ...Object.keys(t.steps)];
  if (id === old) return t;
  if (keys.includes(id)) throw new Error('That name is already in use.');
  const copy = structuredClone(t);
  const collection = kind === 'role' ? 'roles' : kind === 'step' ? 'steps' : 'memory';
  (copy as any)[collection] = Object.fromEntries(Object.entries((copy as any)[collection]).map(([k, v]) => [k === old ? id : k, v]));
  const same = (value: string) => value === old ? id : value;
  const selector = (s: any) => {
    if (kind === 'role' && s?.fromRole) s.fromRole = same(s.fromRole);
    if (kind === 'step' && s?.rankBy) s.rankBy.step = same(s.rankBy.step);
  };
  for (const a of copy.assignments) { if (kind === 'role') a.role = same(a.role); selector(a.select); }
  for (const r of copy.transitions ?? []) {
    if (kind === 'role') { r.from = same(r.from); r.to = same(r.to); }
    selector(r.select);
  }
  if (kind === 'step') {
    copy.start = same(copy.start);
    for (const e of copy.exceptions ?? []) e.next = same(e.next);
  }
  for (const s of Object.values(copy.steps)) {
    if (kind === 'role' && (s.type === 'turn' || s.type === 'assign')) s.role = same(s.role);
    if (s.type === 'assign') selector(s.select);
    if ((s.type === 'turn' || s.type === 'operation') && kind !== 'memory') for (const r of s.input ?? []) r.from = same(r.from);
    if (kind === 'step') {
      if ('next' in s) s.next = same(s.next);
      if (s.type === 'branch') { s.otherwise = same(s.otherwise); for (const c of s.cases) c.next = same(c.next); }
      if (s.onError?.next) s.onError.next = same(s.onError.next);
    }
  }
  for (const m of Object.values(copy.memory ?? {})) {
    if (kind === 'role') m.readBy = m.readBy.map(same);
    if (kind === 'step') m.writeFrom = m.writeFrom.map(same);
  }
  const roots = kind === 'role' ? ['roles'] : kind === 'step' ? ['outputs', 'visits'] : ['memory'];
  const path = (p: string) => {
    for (const root of roots) if (p === `${root}.${old}` || p.startsWith(`${root}.${old}.`)) return `${root}.${id}${p.slice(root.length + old.length + 1)}`;
    return p;
  };
  const condition = (c: Condition): void => {
    if ('all' in c) c.all.forEach(condition);
    else if ('any' in c) c.any.forEach(condition);
    else if ('not' in c) condition(c.not);
    else { c.path = path(c.path); if (c.valuePath !== undefined) c.valuePath = path(c.valuePath); if (c.where) condition(c.where); }
  };
  conditions(copy).forEach(condition);
  const text = (s: string) => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, p: string) => `{{${path(p)}}}`);
  for (const r of Object.values(copy.roles)) r.instructions = text(r.instructions);
  for (const s of Object.values(copy.steps)) {
    if (s.type === 'turn') s.prompt = text(s.prompt);
    if (s.type === 'operation' && s.prompts) s.prompts = Object.fromEntries(Object.entries(s.prompts).map(([kind, prompt]) => [kind, text(prompt)]));
    if (s.type === 'finish') s.reason = text(s.reason);
  }
  if (copy.completion) copy.completion.reason = text(copy.completion.reason);
  return copy;
}

export function orderedSteps(t: CoordinationTemplate): string[] {
  const result: string[] = [], seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !t.steps[id]) return;
    seen.add(id); result.push(id);
    const s = t.steps[id];
    if ('next' in s) visit(s.next);
    if (s.type === 'branch') { for (const c of s.cases) visit(c.next); visit(s.otherwise); }
  };
  visit(t.start);
  for (const id of Object.keys(t.steps)) visit(id);
  return result;
}

/** Insert on an existing edge so adding a turn actually makes it run. */
export function insertStep(t: CoordinationTemplate, after: string, type: Step['type']): { template: CoordinationTemplate; id: string; } {
  const id = uniqueId(type === 'turn' ? 'model-turn' : type === 'assign' ? 'change-role' : type === 'branch' ? 'condition' : type === 'operation' ? 'built-in-stage' : 'finish', [...Object.keys(t.roles), ...Object.keys(t.steps)]);
  const previous = t.steps[after];
  const next = previous && 'next' in previous ? previous.next : previous?.type === 'branch' ? previous.otherwise : t.start;
  const s = defaultStep(type, t, next);
  const steps = { ...t.steps };
  if (previous && 'next' in previous && !(previous.type === 'operation' && previous.use.endsWith('.finish'))) steps[after] = { ...previous, next: id };
  else if (previous?.type === 'branch') steps[after] = { ...previous, otherwise: id };
  else if (previous?.type === 'finish' || (previous?.type === 'operation' && previous.use.endsWith('.finish')) || !previous) {
    // Inserting before a finish keeps every incoming edge connected.
    for (const [key, node] of Object.entries(steps)) {
      if ('next' in node && node.next === after) steps[key] = { ...node, next: id };
      if (node.type === 'branch') steps[key] = { ...node, otherwise: node.otherwise === after ? id : node.otherwise, cases: node.cases.map((c) => ({ ...c, next: c.next === after ? id : c.next })) };
    }
    if ('next' in s) s.next = after || next;
  }
  steps[id] = s;
  return { template: { ...t, steps, start: t.start === after && (previous?.type === 'finish' || (previous?.type === 'operation' && previous.use.endsWith('.finish'))) ? id : t.start }, id };
}

export function removalIssue(t: CoordinationTemplate, id: string): string | undefined {
  if (Object.keys(t.steps).length === 1) return 'Keep at least one step.';
  // Conditions and ranking cannot be meaningfully redirected to another result.
  const selectors = [...t.assignments.map((a) => a.select), ...(t.transitions ?? []).map((r) => r.select), ...Object.values(t.steps).flatMap((s) => s.type === 'assign' ? [s.select] : [])];
  if (stateReferences(t, 'step', id) || selectors.some((s) => s?.rankBy?.step === id)) return 'Update the conditions, prompts or rankings that reference this step first.';
  return undefined;
}

function conditions(t: CoordinationTemplate): Condition[] {
  return [...(t.transitions ?? []).map((r) => r.when), ...(t.exceptions ?? []).map((r) => r.when), ...(t.completion ? [t.completion.when] : []), ...Object.values(t.steps).flatMap((s) => s.type === 'branch' ? s.cases.map((c) => c.when) : [])];
}
export function stateReferences(t: CoordinationTemplate, kind: 'step' | 'role' | 'memory', id: string): boolean {
  const roots = kind === 'step' ? ['outputs', 'visits'] : kind === 'role' ? ['roles'] : ['memory'];
  const path = (p: string) => roots.some((root) => p === `${root}.${id}` || p.startsWith(`${root}.${id}.`));
  const test = (c: Condition): boolean => 'all' in c ? c.all.some(test) : 'any' in c ? c.any.some(test) : 'not' in c ? test(c.not) : path(c.path) || (!!c.valuePath && path(c.valuePath)) || (!!c.where && test(c.where));
  if (conditions(t).some(test)) return true;
  const strings = [...Object.values(t.roles).map((r) => r.instructions), ...Object.values(t.steps).flatMap((s) => s.type === 'turn' ? [s.prompt] : s.type === 'operation' ? Object.values(s.prompts ?? {}) : s.type === 'finish' ? [s.reason] : []), ...(t.completion ? [t.completion.reason] : [])];
  return strings.some((s) => [...s.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].some((m) => path(m[1])));
}
export function removeStep(t: CoordinationTemplate, id: string): CoordinationTemplate {
  const issue = removalIssue(t, id);
  if (issue) throw new Error(issue);
  const copy = structuredClone(t), old = copy.steps[id];
  const next = old && 'next' in old && old.next !== id ? old.next : old?.type === 'branch' && old.otherwise !== id ? old.otherwise : Object.keys(copy.steps).find((k) => k !== id && copy.steps[k].type === 'finish') ?? Object.keys(copy.steps).find((k) => k !== id)!;
  delete copy.steps[id];
  if (copy.start === id) copy.start = next;
  for (const s of Object.values(copy.steps)) {
    if ('next' in s && s.next === id) s.next = next;
    if (s.type === 'branch') { if (s.otherwise === id) s.otherwise = next; for (const c of s.cases) if (c.next === id) c.next = next; }
    if (s.onError?.next === id) s.onError.next = next;
    if (s.type === 'turn' || s.type === 'operation') s.input = s.input?.filter((r) => r.from !== id);
  }
  for (const e of copy.exceptions ?? []) if (e.next === id) e.next = next;
  for (const [key, m] of Object.entries(copy.memory ?? {})) {
    m.writeFrom = m.writeFrom.filter((s) => s !== id);
    if (!m.writeFrom.length) delete copy.memory![key];
  }
  return copy;
}

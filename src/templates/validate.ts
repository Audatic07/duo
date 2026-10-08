import { isDeepStrictEqual } from 'node:util';
import type { Condition, CoordinationTemplate } from './types.ts';
import { OPERATION_CATALOG } from './operations.ts';

export const LIBRARIES: Record<string, string[]> = {
  ask: ['ask.answers', 'ask.chair', 'ask.finish'],
  review: ['review.independent', 'review.crosscheck', 'review.merge', 'review.chair', 'review.finish'],
  council: ['council.answers', 'council.rank', 'council.aggregate', 'council.chair', 'council.finish'],
  debate: ['debate.round', 'debate.resolve', 'debate.report', 'debate.chair', 'debate.finish'],
  pair: ['pair.prepare', 'pair.cycle', 'pair.finish'],
};
const key = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min: number, max: number) => Number.isInteger(v) && Number(v) >= min && Number(v) <= max;

/** Collect errors so the editor and generator can repair a whole draft at once. */
export function templateErrors(value: unknown): string[] {
  const errors: string[] = [];
  const err = (s: string): void => { errors.push(s); };
  if (!object(value)) return ['template must be an object'];
  const t = value;
  const allowed = (v: Record<string, unknown>, fields: string[], at: string) => {
    for (const k of Object.keys(v)) if (!fields.includes(k)) err(`${at}: unknown field ${k}`);
  };
  allowed(t, ['version', 'id', 'name', 'description', 'library', 'roles', 'assignments', 'transitions', 'start', 'steps', 'completion', 'exceptions', 'limits', 'workspace', 'memory'], 'template');
  if (t.version !== 1) err('version must be 1');
  if (typeof t.id !== 'string' || !key.test(t.id) || unsafe.has(t.id)) err('id must start with a letter and contain at most 64 letters, digits, hyphens or underscores');
  if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 120) err('name must be 1–120 characters');
  if (t.description !== undefined && typeof t.description !== 'string') err('description must be text');
  const library = typeof t.library === 'string' && Object.hasOwn(LIBRARIES, t.library) ? t.library : undefined;
  if (t.library !== undefined && !library) err('unknown operation library');
  const roles = object(t.roles) ? t.roles : {};
  const steps = object(t.steps) ? t.steps : {};
  if (!Object.keys(roles).length || Object.keys(roles).length > 32) err('define 1–32 roles');
  if (!Object.keys(steps).length || Object.keys(steps).length > 128) err('define 1–128 steps');
  const role = (v: unknown, at: string) => { if (typeof v !== 'string' || !Object.hasOwn(roles, v)) err(`${at}: unknown role ${typeof v === 'string' ? v : '(invalid reference)'}`); };
  const target = (v: unknown, at: string) => { if (typeof v !== 'string' || !Object.hasOwn(steps, v)) err(`${at}: unknown step ${typeof v === 'string' ? v : '(invalid reference)'}`); };
  const select = (v: unknown, at: string) => {
    if (!object(v)) return err(`${at}: selector must be an object`);
    allowed(v, ['ids', 'engine', 'model', 'fromRole', 'count', 'rankBy'], at);
    if (v.ids !== undefined && (!Array.isArray(v.ids) || !v.ids.length || v.ids.some((s: unknown) => typeof s !== 'string' || !/^[A-Z]+$/.test(s)))) err(`${at}: ids must be seat ids such as A, B, C`);
    if (v.engine !== undefined && !['codex', 'claude'].includes(v.engine)) err(`${at}: unknown engine`);
    if (v.model !== undefined && typeof v.model !== 'string') err(`${at}: model must be text`);
    if (v.fromRole !== undefined) role(v.fromRole, at);
    if (v.rankBy !== undefined) {
      if (!object(v.rankBy)) err(`${at}: rankBy must be an object`);
      else {
        allowed(v.rankBy, ['step', 'path', 'direction'], at); target(v.rankBy.step, at);
        if (typeof v.rankBy.path !== 'string' || !/^[\w-]+(?:\.[\w-]+)*$/.test(v.rankBy.path) || v.rankBy.path.split('.').some((p: string) => unsafe.has(p))) err(`${at}: invalid rankBy path`);
        if (v.rankBy.direction !== undefined && !['asc', 'desc'].includes(v.rankBy.direction)) err(`${at}: rankBy direction must be asc or desc`);
      }
    }
    if (v.count !== undefined && !integer(v.count, 1, 32)) err(`${at}: count must be 1–32`);
  };
  const condition = (v: unknown, at: string, depth = 0): void => {
    if (!object(v) || depth > 12) return err(`${at}: invalid condition or nesting deeper than 12`);
    const forms = ['all', 'any', 'not', 'path'].filter((k) => Object.hasOwn(v, k));
    if (forms.length !== 1) return err(`${at}: condition needs exactly one of all, any, not or path`);
    const f = forms[0];
    allowed(v, f === 'path' ? ['path', 'op', 'value', 'valuePath', 'where'] : [f], at);
    if (f === 'all' || f === 'any') {
      if (!Array.isArray(v[f]) || !v[f].length || v[f].length > 64) return err(`${at}: ${f} needs 1–64 conditions`);
      v[f].forEach((c: unknown) => condition(c, at, depth + 1));
    } else if (f === 'not') condition(v.not, at, depth + 1);
    else {
      if (typeof v.path !== 'string' || !/^[\w-]+(?:\.[\w-]+)*$/.test(v.path) || v.path.split('.').some((p: string) => unsafe.has(p))) err(`${at}: invalid data path`);
      if (v.valuePath !== undefined && (typeof v.valuePath !== 'string' || !/^[\w-]+(?:\.[\w-]+)*$/.test(v.valuePath) || v.valuePath.split('.').some((p: string) => unsafe.has(p)))) err(`${at}: invalid valuePath`);
      if (v.op !== 'exists' && v.where === undefined && !Object.hasOwn(v, 'value') && v.valuePath === undefined) err(`${at}: comparison needs value or valuePath`);
      if (Object.hasOwn(v, 'value') && v.valuePath !== undefined) err(`${at}: use value or valuePath, not both`);
      if (v.where !== undefined) {
        if (!['every', 'some'].includes(v.op)) err(`${at}: where is only valid for every/some`);
        condition(v.where, at, depth + 1);
      }
      if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists', 'includes', 'every', 'some'].includes(v.op)) err(`${at}: unknown condition operator`);
    }
  };
  const schema = (v: unknown, at: string, depth = 0): void => {
    if (!object(v) || depth > 12) return err(`${at}: schema must be an object, nested at most 12 levels`);
    allowed(v, ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description'], at);
    const types = Array.isArray(v.type) ? v.type : [v.type];
    if (!types.length || types.some((type: unknown) => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type as string)) || (Array.isArray(v.type) && (types.length !== 2 || !types.includes('null')))) err(`${at}: schema needs a supported type, optionally combined with null`);
    if (v.enum !== undefined && (!Array.isArray(v.enum) || !v.enum.length)) err(`${at}: enum must be nonempty`);
    if (types.includes('object')) {
      if (!object(v.properties)) err(`${at}: object schema needs properties`);
      else for (const [k, s] of Object.entries(v.properties)) {
        if (unsafe.has(k)) err(`${at}: unsafe property ${k}`);
        schema(s, `${at}.${k}`, depth + 1);
      }
      if (v.required !== undefined && (!Array.isArray(v.required) || v.required.some((k: unknown) => typeof k !== 'string' || !Object.hasOwn(v.properties ?? {}, k)))) err(`${at}: required must name properties`);
      if (v.additionalProperties !== undefined && typeof v.additionalProperties !== 'boolean') err(`${at}: additionalProperties must be boolean`);
    }
    if (types.includes('array')) schema(v.items, `${at}.items`, depth + 1);
  };
  for (const [id, r] of Object.entries(roles)) {
    if (!key.test(id) || unsafe.has(id)) err(`invalid role id ${id}`);
    if (!object(r)) { err(`role ${id} must be an object`); continue; }
    allowed(r, ['instructions', 'access', 'schema'], `role ${id}`);
    if (typeof r.instructions !== 'string' || !r.instructions.trim()) err(`role ${id} needs instructions`);
    if (r.access !== undefined && !['read', 'sandboxed', 'sandboxed-network'].includes(r.access)) err(`role ${id}: access must be read, sandboxed or sandboxed-network`);
    if (r.schema !== undefined) schema(r.schema, `role ${id} schema`);
  }
  if (!Array.isArray(t.assignments) || !t.assignments.length) err('assignments must be a nonempty array');
  else for (const a of t.assignments) {
    if (!object(a)) { err('invalid assignment'); continue; }
    allowed(a, ['role', 'select'], 'assignment'); role(a.role, 'assignment'); select(a.select, 'assignment');
  }
  target(t.start, 'start');
  for (const [id, s] of Object.entries(steps)) {
    if (!key.test(id) || unsafe.has(id)) err(`invalid step id ${id}`);
    if (!object(s)) { err(`step ${id} must be an object`); continue; }
    const fields: Record<string, string[]> = {
      turn: ['role', 'prompt', 'input', 'count', 'parallel', 'session', 'next'], assign: ['role', 'select', 'mode', 'next'],
      branch: ['cases', 'otherwise'], finish: ['status', 'reason'], operation: ['use', 'next', 'prompts', 'settings', 'input'],
    };
    if (typeof s.type !== 'string' || !Object.hasOwn(fields, s.type)) { err(`step ${id}: unknown type`); continue; }
    allowed(s, ['type', 'onError', ...fields[s.type]], `step ${id}`);
    if (s.type === 'turn') {
      role(s.role, id);
      if (typeof s.prompt !== 'string' || !s.prompt.trim()) err(`${id}: prompt is empty`);
      if (s.count !== undefined && !integer(s.count, 1, 32)) err(`${id}: count must be 1–32`);
      if (s.parallel !== undefined && typeof s.parallel !== 'boolean') err(`${id}: parallel must be boolean`);
      if (s.session !== undefined && !['fresh', 'role'].includes(s.session)) err(`${id}: session must be fresh or role`);
    }
    if (s.type === 'turn' || s.type === 'operation') {
      if (s.input !== undefined) {
        if (!Array.isArray(s.input) || s.input.length > 32) err(`${id}: input must be up to 32 routes`);
        else for (const r of s.input) {
          if (!object(r)) { err(`${id}: invalid route`); continue; }
          allowed(r, ['from', 'parts', 'history', 'excludeSelf', 'limit', 'anonymous', 'maxChars'], `${id} route`);
          if (typeof r.from !== 'string' || (!Object.hasOwn(roles, r.from) && !Object.hasOwn(steps, r.from))) err(`${id}: route from unknown role/step`);
          else if (Object.hasOwn(roles, r.from) && Object.hasOwn(steps, r.from)) err(`${id}: route source ${r.from} names both a role and a step; rename one to choose the source`);
          if (r.parts !== undefined && (!Array.isArray(r.parts) || !r.parts.length || r.parts.some((p: string) => !['reply', 'data'].includes(p)))) err(`${id}: route parts must be reply and/or data`);
          if (r.history !== undefined && !['latest', 'all'].includes(r.history)) err(`${id}: route history must be latest or all`);
          for (const k of ['excludeSelf', 'anonymous']) if (r[k] !== undefined && typeof r[k] !== 'boolean') err(`${id}: ${k} must be boolean`);
          if (r.limit !== undefined && !integer(r.limit, 1, 32)) err(`${id}: route limit must be 1–32`);
          if (r.maxChars !== undefined && !integer(r.maxChars, 1, 1_000_000)) err(`${id}: route maxChars must be 1–1000000`);
        }
      }
    }
    if (s.type === 'assign') {
      role(s.role, id); select(s.select, id);
      if (s.mode !== undefined && !['replace', 'add'].includes(s.mode)) err(`${id}: mode must be replace or add`);
    }
    if (s.type === 'operation' && !(library ? LIBRARIES[library] : []).includes(s.use)) err(`${id}: operation is not in the selected library`);
    if (s.type === 'operation') {
      const def = typeof s.use === 'string' ? OPERATION_CATALOG[s.use] : undefined;
      if (s.prompts !== undefined) {
        if (!object(s.prompts)) err(`${id}: prompts must be a map of message kinds to templates`);
        else for (const [kind, text] of Object.entries(s.prompts)) {
          if (!Object.hasOwn(def?.prompts ?? {}, kind)) err(`${id}: unsupported prompt kind ${kind}`);
          if (typeof text !== 'string' || !text.trim()) err(`${id}: prompt ${kind} must be nonempty text`);
        }
      }
      if (s.settings !== undefined) {
        if (!object(s.settings)) err(`${id}: settings must be an object`);
        else for (const [name, value] of Object.entries(s.settings)) {
          const field = def?.settings?.[name];
          if (!field) err(`${id}: unknown setting ${name}`);
          else if (field.type === 'boolean' ? typeof value !== 'boolean' : field.type === 'integer' ? !integer(value, field.min ?? 0, field.max ?? 1000) : !field.choices?.some((c) => c.value === value)) err(`${id}: invalid setting ${name}`);
        }
      }
    }
    if (s.type === 'branch') {
      if (!Array.isArray(s.cases) || !s.cases.length) err(`${id}: cases must be nonempty`);
      else for (const c of s.cases) { if (!object(c)) { err(`${id}: invalid case`); continue; } allowed(c, ['when', 'next'], id); condition(c.when, id); target(c.next, id); }
      target(s.otherwise, id);
    } else if (s.type === 'finish') {
      if (!['completed', 'failed', 'blocked', 'limit'].includes(s.status) || typeof s.reason !== 'string') err(`${id}: finish needs status and reason`);
    } else target(s.next, id);
    if (s.onError !== undefined) {
      if (!object(s.onError) || !['fail', 'skip', 'goto'].includes(s.onError.action)) err(`${id}: invalid onError`);
      else { allowed(s.onError, ['action', 'next'], id); if (s.onError.action === 'goto') target(s.onError.next, id); if (s.onError.action === 'skip' && !s.next) err(`${id}: skip needs a next step`); }
    }
  }
  if (t.completion !== undefined) {
    if (!object(t.completion) || typeof t.completion.reason !== 'string') err('completion needs when and reason');
    else { allowed(t.completion, ['when', 'reason'], 'completion'); condition(t.completion.when, 'completion'); }
  }
  for (const [field, list] of [['transitions', t.transitions], ['exceptions', t.exceptions]] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 64) { err(`${field} must be an array of at most 64 rules`); continue; }
    for (const r of list) {
      if (!object(r)) { err(`invalid ${field} rule`); continue; }
      allowed(r, field === 'exceptions' ? ['when', 'next'] : ['when', 'from', 'to', 'select', 'once'], field);
      condition(r.when, field);
      if (field === 'exceptions') target(r.next, field);
      else { role(r.from, field); role(r.to, field); if (r.select !== undefined) select(r.select, field); if (r.once !== undefined && typeof r.once !== 'boolean') err('once must be boolean'); }
    }
  }
  if (!object(t.limits)) err('limits are required');
  else {
    allowed(t.limits, ['maxSteps', 'maxTurns', 'maxDurationSec', 'maxContextChars', 'minSeats'], 'limits');
    for (const [k, max] of [['maxSteps', 10000], ['maxTurns', 1000], ['maxDurationSec', 86400], ['maxContextChars', 1_000_000], ['minSeats', 32]] as const)
      if ((k !== 'minSeats' || t.limits[k] !== undefined) && !integer(t.limits[k], 1, max)) err(`limits.${k} must be 1–${max}`);
  }
  if (t.workspace !== undefined && (!object(t.workspace) || !['worktree', 'in-place'].includes(t.workspace.isolation) || Object.keys(t.workspace).some((k) => k !== 'isolation'))) err('workspace needs isolation: worktree or in-place');
  if (library && Object.values(roles).some((r: any) => r?.access && r.access !== 'read')) err('library operations own their writer workspace and permissions; use a fully custom method for additional write roles');
  if (!t.library && Object.values(roles).some((r: any) => r?.access && r.access !== 'read') && !t.workspace) err('write roles require an explicit workspace isolation');
  if (t.memory !== undefined) {
    if (!object(t.memory) || Object.keys(t.memory).length > 32) err('memory must contain at most 32 named channels');
    else for (const [id, m] of Object.entries(t.memory)) {
      if (!key.test(id) || unsafe.has(id) || !object(m)) { err(`invalid memory channel ${id}`); continue; }
      allowed(m, ['scope', 'readBy', 'writeFrom', 'parts', 'paths', 'maxEntries', 'maxChars'], `memory ${id}`);
      if (!['run', 'template'].includes(m.scope)) err(`memory ${id}: scope must be run or template`);
      if (!Array.isArray(m.readBy) || !m.readBy.length) err(`memory ${id}: readBy needs roles`);
      else for (const r of m.readBy) role(r, `memory ${id}`);
      if (!Array.isArray(m.writeFrom) || !m.writeFrom.length) err(`memory ${id}: writeFrom needs step ids`);
      else for (const r of m.writeFrom) target(r, `memory ${id}`);
      if (!Array.isArray(m.parts) || !m.parts.length || m.parts.some((p: string) => !['reply', 'data'].includes(p))) err(`memory ${id}: parts must be reply and/or data`);
      if (m.paths !== undefined && (!Array.isArray(m.paths) || m.paths.some((p: unknown) => typeof p !== 'string' || !/^[\w-]+(?:\.[\w-]+)*$/.test(p) || p.split('.').some((x) => unsafe.has(x))))) err(`memory ${id}: invalid data paths`);
      if (!integer(m.maxEntries, 1, 1000) || !integer(m.maxChars, 1, 1_000_000)) err(`memory ${id}: maxEntries must be 1–1000 and maxChars 1–1000000`);
    }
  }
  // A reachable finish or native finalizer is required; cycles are still bounded by limits.
  const seen = new Set<string>();
  const visit = (id: unknown) => {
    if (typeof id !== 'string' || seen.has(id) || !Object.hasOwn(steps, id) || !object(steps[id])) return;
    seen.add(id); const s = steps[id];
    if (s.next) visit(s.next);
    if (s.otherwise) visit(s.otherwise);
    if (Array.isArray(s.cases)) for (const c of s.cases) if (c?.next) visit(c.next);
    if (s.onError?.next) visit(s.onError.next);
  };
  visit(t.start);
  for (const r of Array.isArray(t.exceptions) ? t.exceptions : []) if (r?.next) visit(r.next);
  if (![...seen].some((id) => steps[id].type === 'finish' || (typeof steps[id].use === 'string' && steps[id].use.endsWith('.finish'))) && !t.completion) err('no reachable finish or completion criterion');
  return errors;
}
export function validateTemplate(value: unknown): CoordinationTemplate {
  const errors = templateErrors(value);
  if (errors.length) throw new Error(`Invalid coordination template:\n${errors.join('\n')}`);
  return JSON.parse(JSON.stringify(value)) as CoordinationTemplate;
}

export function readPath(data: unknown, path: string): unknown {
  let value = data;
  for (const part of path.split('.')) {
    if (unsafe.has(part) || value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export function matches(c: Condition, state: unknown): boolean {
  if ('all' in c) return c.all.every((x) => matches(x, state));
  if ('any' in c) return c.any.some((x) => matches(x, state));
  if ('not' in c) return !matches(c.not, state);
  const v = readPath(state, c.path);
  const value = c.valuePath ? readPath(state, c.valuePath) : c.value;
  if (c.valuePath && value === undefined) return false;
  const eq = isDeepStrictEqual;
  switch (c.op) {
    case 'exists': return v !== undefined && v !== null;
    case 'eq': return v !== undefined && eq(v, value);
    case 'ne': return v !== undefined && !eq(v, value);
    case 'includes': return typeof v === 'string' && typeof value === 'string' ? v.includes(value as string) : Array.isArray(v) && v.some((x) => eq(x, value));
    case 'every': return Array.isArray(v) && v.length > 0 && v.every((x) => c.where ? matches(c.where, x) : eq(x, value));
    case 'some': return Array.isArray(v) && v.some((x) => c.where ? matches(c.where, x) : eq(x, value));
    default: if (typeof v !== 'number' || typeof value !== 'number') return false;
      return c.op === 'gt' ? v > value : c.op === 'gte' ? v >= value : c.op === 'lt' ? v < value : v <= value;
  }
}

/** Validate the deliberately small schema dialect again locally, independent of the CLI. */
export function schemaError(schema: Record<string, any>, v: unknown, path = 'reply'): string | undefined {
  const type = schema.type;
  if (schema.enum && !schema.enum.some((x: unknown) => isDeepStrictEqual(x, v))) return `${path}: value is outside enum`;
  if (Array.isArray(type)) {
    if (type.includes('null') && v === null) return undefined;
    return schemaError({ ...schema, type: type.find((t) => t !== 'null') }, v, path);
  }
  if (type === 'object') {
    if (!object(v)) return `${path}: expected object`;
    for (const k of schema.required ?? []) if (!Object.hasOwn(v, k)) return `${path}: missing ${k}`;
    for (const [k, x] of Object.entries(v)) {
      if (!Object.hasOwn(schema.properties, k)) { if (schema.additionalProperties === false) return `${path}: unexpected ${k}`; continue; }
      const e = schemaError(schema.properties[k], x, `${path}.${k}`); if (e) return e;
    }
  } else if (type === 'array') {
    if (!Array.isArray(v)) return `${path}: expected array`;
    for (let i = 0; i < v.length; i++) { const e = schemaError(schema.items, v[i], `${path}.${i}`); if (e) return e; }
  } else if (type === 'null' ? v !== null : type === 'integer' ? !Number.isInteger(v) : typeof v !== type) return `${path}: expected ${type}`;
  return undefined;
}

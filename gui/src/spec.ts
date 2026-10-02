/** Seat specs in the GUI: engine[:model][@effort][+option...] (the server validates). */
import type { Engine } from './types.ts';

export interface SpecParts {
  engine: Engine;
  model: string;
  effort?: string;
  opts: [string, string][];
}

export function parseSpec(spec: string): SpecParts {
  const [head, ...rest] = spec.trim().split('+');
  const m = /^([a-z]+)(?::([^@]+))?(?:@([a-z]+))?$/i.exec(head) ?? [];
  const engine = (m[1] === 'codex' || m[1] === 'cx' ? 'codex' : 'claude') as Engine;
  const opts = rest.filter(Boolean).map((o): [string, string] => {
    const i = o.indexOf('=');
    return i < 0 ? [o, ''] : [o.slice(0, i), o.slice(i + 1)];
  });
  return { engine, model: m[2] ?? '', effort: m[3], opts };
}

export function buildSpec(p: SpecParts): string {
  let s = `${p.engine}:${p.model}${p.effort ? '@' + p.effort : ''}`;
  for (const [k, v] of p.opts) s += v ? `+${k}=${v}` : `+${k}`;
  return s;
}

export function getOpt(p: SpecParts, key: string): string | undefined {
  const o = p.opts.find(([k]) => k === key);
  return o ? o[1] || 'on' : undefined;
}

export function setOpt(p: SpecParts, key: string, value: string | undefined): SpecParts {
  const opts = p.opts.filter(([k]) => k !== key);
  if (value !== undefined) opts.push([key, value === 'on' ? '' : value]);
  return { ...p, opts };
}

export function shortSpec(spec: string): string {
  const p = parseSpec(spec);
  return `${p.model || p.engine}${p.effort ? ' · ' + p.effort : ''}`;
}

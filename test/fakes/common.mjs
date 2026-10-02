// Shared by the fake CLIs: a minimal instance of a JSON schema (first enum value, empty arrays).
import { appendFileSync } from 'node:fs';

export function instance(schema, overrides = {}) {
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type;
  if (schema.enum) return schema.enum[0];
  if (t === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(schema.properties ?? {})) o[k] = k in overrides ? overrides[k] : instance(v);
    return o;
  }
  if (t === 'array') return [];
  if (t === 'number' || t === 'integer') return 0.5;
  if (t === 'boolean') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return null;
  return 'fake';
}

export function record(entry) {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\n');
}

export function valueOf(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

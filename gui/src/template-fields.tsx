import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { Condition, CoordinationTemplate, Selector } from '../../src/templates/types.ts';
import { seatId } from '../../src/seat-ids.ts';
import { shortSpec } from './spec.ts';
import { Icon } from './ui.tsx';
import { slug, title, uniqueId } from './template-model.ts';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ComponentChildren; }) {
  return <label class="field">{label}{children}{hint && <span class="template-hint">{hint}</span>}</label>;
}
export function Pick({ label, value, options, onChange, empty, hint }: { label: string; value?: string; options: (string | { value: string; label: string; })[]; onChange: (value: string) => void; empty?: string; hint?: string; }) {
  return <Field label={label} hint={hint}><select value={value ?? ''} onChange={(e) => onChange(e.currentTarget.value)}>
    {empty !== undefined && <option value="">{empty}</option>}
    {options.map((o) => { const v = typeof o === 'string' ? o : o.value; return <option key={v} value={v}>{typeof o === 'string' ? title(o) : o.label}</option>; })}
  </select></Field>;
}
export function NumberField({ label, value, onChange, min = 1, max, optional, hint }: { label: string; value?: number; onChange: (n: number | undefined) => void; min?: number; max: number; optional?: string; hint?: string; }) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(String(value ?? ''));
  useEffect(() => { if (document.activeElement !== input.current) setText(String(value ?? '')); }, [value]);
  return <Field label={label} hint={hint}><input ref={input} type="number" min={min} max={max} value={text} placeholder={optional} onInput={(e) => {
    setText(e.currentTarget.value);
    onChange(e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value));
  }} onBlur={() => setText(String(value ?? ''))} /></Field>;
}
export function NameField({ label, value, onChange, hint, disabled }: { label: string; value: string; onChange: (name: string) => void; hint?: string; disabled?: boolean; }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => { if (text !== value) { onChange(text); setText(value); } };
  return <Field label={label} hint={hint}><input value={text} disabled={disabled} onInput={(e) => setText(e.currentTarget.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); e.currentTarget.blur(); } }} /></Field>;
}
export function ListField({ label, value, onChange, hint, placeholder }: { label: string; value: string[]; onChange: (values: string[]) => void; hint?: string; placeholder?: string; }) {
  const serialized = value.join(', ');
  const [text, setText] = useState(serialized);
  useEffect(() => setText(serialized), [serialized]);
  return <Field label={label} hint={hint}><input value={text} placeholder={placeholder} onInput={(e) => setText(e.currentTarget.value)} onBlur={() => { const next = text.split(',').map((v) => v.trim()).filter(Boolean); if (JSON.stringify(next) !== JSON.stringify(value)) onChange(next); }} /></Field>;
}
export function Checks({ label, options, value, onChange }: { label: string; options: (string | { value: string; label: string; })[]; value: string[]; onChange: (values: string[]) => void; }) {
  return <fieldset class="template-checks"><legend>{label}</legend><div class="row wrap">{options.map((o) => {
    const id = typeof o === 'string' ? o : o.value;
    return <label key={id} class={`template-check ${value.includes(id) ? 'on' : ''}`}><input type="checkbox" checked={value.includes(id)} onChange={(e) => onChange(e.currentTarget.checked ? [...value, id] : value.filter((v) => v !== id))} />{typeof o === 'string' ? title(o) : o.label}</label>;
  })}</div></fieldset>;
}
export function Remove({ label, onClick, disabled, hint }: { label: string; onClick: () => void; disabled?: boolean; hint?: string; }) {
  return <button type="button" class="icon-btn small template-remove" aria-label={label} title={hint ?? label} disabled={disabled} onClick={onClick}><Icon name="trash" size={14} /></button>;
}
export function SectionTitle({ title: heading, hint, children }: { title: string; hint?: string; children?: ComponentChildren; }) {
  return <div class="template-section-title"><div><h4>{heading}</h4>{hint && <p class="template-hint">{hint}</p>}</div>{children}</div>;
}

export function SelectorEditor({ value, onChange, template, seats }: { value: Selector; onChange: (value: Selector) => void; template: CoordinationTemplate; seats: string[]; }) {
  const update = (patch: Partial<Selector>) => onChange({ ...value, ...patch });
  const ids = [...new Set([...seats.map((_, i) => seatId(i)), ...(value.ids ?? [])])];
  return <div class="template-stack">
    <div class="template-grid">
      <Pick label="Eligible models" value={value.ids ? 'choose' : 'all'} options={[{ value: 'all', label: 'All seats' }, { value: 'choose', label: 'Choose seats' }]} onChange={(v) => update({ ids: v === 'all' ? undefined : [ids[0] ?? 'A'] })} />
      <NumberField label="How many" value={value.count} max={32} optional="All eligible models" onChange={(count) => update({ count })} />
    </div>
    {value.ids && <Checks label="Seats" value={value.ids} options={ids.map((id) => ({ value: id, label: `${id}${seats.find((_, i) => seatId(i) === id) ? ` · ${shortSpec(seats[ids.indexOf(id)])}` : ' · not added yet'}` }))} onChange={(v) => update({ ids: v })} />}
    <details class="template-details"><summary>Eligibility filters & ranking</summary><div class="template-stack">
      <div class="template-grid">
        <Pick label="Provider" value={value.engine} empty="Any provider" options={['codex', 'claude']} onChange={(v) => update({ engine: (v || undefined) as Selector['engine'] })} />
        <Pick label="Currently in role" value={value.fromRole} empty="Any role" options={Object.keys(template.roles)} onChange={(v) => update({ fromRole: v || undefined })} />
      </div>
      <Field label="Exact model name" hint="Leave blank to allow any model."><input value={value.model ?? ''} placeholder="e.g. gpt-6-sol" onInput={(e) => update({ model: e.currentTarget.value || undefined })} /></Field>
      <Pick label="Choose by" value={value.rankBy ? 'score' : 'order'} options={[{ value: 'order', label: 'Seat order' }, { value: 'score', label: 'Score from an earlier step' }]} onChange={(v) => update({ rankBy: v === 'score' ? { step: template.start, path: 'data.score', direction: 'desc' } : undefined })} />
      {value.rankBy && <div class="template-grid">
        <Pick label="Score step" value={value.rankBy.step} options={Object.keys(template.steps)} onChange={(step) => update({ rankBy: { ...value.rankBy!, step } })} />
        <Field label="Score field"><input value={value.rankBy.path} placeholder="data.score" onInput={(e) => update({ rankBy: { ...value.rankBy!, path: e.currentTarget.value } })} /></Field>
        <Pick label="Ranking" value={value.rankBy.direction ?? 'desc'} options={[{ value: 'desc', label: 'Highest score first' }, { value: 'asc', label: 'Lowest score first' }]} onChange={(v) => update({ rankBy: { ...value.rankBy!, direction: v as 'asc' | 'desc' } })} />
      </div>}
    </div></details>
  </div>;
}

export function statePaths(t: CoordinationTemplate, perModel = false): string[] {
  const result = ['vars.error', ...(t.library ? ['vars.done'] : []), ...(t.library === 'debate' ? ['vars.reviewComplete', 'vars.reviewAddressed', 'vars.ledger.claims', 'vars.ledger.resolution.agreed', 'vars.ledger.resolution.disputed', 'vars.ledger.resolution.unaddressed'] : []), ...(perModel ? ['model.id', 'model.engine', 'model.model', 'model.reply'] : [])];
  for (const [id, step] of Object.entries(t.steps)) {
    result.push(`visits.${id}`);
    if (step.type !== 'turn' && (step.type !== 'operation' || step.use.endsWith('.finish'))) continue;
    result.push(`outputs.${id}`, `outputs.${id}.0.reply`);
    const schema = step.type === 'turn' ? t.roles[step.role]?.schema : undefined;
    for (const key of Object.keys((schema?.properties as object) ?? {})) result.push(`outputs.${id}.0.data.${key}`, ...(perModel ? [`model.data.${key}`] : []));
  }
  result.push(...Object.keys(t.roles).map((r) => `roles.${r}`), ...Object.keys(t.memory ?? {}).map((m) => `memory.${m}`));
  return [...new Set(result)];
}

/** Typed literal controls preserve compound values without making JSON a prerequisite. */
function ValueEditor({ value, onChange, depth = 0, fixedType }: { value: unknown; onChange: (v: unknown) => void; depth?: number; fixedType?: boolean; }) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const defaults: Record<string, unknown> = { string: '', number: 0, boolean: true, null: null, array: [], object: {} };
  return <div class="template-value">
    {!fixedType && <Pick label="Value type" value={type} options={[{ value: 'string', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'boolean', label: 'Yes / no' }, { value: 'null', label: 'Empty (null)' }, { value: 'array', label: 'List' }, { value: 'object', label: 'Fields' }]} onChange={(v) => onChange(defaults[v])} />}
    {type === 'string' && <Field label="Value"><input value={String(value)} onInput={(e) => onChange(e.currentTarget.value)} /></Field>}
    {type === 'number' && <Field label="Value"><input type="number" step="any" value={value as number} onInput={(e) => onChange(e.currentTarget.value === '' ? 0 : Number(e.currentTarget.value))} /></Field>}
    {type === 'boolean' && <Pick label="Value" value={value ? 'yes' : 'no'} options={[{ value: 'yes', label: 'Yes (true)' }, { value: 'no', label: 'No (false)' }]} onChange={(v) => onChange(v === 'yes')} />}
    {depth < 12 && type === 'array' && <div class="template-stack template-span">
      {(value as unknown[]).map((v, i) => <div class="template-subcard" key={i}><div class="row"><b class="small">Item {i + 1}</b><span class="spacer" /><Remove label={`Remove item ${i + 1}`} onClick={() => onChange((value as unknown[]).filter((_, n) => n !== i))} /></div><ValueEditor value={v} depth={depth + 1} onChange={(next) => onChange((value as unknown[]).map((old, n) => n === i ? next : old))} /></div>)}
      <button type="button" class="btn small ghost" onClick={() => onChange([...(value as unknown[]), ''])}><Icon name="plus" size={13} />Add item</button>
    </div>}
    {depth < 12 && type === 'object' && <div class="template-stack template-span">
      {Object.entries(value as Record<string, unknown>).map(([key, v]) => <div class="template-subcard" key={key}>
        <div class="row"><NameField label="Field name" value={key} onChange={(name) => {
          const id = slug(name); if (!id || ['__proto__', 'prototype', 'constructor'].includes(id) || Object.hasOwn(value as object, id)) return;
          onChange(Object.fromEntries(Object.entries(value as object).map(([k, old]) => [k === key ? id : k, old])));
        }} /><Remove label={`Remove ${key}`} onClick={() => onChange(Object.fromEntries(Object.entries(value as object).filter(([k]) => k !== key)))} /></div>
        <ValueEditor value={v} depth={depth + 1} onChange={(next) => onChange({ ...(value as object), [key]: next })} />
      </div>)}
      <button type="button" class="btn small ghost" onClick={() => onChange({ ...(value as object), [uniqueId('field', Object.keys(value as object))]: '' })}><Icon name="plus" size={13} />Add field</button>
    </div>}
  </div>;
}

const OPERATORS = [
  { value: 'eq', label: 'is equal to' }, { value: 'ne', label: 'is not equal to' }, { value: 'gt', label: 'is greater than' }, { value: 'gte', label: 'is at least' },
  { value: 'lt', label: 'is less than' }, { value: 'lte', label: 'is at most' }, { value: 'exists', label: 'has a value' }, { value: 'includes', label: 'contains' },
  { value: 'every', label: 'every item matches' }, { value: 'some', label: 'any item matches' },
];
function pathLabel(path: string): string {
  const parts = path.split('.');
  if (parts[0] === 'visits') return `${title(parts[1])} · Times visited`;
  if (parts[0] === 'outputs') return `${title(parts[1])} · ${parts.length === 2 ? 'All model responses' : parts[3] === 'data' ? `${title(parts.slice(4).join('.'))} (model ${Number(parts[2]) + 1})` : `Response text (model ${Number(parts[2]) + 1})`}`;
  if (parts[0] === 'roles') return `${title(parts[1])} · Assigned models`;
  if (parts[0] === 'memory') return `${title(parts[1])} · Stored memory`;
  if (path === 'vars.done') return 'Built-in stage · Finished';
  if (path === 'vars.error') return 'Run · Last error';
  if (parts[0] === 'model') return `Current model · ${path === 'model.id' ? 'Seat' : path === 'model.engine' ? 'Provider' : path === 'model.model' ? 'Model name' : path === 'model.reply' ? 'Latest response' : title(parts.slice(2).join('.'))}`;
  return parts[0] === 'data' ? `Item · ${title(parts.slice(1).join('.'))}` : title(path);
}
function PathField({ label, value, onChange, paths }: { label: string; value: string; onChange: (v: string) => void; paths: string[]; }) {
  const [custom, setCustom] = useState(!paths.includes(value));
  const id = useId();
  return <div class="template-stack">
    <Pick label={label} value={custom || !paths.includes(value) ? '__custom' : value} options={[...paths.map((p) => ({ value: p, label: pathLabel(p) })), { value: '__custom', label: 'Custom data path…' }]} onChange={(v) => { setCustom(v === '__custom'); if (v !== '__custom') onChange(v); }} />
    {(custom || !paths.includes(value)) && <Field label="Data path" hint="Select a suggestion or enter a path to any recorded field."><input value={value} list={id} onInput={(e) => onChange(e.currentTarget.value)} /><datalist id={id}>{paths.map((p) => <option key={p} value={p} />)}</datalist></Field>}
  </div>;
}
export function ConditionEditor({ value, onChange, paths, depth = 0 }: { value: Condition; onChange: (v: Condition) => void; paths: string[]; depth?: number; }) {
  const kind = 'all' in value ? 'all' : 'any' in value ? 'any' : 'not' in value ? 'not' : 'test';
  const fallback: Condition = { path: paths.find((p) => p.startsWith('visits.')) ?? 'vars.done', op: 'gte', value: 1 };
  return <div class="template-condition">
    <Pick label="Match" value={kind} options={[{ value: 'test', label: 'One condition' }, ...(depth < 11 ? [{ value: 'all', label: 'All of these conditions' }, { value: 'any', label: 'Any of these conditions' }, { value: 'not', label: 'The following is false' }] : [])]} onChange={(v) => {
      const child = 'all' in value ? value.all[0] : 'any' in value ? value.any[0] : 'not' in value ? value.not : value;
      onChange(v === 'test' ? ('path' in child ? child : fallback) : v === 'not' ? { not: child } : v === 'any' ? { any: [child] } : { all: [child] });
    }} />
    {('all' in value || 'any' in value) && <div class="template-stack">
      {('all' in value ? value.all : value.any).map((c, i, list) => <div class="template-subcard" key={i}>
        <div class="row"><span class="template-eyebrow">Condition {i + 1}</span><span class="spacer" /><Remove label={`Remove condition ${i + 1}`} disabled={list.length <= 1} onClick={() => onChange('all' in value ? { all: list.filter((_, n) => n !== i) } : { any: list.filter((_, n) => n !== i) })} /></div>
        <ConditionEditor value={c} paths={paths} depth={depth + 1} onChange={(next) => onChange('all' in value ? { all: list.map((old, n) => n === i ? next : old) } : { any: list.map((old, n) => n === i ? next : old) })} />
      </div>)}
      <button class="btn small ghost" type="button" disabled={depth >= 11} onClick={() => onChange('all' in value ? { all: [...value.all, fallback] } : { any: [...value.any, fallback] })}><Icon name="plus" size={13} />Add condition</button>
    </div>}
    {'not' in value && <ConditionEditor value={value.not} paths={paths} depth={depth + 1} onChange={(not) => onChange({ not })} />}
    {'path' in value && <>
      <div class="template-grid">
        <PathField label="Data to check" value={value.path} paths={paths} onChange={(path) => onChange({ ...value, path })} />
        <Pick label="Comparison" value={value.op} options={OPERATORS} onChange={(v) => {
          const op = v as typeof value.op;
          if (op === 'exists') return onChange({ path: value.path, op });
          const { where, ...rest } = value;
          const keepWhere = where && ['every', 'some'].includes(op);
          onChange({ ...rest, op, ...(keepWhere ? { where } : {}), ...(!Object.hasOwn(rest, 'value') && rest.valuePath === undefined && !keepWhere ? { value: true } : {}) });
        }} />
      </div>
      {value.op !== 'exists' && <>
        <Pick label="Compare against" value={value.where ? 'where' : value.valuePath !== undefined ? 'path' : 'value'} options={[{ value: 'value', label: 'A specific value' }, { value: 'path', label: 'Another data field' }, ...(['every', 'some'].includes(value.op) && depth < 11 ? [{ value: 'where', label: 'A condition for each item' }] : [])]} onChange={(v) => onChange({ path: value.path, op: value.op, ...(v === 'path' ? { valuePath: value.path } : v === 'where' ? { where: { path: 'data.approved', op: 'eq', value: true } } : { value: true }) })} />
        {value.where ? <ConditionEditor value={value.where} paths={['data.approved', 'data.done', 'data.score', 'reply', 'seat', 'role']} depth={depth + 1} onChange={(where) => onChange({ ...value, where })} /> : value.valuePath !== undefined ? <PathField label="Other data field" value={value.valuePath} paths={paths} onChange={(valuePath) => onChange({ ...value, valuePath })} /> : <ValueEditor value={value.value ?? (value.value === null ? null : true)} onChange={(v) => onChange({ ...value, value: v })} />}
      </>}
    </>}
  </div>;
}

export function SchemaEditor({ value, onChange, depth = 0 }: { value: Record<string, any>; onChange: (s: Record<string, any>) => void; depth?: number; }) {
  const properties = value.properties ?? {};
  const type = Array.isArray(value.type) ? value.type.find((t: string) => t !== 'null') : value.type;
  const nullable = Array.isArray(value.type) && value.type.includes('null');
  return <div class="template-stack">
    <Pick label="Response type" value={type} options={['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']} onChange={(type) => onChange({ type: nullable && type !== 'null' ? [type, 'null'] : type, ...(value.description ? { description: value.description } : {}), ...(type === 'object' ? { properties: {}, required: [], additionalProperties: false } : type === 'array' ? { items: { type: 'string' } } : {}) })} />
    {type !== 'null' && <label class="template-inline-check"><input type="checkbox" checked={nullable} onChange={(e) => onChange({ ...value, type: e.currentTarget.checked ? [type, 'null'] : type })} />Allow null</label>}
    {type === 'object' && <>
      {Object.entries(properties).map(([key, schema]) => <div class="template-subcard" key={key}>
        <div class="row"><NameField label="Field name" value={key} onChange={(name) => {
          const id = slug(name); if (!id || id === key || ['__proto__', 'constructor', 'prototype'].includes(id) || Object.hasOwn(properties, id)) return;
          onChange({ ...value, properties: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k === key ? id : k, v])), required: (value.required ?? []).map((k: string) => k === key ? id : k) });
        }} /><Remove label={`Remove field ${key}`} onClick={() => onChange({ ...value, properties: Object.fromEntries(Object.entries(properties).filter(([k]) => k !== key)), required: (value.required ?? []).filter((k: string) => k !== key) })} /></div>
        <label class="template-inline-check"><input type="checkbox" checked={(value.required ?? []).includes(key)} onChange={(e) => onChange({ ...value, required: e.currentTarget.checked ? [...(value.required ?? []), key] : (value.required ?? []).filter((k: string) => k !== key) })} />Required</label>
        <SchemaEditor value={schema as Record<string, any>} depth={depth + 1} onChange={(s) => onChange({ ...value, properties: { ...properties, [key]: s } })} />
      </div>)}
      <button class="btn small ghost" type="button" disabled={depth >= 11} onClick={() => { const id = uniqueId('field', Object.keys(properties)); onChange({ ...value, properties: { ...properties, [id]: { type: 'string' } }, required: [...(value.required ?? []), id] }); }}><Icon name="plus" size={13} />Add response field</button>
      <label class="template-inline-check"><input type="checkbox" checked={value.additionalProperties !== false} onChange={(e) => onChange({ ...value, additionalProperties: e.currentTarget.checked })} />Allow additional fields</label>
    </>}
    {type === 'array' && depth < 12 && <div class="template-subcard"><span class="template-eyebrow">Each list item</span><SchemaEditor value={value.items ?? { type: 'string' }} depth={depth + 1} onChange={(items) => onChange({ ...value, items })} /></div>}
    <details class="template-details"><summary>Field description & allowed values</summary><div class="template-stack">
      <Field label="Description"><input value={value.description ?? ''} onInput={(e) => onChange({ ...value, description: e.currentTarget.value || undefined })} /></Field>
      <label class="template-inline-check"><input type="checkbox" checked={!!value.enum} onChange={(e) => onChange({ ...value, enum: e.currentTarget.checked ? [type === 'boolean' ? true : type === 'number' || type === 'integer' ? 0 : ''] : undefined })} />Restrict to allowed values</label>
      {value.enum && <ValueEditor fixedType value={value.enum} onChange={(v) => { if (Array.isArray(v)) onChange({ ...value, enum: v }); }} />}
    </div></details>
  </div>;
}

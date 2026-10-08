import { useState } from 'preact/hooks';
import type { CoordinationTemplate, MemoryChannel, Role } from '../../src/templates/types.ts';
import { api } from './api.ts';
import { confirmAction, guard, toast } from './store.ts';
import { Empty, Icon, Toggle } from './ui.tsx';
import { Checks, ConditionEditor, Field, ListField, NameField, NumberField, Pick, Remove, SchemaEditor, SectionTitle, SelectorEditor, statePaths } from './template-fields.tsx';
import { renameItem, stateReferences, title, uniqueId } from './template-model.ts';

type Props = { template: CoordinationTemplate; onChange: (t: CoordinationTemplate) => void; seats: string[]; };

export function RolesEditor({ template: t, onChange, seats, selected, onSelect: setSelected }: Props & { selected: string; onSelect: (id: string) => void; }) {
  const id = t.roles[selected] ? selected : Object.keys(t.roles)[0], role = t.roles[id];
  const ids = Object.keys(t.roles);
  const nativeRole = !!t.library && (t.library === 'pair' ? ['writer', 'reviewer'] : ['participant', 'chair', ...(t.library === 'council' ? ['reviewer'] : [])]).includes(id);
  const update = (r: Role) => onChange({ ...t, roles: { ...t.roles, [id]: r } });
  const usage = Object.values(t.steps).some((s) => ('role' in s && s.role === id) || (s.type === 'turn' && s.input?.some((r) => r.from === id)) || (s.type === 'assign' && s.select.fromRole === id)) ||
    t.transitions?.some((r) => r.from === id || r.to === id || r.select?.fromRole === id) || Object.values(t.memory ?? {}).some((m) => m.readBy.includes(id)) || t.assignments.some((a) => a.select.fromRole === id) || stateReferences(t, 'role', id);
  const removeHint = nativeRole ? 'The built-in stages require this role.' : ids.length <= 1 ? 'Keep at least one role.' : usage ? 'Update steps, rules or memory that reference this role first.' : !t.assignments.some((a) => a.role !== id) ? 'Assign starting models to another role first.' : undefined;
  return <div class="template-stack">
    <SectionTitle title="Model roles" hint="Give each role a responsibility, then choose which models start in it."><button type="button" class="btn small" disabled={ids.length >= 32} onClick={() => {
      const key = uniqueId('new-role', [...ids, ...Object.keys(t.steps)]); onChange({ ...t, roles: { ...t.roles, [key]: { instructions: 'Describe this role’s responsibility.' } } }); setSelected(key);
    }}><Icon name="plus" size={14} />Add role</button></SectionTitle>
    <div class="template-role-tabs" aria-label="Roles">{ids.map((key) => <button type="button" key={key} class={`chip ${key === id ? 'open' : ''}`} aria-pressed={key === id} onClick={() => setSelected(key)}><Icon name="user" size={13} />{title(key)}</button>)}</div>
    {role && <div class="template-card" key={id}>
      <div class="row"><span class="template-eyebrow">Role {ids.indexOf(id) + 1} of {ids.length}</span><span class="spacer" /><Remove label={`Remove role ${title(id)}`} disabled={!!removeHint} hint={removeHint} onClick={() => {
        const roles = { ...t.roles }; delete roles[id]; onChange({ ...t, roles, assignments: t.assignments.filter((a) => a.role !== id) }); setSelected(Object.keys(roles)[0]);
      }} /></div>
      <NameField label="Role name" value={title(id)} disabled={nativeRole} hint={nativeRole ? 'This name is part of the built-in role contract.' : undefined} onChange={(name) => { try { const next = renameItem(t, 'role', id, name); onChange(next); setSelected(Object.keys(next.roles).find((k) => !t.roles[k]) ?? id); } catch (e) { toast((e as Error).message); } }} />
      <Field label="Instructions" hint={nativeRole ? 'These instructions supplement this role’s original built-in prompts.' : 'Describe what this role should do and what a good response looks like.'}><textarea rows={5} value={role.instructions} onInput={(e) => update({ ...role, instructions: e.currentTarget.value })} /></Field>
      {nativeRole && <p class="template-hint">Library stages use the response fields below. Preserve the fields their ledger, ranking or review checks consume; add or customize fields as needed. Writer permissions are set in the run controls.</p>}
      {!nativeRole && <>
        <Pick label="Permissions" value={role.access ?? 'read'} options={[{ value: 'read', label: 'Read only' }, ...(!t.library ? [{ value: 'sandboxed', label: 'Edit files in the workspace' }, { value: 'sandboxed-network', label: 'Edit files and access the network' }] : [])]} hint={t.library ? 'Additional roles in a built-in copy are read-only. Create a new method for custom write roles.' : undefined} onChange={(v) => onChange({ ...t, roles: { ...t.roles, [id]: { ...role, access: v as Role['access'] } }, ...(v !== 'read' && !t.workspace ? { workspace: { isolation: 'worktree' } } : {}) })} />
      </>}
      <Pick label="Response format" value={role.schema ? 'structured' : 'text'} options={[...(!nativeRole || !role.schema ? [{ value: 'text', label: 'Free-form response' }] : []), { value: 'structured', label: 'Structured fields' }]} onChange={(v) => update({ ...role, schema: v === 'structured' ? { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } : undefined })} />
      {role.schema && <details class="template-details"><summary>Response fields</summary><div class="template-subcard"><SchemaEditor value={role.schema} onChange={(schema) => update({ ...role, schema })} /></div></details>}
      <div class="template-divider" />
      <SectionTitle title="Models at the start" hint="Each model holds one role at a time. Later assignments take priority." />
      {t.assignments.map((a, i) => a.role === id && <div class="template-subcard" key={i}><div class="row"><span class="template-eyebrow">Assignment {i + 1}</span><span class="spacer" /><Remove label={`Remove assignment ${i + 1}`} disabled={t.assignments.length <= 1} hint={t.assignments.length <= 1 ? 'The method needs at least one initial assignment.' : undefined} onClick={() => onChange({ ...t, assignments: t.assignments.filter((_, n) => n !== i) })} /></div>
        <SelectorEditor value={a.select} template={t} seats={seats} onChange={(select) => onChange({ ...t, assignments: t.assignments.map((v, n) => n === i ? { ...v, select } : v) })} />
      </div>)}
      {!t.assignments.some((a) => a.role === id) && <p class="template-empty-note"><Icon name="clock" size={14} />No models start in this role. Assign it in a workflow step or role-change rule.</p>}
      <button class="btn small ghost template-add" type="button" onClick={() => onChange({ ...t, assignments: [...t.assignments, { role: id, select: { ids: [seats.length > 1 ? 'B' : 'A'] } }] })}><Icon name="plus" size={14} />Assign models at start</button>
      {removeHint && <p class="template-hint">To remove this role: {removeHint}</p>}
    </div>}
  </div>;
}

export function RulesEditor({ template: t, onChange, seats }: Props) {
  const paths = statePaths(t), modelPaths = statePaths(t, true), roles = Object.keys(t.roles), steps = Object.keys(t.steps);
  const condition = () => ({ path: `visits.${t.start}`, op: 'gte' as const, value: 1 });
  return <div class="template-stack template-rule-sections">
    <div class="template-stack">
      <SectionTitle title="Conditional role changes" hint="Checked after each step, in order. A role change opens a fresh conversation for that model."><button class="btn small" type="button" disabled={(t.transitions?.length ?? 0) >= 64} onClick={() => onChange({ ...t, transitions: [...(t.transitions ?? []), { from: roles[0], to: roles[1] ?? roles[0], when: condition() }] })}><Icon name="plus" size={14} />Add rule</button></SectionTitle>
      {!t.transitions?.length && <p class="template-empty-note"><Icon name="user" size={14} />Roles stay fixed unless a workflow step changes them.</p>}
      {t.transitions?.map((r, i) => {
        const update = (patch: Partial<typeof r>) => onChange({ ...t, transitions: t.transitions!.map((v, n) => n === i ? { ...v, ...patch } : v) });
        return <div class="template-card" key={i}>
          <div class="row"><span class="template-eyebrow">Role change {i + 1}</span><span class="spacer" /><button class="icon-btn small" type="button" aria-label={`Move role change ${i + 1} up`} disabled={i === 0} onClick={() => { const transitions = [...t.transitions!];[transitions[i - 1], transitions[i]] = [transitions[i], transitions[i - 1]]; onChange({ ...t, transitions }); }}><Icon name="up" size={14} /></button><Remove label={`Remove role change ${i + 1}`} onClick={() => onChange({ ...t, transitions: t.transitions!.filter((_, n) => n !== i) })} /></div>
          <div class="template-grid"><Pick label="From role" value={r.from} options={roles} onChange={(from) => update({ from })} /><Pick label="To role" value={r.to} options={roles} onChange={(to) => update({ to })} /></div>
          <ConditionEditor value={r.when} paths={modelPaths} onChange={(when) => update({ when })} />
          <Toggle checked={r.once !== false} label="Apply this rule only once" onChange={(once) => update({ once })} />
          <details class="template-details"><summary>Restrict eligible models</summary><SelectorEditor value={r.select ?? {}} template={t} seats={seats} onChange={(select) => update({ select })} /></details>
        </div>;
      })}
    </div>
    <div class="template-stack">
      <SectionTitle title="Completion condition" hint="Optionally finish as soon as a condition is met, without waiting for a Finish step." />
      <Toggle checked={!!t.completion} label="Finish when a condition is met" onChange={(enabled) => onChange({ ...t, completion: enabled ? { when: condition(), reason: 'Completion condition met' } : undefined })} />
      {t.completion && <div class="template-card"><ConditionEditor value={t.completion.when} paths={paths} onChange={(when) => onChange({ ...t, completion: { ...t.completion!, when } })} /><Field label="Completion message"><input value={t.completion.reason} onInput={(e) => onChange({ ...t, completion: { ...t.completion!, reason: e.currentTarget.value } })} /></Field></div>}
    </div>
    <div class="template-stack">
      <SectionTitle title="Exceptions" hint="The first matching exception redirects the flow before completion is checked."><button class="btn small" type="button" disabled={(t.exceptions?.length ?? 0) >= 64} onClick={() => onChange({ ...t, exceptions: [...(t.exceptions ?? []), { when: { path: 'vars.error', op: 'exists' }, next: steps.find((s) => t.steps[s].type === 'finish') ?? t.start }] })}><Icon name="plus" size={14} />Add exception</button></SectionTitle>
      {!t.exceptions?.length && <p class="template-empty-note"><Icon name="shield" size={14} />No global exceptions. Each step has its own failure handling.</p>}
      {t.exceptions?.map((r, i) => <div class="template-card" key={i}>
        <div class="row"><span class="template-eyebrow">Exception {i + 1}</span><span class="spacer" /><button class="icon-btn small" type="button" aria-label={`Move exception ${i + 1} up`} disabled={i === 0} onClick={() => { const exceptions = [...t.exceptions!];[exceptions[i - 1], exceptions[i]] = [exceptions[i], exceptions[i - 1]]; onChange({ ...t, exceptions }); }}><Icon name="up" size={14} /></button><Remove label={`Remove exception ${i + 1}`} onClick={() => onChange({ ...t, exceptions: t.exceptions!.filter((_, n) => n !== i) })} /></div>
        <ConditionEditor value={r.when} paths={paths} onChange={(when) => onChange({ ...t, exceptions: t.exceptions!.map((v, n) => n === i ? { ...v, when } : v) })} />
        <Pick label="Recovery step" value={r.next} options={steps} onChange={(next) => onChange({ ...t, exceptions: t.exceptions!.map((v, n) => n === i ? { ...v, next } : v) })} />
      </div>)}
    </div>
  </div>;
}

export function MemoryEditor({ template: t, onChange, savedId }: Omit<Props, 'seats'> & { savedId?: string; }) {
  const [clearing, setClearing] = useState<string>();
  const channels = Object.entries(t.memory ?? {}), roles = Object.keys(t.roles), steps = Object.keys(t.steps);
  const add = () => {
    const id = uniqueId('decisions', channels.map(([key]) => key));
    onChange({ ...t, memory: { ...t.memory, [id]: { scope: 'template', readBy: [roles[0]], writeFrom: [steps.find((s) => t.steps[s].type === 'turn') ?? t.start], parts: ['reply'], maxEntries: 8, maxChars: 4000 } } });
  };
  const clear = async (id: string) => {
    if (!savedId) return;
    setClearing(id);
    const result = await guard(api(`/api/templates/${encodeURIComponent(savedId)}/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    if (result) toast(`Cleared ${title(id)} memory`, 'success');
    setClearing(undefined);
  };
  return <div class="template-stack">
    <SectionTitle title="Persistent memory" hint="Choose what gets retained, which roles can reference it, and how much to keep."><button type="button" class="btn small" disabled={channels.length >= 32} onClick={add}><Icon name="plus" size={14} />Add memory</button></SectionTitle>
    {!channels.length && <div class="template-empty"><Empty icon="layers" title="Keep useful context between turns">Store decisions, research or feedback in a bounded memory channel.</Empty><button type="button" class="btn small" onClick={add}><Icon name="plus" size={14} />Create memory channel</button></div>}
    {channels.map(([id, m]) => {
      const update = (patch: Partial<MemoryChannel>) => onChange({ ...t, memory: { ...t.memory, [id]: { ...m, ...patch } } });
      return <div class="template-card" key={id}>
        <div class="row"><span class="template-eyebrow">Memory channel</span><span class="spacer" /><Remove label={`Remove memory ${title(id)}`} disabled={stateReferences(t, 'memory', id)} hint={stateReferences(t, 'memory', id) ? 'Update conditions or prompts that reference this channel first.' : undefined} onClick={() => { const memory = { ...t.memory }; delete memory[id]; onChange({ ...t, memory }); }} /></div>
        <div class="template-grid"><NameField label="Memory name" value={title(id)} onChange={(name) => { try { onChange(renameItem(t, 'memory', id, name)); } catch (e) { toast((e as Error).message); } }} /><Pick label="Keep for" value={m.scope} options={[{ value: 'run', label: 'This run only' }, { value: 'template', label: 'Future runs of this method' }]} onChange={(v) => update({ scope: v as MemoryChannel['scope'] })} /></div>
        <Checks label="Store responses from steps" value={m.writeFrom} options={steps} onChange={(writeFrom) => update({ writeFrom })} />
        <Checks label="Roles that can read this memory" value={m.readBy} options={roles} onChange={(readBy) => update({ readBy })} />
        <Checks label="What to store" value={m.parts} options={[{ value: 'reply', label: 'Full response' }, { value: 'data', label: 'Structured fields' }]} onChange={(v) => update({ parts: v as MemoryChannel['parts'] })} />
        {m.parts.includes('data') && <ListField label="Retain only these fields" value={m.paths ?? []} placeholder="decision, summary" hint="Comma-separated field paths. Leave blank to retain all structured fields." onChange={(paths) => update({ paths: paths.length ? paths : undefined })} />}
        <div class="template-grid"><NumberField label="Maximum entries" value={m.maxEntries} max={1000} onChange={(n) => update({ maxEntries: n ?? 0 })} /><NumberField label="Total character budget" value={m.maxChars} max={1000000} onChange={(n) => update({ maxChars: n ?? 0 })} /></div>
        <div class="template-memory-summary"><Icon name="layers" size={15} /><span>Keep up to <b>{m.maxEntries} entries</b> within <b>{m.maxChars.toLocaleString()} characters</b>. Oldest entries are removed first.</span></div>
        {m.scope === 'template' && <div class="row wrap"><button type="button" class="btn small ghost danger" disabled={!savedId || clearing === id} onClick={() => confirmAction({ title: `Clear ${title(id)} memory?`, body: 'Future runs will start with an empty channel. Past run records stay available.', action: 'Clear memory', danger: true }, () => void clear(id))}><Icon name="trash" size={13} />{clearing === id ? 'Clearing…' : 'Clear stored memory'}</button>{!savedId && <span class="template-hint">Save the method to manage stored memory.</span>}</div>}
      </div>;
    })}
    <p class="template-hint">These budgets control memory referenced by future turns. Duo’s full audit trace and the model providers’ conversation files are stored separately.</p>
  </div>;
}

export function LimitsEditor({ template: t, onChange }: Omit<Props, 'seats'>) {
  const update = (patch: Partial<CoordinationTemplate['limits']>) => onChange({ ...t, limits: { ...t.limits, ...patch } });
  const writes = Object.values(t.roles).some((r) => r.access && r.access !== 'read');
  return <div class="template-stack">
    <SectionTitle title="Execution limits" hint="Bound loops, model calls and context. Reaching a limit is recorded separately from successful completion." />
    <div class="template-grid">
      <NumberField label="Maximum model turns" value={t.limits.maxTurns} max={1000} hint="Includes output-repair attempts." onChange={(n) => update({ maxTurns: n ?? 0 })} />
      <NumberField label="Maximum workflow steps" value={t.limits.maxSteps} max={10000} hint="Includes branches and role assignments." onChange={(n) => update({ maxSteps: n ?? 0 })} />
      <NumberField label="Time limit (seconds)" value={t.limits.maxDurationSec} max={86400} onChange={(n) => update({ maxDurationSec: n ?? 0 })} />
      <NumberField label="Context budget (characters)" value={t.limits.maxContextChars} max={1000000} hint="Bounds each assembled model prompt." onChange={(n) => update({ maxContextChars: n ?? 0 })} />
      <NumberField label="Minimum available models" value={t.limits.minSeats} max={32} optional="1 model" hint="Stop if fewer models remain available." onChange={(minSeats) => update({ minSeats })} />
    </div>
    {!t.library && <><div class="template-divider" /><SectionTitle title="Workspace" hint={writes ? 'A write-enabled role needs an explicit workspace.' : 'Only needed when a role can edit files.'} />
      <Pick label="Where models can edit files" value={t.workspace?.isolation ?? ''} empty={writes ? undefined : 'No write workspace'} options={['worktree', 'in-place'].map((value) => ({ value, label: value === 'worktree' ? 'Isolated Git worktree' : 'In the selected project folder' }))} onChange={(v) => onChange({ ...t, workspace: v ? { isolation: v as 'worktree' | 'in-place' } : undefined })} />
    </>}
    {t.library && <p class="template-hint">The copied {title(t.library)} method also keeps its original run settings, shown below the builder.</p>}
  </div>;
}

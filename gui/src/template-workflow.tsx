import type { CoordinationTemplate, Route, Step } from '../../src/templates/types.ts';
import { Dropdown, Icon, MenuItem, Toggle } from './ui.tsx';
import { Checks, ConditionEditor, Field, NameField, NumberField, Pick, Remove, SectionTitle, SelectorEditor, statePaths } from './template-fields.tsx';
import { defaultStep, insertStep, orderedSteps, removalIssue, removeStep, renameItem, title } from './template-model.ts';
import { toast } from './store.ts';
import { OPERATION_CATALOG, operationStep } from '../../src/templates/operations.ts';

const TYPES: { value: Step['type']; label: string; icon: string; }[] = [
  { value: 'turn', label: 'Model turn', icon: 'chat' }, { value: 'assign', label: 'Change roles', icon: 'user' },
  { value: 'branch', label: 'Condition', icon: 'branch' }, { value: 'finish', label: 'Finish', icon: 'check-circle' }, { value: 'operation', label: 'Built-in stage', icon: 'layers' },
];
const NATIVE = OPERATION_CATALOG;
const nativeName = (use: string) => use.endsWith('.finish') ? 'Finish & save report' : NATIVE[use]?.name ?? title(use.split('.').at(-1) ?? use);

function RoutesEditor({ routes, onChange, template, stepId, additional = false }: { routes: Route[]; onChange: (r: Route[]) => void; template: CoordinationTemplate; stepId: string; additional?: boolean; }) {
  const sources = [
    ...Object.keys(template.steps).map((id) => ({ value: id, label: `Step · ${title(id)}` })),
    ...Object.keys(template.roles).map((id) => ({ value: id, label: `Role · ${title(id)}` })),
  ];
  const update = (i: number, patch: Partial<Route>) => onChange(routes.map((r, n) => n === i ? { ...r, ...patch } : r));
  return <div class="template-stack">
    <SectionTitle title={additional ? 'Additional shared context' : 'Shared context'} hint={additional ? 'Add messages to the context already included by the stage prompt.' : 'Choose which previous messages this step receives alongside its prompt and role instructions.'} />
    {!routes.length && <p class="template-empty-note"><Icon name="lock" size={14} />{additional ? 'No additional message routes.' : 'No other model’s messages are shared.'}</p>}
    {routes.map((r, i) => <div class="template-subcard" key={i}>
      <div class="row"><span class="template-eyebrow">Context {i + 1}</span><span class="spacer" /><Remove label={`Remove context ${i + 1}`} onClick={() => onChange(routes.filter((_, n) => n !== i))} /></div>
      <div class="template-grid">
        <Pick label="Share from" value={r.from} options={sources} onChange={(from) => update(i, { from })} />
        <Pick label="Messages" value={r.history ?? 'latest'} options={[{ value: 'latest', label: 'Latest per model' }, { value: 'all', label: 'All previous messages' }]} onChange={(v) => update(i, { history: v as Route['history'] })} />
      </div>
      <Checks label="Content" options={[{ value: 'reply', label: 'Full response' }, { value: 'data', label: 'Structured fields' }]} value={r.parts ?? ['reply']} onChange={(v) => update(i, { parts: v as Route['parts'] })} />
      <div class="template-grid">
        <NumberField label="Source limit" value={r.limit} max={32} optional="All source messages" onChange={(limit) => update(i, { limit })} />
        <NumberField label="Character limit" value={r.maxChars} max={1000000} optional="Use context budget" onChange={(maxChars) => update(i, { maxChars })} />
      </div>
      <Toggle checked={r.excludeSelf ?? false} label="Exclude the recipient’s own messages" onChange={(excludeSelf) => update(i, { excludeSelf })} />
      <Toggle checked={r.anonymous ?? false} label="Hide source model labels" hint="Prose may still identify its author." onChange={(anonymous) => update(i, { anonymous })} />
    </div>)}
    <button type="button" class="btn small ghost template-add" disabled={routes.length >= 32} onClick={() => onChange([...routes, { from: sources.find((s) => s.value !== stepId)?.value ?? stepId, parts: ['reply'] }])}><Icon name="plus" size={14} />Share context</button>
  </div>;
}

export function WorkflowEditor({ template: t, onChange, seats, onRoles, selected, onSelect: setSelected }: { template: CoordinationTemplate; onChange: (t: CoordinationTemplate) => void; seats: string[]; onRoles: () => void; selected: string; onSelect: (id: string) => void; }) {
  const id = t.steps[selected] ? selected : t.start;
  const step = t.steps[id];
  const roles = Object.keys(t.roles), ids = orderedSteps(t), paths = statePaths(t);
  const update = (s: Step) => onChange({ ...t, steps: { ...t.steps, [id]: s } });
  const add = (type: Step['type']) => { const r = insertStep(t, id, type); onChange(r.template); setSelected(r.id); };
  const rename = (name: string) => {
    try { const next = renameItem(t, 'step', id, name); onChange(next); setSelected(Object.keys(next.steps).find((k) => !t.steps[k]) ?? id); }
    catch (e) { toast((e as Error).message); }
  };
  return <div class="template-stack">
    <div class="template-workflow-head">
      <div><h4>Workflow</h4><p class="template-hint">Select a step to edit it. Connect steps to create sequences or loops.</p></div>
      <Pick label="Start at" value={t.start} options={Object.keys(t.steps)} onChange={(start) => onChange({ ...t, start })} />
    </div>
    {t.library && <div class="template-library-note"><Icon name="layers" size={16} /><div><b>{title(t.library)} operation library</b><p>Edit stage prompts, settings, shared context and response fields. Connect the stages in the workflow to choose when each runs.</p></div></div>}
    <div class="template-workflow">
      <div class="template-step-rail" aria-label="Workflow steps">
        {ids.map((key, i) => {
          const s = t.steps[key], type = TYPES.find((x) => x.value === s.type)!;
          const terminal = s.type === 'finish' || (s.type === 'operation' && s.use.endsWith('.finish'));
          const targets = terminal ? [] : 'next' in s ? [s.next] : s.type === 'branch' ? [...new Set([...s.cases.map((c) => c.next), s.otherwise])] : [];
          const summary = s.type === 'turn' ? title(s.role) : s.type === 'assign' ? `Assign ${title(s.role)}` : s.type === 'finish' ? title(s.status) : s.type === 'operation' ? nativeName(s.use) : `${s.cases.length} condition${s.cases.length === 1 ? '' : 's'}`;
          return <button type="button" key={key} class={`template-step ${id === key ? 'on' : ''} ${terminal ? 'is-finish' : ''}`} aria-pressed={id === key} onClick={() => setSelected(key)}>
            <span class="template-step-number">{i + 1}</span><span class="template-step-copy"><span class="template-step-name">{title(key)}{key === t.start && <span class="badge">start</span>}</span><span class="template-step-kind"><Icon name={type.icon} size={12} />{summary}</span>
              {targets.length > 0 && <span class="template-step-next"><Icon name="forward" size={12} />{targets.map(title).join(' / ')}</span>}
            </span>
          </button>;
        })}
        <Dropdown trigger={(open, toggle) => <button class="btn small template-add-step" type="button" aria-expanded={open} disabled={ids.length >= 128} onClick={toggle}><Icon name="plus" size={14} />Add step<Icon name="down" size={13} /></button>}>
          {(close) => <>{TYPES.filter((x) => x.value !== 'operation' || t.library).map((x) => <MenuItem key={x.value} icon={x.icon} onClick={() => { add(x.value); close(); }}>{x.label}</MenuItem>)}</>}
        </Dropdown>
        <p class="template-hint">{step?.type === 'finish' || (step?.type === 'operation' && step.use.endsWith('.finish')) ? 'Inserted before the selected finish.' : step?.type === 'branch' ? 'Inserted on the “otherwise” path.' : 'Inserted after the selected step.'}</p>
      </div>
      {step && <div class="template-inspector" key={id}>
        <div class="template-inspector-head"><span class="template-eyebrow">Step {ids.indexOf(id) + 1} of {ids.length}</span><Remove label={`Remove step ${title(id)}`} disabled={!!removalIssue(t, id)} hint={removalIssue(t, id)} onClick={() => { const next = removeStep(t, id); onChange(next); setSelected(next.start); }} /></div>
        <NameField label="Step name" value={title(id)} onChange={rename} />
        <Pick label="Step action" value={step.type} options={TYPES.filter((x) => x.value !== 'operation' || t.library).map((x) => ({ value: x.value, label: x.label }))} onChange={(v) => {
          const next = 'next' in step ? step.next : ids.find((k) => k !== id) ?? id;
          const node = defaultStep(v as Step['type'], t, next);
          update(node);
        }} />
        {step.type === 'turn' && <>
          <Pick label="Which role responds" value={step.role} options={roles} onChange={(role) => update({ ...step, role })} />
          <Field label="Prompt" hint="Use {{brief}} to include the user’s task. Shared context is added below."><textarea rows={4} value={step.prompt} onInput={(e) => update({ ...step, prompt: e.currentTarget.value })} /></Field>
          <div class="template-grid">
            <NumberField label="Recipient limit" value={step.count} max={32} optional="All models in this role" onChange={(count) => update({ ...step, count })} />
            <Pick label="Conversation context" value={step.session ?? 'role'} options={[{ value: 'role', label: 'Remember turns in this role' }, { value: 'fresh', label: 'Fresh context each turn' }]} onChange={(v) => update({ ...step, session: v as 'role' | 'fresh' })} />
          </div>
          <Toggle checked={step.parallel !== false} label="Respond in parallel" hint="Every recipient sees the same previous-message snapshot." onChange={(parallel) => update({ ...step, parallel })} />
          {step.session !== 'fresh' && <p class="template-hint">Reused conversations retain earlier messages. Choose fresh context for strict sharing boundaries.</p>}
          <div class="template-divider" />
          <RoutesEditor routes={step.input ?? []} template={t} stepId={id} onChange={(input) => update({ ...step, input })} />
        </>}
        {step.type === 'assign' && <>
          <Pick label="New role" value={step.role} options={roles} onChange={(role) => update({ ...step, role })} />
          <SelectorEditor value={step.select} template={t} seats={seats} onChange={(select) => update({ ...step, select })} />
          <Pick label="Role membership" value={step.mode ?? 'replace'} options={[{ value: 'replace', label: 'Replace the role’s members' }, { value: 'add', label: 'Add to the role’s members' }]} onChange={(v) => update({ ...step, mode: v as 'replace' | 'add' })} />
          <p class="template-hint">Selected models leave their previous role and start a fresh conversation.</p>
        </>}
        {step.type === 'branch' && <>
          <p class="template-hint">Rules are checked in order. The first match chooses the next step.</p>
          {step.cases.map((c, i) => <div class="template-subcard" key={i}>
            <div class="row"><span class="template-eyebrow">If · Rule {i + 1}</span><span class="spacer" /><button class="icon-btn small" type="button" aria-label={`Move rule ${i + 1} up`} disabled={i === 0} onClick={() => { const cases = [...step.cases];[cases[i - 1], cases[i]] = [cases[i], cases[i - 1]]; update({ ...step, cases }); }}><Icon name="up" size={14} /></button><Remove label={`Remove branch rule ${i + 1}`} disabled={step.cases.length <= 1} onClick={() => update({ ...step, cases: step.cases.filter((_, n) => n !== i) })} /></div>
            <ConditionEditor value={c.when} paths={paths} onChange={(when) => update({ ...step, cases: step.cases.map((v, n) => n === i ? { ...v, when } : v) })} />
            <Pick label="Then go to" value={c.next} options={Object.keys(t.steps)} onChange={(next) => update({ ...step, cases: step.cases.map((v, n) => n === i ? { ...v, next } : v) })} />
          </div>)}
          <button class="btn small ghost template-add" type="button" onClick={() => update({ ...step, cases: [...step.cases, { when: { path: `visits.${t.start}`, op: 'gte', value: 1 }, next: step.otherwise }] })}><Icon name="plus" size={14} />Add branch rule</button>
          <Pick label="Otherwise go to" value={step.otherwise} options={Object.keys(t.steps)} onChange={(otherwise) => update({ ...step, otherwise })} />
        </>}
        {step.type === 'finish' && <>
          <Pick label="Result" value={step.status} options={[{ value: 'completed', label: 'Completed successfully' }, { value: 'blocked', label: 'Needs user input' }, { value: 'failed', label: 'Failed' }, { value: 'limit', label: 'Limit reached' }]} onChange={(v) => update({ ...step, status: v as typeof step.status })} />
          <Field label="Completion message"><textarea rows={3} value={step.reason} onInput={(e) => update({ ...step, reason: e.currentTarget.value })} /></Field>
        </>}
        {step.type === 'operation' && <>
          <Pick label="Built-in stage" value={step.use} options={Object.keys(NATIVE).filter((key) => key.startsWith(`${t.library}.`)).map((key) => ({ value: key, label: nativeName(key) }))} onChange={(use) => update({ ...operationStep(use, step.next), onError: step.onError })} />
          <p class="template-hint">{NATIVE[step.use]?.hint ?? 'Save the original report and finish the run.'}</p>
          {Object.entries(NATIVE[step.use]?.settings ?? {}).map(([key, field]) => {
            const value = step.settings?.[key] ?? field.default;
            const set = (v: boolean | number | string) => update({ ...step, settings: { ...step.settings, [key]: v } });
            return field.type === 'boolean' ? <Toggle key={key} label={field.label} hint={field.hint} checked={value === true} onChange={set} /> : field.type === 'integer' ?
              <NumberField key={key} label={field.label} value={Number(value)} min={field.min} max={field.max ?? 1000} hint={field.hint} onChange={(n) => set(n ?? -1)} /> :
              <Pick key={key} label={field.label} value={String(value)} options={field.choices ?? []} hint={field.hint} onChange={set} />;
          })}
          {Object.entries(NATIVE[step.use]?.prompts ?? {}).map(([kind, source]) => <Field key={kind} label={`${title(kind)} prompt`} hint="Edit the complete stage message. {{nativePrompt}} inserts the library’s prepared task and evidence; {{brief}}, {{seat}}, {{round}} and workflow data paths are also available.">
            <textarea rows={kind === 'ledger-review' ? 12 : 4} value={step.prompts?.[kind] ?? source} onInput={(e) => update({ ...step, prompts: { ...step.prompts, [kind]: e.currentTarget.value } })} />
          </Field>)}
          {step.use === 'debate.resolve' && <p class="template-hint">Ledger review also provides {'{{finalPositions}}'}, {'{{claimLedger}}'}, {'{{requiredClaims}}'} and {'{{decisions}}'}. Frozen claims keep each model’s decisions about the same statements.</p>}
          <button type="button" class="btn small ghost template-add" onClick={onRoles}><Icon name="user" size={14} />Edit role instructions</button>
          {NATIVE[step.use]?.prompts && <RoutesEditor additional routes={step.input ?? []} template={t} stepId={id} onChange={(input) => update({ ...step, input })} />}
        </>}
        {'next' in step && !(step.type === 'operation' && step.use.endsWith('.finish')) && <><div class="template-divider" /><Pick label="Next step" value={step.next} options={Object.keys(t.steps)} onChange={(next) => update({ ...step, next })} /></>}
        {step.type !== 'finish' && <details class="template-details"><summary>If this step fails</summary><div class="template-stack">
          <Pick label="Recovery" value={step.onError?.action ?? 'fail'} options={[{ value: 'fail', label: 'Fail the run' }, ...('next' in step ? [{ value: 'skip', label: 'Skip to the next step' }] : []), { value: 'goto', label: 'Go to a recovery step' }]} onChange={(v) => update({ ...step, onError: v === 'fail' ? undefined : v === 'skip' ? { action: 'skip' } : { action: 'goto', next: ids.find((k) => k !== id) ?? id } })} />
          {step.onError?.action === 'goto' && <Pick label="Recovery step" value={step.onError.next} options={Object.keys(t.steps)} onChange={(next) => update({ ...step, onError: { action: 'goto', next } })} />}
          <p class="template-hint">Output formatting gets one repair attempt first. Cancellation and fatal provider errors always stop the run.</p>
        </div></details>}
        {removalIssue(t, id) && <p class="template-hint">To remove this step: {removalIssue(t, id)}</p>}
      </div>}
    </div>
  </div>;
}

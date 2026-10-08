import { useEffect, useState } from 'preact/hooks';
import type { CoordinationTemplate } from '../../src/templates/types.ts';
import { api } from './api.ts';
import { SeatPicker } from './SeatPicker.tsx';
import { app, confirmAction, guard, toast } from './store.ts';
import { Icon, Spinner, Tabs } from './ui.tsx';
import { Field, Pick } from './template-fields.tsx';
import { LimitsEditor, MemoryEditor, RolesEditor, RulesEditor } from './template-sections.tsx';
import { WorkflowEditor } from './template-workflow.tsx';
import { STARTER, chooseLibrary, uniqueId } from './template-model.ts';
import { BUILTIN_IDS, type Builtin } from '../../src/templates/definitions.ts';

type Entry = { template: CoordinationTemplate; builtin: boolean; };
type BuilderTab = 'workflow' | 'roles' | 'rules' | 'memory' | 'limits';
type History = { past: CoordinationTemplate[]; present: CoordinationTemplate; future: CoordinationTemplate[]; };

export function TemplateEditor({ initial, seats, onChange, onDraft }: { initial?: CoordinationTemplate; seats: string[]; onChange: (t: CoordinationTemplate | undefined) => void; onDraft: (t: CoordinationTemplate) => void; }) {
  const [history, setHistory] = useState<History>(() => ({ past: [], present: structuredClone(initial ?? STARTER), future: [] }));
  const draft = history.present;
  const [tab, setTab] = useState<BuilderTab>('workflow');
  const [selectedStep, setSelectedStep] = useState(draft.start);
  const [selectedRole, setSelectedRole] = useState(Object.keys(draft.roles)[0]);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [checking, setChecking] = useState(true);
  const [valid, setValid] = useState<CoordinationTemplate>();
  const [authorOpen, setAuthorOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [model, setModel] = useState(app.value!.gui.codex.spec);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [savedId, setSavedId] = useState<string>();
  const [loaded, setLoaded] = useState(0);
  const refresh = () => void guard(api<Entry[]>('/api/templates')).then((r) => r && setEntries(r));
  useEffect(refresh, []);
  useEffect(() => { if (!jsonMode) onDraft(draft); }, [draft, jsonMode, onDraft]);
  useEffect(() => {
    let cancelled = false;
    setValid(undefined); onChange(undefined); setChecking(true);
    if (busy) return;
    const timer = setTimeout(() => {
      let candidate: CoordinationTemplate;
      try { candidate = jsonMode ? JSON.parse(jsonText) : draft; }
      catch (e) { setErrors([`Invalid JSON: ${(e as Error).message}`]); setChecking(false); return; }
      void api<{ errors: string[]; }>('/api/templates/validate', { method: 'POST', body: candidate }).then((r) => {
        if (cancelled) return;
        setErrors(r.errors); setChecking(false);
        if (!r.errors.length) { setValid(candidate); onChange(candidate); if (jsonMode) onDraft(candidate); }
      }).catch((e: Error) => { if (!cancelled) { setErrors([e.message]); setChecking(false); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [draft, jsonMode, jsonText, busy, onChange, onDraft]);

  const invalidate = () => { setValid(undefined); setChecking(true); onChange(undefined); setSavedId(undefined); };
  const change = (next: CoordinationTemplate, previous?: CoordinationTemplate) => {
    invalidate();
    setHistory((h) => ({ past: [...h.past, previous ?? h.present].slice(-50), present: next, future: [] }));
  };
  const load = (next: CoordinationTemplate, saved?: string, previous?: CoordinationTemplate) => {
    change(structuredClone(next), previous); setSavedId(saved); setJsonMode(false); setTab('workflow'); setSelectedStep(next.start); setSelectedRole(Object.keys(next.roles)[0]); setExplanation(''); setLoaded((v) => v + 1);
  };
  const undo = () => {
    if (!history.past.length) return;
    invalidate(); setHistory((h) => ({ past: h.past.slice(0, -1), present: h.past.at(-1)!, future: [h.present, ...h.future] }));
  };
  const redo = () => {
    if (!history.future.length) return;
    invalidate(); setHistory((h) => ({ past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) }));
  };
  const generate = async () => {
    if (!description.trim()) return toast('Describe how the models should work together');
    setBusy(true);
    try {
      const r = await api<{ template: CoordinationTemplate; explanation: string; run: string; }>('/api/templates/generate', { method: 'POST', body: { description, model, current: valid } });
      load(r.template, undefined, valid); setExplanation(r.explanation);
      toast('Draft ready to review in the visual builder', 'success');
    } catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!valid) return;
    setSaving(true);
    const r = await guard(api<CoordinationTemplate>('/api/templates', { method: 'POST', body: valid }));
    if (r) { setSavedId(r.id); refresh(); toast(`Saved ${r.name}`, 'success'); }
    setSaving(false);
  };
  const openJson = () => { if (!jsonMode) { setJsonText(JSON.stringify(draft, null, 2)); setJsonMode(true); } };
  const removeSaved = () => {
    if (!savedId) return;
    const id = savedId;
    confirmAction({ title: 'Delete saved template?', body: 'Remove this method from your library and clear its cross-run memory. Past runs stay available. The current draft stays in the builder.', action: 'Delete template', danger: true }, () => {
      setSaving(true);
      void guard(api(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' })).then((r) => {
        if (r) { setSavedId(undefined); refresh(); toast('Saved template deleted', 'success'); }
      }).finally(() => setSaving(false));
    });
  };
  const closeJson = () => {
    if (!valid) return;
    if (JSON.stringify(valid) !== JSON.stringify(draft)) change(valid);
    setJsonMode(false);
  };
  return <section class="form-section template-panel">
    <div class="section-head template-panel-head"><div class="row"><span class="template-mark"><Icon name="branch" size={18} /></span><div><h3>Coordination method</h3><p class="template-hint">Build how your models work together.</p></div></div><button class={`btn small ghost ${authorOpen ? 'template-author-on' : ''}`} type="button" disabled={busy || saving} aria-expanded={authorOpen} onClick={() => setAuthorOpen(!authorOpen)}><Icon name="spark" size={14} />Describe with AI</button></div>
    {authorOpen && <div class="template-author">
      <Field label="Describe your method, or a change to the draft"><textarea rows={3} value={description} disabled={busy} onInput={(e) => setDescription(e.currentTarget.value)} placeholder="Two researchers answer independently. A skeptic challenges both. The strongest researcher becomes the decision maker. Keep the last eight decisions." /></Field>
      <div class="row wrap"><span class="muted small">Author model</span><fieldset class="template-picker" disabled={busy || saving}><SeatPicker spec={model} seat onChange={setModel} /></fieldset><span class="spacer" /><button class="btn small" type="button" disabled={busy || saving || !valid || !description.trim()} onClick={() => void generate()}>{busy ? <Spinner size={13} /> : <Icon name="spark" size={13} />}{busy ? 'Authoring & validating…' : 'Update draft'}</button></div>
      <p class="template-hint">The model edits this draft. Review the result in the builder before starting a run.</p>
      {!busy && !checking && !valid && <p class="template-hint">Resolve the settings that need attention before asking the model to revise this draft.</p>}
      {explanation && <p class="template-author-explanation">{explanation}</p>}
    </div>}
    <fieldset class="template-body" disabled={busy || saving}>
      <div class="template-library-row"><select aria-label="Load a saved template or copy a built-in" value="" onChange={(e) => {
        const entry = entries.find((x) => x.template.id === e.currentTarget.value); if (!entry) return;
        const t = entry.builtin ? { ...entry.template, id: uniqueId(`${entry.template.id}-custom`, entries.map((x) => x.template.id)), name: `${entry.template.name} copy` } : entry.template;
        load(t, entry.builtin ? undefined : t.id);
      }}><option value="">Load template or copy a built-in…</option><optgroup label="Your templates">{entries.filter((e) => !e.builtin).map((e) => <option key={e.template.id} value={e.template.id}>{e.template.name}</option>)}</optgroup><optgroup label="Built-in methods">{entries.filter((e) => e.builtin).map((e) => <option key={e.template.id} value={e.template.id}>{e.template.name}</option>)}</optgroup></select>
        <button class="btn small" type="button" onClick={() => load({ ...structuredClone(STARTER), id: uniqueId('my-method', entries.map((e) => e.template.id)) })}><Icon name="plus" size={14} />New method</button>
      </div>
      <div class="template-toolbar"><div class="template-edit-mode"><button class={`btn small ghost ${!jsonMode ? 'template-mode-on' : ''}`} type="button" disabled={jsonMode && !valid} aria-pressed={!jsonMode} onClick={closeJson}><Icon name="branch" size={14} />Visual builder</button><button class={`btn small ghost ${jsonMode ? 'template-mode-on' : ''}`} type="button" aria-pressed={jsonMode} onClick={openJson}><Icon name="pair" size={14} />JSON</button></div><span class="spacer" />{!jsonMode && <><button class="icon-btn small" type="button" disabled={!history.past.length} title="Undo edit" aria-label="Undo edit" onClick={undo}><Icon name="retry" size={14} /></button><button class="icon-btn small" type="button" disabled={!history.future.length} title="Redo edit" aria-label="Redo edit" onClick={redo}><Icon name="refresh" size={14} /></button></>}</div>
      {jsonMode ? <div class="template-stack">
        <Field label="Template JSON" hint="JSON is an alternate editor for the same method. Return to the visual builder once the definition is valid."><textarea class="mono template-editor" aria-label="Template JSON" rows={22} value={jsonText} spellcheck={false} onInput={(e) => { invalidate(); setJsonText(e.currentTarget.value); }} /></Field>
        <button class="btn small ghost template-add" type="button" onClick={() => { invalidate(); setJsonText(JSON.stringify(draft, null, 2)); setJsonMode(false); }}><Icon name="retry" size={13} />Discard JSON edits</button>
      </div> : <>
        <Field label="Method name"><input class="template-name" value={draft.name} maxLength={120} onInput={(e) => change({ ...draft, name: e.currentTarget.value })} /></Field>
        <Pick label="Operation library" value={draft.library ?? ''} empty="Custom model turns" options={BUILTIN_IDS.map((id) => ({ value: id, label: id[0].toUpperCase() + id.slice(1) }))} hint="Start any built-in from a new method, then edit its stages, prompts, settings and response fields. Changing libraries starts its default workflow; Undo restores the previous draft." onChange={(v) => load(chooseLibrary(draft, v ? v as Builtin : undefined))} />
        <details class="template-details"><summary>Method description & identifier</summary><div class="template-grid"><Field label="Description"><textarea rows={2} value={draft.description ?? ''} onInput={(e) => change({ ...draft, description: e.currentTarget.value || undefined })} /></Field><Field label="Identifier" hint="Used for saving and cross-run memory. Use a new identifier for an unrelated method."><input value={draft.id} maxLength={64} onInput={(e) => change({ ...draft, id: e.currentTarget.value })} /></Field></div></details>
        <Tabs<BuilderTab> active={tab} onChange={setTab} tabs={[{ id: 'workflow', label: 'Workflow', count: Object.keys(draft.steps).length }, { id: 'roles', label: 'Roles', count: Object.keys(draft.roles).length }, { id: 'rules', label: 'Rules', count: (draft.transitions?.length ?? 0) + (draft.exceptions?.length ?? 0) + (draft.completion ? 1 : 0) }, { id: 'memory', label: 'Memory', count: Object.keys(draft.memory ?? {}).length }, { id: 'limits', label: 'Limits' }]} />
        <div class="template-tab-body" key={loaded}>
          {tab === 'workflow' && <WorkflowEditor template={draft} seats={seats} onChange={change} selected={selectedStep} onSelect={setSelectedStep} onRoles={() => setTab('roles')} />}
          {tab === 'roles' && <RolesEditor template={draft} seats={seats} onChange={change} selected={selectedRole} onSelect={setSelectedRole} />}
          {tab === 'rules' && <RulesEditor template={draft} seats={seats} onChange={change} />}
          {tab === 'memory' && <MemoryEditor template={draft} savedId={savedId} onChange={change} />}
          {tab === 'limits' && <LimitsEditor template={draft} onChange={change} />}
        </div>
      </>}
    </fieldset>
    <div class="template-validation" role="status" aria-live="polite">{busy ? <><Spinner size={13} /><span>Authoring your method…</span></> : checking ? <><Spinner size={13} /><span>Checking method…</span></> : errors.length ? <details><summary><Icon name="alert" size={14} /><span>{errors.length} {errors.length === 1 ? 'setting needs' : 'settings need'} attention</span><Icon name="down" size={13} /></summary><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></details> : <><Icon name="check-circle" size={14} /><span class="good-text">Ready to run</span><span class="template-validation-summary">{Object.keys(valid?.roles ?? {}).length} roles · {Object.keys(valid?.steps ?? {}).length} steps · {valid?.limits.maxTurns} turns at most</span></>}</div>
    <div class="template-footer"><button class="btn small" type="button" disabled={!valid || busy || saving} onClick={() => void save()}>{saving ? <Spinner size={13} /> : <Icon name="check" size={13} />}Save template</button><span class="template-hint">{savedId ? `Saved as ${savedId}` : 'Draft · Start custom runs this method with the models below.'}</span>{savedId && <button class="icon-btn small danger" type="button" aria-label="Delete saved template" title="Delete saved template" disabled={busy || saving} onClick={removeSaved}><Icon name="trash" size={14} /></button>}</div>
  </section>;
}

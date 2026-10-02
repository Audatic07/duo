import { useState } from 'preact/hooks';
import { buildSpec, getOpt, parseSpec, setOpt, shortSpec, type SpecParts } from './spec.ts';
import { app } from './store.ts';
import type { Engine } from './types.ts';
import { Dropdown, EngineMark, Icon } from './ui.tsx';

const CLAUDE_DEFAULT_MODEL = 'opus';

function defaultsFor(engine: Engine): SpecParts {
  const s = app.value!;
  return parseSpec(engine === 'claude' ? s.gui.claude.spec : s.gui.codex.spec);
}

function rateLabel(slug: string): string | undefined {
  const r = app.value?.rates[slug];
  return r ? `${r[0]} / ${r[2]} cr per 1M in/out` : undefined;
}

/** Model + effort + options for one seat. `seat` shows the read-only-seat options (Claude web search). */
export function SeatPicker({ spec, onChange, engineLocked, seat, align = 'left', up, label }: { spec: string; onChange: (s: string) => void; engineLocked?: boolean; seat?: boolean; align?: 'left' | 'right'; up?: boolean; label?: string }) {
  const s = app.value!;
  const p = parseSpec(spec);
  const [raw, setRaw] = useState(spec);
  const apply = (next: SpecParts) => {
    const str = buildSpec(next);
    setRaw(str);
    onChange(str);
  };
  const codexModel = s.models.codex.find((m) => m.slug === p.model);
  const efforts = p.engine === 'codex' ? (codexModel?.efforts.length ? codexModel.efforts : s.efforts.codex) : s.efforts.claude;
  const chip = (open: boolean, toggle: () => void) => (
    <button type="button" class={`chip seat-chip ${p.engine} ${open ? 'open' : ''}`} onClick={() => { setRaw(spec); toggle(); }} title={`${spec}\nClick to change the model, effort and options`}>
      <EngineMark engine={p.engine} size={16} />
      {label && <span class="chip-label">{label}</span>}
      <span>{shortSpec(spec)}</span>
      {p.opts.length > 0 && <span class="chip-extra">+{p.opts.length}</span>}
      <Icon name="down" size={12} />
    </button>
  );
  return (
    <Dropdown align={align} up={up} class="seat-dropdown" trigger={chip}>
      {() => (
        <div class="seat-panel" onMouseDown={(e) => e.stopPropagation()}>
          {!engineLocked && (
            <div class="seg full">
              {(['claude', 'codex'] as Engine[]).map((e) => (
                <button type="button" class={p.engine === e ? 'on' : ''} onClick={() => apply(e === p.engine ? p : defaultsFor(e))}>
                  <EngineMark engine={e} size={16} /> {e === 'claude' ? 'Claude' : 'Codex'}
                </button>
              ))}
            </div>
          )}
          <div class="panel-label">Model</div>
          <div class="model-list">
            {p.engine === 'codex'
              ? s.models.codex.map((m) => (
                  <button type="button" class={`model-row ${m.slug === p.model ? 'on' : ''}`} onClick={() => apply({ ...p, model: m.slug, effort: m.efforts.includes(p.effort ?? '') ? p.effort : m.defaultEffort })}>
                    <span class="model-name">{m.display}{m.slug === p.model && <Icon name="check" size={13} />}</span>
                    <span class="model-desc">{m.description}</span>
                    {rateLabel(m.slug) && <span class="model-rate">{rateLabel(m.slug)}</span>}
                  </button>
                ))
              : s.models.claude.map((m) => (
                  <button type="button" class={`model-row ${m.alias === (p.model || CLAUDE_DEFAULT_MODEL) ? 'on' : ''}`} onClick={() => apply({ ...p, model: m.alias })}>
                    <span class="model-name">{m.alias[0].toUpperCase() + m.alias.slice(1)}{m.alias === (p.model || CLAUDE_DEFAULT_MODEL) && <Icon name="check" size={13} />}</span>
                    <span class="model-desc">{m.note}</span>
                  </button>
                ))}
          </div>
          <div class="panel-label">Effort</div>
          <div class="seg wrap">
            {efforts.map((e) => (
              <button type="button" class={p.effort === e ? 'on' : ''} onClick={() => apply({ ...p, effort: e })}>{e}</button>
            ))}
          </div>
          {p.engine === 'codex' && (
            <>
              <div class="panel-label">Output</div>
              <div class="opt-grid">
                <label>Verbosity
                  <select value={getOpt(p, 'verbosity') ?? ''} onChange={(e) => apply(setOpt(p, 'verbosity', (e.target as HTMLSelectElement).value || undefined))}>
                    <option value="">model default</option><option>low</option><option>medium</option><option>high</option>
                  </select>
                </label>
                <label>Reasoning summary
                  <select value={getOpt(p, 'summary') ?? ''} onChange={(e) => apply(setOpt(p, 'summary', (e.target as HTMLSelectElement).value || undefined))}>
                    <option value="">model default</option><option>auto</option><option>concise</option><option>detailed</option><option>none</option>
                  </select>
                </label>
                <label>Web search
                  <select value={getOpt(p, 'web') ?? ''} onChange={(e) => apply(setOpt(p, 'web', (e.target as HTMLSelectElement).value || undefined))}>
                    <option value="">default (cached)</option><option value="live">live</option><option value="disabled">off</option>
                  </select>
                </label>
                <label class="check">
                  <input type="checkbox" checked={getOpt(p, 'tier') === 'fast'} onChange={(e) => apply(setOpt(p, 'tier', (e.target as HTMLInputElement).checked ? 'fast' : undefined))} />
                  Fast mode <span class="muted">2× credits</span>
                </label>
              </div>
            </>
          )}
          {p.engine === 'claude' && seat && (
            <label class="check">
              <input type="checkbox" checked={!!getOpt(p, 'web')} onChange={(e) => apply(setOpt(p, 'web', (e.target as HTMLInputElement).checked ? 'on' : undefined))} />
              Web search
            </label>
          )}
          <details class="raw-spec">
            <summary>Seat spec</summary>
            <div class="row">
              <input class="mono" value={raw} spellcheck={false} onInput={(e) => setRaw((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && onChange(raw.trim())} />
              <button type="button" class="btn small" onClick={() => onChange(raw.trim())}>Apply</button>
            </div>
          </details>
        </div>
      )}
    </Dropdown>
  );
}

const ACCESS_HELP: Record<string, string> = {
  plan: 'Reads and searches; never edits or runs commands.',
  ask: 'Edits and commands wait for your approval in this window.',
  edits: 'File edits apply directly; commands still ask you.',
  auto: "Claude Code's classifier approves safe actions and asks about the rest.",
  full: 'No prompts at all. Use only in folders you can afford to lose.',
  'read-only': 'Reads files and runs read-only commands.',
  workspace: 'Edits and runs commands inside the project, sandboxed, without network.',
};

export function AccessPicker({ engine, access, onChange, align = 'left', up }: { engine: Engine; access: string; onChange: (a: string) => void; align?: 'left' | 'right'; up?: boolean }) {
  const labels = app.value!.access[engine];
  const risky = access === 'full';
  return (
    <Dropdown align={align} up={up} trigger={(open, toggle) => (
      <button type="button" class={`chip access-chip ${risky ? 'risky' : ''} ${open ? 'open' : ''}`} onClick={toggle} title={ACCESS_HELP[access] ?? 'Permissions'}>
        <Icon name={risky ? 'alert' : 'shield'} size={13} />
        <span>{labels[access] ?? access}</span>
        <Icon name="down" size={12} />
      </button>
    )}>
      {(close) => (
        <div class="access-panel">
          {Object.entries(labels).map(([k, label]) => (
            <button type="button" class={`access-row ${k === access ? 'on' : ''} ${k === 'full' ? 'risky' : ''}`} onClick={() => { onChange(k); close(); }}>
              <span class="access-name">{label}{k === access && <Icon name="check" size={13} />}</span>
              <span class="access-desc">{ACCESS_HELP[k] ?? ''}</span>
            </button>
          ))}
        </div>
      )}
    </Dropdown>
  );
}

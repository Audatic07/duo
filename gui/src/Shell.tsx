import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, desktop, MOD } from './api.ts';
import { AutoTextarea, ChatView } from './Chat.tsx';
import { MODE_ORDER, MODES, ModeDemo, type ModeId } from './demos.tsx';
import { DiffView } from './Diff.tsx';
import { NewRun, outcomeTone, PROTOCOLS, RunView, StatusChip } from './Run.tsx';
import { AccessPicker, SeatPicker } from './SeatPicker.tsx';
import { shortSpec } from './spec.ts';
import {
  app, chats, confirmAction, connected, deleteChat, deleteRun, dismissToast, doctor, gitTick, go, guard, loadDoctor, modal, openNewChat, openSideBySide, paletteOpen,
  patchChat, prefs, project, refreshQuota, rightPanel, runs, saveSettings, setPrefs, setProject, setRight, sidebarOpen, toasts, toggleSidebar, updateClaude, view,
} from './store.ts';
import type { AppState, ChatSummary, Protocol, QuotaWindow, RunSummary } from './types.ts';
import {
  ago, base, dayGroup, Dropdown, dur, Empty, EngineMark, Icon, Kbd, kfmt, Logo, MenuItem, MenuSeparator, Modal, money, Segmented, Spinner, Tabs, Toggle, untilText, when,
} from './ui.tsx';

// ── quota ────────────────────────────────────────────────────────────────

function Meter({ w, warn }: { w: QuotaWindow; warn: number; }) {
  const reset = w.resetsAt * 1000 < Date.now();
  const pct = reset ? 0 : Math.min(100, w.usedPercent);
  const tone = reset ? 'idle' : pct >= warn ? 'bad' : pct >= warn - 20 ? 'warn' : 'good';
  return (
    <span class="meter" title={reset ? `${w.label}: reset at ${when(w.resetsAt)} (was ${w.usedPercent.toFixed(0)}%)` : `${w.label}: ${w.usedPercent.toFixed(0)}% used · resets ${untilText(w.resetsAt)} (${when(w.resetsAt)})`}>
      <span class="meter-label">{w.label === 'weekly' ? 'wk' : w.label}</span>
      <span class={`meter-bar ${tone}`}><span style={{ width: `${pct}%` }} /></span>
      <span class="meter-num">{reset ? '0%' : `${w.usedPercent.toFixed(0)}%`}</span>
    </span>
  );
}

function QuotaPills() {
  const s = app.value!;
  const q = s.quota;
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" class="quota" title="Plan usage. Click to refresh (sends one tiny message to each side)." disabled={busy} onClick={async () => { setBusy(true); await refreshQuota(); setBusy(false); }}>
      <span class="quota-side"><EngineMark engine="claude" size={16} />{q?.claude?.windows.length ? q.claude.windows.map((w) => <Meter w={w} warn={s.warnPercent} />) : <span class="muted small">—</span>}</span>
      <span class="quota-side"><EngineMark engine="codex" size={16} />{q?.codex?.windows.length ? q.codex.windows.map((w) => <Meter w={w} warn={s.warnPercent} />) : <span class="muted small">—</span>}</span>
      {busy ? <Spinner size={12} /> : <Icon name="refresh" size={13} class="quota-refresh" />}
    </button>
  );
}

// ── project picker ───────────────────────────────────────────────────────

export function pickFolder(start: string, onPick: (p: string) => void): void {
  if (desktop) {
    void desktop.pickFolder().then((p) => p && onPick(p));
    return;
  }
  modal.value = { kind: 'folder', onPick, start };
}

function ProjectPicker() {
  const s = app.value!;
  const recent = [...new Set([project.value, ...s.projects])].filter(Boolean).slice(0, 12);
  const current = project.value;
  return (
    <Dropdown trigger={(open, toggle) => (
      <button type="button" class={`project-btn ${open ? 'open' : ''}`} onClick={toggle} title={current || 'No project folder'}>
        <Icon name={current ? 'folder' : 'folder-off'} size={14} /> <span>{current ? base(current) : 'No folder'}</span> <Icon name="down" size={12} />
      </button>
    )}>
      {(close) => (
        <div class="project-menu">
          <div class="panel-label">Where new chats and runs work</div>
          <MenuItem icon="folder-off" active={!current} onClick={() => { setProject(''); close(); }} hint="general questions">No folder</MenuItem>
          {recent.length > 0 && <MenuSeparator />}
          {recent.map((p) => (
            <MenuItem icon="folder" active={p === current} onClick={() => { setProject(p); close(); }} hint={p.replace(s.home, '~')}>{base(p)}</MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem icon="plus" onClick={() => { close(); pickFolder(current || s.home, setProject); }}>Open folder…</MenuItem>
        </div>
      )}
    </Dropdown>
  );
}

function viewTitle(): string {
  const v = view.value;
  if (v.kind === 'chat') return v.panes.length > 1 ? 'Side by side' : chats.value[v.panes[0]]?.title ?? 'Chat';
  if (v.kind === 'run') return runs.value[v.id]?.meta.title ?? app.value?.runs.find((r) => r.id === v.id)?.title ?? 'Run';
  if (v.kind === 'new-run') return 'New run';
  return '';
}

function TopBar() {
  return (
    <header class="topbar">
      {!sidebarOpen.value && (
        <>
          <button type="button" class="icon-btn" onClick={toggleSidebar} title={`Show the sidebar (${MOD}+B)`}><Icon name="sidebar" /></button>
          <button type="button" class="brand" onClick={() => go({ kind: 'home' })}><Logo size={20} /> Duo</button>
        </>
      )}
      <ProjectPicker />
      <span class="crumb">{viewTitle()}</span>
      <div class="spacer" />
      {!connected.value && <span class="status bad"><Icon name="alert" size={12} /> engine offline</span>}
      <QuotaPills />
      <button type="button" class="palette-btn" onClick={() => (paletteOpen.value = true)} title="Command palette"><Icon name="search" size={14} /> <span>Search or run a command</span> <Kbd>{MOD}</Kbd><Kbd>K</Kbd></button>
      <button type="button" class={`icon-btn ${rightPanel.value === 'changes' ? 'on' : ''}`} title={`Changes in the project (${MOD}+J)`} onClick={() => setRight('changes')}><Icon name="branch" /></button>
      <button type="button" class={`icon-btn ${rightPanel.value === 'trace' ? 'on' : ''}`} title="Trace: tokens, time, cost" onClick={() => setRight('trace')}><Icon name="panel" /></button>
    </header>
  );
}

// ── sidebar ──────────────────────────────────────────────────────────────

type Item = { kind: 'chat'; at: string; c: ChatSummary; } | { kind: 'run'; at: string; r: RunSummary; };

function ItemMenu({ item }: { item: Item; }) {
  return (
    <Dropdown align="right" class="side-more" trigger={(_o, toggle) => <button type="button" class="icon-btn tiny" title="More" onClick={(e) => { e.stopPropagation(); toggle(); }}><Icon name="dots" size={14} /></button>}>
      {(close) => item.kind === 'chat' ? (
        <>
          <MenuItem icon="pin" onClick={() => { close(); void patchChat(item.c.id, { pinned: !item.c.pinned }); }}>{item.c.pinned ? 'Unpin' : 'Pin'}</MenuItem>
          <MenuItem icon="split" onClick={() => { close(); const v = view.value; go({ kind: 'chat', panes: v.kind === 'chat' && v.panes.length === 1 && v.panes[0] !== item.c.id ? [v.panes[0], item.c.id] : [item.c.id] }); }}>Open side by side</MenuItem>
          <MenuSeparator />
          <MenuItem icon="trash" danger onClick={() => { close(); confirmAction({ title: 'Delete this chat?', body: `“${item.c.title}” is removed from Duo.`, action: 'Delete', danger: true }, () => void deleteChat(item.c.id)); }}>Delete</MenuItem>
        </>
      ) : (
        <>
          <MenuItem icon="trash" danger disabled={item.r.status === 'running'} onClick={() => { close(); confirmAction({ title: 'Delete this run?', body: `“${item.r.title}” and its trace are deleted.`, action: 'Delete', danger: true }, () => void deleteRun(item.r.id)); }}>Delete</MenuItem>
        </>
      )}
    </Dropdown>
  );
}

function SideItem({ item }: { item: Item; }) {
  const v = view.value;
  if (item.kind === 'chat') {
    const c = item.c;
    const active = v.kind === 'chat' && v.panes.includes(c.id);
    const open = (e: MouseEvent) => {
      if ((e.ctrlKey || e.metaKey) && v.kind === 'chat' && v.panes.length === 1 && v.panes[0] !== c.id) go({ kind: 'chat', panes: [v.panes[0], c.id] });
      else go({ kind: 'chat', panes: [c.id] });
    };
    return (
      <div class={`side-item ${active ? 'active' : ''}`} role="button" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === 'Enter' && go({ kind: 'chat', panes: [c.id] })} title={`${c.title}\n${c.cwd}\n${MOD}+click: open next to the current chat`}>
        <span class="side-icon">{c.running ? <Spinner size={12} /> : <EngineMark engine={c.engine} size={18} />}</span>
        <span class="side-text">
          <span class="side-title">{c.pinned && <Icon name="pin" size={11} class="pin" />}{c.title}</span>
          <span class="side-sub">{shortSpec(c.spec)}{c.cwd.includes('scratch') ? '' : ` · ${base(c.cwd)}`}</span>
        </span>
        <span class="side-time">{ago(c.updatedAt)}</span>
        <ItemMenu item={item} />
      </div>
    );
  }
  const r = item.r;
  const tone = outcomeTone(r.status, r.outcome);
  return (
    <div class={`side-item ${v.kind === 'run' && v.id === r.id ? 'active' : ''}`} role="button" tabIndex={0} onClick={() => go({ kind: 'run', id: r.id })} onKeyDown={(e) => e.key === 'Enter' && go({ kind: 'run', id: r.id })} title={`${r.title}\n${r.seats.join(' · ')}\n${r.outcome?.stop ?? r.status}`}>
      <span class={`side-icon run ${tone.tone}`}>{r.status === 'running' ? <Spinner size={12} /> : <Icon name={PROTOCOLS[r.protocol]?.icon ?? 'dots'} size={15} />}</span>
      <span class="side-text">
        <span class="side-title">{r.title}</span>
        <span class="side-sub"><span class={`tone-dot ${tone.tone}`} />{PROTOCOLS[r.protocol]?.label ?? r.protocol} · {tone.label}</span>
      </span>
      <span class="side-time">{ago(r.createdAt)}</span>
      <ItemMenu item={item} />
    </div>
  );
}

function Sidebar() {
  const s = app.value!;
  const [q, setQ] = useState('');
  const filter = prefs.value.sidebarFilter ?? 'all';
  const needle = q.trim().toLowerCase();
  const items: Item[] = [
    ...(filter !== 'runs' ? s.chats.filter((c) => !needle || c.title.toLowerCase().includes(needle) || c.cwd.toLowerCase().includes(needle)).map((c): Item => ({ kind: 'chat', at: c.updatedAt, c })) : []),
    ...(filter !== 'chats' ? s.runs.filter((r) => !needle || r.title.toLowerCase().includes(needle) || r.protocol.includes(needle)).map((r): Item => ({ kind: 'run', at: r.createdAt, r })) : []),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const pinned = items.filter((i) => i.kind === 'chat' && i.c.pinned);
  const rest = items.filter((i) => !(i.kind === 'chat' && i.c.pinned));
  const groups: [string, Item[]][] = [];
  for (const it of rest) {
    const g = dayGroup(it.at);
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(it);
    else groups.push([g, [it]]);
  }
  return (
    <aside class="sidebar">
      <div class="side-top">
        <button type="button" class="brand" onClick={() => go({ kind: 'home' })}><Logo size={22} /> Duo</button>
        <div class="spacer" />
        <button type="button" class="icon-btn" onClick={toggleSidebar} title={`Hide the sidebar (${MOD}+B)`}><Icon name="sidebar" /></button>
      </div>
      <div class="side-actions">
        <div class="split-btn">
          <button type="button" class="btn primary grow" onClick={() => void openNewChat(s.gui.claude ? 'claude' : 'codex')} title={`New chat (${MOD}+N)`}><Icon name="plus" size={15} /> New chat</button>
          <Dropdown align="right" trigger={(_o, toggle) => <button type="button" class="btn primary icon-only" onClick={toggle} title="More ways to start"><Icon name="down" size={14} /></button>}>
            {(close) => (
              <>
                <MenuItem onClick={() => { close(); void openNewChat('claude'); }} hint={shortSpec(s.gui.claude.spec)}><span class="mi-mark"><EngineMark engine="claude" size={16} /></span> Claude</MenuItem>
                <MenuItem onClick={() => { close(); void openNewChat('codex'); }} hint={shortSpec(s.gui.codex.spec)}><span class="mi-mark"><EngineMark engine="codex" size={16} /></span> Codex</MenuItem>
                <MenuItem icon="split" onClick={() => { close(); void openSideBySide(); }} hint={`${MOD}+Shift+N`}>Side by side</MenuItem>
              </>
            )}
          </Dropdown>
        </div>
        <div class="mode-links">
          {(['pair', 'debate', 'review', 'council', 'ask', 'custom'] as Protocol[]).map((p) => (
            <button type="button" class={`mode-link ${view.value.kind === 'new-run' && (view.value.draft?.protocol ?? 'pair') === p ? 'on' : ''}`} onClick={() => go({ kind: 'new-run', draft: { protocol: p } })} title={PROTOCOLS[p].help}>
              <Icon name={PROTOCOLS[p].icon} size={15} /> {PROTOCOLS[p].label}
            </button>
          ))}
        </div>
      </div>
      <div class="search"><Icon name="search" size={14} /><input placeholder="Search chats and runs" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />{q && <button type="button" class="icon-btn tiny" onClick={() => setQ('')}><Icon name="x" size={12} /></button>}</div>
      <div class="side-filter">
        <Segmented size="small" value={filter} onChange={(f) => setPrefs({ sidebarFilter: f })} options={[{ id: 'all', label: 'All' }, { id: 'chats', label: 'Chats' }, { id: 'runs', label: 'Runs' }]} />
      </div>
      <div class="side-scroll">
        {pinned.length > 0 && <div class="side-label">Pinned</div>}
        {pinned.map((it) => <SideItem item={it} />)}
        {groups.map(([g, list]) => (
          <>
            <div class="side-label">{g}</div>
            {list.map((it) => <SideItem item={it} />)}
          </>
        ))}
        {!items.length && <div class="side-empty">{needle ? 'Nothing matches.' : 'Your chats and runs appear here.'}</div>}
      </div>
      <div class="side-foot">
        <button type="button" class="side-foot-btn" onClick={() => (modal.value = { kind: 'settings' })} title={`Settings (${MOD}+,)`}><Icon name="settings" size={15} /> Settings</button>
        <button type="button" class="icon-btn" onClick={() => (modal.value = { kind: 'shortcuts' })} title={`Keyboard shortcuts (${MOD}+/)`}><Icon name="keyboard" size={15} /></button>
        <span class="muted tiny">v{s.version}</span>
      </div>
    </aside>
  );
}

// ── home ─────────────────────────────────────────────────────────────────

type HomeTarget = 'claude' | 'codex' | 'both' | Protocol;

const HOME_TARGETS: { id: HomeTarget; label: string; icon?: string; engine?: 'claude' | 'codex'; }[] = [
  { id: 'claude', label: 'Claude', engine: 'claude' },
  { id: 'codex', label: 'Codex', engine: 'codex' },
  { id: 'both', label: 'Both', icon: 'split' },
  { id: 'pair', label: 'Pair', icon: 'pair' },
  { id: 'debate', label: 'Debate', icon: 'debate' },
  { id: 'council', label: 'Council', icon: 'council' },
  { id: 'ask', label: 'Ask', icon: 'ask' },
  { id: 'review', label: 'Review', icon: 'review' },
];

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function SetupBanner() {
  const checks = doctor.value;
  useEffect(() => {
    if (!doctor.value) void loadDoctor();
  }, []);
  const failing = checks?.filter((c) => c.level === 'fail') ?? [];
  if (!failing.length) return null;
  return (
    <div class="callout warn setup-banner">
      <Icon name="wrench" size={16} />
      <div class="callout-body">
        <b>{failing.length === 1 ? 'One thing needs attention' : `${failing.length} things need attention`} before everything works</b>
        {failing.map((c) => <div class="small">{c.label}: {c.detail}{c.fix ? ` — ${c.fix}` : ''}</div>)}
      </div>
      <button type="button" class="btn small" onClick={() => (modal.value = { kind: 'settings', tab: 'setup' })}>Open setup check</button>
    </div>
  );
}

function Home() {
  const s = app.value!;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem('duo.draft.home') ?? '';
    } catch {
      return '';
    }
  });
  const [target, setTarget] = useState<HomeTarget>('claude');
  const save = (v: string) => {
    setText(v);
    try {
      if (v) localStorage.setItem('duo.draft.home', v);
      else localStorage.removeItem('duo.draft.home');
    } catch {
      /* ignore */
    }
  };
  const submit = () => {
    const t = text.trim();
    if (target === 'claude' || target === 'codex') {
      if (!t) return void openNewChat(target);
      save('');
      void openNewChat(target, t);
    } else if (target === 'both') {
      if (t) save('');
      void openSideBySide(t || undefined);
    } else {
      save('');
      go({ kind: 'new-run', draft: { protocol: target, brief: t } });
    }
  };
  const recent: Item[] = [
    ...s.chats.slice(0, 6).map((c): Item => ({ kind: 'chat', at: c.updatedAt, c })),
    ...s.runs.slice(0, 6).map((r): Item => ({ kind: 'run', at: r.createdAt, r })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
  const openMode = (m: ModeId) => {
    const info = MODES[m];
    if (m === 'chat') void openNewChat('claude');
    else if (m === 'split') void openSideBySide();
    else go({ kind: 'new-run', draft: { protocol: info.protocol } });
  };
  const runTarget = !['claude', 'codex', 'both'].includes(target);
  return (
    <div class="home">
      <div class="home-inner">
        <div class="hero">
          <Logo size={44} />
          <h1>{greeting()}. What are we working on?</h1>
          <p class="muted">Claude Code and Codex in one window: chat with either, or let them pair, debate and review each other.</p>
        </div>
        <SetupBanner />
        <div class="hero-composer">
          <AutoTextarea value={text} onInput={save} onSubmit={submit} autoFocus max={0.3}
            placeholder={runTarget ? `Describe the ${target === 'pair' ? 'task' : 'question'}; you choose the seats next` : target === 'both' ? 'Ask Claude and Codex at once' : `Ask ${target === 'claude' ? 'Claude' : 'Codex'} anything`} />
          <div class="hero-bar">
            <div class="target-chips">
              {HOME_TARGETS.map((t) => (
                <button type="button" class={`chip target ${t.engine ?? ''} ${target === t.id ? 'on' : ''}`} onClick={() => setTarget(t.id)} aria-pressed={target === t.id}>
                  {t.engine ? <EngineMark engine={t.engine} size={16} /> : <Icon name={t.icon!} size={14} />} {t.label}
                </button>
              ))}
            </div>
            <div class="spacer" />
            <button type="button" class="send-btn" onClick={submit} title={runTarget ? 'Set up the run' : 'Send (Enter)'}><Icon name={runTarget ? 'right' : 'send'} /></button>
          </div>
        </div>
        <div class="home-meta muted small">
          <Icon name={project.value ? 'folder' : 'folder-off'} size={13} />
          {project.value ? <>Working in <button type="button" class="link-btn" onClick={() => pickFolder(project.value || s.home, setProject)}><span class="mono">{project.value.replace(s.home, '~')}</span></button></> : <>No project folder — <button type="button" class="link-btn" onClick={() => pickFolder(s.home, setProject)}>open one</button> for code tasks</>}
        </div>

        <div class="section-title">Modes</div>
        <div class="mode-grid">
          {MODE_ORDER.map((m) => (
            <button type="button" class="mode-card" onClick={() => openMode(m)}>
              <ModeDemo mode={m} />
              <div class="mode-card-text">
                <b><Icon name={MODES[m].icon} size={15} /> {MODES[m].label}</b>
                <span>{MODES[m].tagline}</span>
              </div>
            </button>
          ))}
        </div>

        {recent.length > 0 && (
          <>
            <div class="section-title">Recent</div>
            <div class="recent-list">
              {recent.map((it) => it.kind === 'chat' ? (
                <button type="button" class="recent-row" onClick={() => go({ kind: 'chat', panes: [it.c.id] })}>
                  <EngineMark engine={it.c.engine} size={18} /><span class="recent-title">{it.c.title}</span><span class="muted small">{it.c.cwd.includes('scratch') ? '' : base(it.c.cwd)}</span><span class="muted small">{ago(it.at)}</span>
                </button>
              ) : (
                <button type="button" class="recent-row" onClick={() => go({ kind: 'run', id: it.r.id })}>
                  <Icon name={PROTOCOLS[it.r.protocol]?.icon ?? 'dots'} size={16} /><span class="recent-title">{it.r.title}</span><StatusChip status={it.r.status} outcome={it.r.outcome} /><span class="muted small">{ago(it.at)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── right panel ──────────────────────────────────────────────────────────

function contextCwd(): string {
  const v = view.value;
  if (v.kind === 'chat') return chats.value[v.panes[0]]?.cwd ?? project.value;
  if (v.kind === 'run') return runs.value[v.id]?.meta.cwd ?? project.value;
  return project.value;
}

function Changes() {
  const cwd = contextCwd();
  const [g, setG] = useState<any>(null);
  const load = () => void guard(api(`/api/git?cwd=${encodeURIComponent(cwd)}`)).then(setG);
  useEffect(load, [cwd, gitTick.value]);
  if (!cwd || cwd.includes('scratch')) return <Empty icon="folder-off" title="No project folder">Changes appear here for chats and runs in a git repository.</Empty>;
  if (!g) return <div class="center pad"><Spinner /></div>;
  if (!g.repo) return <Empty icon="branch" title="Not a git repository">{base(cwd)} has no git history to compare against.</Empty>;
  return (
    <>
      <div class="rp-head">
        <span class="rp-branch"><Icon name="branch" size={13} /> {g.branch}</span>
        <span class="muted small ellipsis" title={g.head}>{g.head}</span>
        <div class="spacer" />
        <button type="button" class="icon-btn" onClick={load} title="Refresh"><Icon name="refresh" size={14} /></button>
      </div>
      {g.files.length > 0 ? <div class="file-list">{g.files.map((f: any) => <div class="file-row"><span class={`fstat s${f.status[0]}`}>{f.status}</span><span class="mono">{f.path}</span></div>)}</div> : <div class="muted pad small">Working tree clean.</div>}
      <DiffView diff={g.diff} />
    </>
  );
}

function Trace() {
  const v = view.value;
  if (v.kind === 'chat') {
    return (
      <div class="pad">
        {v.panes.map((id) => {
          const c = chats.value[id];
          if (!c) return null;
          const done = c.turns.filter((t) => t.usage);
          const sum = (f: (t: (typeof done)[number]) => number | undefined) => done.reduce((a, t) => a + (f(t) ?? 0), 0);
          return (
            <div class="trace-block">
              <h4><EngineMark engine={c.engine} size={16} /> {c.title}</h4>
              <table class="data small">
                <thead><tr><th>#</th><th>model</th><th>time</th><th>in (cached)</th><th>out</th><th>cost</th></tr></thead>
                <tbody>
                  {c.turns.map((t, i) => (
                    <tr><td>{i + 1}</td><td class="nowrap">{shortSpec(t.spec)}</td><td>{dur(t.durationMs)}</td><td>{kfmt(t.usage?.input)} ({kfmt(t.usage?.cached)})</td><td>{kfmt(t.usage?.output)}</td><td>{money(t.credits, t.usd)}</td></tr>
                  ))}
                </tbody>
              </table>
              <div class="muted small">Total {dur(sum((t) => t.durationMs))} · {kfmt(sum((t) => t.usage?.input))} in · {kfmt(sum((t) => t.usage?.output))} out · {c.engine === 'codex' ? `${sum((t) => t.credits).toFixed(2)} credits` : `~$${sum((t) => t.usd).toFixed(3)}`}</div>
            </div>
          );
        })}
      </div>
    );
  }
  if (v.kind === 'run') {
    const d = runs.value[v.id];
    if (!d) return <div class="center pad"><Spinner /></div>;
    return (
      <div class="pad">
        <table class="data small">
          <thead><tr><th>#</th><th>R</th><th>seat</th><th>kind</th><th>time</th><th>in (cached)</th><th>out (reas.)</th><th>cost</th></tr></thead>
          <tbody>
            {d.meta.turns.map((t) => (
              <tr class={t.error ? 'bad-row' : ''} title={t.error}><td>{t.n}</td><td>{t.round}</td><td>{t.seat}</td><td>{t.kind}</td><td>{dur(t.durationMs)}</td><td>{kfmt(t.usage.input)} ({kfmt(t.usage.cached)})</td><td>{kfmt(t.usage.output)} ({kfmt(t.usage.reasoning)})</td><td>{money(t.codexCredits, t.usd)}</td></tr>
            ))}
          </tbody>
        </table>
        <div class="muted small">codex {d.meta.versions.codex} · claude {d.meta.versions.claude} · claw {d.meta.versions.claw}</div>
        <div class="muted small mono ellipsis" title={d.dir}>{d.dir}</div>
      </div>
    );
  }
  return <Empty icon="panel" title="Nothing to trace">Open a chat or a run to see its tokens, time and cost per turn.</Empty>;
}

function RightPanel() {
  return (
    <aside class="rightpanel">
      <div class="rp-tabs">
        <Tabs active={rightPanel.value === 'trace' ? 'trace' : 'changes'} onChange={(t) => setRight(t)} tabs={[{ id: 'changes', label: 'Changes' }, { id: 'trace', label: 'Trace' }]} />
        <div class="spacer" />
        <button type="button" class="icon-btn" onClick={() => setRight(rightPanel.value)} title="Close"><Icon name="x" size={14} /></button>
      </div>
      <div class="rp-body">{rightPanel.value === 'changes' ? <Changes /> : <Trace />}</div>
    </aside>
  );
}

// ── modals ───────────────────────────────────────────────────────────────

function FolderPicker({ start, onPick }: { start?: string; onPick: (p: string) => void; }) {
  const [path, setPath] = useState(start || app.value!.home);
  const [hidden, setHidden] = useState(false);
  const [l, setL] = useState<any>(null);
  useEffect(() => void guard(api(`/api/fs/dirs?path=${encodeURIComponent(path)}${hidden ? '&hidden=1' : ''}`)).then((r) => r && setL(r)), [path, hidden]);
  const close = () => (modal.value = null);
  return (
    <Modal title="Choose a project folder" onClose={close} footer={<>
      <span class="muted small">{l?.git ? 'git repository' : ''}</span>
      <div class="spacer" />
      <button type="button" class="btn" onClick={close}>Cancel</button>
      <button type="button" class="btn primary" disabled={!l?.path} onClick={() => { onPick(l?.path ?? path); close(); }}>Use this folder</button>
    </>}>
      <div class="row">
        <button type="button" class="icon-btn" disabled={!l?.parent} onClick={() => l?.parent && setPath(l.parent)} title="Up one folder"><Icon name="up" /></button>
        <input class="mono grow" value={path} onKeyDown={(e) => e.key === 'Enter' && setPath((e.target as HTMLInputElement).value)} onChange={(e) => setPath((e.target as HTMLInputElement).value)} />
        <label class="check small"><input type="checkbox" checked={hidden} onChange={(e) => setHidden((e.target as HTMLInputElement).checked)} /> hidden</label>
      </div>
      <div class="dir-list">
        {l?.dirs.map((d: any) => (
          <button type="button" class="dir-row" onClick={() => setPath(d.path)} onDblClick={() => { onPick(d.path); close(); }}>
            <Icon name="folder" size={14} /> <span>{d.name}</span> {d.git && <span class="badge">git</span>}
          </button>
        ))}
        {l && !l.dirs.length && <div class="muted pad">No sub-folders.</div>}
      </div>
    </Modal>
  );
}

function SetupCheck() {
  const checks = doctor.value;
  useEffect(() => void loadDoctor(), []);
  if (!checks) return <div class="center pad"><Spinner /> <span class="muted">Checking both CLIs and their sign-ins…</span></div>;
  const claudeOld = checks.find((c) => c.id === 'claude');
  return (
    <div class="checks">
      {checks.map((c) => (
        <div class={`check-row ${c.level}`}>
          <Icon name={c.level === 'ok' ? 'check-circle' : c.level === 'fail' ? 'x-circle' : c.level === 'warn' ? 'alert' : 'info'} size={16} />
          <div class="check-text">
            <b>{c.label}</b>
            <span class="muted small">{c.detail}</span>
            {c.fix && <span class="small">{c.fix}</span>}
          </div>
        </div>
      ))}
      <div class="row">
        <button type="button" class="btn small" onClick={() => void loadDoctor()}><Icon name="refresh" size={13} /> Check again</button>
        <button type="button" class="btn small" onClick={() => void loadDoctor(true)} title="Sends one tiny message through each CLI (Haiku and GPT-6 Luna) to prove both sign-ins work"><Icon name="zap" size={13} /> Test both sign-ins</button>
        {claudeOld && <button type="button" class="btn small" onClick={() => void updateClaude()}><Icon name="download" size={13} /> Update Claude Code</button>}
        <button type="button" class="btn small" onClick={() => void refreshQuota()}><Icon name="refresh" size={13} /> Refresh plan usage</button>
      </div>
    </div>
  );
}

function Settings({ tab: initial }: { tab?: 'general' | 'presets' | 'setup' | 'about'; }) {
  const s = app.value!;
  const [tab, setTab] = useState<'general' | 'presets' | 'setup' | 'about'>(initial ?? 'general');
  const [gui, setGui] = useState<AppState['gui']>(structuredClone(s.gui));
  const [warn, setWarn] = useState(s.warnPercent);
  const [presets, setPresets] = useState(JSON.stringify(s.presets, null, 2));
  const [err, setErr] = useState('');
  const close = () => (modal.value = null);
  const save = async () => {
    let p: unknown;
    try {
      p = JSON.parse(presets);
    } catch (e) {
      setErr(`Presets are not valid JSON: ${(e as Error).message}`);
      setTab('presets');
      return;
    }
    await saveSettings({ gui, presets: p, warnPercent: warn });
    close();
  };
  const dirty = tab === 'general' || tab === 'presets';
  return (
    <Modal title="Settings" onClose={close} wide footer={dirty ? <>
      <div class="spacer" />
      <button type="button" class="btn" onClick={close}>Cancel</button>
      <button type="button" class="btn primary" onClick={() => void save()}>Save</button>
    </> : undefined}>
      <Tabs active={tab} onChange={setTab} tabs={[{ id: 'general', label: 'General' }, { id: 'presets', label: 'Run presets' }, { id: 'setup', label: 'Setup check' }, { id: 'about', label: 'About' }]} />
      <div class="settings">
        {tab === 'general' && (
          <>
            <section>
              <h3>New Claude chats</h3>
              <div class="row"><SeatPicker spec={gui.claude.spec} engineLocked onChange={(spec) => setGui({ ...gui, claude: { ...gui.claude, spec } })} /><AccessPicker engine="claude" access={gui.claude.access} onChange={(access) => setGui({ ...gui, claude: { ...gui.claude, access } })} /></div>
            </section>
            <section>
              <h3>New Codex chats</h3>
              <div class="row wrap">
                <SeatPicker spec={gui.codex.spec} engineLocked onChange={(spec) => setGui({ ...gui, codex: { ...gui.codex, spec } })} />
                <AccessPicker engine="codex" access={gui.codex.access} onChange={(access) => setGui({ ...gui, codex: { ...gui.codex, access } })} />
                <Toggle checked={gui.codex.useConfig} onChange={(v) => setGui({ ...gui, codex: { ...gui.codex, useConfig: v } })} label="Load my Codex config" hint="plugins and MCP servers from ~/.codex/config.toml" />
              </div>
            </section>
            <section>
              <h3>Appearance</h3>
              <Segmented value={gui.theme} onChange={(t) => setGui({ ...gui, theme: t })} options={[{ id: 'system', label: <><Icon name="monitor" size={13} /> System</> }, { id: 'light', label: <><Icon name="sun" size={13} /> Light</> }, { id: 'dark', label: <><Icon name="moon" size={13} /> Dark</> }]} />
            </section>
            <section>
              <h3>Notifications and limits</h3>
              <Toggle checked={gui.notify} onChange={(v) => setGui({ ...gui, notify: v })} label="Notify me when a run or a long chat turn finishes" hint="only while Duo is in the background" />
              <label class="field inline">Warn when a plan window is at <input type="number" min={10} max={100} value={warn} onInput={(e) => setWarn(Number((e.target as HTMLInputElement).value) || 85)} /> %</label>
            </section>
          </>
        )}
        {tab === 'presets' && (
          <section>
            <p class="muted small">Named seat sets for runs: <span class="mono">{'{ "name": { "seats": [...], "chair": "...", "rounds": 3 } }'}</span></p>
            <textarea class="mono" rows={16} spellcheck={false} value={presets} onInput={(e) => { setPresets((e.target as HTMLTextAreaElement).value); setErr(''); }} />
            {err && <div class="callout bad"><Icon name="alert" size={14} /> {err}</div>}
          </section>
        )}
        {tab === 'setup' && <SetupCheck />}
        {tab === 'about' && (
          <section class="about">
            <Logo size={40} />
            <div>
              <b>Duo {s.version}</b>
              <div class="muted small">{s.versions.codex} · Claude Code {s.versions.claude} · {s.platform}</div>
              <div class="muted small">Config <span class="mono">{s.configPath}</span></div>
              <div class="muted small">Data <span class="mono">{s.dataDir}</span></div>
              <div class="muted small">Built on claw-orchestrator (MIT). Released under the MIT license.</div>
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  [`${MOD} K`, 'Command palette'],
  [`${MOD} N`, 'New Claude chat'],
  [`${MOD} Shift N`, 'Side by side'],
  [`${MOD} Shift P`, 'New pair run'],
  [`${MOD} B`, 'Toggle the sidebar'],
  [`${MOD} J`, 'Toggle the Changes panel'],
  [`${MOD} ,`, 'Settings'],
  [`${MOD} /`, 'This list'],
  ['Enter', 'Send'],
  ['Shift Enter', 'New line'],
  ['↑ (empty box)', 'Edit the last message'],
  [`${MOD} Enter`, 'Start the run (new-run form)'],
  ['Esc', 'Close dialogs and menus'],
];

function Shortcuts() {
  const close = () => (modal.value = null);
  return (
    <Modal title="Keyboard shortcuts" onClose={close}>
      <div class="shortcuts">
        {SHORTCUTS.map(([k, label]) => <div class="shortcut"><span>{label}</span><span>{k.split(' ').map((x) => <Kbd>{x}</Kbd>)}</span></div>)}
      </div>
    </Modal>
  );
}

function Confirm({ m }: { m: Extract<NonNullable<typeof modal.value>, { kind: 'confirm'; }>; }) {
  const close = () => (modal.value = null);
  return (
    <Modal title={m.title} onClose={close} footer={<>
      <div class="spacer" />
      <button type="button" class="btn" onClick={close}>Cancel</button>
      <button type="button" class={`btn ${m.danger ? 'danger-solid' : 'primary'}`} autoFocus onClick={() => { close(); m.onConfirm(); }}>{m.action}</button>
    </>}>
      <p>{m.body}</p>
    </Modal>
  );
}

// ── command palette ──────────────────────────────────────────────────────

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
  engine?: 'claude' | 'codex';
  run: () => void;
}

function commands(): Command[] {
  const s = app.value!;
  const out: Command[] = [
    { id: 'new-claude', label: 'New Claude chat', icon: 'chat', engine: 'claude', hint: `${MOD} N`, run: () => void openNewChat('claude') },
    { id: 'new-codex', label: 'New Codex chat', icon: 'chat', engine: 'codex', run: () => void openNewChat('codex') },
    { id: 'split', label: 'Side by side: Claude and Codex', icon: 'split', hint: `${MOD} Shift N`, run: () => void openSideBySide() },
    ...(['pair', 'debate', 'review', 'council', 'ask', 'custom'] as Protocol[]).map((p) => ({ id: `run-${p}`, label: `New ${PROTOCOLS[p].label.toLowerCase()} run`, icon: PROTOCOLS[p].icon, run: () => go({ kind: 'new-run', draft: { protocol: p } }) })),
    { id: 'home', label: 'Go home', icon: 'home', run: () => go({ kind: 'home' }) },
    { id: 'folder', label: 'Open a project folder…', icon: 'folder', run: () => pickFolder(project.value || s.home, setProject) },
    { id: 'no-folder', label: 'Work without a project folder', icon: 'folder-off', run: () => setProject('') },
    { id: 'changes', label: 'Toggle the Changes panel', icon: 'branch', hint: `${MOD} J`, run: () => setRight('changes') },
    { id: 'trace', label: 'Toggle the Trace panel', icon: 'panel', run: () => setRight('trace') },
    { id: 'quota', label: 'Refresh plan usage', icon: 'refresh', run: () => void refreshQuota() },
    { id: 'settings', label: 'Settings', icon: 'settings', hint: `${MOD} ,`, run: () => (modal.value = { kind: 'settings' }) },
    { id: 'setup', label: 'Setup check', icon: 'wrench', run: () => (modal.value = { kind: 'settings', tab: 'setup' }) },
    { id: 'theme', label: 'Switch light / dark', icon: 'moon', run: () => void saveSettings({ gui: { ...s.gui, theme: document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches) ? 'light' : 'dark' } }) },
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', hint: `${MOD} /`, run: () => (modal.value = { kind: 'shortcuts' }) },
  ];
  for (const p of s.projects.slice(0, 8)) out.push({ id: `proj-${p}`, label: `Project: ${base(p)}`, hint: p.replace(s.home, '~'), icon: 'folder', run: () => setProject(p) });
  for (const c of s.chats.slice(0, 30)) out.push({ id: `chat-${c.id}`, label: c.title, hint: `${c.engine === 'claude' ? 'Claude' : 'Codex'} · ${ago(c.updatedAt)}`, engine: c.engine, run: () => go({ kind: 'chat', panes: [c.id] }) });
  for (const r of s.runs.slice(0, 30)) out.push({ id: `runv-${r.id}`, label: r.title, hint: `${PROTOCOLS[r.protocol]?.label ?? r.protocol} · ${ago(r.createdAt)}`, icon: PROTOCOLS[r.protocol]?.icon, run: () => go({ kind: 'run', id: r.id }) });
  return out;
}

function score(label: string, q: string): number {
  const l = label.toLowerCase();
  if (!q) return 1;
  if (l.startsWith(q)) return 3;
  if (l.includes(q)) return 2;
  let i = 0;
  for (const ch of l) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
}

function Palette() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const all = useMemo(commands, [app.value]);
  const needle = q.trim().toLowerCase();
  const list = all.map((c) => ({ c, s: score(c.label, needle) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.c);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => (paletteOpen.value = false);
  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    c.run();
  };
  useEffect(() => setSel(0), [q]);
  useEffect(() => ref.current?.querySelector('.pal-item.sel')?.scrollIntoView({ block: 'nearest' }), [sel]);
  return (
    <div class="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="palette" role="dialog" aria-label="Command palette">
        <div class="pal-input"><Icon name="search" size={16} />
          <input autoFocus placeholder="Type a command, a chat or a run…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(list.length - 1, x + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(0, x - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(list[sel]); }
              else if (e.key === 'Escape') close();
            }} />
        </div>
        <div class="pal-list" ref={ref}>
          {list.map((c, i) => (
            <button type="button" class={`pal-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              {c.engine && !c.icon?.startsWith('chat') ? <EngineMark engine={c.engine} size={18} /> : c.engine ? <EngineMark engine={c.engine} size={18} /> : <Icon name={c.icon ?? 'dots'} size={16} />}
              <span class="pal-label">{c.label}</span>
              {c.hint && <span class="pal-hint">{c.hint}</span>}
            </button>
          ))}
          {!list.length && <div class="muted pad">No matches.</div>}
        </div>
      </div>
    </div>
  );
}

function Toasts() {
  return (
    <div class="toasts" role="status">
      {toasts.value.map((t) => (
        <div class={`toast ${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check-circle' : 'info'} size={15} />
          <span class="toast-text">{t.text}</span>
          {t.action && <button type="button" class="link-btn" onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>}
          <button type="button" class="icon-btn tiny" onClick={() => dismissToast(t.id)} aria-label="Dismiss"><Icon name="x" size={12} /></button>
        </div>
      ))}
    </div>
  );
}

export function App() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); paletteOpen.value = !paletteOpen.value; }
      else if (k === 'b') { e.preventDefault(); toggleSidebar(); }
      else if (k === 'j') { e.preventDefault(); setRight('changes'); }
      else if (k === ',') { e.preventDefault(); modal.value = { kind: 'settings' }; }
      else if (k === '/') { e.preventDefault(); modal.value = { kind: 'shortcuts' }; }
      else if (k === 'n' && e.shiftKey) { e.preventDefault(); void openSideBySide(); }
      else if (k === 'n') { e.preventDefault(); void openNewChat('claude'); }
      else if (k === 'p' && e.shiftKey) { e.preventDefault(); go({ kind: 'new-run', draft: { protocol: 'pair' } }); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const s = app.value;
  if (!s) {
    return (
      <div class="splash">
        <Logo size={56} />
        <p class="muted">{connected.value ? 'Loading…' : 'Starting the engine…'}</p>
        <Spinner size={18} />
      </div>
    );
  }
  const v = view.value;
  const m = modal.value;
  return (
    <div class={`app ${sidebarOpen.value ? '' : 'no-sidebar'} ${rightPanel.value !== 'none' ? 'has-right' : ''}`}>
      {sidebarOpen.value && <Sidebar />}
      <TopBar />
      <main class="main" key={v.kind === 'run' ? v.id : v.kind}>
        {v.kind === 'home' && <Home />}
        {v.kind === 'chat' && (v.panes.length ? <ChatView panes={v.panes} /> : <Home />)}
        {v.kind === 'run' && <RunView id={v.id} />}
        {v.kind === 'new-run' && <NewRun draft={v.draft} key={JSON.stringify(v.draft ?? {})} />}
      </main>
      {rightPanel.value !== 'none' && <RightPanel />}
      {m?.kind === 'folder' && <FolderPicker start={m.start} onPick={m.onPick} />}
      {m?.kind === 'settings' && <Settings tab={m.tab} />}
      {m?.kind === 'shortcuts' && <Shortcuts />}
      {m?.kind === 'confirm' && <Confirm m={m} />}
      {paletteOpen.value && <Palette />}
      <Toasts />
    </div>
  );
}

import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { desktop, MOD } from './api.ts';
import { onCopyClick, renderMarkdown } from './md.ts';
import { AccessPicker, SeatPicker } from './SeatPicker.tsx';
import { shortSpec } from './spec.ts';
import { chats, compareWith, confirmAction, decide, deleteChat, go, patchChat, retryChat, sendTo, stopChat, toast, updateClaude, view } from './store.ts';
import type { Block, ChatSession, ChatTurn, Engine, PermissionRequest } from './types.ts';
import { base, Dropdown, dur, Elapsed, EngineMark, Icon, Kbd, kfmt, MenuItem, MenuSeparator, money, Spinner } from './ui.tsx';

/** Text the split view's shared composer should pick up (from "Ask the other to review"). */
const sharedDraft = signal<{ text: string; targets: string[] } | null>(null);

export function Markdown({ text, class: cls }: { text: string; class?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class={`md ${cls ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── drafts (per chat, kept across restarts) ──────────────────────────────

function useDraft(key: string): [string, (v: string) => void] {
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      setText(localStorage.getItem(key) ?? '');
    } catch {
      /* ignore */
    }
  }, [key]);
  const set = (v: string) => {
    setText(v);
    try {
      if (v) localStorage.setItem(key, v);
      else localStorage.removeItem(key);
    } catch {
      /* storage blocked */
    }
  };
  return [text, set];
}

// ── tools ────────────────────────────────────────────────────────────────

function parseInput(b: Pick<Block, 'input'>): any {
  try {
    return JSON.parse(b.input || '{}');
  } catch {
    return b.input ?? '';
  }
}

function rel(p: unknown, cwd?: string): string {
  const s = String(p ?? '');
  if (!cwd) return s;
  for (const sep of ['/', '\\']) if (s.startsWith(cwd + sep)) return s.slice(cwd.length + 1);
  return s;
}

/** `bash -lc '…'` / `bash -lc "…"` / `powershell -Command "…"` → the command itself. */
function shellCommand(cmd: string): string {
  const c = cmd.trim();
  const single = /^\/?(?:usr\/)?(?:bin\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(c);
  if (single) return single[1].replace(/'\\''/g, "'");
  const double = /^\/?(?:usr\/)?(?:bin\/)?(?:ba|z)?sh -l?c "([\s\S]*)"$/.exec(c) ?? /^"?[^"]*powershell(?:\.exe)?"? (?:-NoProfile )?-Command "([\s\S]*)"$/i.exec(c);
  return double ? double[1].replace(/\\"/g, '"') : cmd;
}

export function toolSummary(name: string | undefined, input: any, cwd?: string): { icon: string; title: string; detail?: string } {
  switch (name) {
    case 'shell':
      return { icon: 'terminal', title: shellCommand(String(input ?? '')) };
    case 'Bash':
    case 'PowerShell':
      return { icon: 'terminal', title: String(input.command ?? ''), detail: input.description };
    case 'Read':
      return { icon: 'file', title: `Read ${rel(input.file_path, cwd)}` };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { icon: 'edit', title: `Edit ${rel(input.file_path ?? input.notebook_path, cwd)}` };
    case 'Write':
      return { icon: 'edit', title: `Write ${rel(input.file_path, cwd)}` };
    case 'Grep':
      return { icon: 'search', title: `Search “${input.pattern ?? ''}”${input.path ? ` in ${rel(input.path, cwd)}` : ''}` };
    case 'Glob':
      return { icon: 'search', title: `Find ${input.pattern ?? ''}` };
    case 'WebSearch':
    case 'web_search':
      return { icon: 'globe', title: `Search the web: ${typeof input === 'string' ? input : input.query ?? ''}` };
    case 'WebFetch':
      return { icon: 'globe', title: `Fetch ${input.url ?? ''}` };
    case 'TodoWrite':
      return { icon: 'list', title: 'Update the plan' };
    case 'Task':
    case 'Agent':
      return { icon: 'council', title: `Sub-agent: ${input.description ?? ''}` };
    default:
      return { icon: 'wrench', title: name ?? 'tool' };
  }
}

function EditDiff({ input }: { input: any }) {
  const edits: { old_string?: string; new_string?: string }[] = input.edits ?? [input];
  return (
    <div class="diff">
      {edits.map((e) => (
        <>
          {(e.old_string ?? '').split('\n').map((l) => l && <div class="del">- {l}</div>)}
          {(e.new_string ?? '').split('\n').map((l) => <div class="add">+ {l}</div>)}
        </>
      ))}
    </div>
  );
}

function ToolRow({ b, cwd }: { b: Block; cwd: string }) {
  const [open, setOpen] = useState(false);
  const input = parseInput(b);
  const s = toolSummary(b.name, b.name === 'shell' ? b.input : input, cwd);
  const isEdit = ['Edit', 'MultiEdit', 'Write'].includes(b.name ?? '');
  const isShell = b.name === 'shell' || b.name === 'Bash' || b.name === 'PowerShell';
  return (
    <div class={`step tool ${b.status ?? ''}`}>
      <button type="button" class="step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="step-icon">{b.status === 'running' ? <Spinner size={12} /> : <Icon name={s.icon} size={14} />}</span>
        <span class={`step-title ${isShell ? 'mono' : ''}`}>{s.title}</span>
        {b.exitCode ? <span class="badge bad">exit {b.exitCode}</span> : b.status === 'error' ? <span class="badge bad">failed</span> : null}
        <Icon name={open ? 'down' : 'right'} size={12} class="step-caret" />
      </button>
      {open && (
        <div class="step-body">
          {s.detail && <div class="muted small">{s.detail}</div>}
          {isEdit && typeof input === 'object' ? (b.name === 'Write' ? <pre class="io">{String(input.content ?? '').slice(0, 20000)}</pre> : <EditDiff input={input} />)
            : !isShell && <pre class="io">{typeof input === 'string' ? input : JSON.stringify(input, null, 2)}</pre>}
          {b.output !== undefined && b.output !== '' && <pre class="io out">{b.output}</pre>}
        </div>
      )}
    </div>
  );
}

function Todo({ b }: { b: Block }) {
  let items: { text: string; completed: boolean }[] = [];
  try {
    items = JSON.parse(b.text ?? '[]');
  } catch {
    /* ignore */
  }
  const done = items.filter((i) => i.completed).length;
  return (
    <div class="step todo">
      <div class="step-head static"><span class="step-icon"><Icon name="list" size={14} /></span><span class="step-title">Plan</span><span class="muted small">{done}/{items.length}</span></div>
      <ul class="todo-list">
        {items.map((i) => <li class={i.completed ? 'done' : ''}><span class="box">{i.completed ? <Icon name="check" size={11} /> : null}</span>{i.text}</li>)}
      </ul>
    </div>
  );
}

export function BlockView({ b, cwd }: { b: Block; cwd: string }) {
  switch (b.kind) {
    case 'text':
      return <Markdown text={b.text ?? ''} class={b.phase === 'commentary' ? 'commentary' : ''} />;
    case 'thinking':
      return (
        <details class="thinking" open={b.status === 'running'}>
          <summary><Icon name="spark" size={13} /> {b.status === 'running' ? <span class="shimmer">Thinking…</span> : 'Thought process'}</summary>
          <Markdown text={b.text ?? ''} />
        </details>
      );
    case 'tool':
      return <ToolRow b={b} cwd={cwd} />;
    case 'patch':
      return (
        <div class="step">
          <div class="step-head static"><span class="step-icon"><Icon name="edit" size={14} /></span><span class="step-title">Changed files</span></div>
          <pre class="io">{(b.text ?? '').split('\n').map((l) => l.replace(/^(\w+) (.*)$/, (_m, kind: string, p: string) => `${kind} ${rel(p, cwd)}`)).join('\n')}</pre>
        </div>
      );
    case 'todo':
      return <Todo b={b} />;
    case 'note':
      return b.status === 'error'
        ? <div class="callout bad"><Icon name="alert" size={14} /> <span>{b.text}</span></div>
        : <div class="callout subtle"><Icon name="refresh" size={13} /> <span>{b.text}</span></div>;
  }
}

// ── permission prompt ────────────────────────────────────────────────────

function PermissionCard({ req, engine, cwd }: { req: PermissionRequest; engine: Engine; cwd: string }) {
  const s = toolSummary(req.tool, req.input, cwd);
  const isEdit = ['Edit', 'MultiEdit', 'Write'].includes(req.tool);
  return (
    <div class="perm-card">
      <div class="perm-head"><Icon name="shield" size={15} /> <b>{engine === 'claude' ? 'Claude' : 'Codex'} wants to use {req.tool}</b></div>
      <div class={`perm-title ${req.tool === 'Bash' ? 'mono' : ''}`}>{s.title}</div>
      {s.detail && <div class="muted small">{s.detail}</div>}
      {req.tool === 'Write' ? <pre class="io">{String(req.input?.content ?? '').slice(0, 20000)}</pre>
        : isEdit ? <EditDiff input={req.input} />
        : req.tool !== 'Bash' && <details><summary class="muted small">Details</summary><pre class="io">{JSON.stringify(req.input, null, 2)}</pre></details>}
      <div class="perm-actions">
        <button type="button" class="btn primary" onClick={() => decide(req.id, 'allow')}><Icon name="check" size={14} /> Allow</button>
        <button type="button" class="btn" onClick={() => decide(req.id, 'allow_session')}>Always allow {req.tool} in this chat</button>
        <div class="spacer" />
        <button type="button" class="btn ghost danger" onClick={() => decide(req.id, 'deny')}>Deny</button>
      </div>
    </div>
  );
}

// ── turns ────────────────────────────────────────────────────────────────

function finalText(turn: ChatTurn): string {
  const texts = turn.blocks.filter((b) => b.kind === 'text' && b.text);
  return (texts.find((b) => b.phase === 'final') ?? texts[texts.length - 1])?.text ?? '';
}

function engineLabel(e: Engine): string {
  return e === 'claude' ? 'Claude' : 'Codex';
}

function TurnFooter({ chat, turn, partner, last }: { chat: ChatSession; turn: ChatTurn; partner?: ChatSession; last: boolean }) {
  const u = turn.usage;
  const text = finalText(turn);
  const cost = money(turn.credits, turn.usd);
  const forReview = `Here is ${engineLabel(chat.engine)}'s answer (${shortSpec(turn.spec)}) to my last message. Review it critically: what is wrong, missing, or better done differently? Verify claims against the code where you can, and be specific.\n\n---\n\n${text}`;
  return (
    <div class="turn-foot">
      <span class="foot-meta" title={turn.spec}>{shortSpec(turn.spec)}</span>
      <span class="foot-meta">{dur(turn.durationMs)}</span>
      {u && <span class="foot-meta" title={`${u.input} input tokens (${u.cached} cached), ${u.output} output, ${u.reasoning} reasoning`}>{kfmt(u.input)} in · {kfmt(u.output)} out</span>}
      {cost && <span class="foot-meta">{cost}</span>}
      {turn.status === 'stopped' && <span class="badge">stopped</span>}
      <div class="spacer" />
      <div class="foot-actions">
        {text && (
          <button type="button" class="icon-btn small" title="Copy the answer" onClick={() => void navigator.clipboard.writeText(text).then(() => toast('Copied', 'success'))}>
            <Icon name="copy" size={14} />
          </button>
        )}
        {last && (turn.status === 'error' || turn.status === 'stopped' || text) && (
          <button type="button" class="icon-btn small" title="Send this message again" onClick={() => retryChat(chat.id)}><Icon name="retry" size={14} /></button>
        )}
        {text && partner && (
          <button type="button" class="link-btn" title={`Send this answer to ${engineLabel(partner.engine)} for a critical review`} onClick={() => (sharedDraft.value = { text: forReview, targets: [partner.id] })}>
            <Icon name="forward" size={13} /> Ask {engineLabel(partner.engine)} to review
          </button>
        )}
        {text && !partner && (
          <button type="button" class="link-btn" title={`Open ${engineLabel(chat.engine === 'claude' ? 'codex' : 'claude')} next to this chat`} onClick={() => void compareWith(chat.id)}>
            <Icon name="split" size={13} /> Compare
          </button>
        )}
        {text && (
          <Dropdown align="right" up trigger={(_o, toggle) => <button type="button" class="link-btn" onClick={toggle}><Icon name="debate" size={13} /> Escalate <Icon name="down" size={11} /></button>}>
            {(close) => (
              <>
                <MenuItem icon="debate" onClick={() => { close(); go({ kind: 'new-run', draft: { protocol: 'debate', cwd: chat.cwd, brief: turn.user } }); }} hint="both argue to agreement">Debate this question</MenuItem>
                <MenuItem icon="council" onClick={() => { close(); go({ kind: 'new-run', draft: { protocol: 'council', cwd: chat.cwd, brief: turn.user } }); }} hint="ranked answers">Ask a council</MenuItem>
                <MenuItem icon="pair" onClick={() => { close(); go({ kind: 'new-run', draft: { protocol: 'pair', cwd: chat.cwd, brief: turn.user } }); }} hint="write + review loop">Pair on it</MenuItem>
              </>
            )}
          </Dropdown>
        )}
      </div>
    </div>
  );
}

function TurnView({ chat, turn, partner, last }: { chat: ChatSession; turn: ChatTurn; partner?: ChatSession; last: boolean }) {
  const running = turn.status === 'running';
  const runningTool = running && [...turn.blocks].reverse().find((b) => b.status === 'running' && b.kind === 'tool');
  const updateHint = turn.error && /claude update|or newer is required/i.test(turn.error);
  return (
    <div class="turn">
      <div class="user-row"><div class="user-bubble">{turn.user}</div></div>
      <div class="assistant">
        <div class="assistant-head">
          <EngineMark engine={chat.engine} size={20} />
          <span class="assistant-name">{engineLabel(chat.engine)}</span>
          <span class="muted small">{shortSpec(turn.spec)}</span>
        </div>
        <div class="assistant-body">
          {turn.blocks.map((b) => <BlockView key={b.id} b={b} cwd={chat.cwd} />)}
          {running && chat.permissions.map((p) => <PermissionCard key={p.id} req={p} engine={chat.engine} cwd={chat.cwd} />)}
          {running && (
            <div class="working">
              <span class="pulse-dot" />
              <span>{chat.permissions.length ? 'Waiting for you' : runningTool ? 'Running' : turn.blocks.length ? 'Working' : 'Starting'}</span>
              <Elapsed since={new Date(turn.at).getTime()} />
              <button type="button" class="link-btn" onClick={() => stopChat(chat.id)}><Icon name="stop" size={11} /> Stop</button>
            </div>
          )}
          {turn.status === 'error' && (
            <div class="callout bad">
              <Icon name="alert" size={15} />
              <div class="callout-body">
                <div>{turn.error}</div>
                {turn.hint && <div class="callout-hint">{turn.hint}</div>}
                <div class="callout-actions">
                  {last && <button type="button" class="btn small" onClick={() => retryChat(chat.id)}><Icon name="retry" size={13} /> Try again</button>}
                  {updateHint && <button type="button" class="btn small" onClick={() => void updateClaude()}><Icon name="download" size={13} /> Update Claude Code</button>}
                </div>
              </div>
            </div>
          )}
          {!running && <TurnFooter chat={chat} turn={turn} partner={partner} last={last} />}
        </div>
      </div>
    </div>
  );
}

// ── panes ────────────────────────────────────────────────────────────────

const STARTERS: Record<Engine, string[]> = {
  claude: ['Explain how this project is put together', 'Find the riskiest code here and say why', 'Write tests for the module I name next', 'Review my uncommitted changes'],
  codex: ['Find and fix a failing test', 'Profile the slowest path and speed it up', 'Add input validation to the API handlers', 'Summarize what changed in the last 10 commits'],
};

function EmptyChat({ chat, onPick }: { chat: ChatSession; onPick: (t: string) => void }) {
  const general = chat.cwd.includes('scratch');
  return (
    <div class="empty-chat">
      <EngineMark engine={chat.engine} size={52} />
      <h2>{chat.engine === 'claude' ? 'Claude Code' : 'Codex'}</h2>
      <p class="muted">{general ? 'General chat (no project folder)' : <>in <span class="mono">{base(chat.cwd)}</span></>} · {shortSpec(chat.spec)}</p>
      {!general && (
        <div class="starters">
          {STARTERS[chat.engine].map((s) => <button type="button" class="starter" onClick={() => onPick(s)}>{s}<Icon name="right" size={13} /></button>)}
        </div>
      )}
    </div>
  );
}

function Title({ chat }: { chat: ChatSession }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(chat.title);
  if (editing) {
    return (
      <input class="title-input" value={value} autoFocus onInput={(e) => setValue((e.target as HTMLInputElement).value)}
        onBlur={() => { setEditing(false); if (value.trim() && value !== chat.title) void patchChat(chat.id, { title: value.trim() }); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setValue(chat.title); setEditing(false); } }} />
    );
  }
  return <span class="pane-title" title="Double-click to rename" onDblClick={() => { setValue(chat.title); setEditing(true); }}>{chat.title}</span>;
}

function useStickToBottom(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      stick.current = near;
      setAway(!near);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [dep]);
  const toBottom = () => {
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };
  return { ref, away, toBottom };
}

function ChatPane({ id, split, partner }: { id: string; split: boolean; partner?: string }) {
  const c = chats.value[id];
  const scroll = useStickToBottom(c ? JSON.stringify(c.turns.map((t) => [t.id, t.status, t.blocks.length, t.blocks[t.blocks.length - 1]?.text?.length, c.permissions.length])) : '');
  const [pick, setPick] = useState<string | undefined>();
  if (!c) return <section class="pane loading"><Spinner /></section>;
  const running = c.turns.some((t) => t.status === 'running');
  const other = partner ? chats.value[partner] : undefined;
  const closePane = () => {
    if (view.value.kind === 'chat') go({ kind: 'chat', panes: view.value.panes.filter((p) => p !== id) });
  };
  return (
    <section class={`pane pane-${c.engine}`}>
      <header class="pane-head">
        <EngineMark engine={c.engine} size={20} />
        <Title chat={c} />
        {c.cwd && !c.cwd.includes('scratch') && <span class="pane-folder" title={c.cwd}><Icon name="folder" size={12} /> {base(c.cwd)}</span>}
        <div class="spacer" />
        {split && <SeatPicker spec={c.spec} engineLocked align="right" onChange={(spec) => void patchChat(id, { spec })} />}
        {split && <AccessPicker engine={c.engine} access={c.access} align="right" onChange={(access) => void patchChat(id, { access })} />}
        {running && split && <button type="button" class="btn small stop" onClick={() => stopChat(id)}><Icon name="stop" size={11} /> Stop</button>}
        {!split && <button type="button" class="icon-btn" title={`Open ${c.engine === 'claude' ? 'Codex' : 'Claude'} side by side`} onClick={() => void compareWith(id)}><Icon name="split" /></button>}
        {split && <button type="button" class="icon-btn" title="Close this pane" onClick={closePane}><Icon name="x" /></button>}
        <Dropdown align="right" trigger={(_o, toggle) => <button type="button" class="icon-btn" onClick={toggle} title="More"><Icon name="dots" /></button>}>
          {(close) => (
            <>
              <MenuItem icon="pin" onClick={() => { close(); void patchChat(c.id, { pinned: !c.pinned }); }}>{c.pinned ? 'Unpin' : 'Pin to the top'}</MenuItem>
              {!c.cwd.includes('scratch') && <MenuItem icon="folder" onClick={() => { close(); if (desktop) void desktop.openPath(c.cwd); else toast(c.cwd, 'info'); }}>Show project folder</MenuItem>}
              <MenuItem icon="copy" onClick={() => { close(); void navigator.clipboard.writeText(c.turns.map((t) => `## You\n\n${t.user}\n\n## ${engineLabel(c.engine)}\n\n${finalText(t)}`).join('\n\n')); toast('Conversation copied as Markdown', 'success'); }}>Copy conversation</MenuItem>
              <MenuSeparator />
              <MenuItem icon="trash" danger onClick={() => { close(); confirmAction({ title: 'Delete this chat?', body: `“${c.title}” is removed from Duo. The ${engineLabel(c.engine)} session itself stays in its own history.`, action: 'Delete', danger: true }, () => void deleteChat(id)); }}>Delete chat</MenuItem>
            </>
          )}
        </Dropdown>
      </header>
      <div class="transcript" ref={scroll.ref} onClick={onCopyClick}>
        <div class="transcript-inner">
          {c.turns.length === 0 && <EmptyChat chat={c} onPick={setPick} />}
          {c.turns.map((t, i) => <TurnView key={t.id} chat={c} turn={t} partner={other} last={i === c.turns.length - 1} />)}
        </div>
      </div>
      {scroll.away && <button type="button" class="to-bottom" onClick={scroll.toBottom} title="Jump to the latest"><Icon name="down" size={16} /></button>}
      {!split && <Composer chat={c} preset={pick} onPresetUsed={() => setPick(undefined)} />}
    </section>
  );
}

// ── composers ────────────────────────────────────────────────────────────

export function AutoTextarea({ value, onInput, onSubmit, placeholder, autoFocus, onKeyDown, max = 0.4 }: { value: string; onInput: (v: string) => void; onSubmit: () => void; placeholder: string; autoFocus?: boolean; onKeyDown?: (e: KeyboardEvent) => boolean | void; max?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * max)}px`;
  }, [value]);
  return (
    <textarea ref={ref} class="composer-input" rows={1} value={value} placeholder={placeholder} autoFocus={autoFocus} spellcheck
      onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)}
      onKeyDown={(e) => {
        if (onKeyDown?.(e)) return;
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          onSubmit();
        }
      }} />
  );
}

function Composer({ chat, preset, onPresetUsed }: { chat: ChatSession; preset?: string; onPresetUsed: () => void }) {
  const [text, setText] = useDraft(`duo.draft.${chat.id}`);
  const running = chat.turns.some((t) => t.status === 'running');
  useEffect(() => {
    if (preset) {
      setText(preset);
      onPresetUsed();
    }
  }, [preset]);
  const submit = async () => {
    if (!text.trim() || running) return;
    const t = text;
    setText('');
    if (!(await sendTo(chat.id, t))) setText(t);
  };
  const last = chat.turns[chat.turns.length - 1];
  return (
    <div class="composer-wrap">
      <div class={`composer ${running ? 'busy' : ''}`}>
        <AutoTextarea value={text} onInput={setText} onSubmit={() => void submit()} autoFocus
          placeholder={running ? `${engineLabel(chat.engine)} is working… you can type the next message` : `Message ${engineLabel(chat.engine)}`}
          onKeyDown={(e) => {
            // ↑ in an empty box brings back the last message for editing.
            if (e.key === 'ArrowUp' && !text && last) {
              e.preventDefault();
              setText(last.user);
              return true;
            }
            return false;
          }} />
        <div class="composer-bar">
          <SeatPicker spec={chat.spec} engineLocked up onChange={(spec) => void patchChat(chat.id, { spec })} />
          <AccessPicker engine={chat.engine} access={chat.access} up onChange={(access) => void patchChat(chat.id, { access })} />
          {chat.engine === 'codex' && (
            <label class="check small" title="Load ~/.codex/config.toml: your Codex plugins and MCP servers">
              <input type="checkbox" checked={chat.useCodexConfig} onChange={(e) => void patchChat(chat.id, { useCodexConfig: (e.target as HTMLInputElement).checked })} />
              My Codex config
            </label>
          )}
          <div class="spacer" />
          <span class="composer-hint"><Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line</span>
          {running
            ? <button type="button" class="send-btn stop" onClick={() => stopChat(chat.id)} title="Stop"><Icon name="stop" /></button>
            : <button type="button" class="send-btn" disabled={!text.trim()} onClick={() => void submit()} title={`Send (Enter)`}><Icon name="send" /></button>}
        </div>
      </div>
    </div>
  );
}

function SharedComposer({ panes }: { panes: string[] }) {
  const cs = panes.map((id) => chats.value[id]).filter(Boolean) as ChatSession[];
  const [text, setText] = useDraft(`duo.draft.${panes.join('+')}`);
  const [targets, setTargets] = useState<string[]>(panes);
  const ref = useRef<HTMLDivElement>(null);
  // A different pair of panes resets who the message goes to.
  useEffect(() => setTargets(panes), [panes.join('+')]);
  useEffect(() => {
    const d = sharedDraft.value;
    if (!d) return;
    setText(d.text);
    setTargets(d.targets);
    sharedDraft.value = null;
    ref.current?.querySelector('textarea')?.focus();
  }, [sharedDraft.value]);
  const busy = cs.filter((c) => c.turns.some((t) => t.status === 'running'));
  const sendable = targets.filter((id) => panes.includes(id) && !busy.some((b) => b.id === id));
  const submit = async () => {
    if (!text.trim() || !sendable.length) return;
    const t = text;
    setText('');
    const ok = await Promise.all(sendable.map((id) => sendTo(id, t)));
    if (!ok.some(Boolean)) setText(t);
  };
  const toggle = (id: string) => setTargets(targets.includes(id) ? targets.filter((x) => x !== id) : [...targets, id]);
  const names = cs.filter((c) => targets.includes(c.id)).map((c) => engineLabel(c.engine));
  return (
    <div class="composer-wrap">
      <div class="composer shared" ref={ref}>
        <AutoTextarea value={text} onInput={setText} onSubmit={() => void submit()} autoFocus placeholder={names.length === cs.length ? 'Message both' : names.length ? `Message ${names.join(' and ')}` : 'Pick who to message below'} />
        <div class="composer-bar">
          <span class="muted small">Send to</span>
          {cs.map((c) => (
            <button type="button" class={`chip target ${c.engine} ${targets.includes(c.id) ? 'on' : ''}`} onClick={() => toggle(c.id)} aria-pressed={targets.includes(c.id)}>
              <EngineMark engine={c.engine} size={16} /> {engineLabel(c.engine)} <span class="muted">{shortSpec(c.spec)}</span>
            </button>
          ))}
          <div class="spacer" />
          <span class="composer-hint">{MOD}+Click a chat in the sidebar to open it here</span>
          {busy.length > 0 && <button type="button" class="btn small stop" onClick={() => busy.forEach((c) => stopChat(c.id))}><Icon name="stop" size={11} /> Stop{busy.length > 1 ? ' both' : ''}</button>}
          <button type="button" class="send-btn" disabled={!text.trim() || !sendable.length} onClick={() => void submit()} title="Send (Enter)"><Icon name="send" /></button>
        </div>
      </div>
    </div>
  );
}

export function ChatView({ panes }: { panes: string[] }) {
  return (
    <div class="chatview">
      <div class={`panes panes-${panes.length}`}>
        {panes.map((id) => <ChatPane key={id} id={id} split={panes.length > 1} partner={panes.find((p) => p !== id)} />)}
      </div>
      {panes.length > 1 && <SharedComposer panes={panes} />}
    </div>
  );
}

import { useEffect, useState } from 'preact/hooks';
import { api, desktop, exportUrl, MOD } from './api.ts';
import { BlockView, Markdown } from './Chat.tsx';
import { MODES, ModeDemo, type ModeId } from './demos.tsx';
import { DiffView } from './Diff.tsx';
import { onCopyClick } from './md.ts';
import { SeatPicker } from './SeatPicker.tsx';
import { parseSpec, shortSpec } from './spec.ts';
import { app, cancelRun, confirmAction, continueRun, deleteRun, go, guard, loadRun, prefs, project, runLive, runLogs, runs, startRun, toast, updateClaude, workspaceAction } from './store.ts';
import type { LiveTurn, PairCycle, Protocol, RunDetails, RunTurnMeta, StartRun } from './types.ts';
import { base, Dropdown, dur, Elapsed, Empty, EngineMark, Icon, Kbd, kfmt, MenuItem, MenuSeparator, Modal, money, Segmented, Spinner, Tabs, Toggle, untilText } from './ui.tsx';

export const PROTOCOLS: Record<Protocol, { icon: string; label: string; help: string; mode: ModeId }> = {
  pair: { icon: 'pair', label: 'Pair', help: MODES.pair.tagline, mode: 'pair' },
  debate: { icon: 'debate', label: 'Debate', help: MODES.debate.tagline, mode: 'debate' },
  review: { icon: 'review', label: 'Review', help: MODES.review.tagline, mode: 'review' },
  council: { icon: 'council', label: 'Council', help: MODES.council.tagline, mode: 'council' },
  ask: { icon: 'ask', label: 'Ask', help: MODES.ask.tagline, mode: 'ask' },
};
export const PROTOCOL_ORDER: Protocol[] = ['pair', 'debate', 'review', 'council', 'ask'];

type Tone = 'good' | 'warn' | 'bad' | 'running' | 'neutral';

export function outcomeTone(status: string, outcome?: Record<string, any>): { tone: Tone; label: string } {
  const stop = String(outcome?.stop ?? '');
  if (status === 'running') return { tone: 'running', label: 'running' };
  if (status === 'cancelled' || stop.startsWith('cancelled')) return { tone: 'neutral', label: 'cancelled' };
  if (status === 'failed') return { tone: 'bad', label: 'failed' };
  if (stop.startsWith('converged')) return { tone: 'good', label: 'converged' };
  if (stop.startsWith('NOT converged')) return { tone: 'warn', label: 'not converged' };
  if (stop.startsWith('stalled')) return { tone: 'warn', label: 'stalled' };
  if (stop.startsWith('deadlocked')) return { tone: 'warn', label: 'deadlocked' };
  if (stop.startsWith('blocked')) return { tone: 'warn', label: 'blocked' };
  if (stop.startsWith('stopped')) return { tone: 'warn', label: 'stopped early' };
  return { tone: 'good', label: status === 'completed' ? 'done' : status };
}

export function StatusChip({ status, outcome }: { status: string; outcome?: Record<string, any> }) {
  const t = outcomeTone(status, outcome);
  return <span class={`status ${t.tone}`}>{t.tone === 'running' ? <span class="pulse-dot" /> : null}{t.label}</span>;
}

function seatRole(d: RunDetails, seat: string): string {
  if (d.meta.protocol !== 'pair') return seat;
  return seat === d.pair?.writer || d.meta.seats.find((s) => s.id === seat)?.role === 'writer' ? 'Writer' : 'Reviewer';
}

function SeatChips({ d }: { d: RunDetails }) {
  const seats = d.meta.seats.filter((s) => s.role !== 'reviewer');
  return (
    <div class="seat-chips">
      {seats.map((s) => (
        <span class={`chip static ${s.engine}`} title={s.spec}>
          <EngineMark engine={s.engine} size={16} />
          <b>{s.role === 'chair' ? 'Chair' : d.meta.protocol === 'pair' ? (s.role === 'writer' ? 'Writer' : 'Reviewer') : s.id}</b>
          <span class="muted">{shortSpec(s.spec)}</span>
        </span>
      ))}
    </div>
  );
}

// ── live activity ────────────────────────────────────────────────────────

function LiveCard({ t, d }: { t: LiveTurn; d: RunDetails }) {
  const seat = d.meta.seats.find((s) => (t.seat === 'chair' ? s.role === 'chair' : s.id === t.seat && s.role !== 'reviewer'));
  const [all, setAll] = useState(false);
  const blocks = all ? t.blocks : t.blocks.slice(-6);
  return (
    <div class={`live-card ${seat?.engine ?? ''}`}>
      <div class="live-head">
        {seat && <EngineMark engine={seat.engine} size={18} />}
        <b>{t.seat === 'chair' ? 'Chair' : seatRole(d, t.seat)}</b>
        <span class="muted small">{t.kind} · {d.meta.protocol === 'pair' ? 'cycle' : 'round'} {t.round}</span>
        <div class="spacer" />
        {!t.done && <><span class="pulse-dot" /><Elapsed since={t.startedAt} /></>}
        {t.done && (t.error ? <span class="badge bad">error</span> : <Icon name="check" size={14} class="good-text" />)}
      </div>
      <div class="live-body">
        {t.blocks.length > 6 && !all && <button type="button" class="link-btn small" onClick={() => setAll(true)}>{t.blocks.length - 6} earlier steps</button>}
        {blocks.map((b) => <BlockView key={b.id} b={b.kind === 'text' && !t.done && b.text && b.text.length > 1200 ? { ...b, text: '…' + b.text.slice(-1200) } : b} cwd={d.meta.workspace?.cwd ?? d.meta.cwd} />)}
        {!t.blocks.length && !t.done && <div class="muted small shimmer">Starting…</div>}
      </div>
    </div>
  );
}

function LiveActivity({ d }: { d: RunDetails }) {
  const live = Object.values(runLive.value[d.meta.id] ?? {});
  const running = live.filter((t) => !t.done);
  if (!running.length) return null;
  return (
    <section class="live">
      <div class="section-title"><span class="pulse-dot" /> Working now</div>
      <div class={`live-grid n${Math.min(running.length, 3)}`}>
        {running.map((t) => <LiveCard key={t.n} t={t} d={d} />)}
      </div>
    </section>
  );
}

// ── rounds grid (debate, review, council, ask) ───────────────────────────

function TurnCard({ t, onOpen }: { t: RunTurnMeta; onOpen: () => void }) {
  return (
    <button type="button" class={`turn-card ${t.error ? 'err' : ''}`} onClick={onOpen} title={t.error ?? (t.warnings?.join('\n') || 'Open the prompt, reply, tool calls and reasoning')}>
      <div class="tc-top"><span class="tc-kind">{t.kind}</span><span class="muted small">{dur(t.durationMs)}</span></div>
      <div class="tc-bottom">
        {t.verdict && <span class={`verdict v-${t.verdict.replace('/', '').replace('_', '-')}`}>{t.verdict.replace('_', ' ')}</span>}
        {t.error ? <span class="badge bad">error</span> : <span class="muted small">{kfmt(t.usage.output)} out{money(t.codexCredits, t.usd) ? ` · ${money(t.codexCredits, t.usd)}` : ''}</span>}
        {t.warnings?.length ? <span class="badge warn" title={t.warnings.join('\n')}>{t.warnings.length} warning{t.warnings.length > 1 ? 's' : ''}</span> : null}
      </div>
    </button>
  );
}

function RoundsGrid({ d, onOpen }: { d: RunDetails; onOpen: (n: number) => void }) {
  const m = d.meta;
  const cols = [...new Set(m.turns.map((t) => t.seat))].sort((a, b) => (a === 'chair' ? 1 : b === 'chair' ? -1 : a.localeCompare(b)));
  // Older runs recorded the chair as round 0; it still belongs at the end.
  const rounds = [...new Set(m.turns.map((t) => t.round))].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b));
  const stats: any[] = d.ledger?.rounds ?? [];
  const specOf = (seat: string) => m.seats.find((s) => (s.role === 'chair' ? 'chair' : s.id) === seat && s.role !== 'reviewer') ?? m.seats.find((s) => s.id === seat);
  if (!m.turns.length) return <Empty icon="clock" title="Waiting for the first replies">The first round runs in parallel; replies appear here as they land.</Empty>;
  return (
    <div class="grid-wrap">
      <table class="rounds-grid">
        <thead>
          <tr>
            <th />
            {cols.map((c) => {
              const s = specOf(c);
              return <th>{s && <EngineMark engine={s.engine} size={16} />} {c === 'chair' ? 'Chair' : c} <span class="muted">{s ? shortSpec(s.spec) : ''}</span></th>;
            })}
            {stats.length > 0 && <th>ledger</th>}
          </tr>
        </thead>
        <tbody>
          {rounds.map((r) => {
            const st = stats.find((x) => x.round === r);
            const chairOnly = m.turns.filter((t) => t.round === r).every((t) => t.seat === 'chair');
            return (
              <tr>
                <th class="round-label">{chairOnly ? 'Chair' : m.protocol === 'council' ? (r === 1 ? 'Answers' : r === 2 ? 'Ranking' : `Stage ${r}`) : `R${r}`}</th>
                {cols.map((c) => (
                  <td>{m.turns.filter((t) => t.round === r && t.seat === c).map((t) => <TurnCard t={t} onOpen={() => onOpen(t.n)} />)}</td>
                ))}
                {stats.length > 0 && (
                  <td class="ledger-cell">
                    {st && (
                      <>
                        <span class="pill good" title="agreed">{st.agreed}</span>
                        <span class="pill warn" title="partial">{st.partial}</span>
                        <span class="pill bad" title="disputed">{st.disputed}</span>
                        <span class="pill" title="open (no stance yet)">{st.unaddressed}</span>
                        {st.citationsChecked > 0 && <span class={`muted small ${st.citationsFailed ? 'bad-text' : ''}`}>cites {st.citationsChecked - st.citationsFailed}/{st.citationsChecked}</span>}
                      </>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── pair ─────────────────────────────────────────────────────────────────

function CycleCard({ c, d, onOpen, running }: { c: PairCycle; d: RunDetails; onOpen: (n: number) => void; running: boolean }) {
  const writer = d.meta.seats.find((s) => s.role === 'writer');
  const reviewer = d.meta.seats.find((s) => s.role === 'participant');
  const check = c.check;
  return (
    <div class="cycle">
      <div class="cycle-num">{c.cycle}</div>
      <div class="cycle-steps">
        <button type="button" class="cycle-step" disabled={!c.writer} onClick={() => c.writer && onOpen(c.writer.n)}>
          {writer && <EngineMark engine={writer.engine} size={18} />}
          <div class="cs-body">
            <div class="cs-title">Writer <span class={`badge ${c.writer?.status === 'done' ? 'good' : c.writer?.status === 'blocked' || c.writer?.status === 'error' ? 'bad' : ''}`}>{c.writer?.status ?? (running ? '…' : 'stopped')}</span></div>
            <div class="cs-text">{c.writer ? `${c.writer.changes} file${c.writer.changes === 1 ? '' : 's'} · ${c.writer.tests.length ? c.writer.tests.map((t) => `${t.command} ${t.outcome === 'passed' ? '✓' : t.outcome === 'failed' ? '✗' : '–'}`).join(', ') : 'no checks run'}` : running ? 'working…' : 'did not finish'}</div>
          </div>
        </button>
        {check && (
          <div class={`cycle-step check ${check.timedOut || check.exitCode !== 0 ? 'bad' : 'good'}`}>
            <Icon name={check.timedOut || check.exitCode !== 0 ? 'x-circle' : 'check-circle'} size={18} />
            <div class="cs-body">
              <div class="cs-title">Check</div>
              <div class="cs-text">{check.timedOut ? 'timed out' : check.exitCode === 0 ? 'passed' : `failed (exit ${check.exitCode})`} · {dur(check.durationMs)}</div>
            </div>
          </div>
        )}
        <button type="button" class="cycle-step" disabled={!c.review} onClick={() => c.review && onOpen(c.review.n)}>
          {reviewer && <EngineMark engine={reviewer.engine} size={18} />}
          <div class="cs-body">
            <div class="cs-title">Reviewer {c.review && <span class={`verdict v-${c.review.verdict.replace('_', '-')}`}>{c.review.verdict.replace('_', ' ')}</span>}</div>
            <div class="cs-text">{c.review ? `${c.review.open} open finding${c.review.open === 1 ? '' : 's'}${c.review.blocking ? ` (${c.review.blocking} blocking)` : ''} · ${c.diff?.files ?? 0} files changed` : !running ? 'did not review' : c.writer ? 'reviewing…' : 'waiting'}</div>
          </div>
        </button>
      </div>
    </div>
  );
}

function PairTimeline({ d, onOpen, running }: { d: RunDetails; onOpen: (n: number) => void; running: boolean }) {
  const cycles = d.pair?.cycles ?? [];
  if (!cycles.length) return running ? <Empty icon="pair" title="Setting up the workspace">The writer starts as soon as its worktree is ready.</Empty> : <Empty icon="pair" title="No cycles ran" />;
  return <div class="cycles">{cycles.map((c) => <CycleCard c={c} d={d} onOpen={onOpen} running={running} />)}</div>;
}

function PairFindings({ d }: { d: RunDetails }) {
  const fs = d.pair?.findings ?? [];
  if (!fs.length) return <Empty icon="check-circle" title="No findings">The reviewer has not filed any findings.</Empty>;
  const sorted = [...fs].sort((a, b) => (a.status === b.status ? a.severity.localeCompare(b.severity) : a.status === 'open' ? -1 : 1));
  return (
    <div class="pad">
      <table class="data">
        <thead><tr><th>id</th><th>sev</th><th>status</th><th>where</th><th>finding</th><th>history</th></tr></thead>
        <tbody>
          {sorted.map((f) => (
            <tr class={f.status === 'resolved' ? 'muted-row' : ''}>
              <td class="mono nowrap">{f.id}</td>
              <td><span class={`sev ${f.severity}`}>{f.severity}</span></td>
              <td class="nowrap"><span class={`status ${f.status === 'open' ? 'warn' : 'good'}`}>{f.status}</span>{f.disputes ? <span class="muted small"> · disputed ×{f.disputes}</span> : null}</td>
              <td class="mono small">{f.location}</td>
              <td><b>{f.title}</b><div class="muted small">{f.problem}</div><div class="small"><b>Fix:</b> {f.fix}</div></td>
              <td class="small nowrap">{f.history.map((h) => <div title={h.note}>{h.cycle}: {h.event}</div>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkspaceBar({ d, running }: { d: RunDetails; running: boolean }) {
  const ws = d.meta.workspace;
  if (!ws) return null;
  if (ws.state === 'moved') {
    return <div class="ws-bar"><Icon name="forward" size={15} /> The workspace moved to the continued run. <button type="button" class="link-btn" onClick={() => ws.movedTo && go({ kind: 'run', id: ws.movedTo })}>Open it</button></div>;
  }
  if (ws.state !== 'active') return <div class="ws-bar done"><Icon name="check-circle" size={15} /> Workspace {ws.state}{ws.outcome ? `: ${ws.outcome}` : ''}</div>;
  const where = ws.mode === 'worktree' ? <>Worktree on branch <span class="mono">{ws.branch}</span></> : <>Edited in place in <span class="mono">{base(ws.cwd)}</span></>;
  return (
    <div class="ws-bar active">
      <Icon name={ws.mode === 'worktree' ? 'branch' : 'folder'} size={15} />
      <span>{where}</span>
      <div class="spacer" />
      {!running && ws.mode === 'worktree' && (
        <>
          <button type="button" class="btn small primary" onClick={() => void workspaceAction(d.meta.id, 'apply')} title="Apply the writer's changes to your folder and remove the worktree"><Icon name="merge" size={13} /> Apply to {base(ws.repo ?? d.meta.cwd)}</button>
          <button type="button" class="btn small" onClick={() => void workspaceAction(d.meta.id, 'keep')} title="Commit on the duo/ branch and remove the worktree folder"><Icon name="branch" size={13} /> Keep branch</button>
          <button type="button" class="btn small ghost danger" onClick={() => confirmAction({ title: 'Discard the writer’s work?', body: `The worktree and the branch ${ws.branch} are deleted. Your folder is not touched.`, action: 'Discard', danger: true }, () => void workspaceAction(d.meta.id, 'discard'))}>Discard</button>
        </>
      )}
      {!running && ws.mode === 'in-place' && (
        <>
          <button type="button" class="btn small primary" onClick={() => void workspaceAction(d.meta.id, 'keep')}><Icon name="check" size={13} /> Keep changes</button>
          <button type="button" class="btn small ghost danger" onClick={() => confirmAction({ title: 'Revert the folder?', body: 'Every file the writer changed goes back to how it was when the run started, and files it added are deleted.', action: 'Revert', danger: true }, () => void workspaceAction(d.meta.id, 'discard'))}>Revert changes</button>
        </>
      )}
    </div>
  );
}

function RunChanges({ d }: { d: RunDetails }) {
  const [diff, setDiff] = useState<{ diff: string; stat: string; files: { status: string; path: string }[]; state?: string } | null>(null);
  const turns = d.meta.turns.length;
  useEffect(() => void guard(api<any>(`/api/runs/${encodeURIComponent(d.meta.id)}/diff`)).then((r) => r && setDiff(r)), [d.meta.id, turns, d.meta.workspace?.state]);
  if (!diff) return <div class="center pad"><Spinner /></div>;
  if (diff.state && diff.state !== 'active') return <Empty icon="branch" title={`Workspace ${diff.state}`}>{d.meta.workspace?.outcome}</Empty>;
  return (
    <div class="pad">
      {diff.files.length > 0 && <div class="file-list">{diff.files.map((f) => <div class="file-row"><span class={`fstat s${f.status[0]}`}>{f.status[0]}</span><span class="mono">{f.path}</span></div>)}</div>}
      <DiffView diff={diff.diff} />
    </div>
  );
}

// ── ledger / findings / ranking ──────────────────────────────────────────

function Ledger({ d }: { d: RunDetails }) {
  const [filter, setFilter] = useState<'all' | 'open'>('all');
  const claims: any[] = d.ledger?.claims ?? [];
  const shown = claims.filter((c) => c.status !== 'withdrawn' && (filter === 'all' || c.status !== 'agreed'));
  const order: Record<string, number> = { disputed: 0, partial: 1, unaddressed: 2, agreed: 3 };
  shown.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  if (!claims.length) return <Empty icon="list" title="No claims yet">Claims appear after the first round.</Empty>;
  return (
    <div class="pad">
      <Segmented size="small" value={filter} onChange={setFilter} options={[{ id: 'all', label: `All (${claims.filter((c) => c.status !== 'withdrawn').length})` }, { id: 'open', label: `Not agreed (${claims.filter((c) => !['agreed', 'withdrawn'].includes(c.status)).length})` }]} />
      <table class="data">
        <thead><tr><th>claim</th><th>status</th><th>citations</th><th>stances</th><th>text</th></tr></thead>
        <tbody>
          {shown.map((c) => (
            <tr>
              <td class="mono nowrap">{c.gid}</td>
              <td><span class={`status s-${c.status}`}>{c.status}</span></td>
              <td class="nowrap">{(c.citations ?? []).map((r: any) => <span class={`cite ${r.status === 'verified' ? 'ok' : r.status === 'not_checked' ? '' : 'bad'}`} title={`${r.ref}: ${r.status}${r.detail ? ' — ' + r.detail : ''}`}>{r.status === 'verified' ? '✓' : r.status === 'not_checked' ? '·' : '✗'}</span>)}</td>
              <td class="nowrap">{Object.entries(c.stances ?? {}).map(([s, v]: [string, any]) => <span class={`stance st-${v.stance}`} title={v.reason}>{s}:{v.stance}</span>)}</td>
              <td>{c.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Findings({ d }: { d: RunDetails }) {
  const f: any[] = d.findings ?? [];
  const sev: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  if (!f.length) return <Empty icon="review" title="No findings yet" />;
  return (
    <div class="pad">
      <table class="data">
        <thead><tr><th>id</th><th>sev</th><th>status</th><th>where</th><th>finding</th></tr></thead>
        <tbody>
          {[...f].sort((a, b) => (sev[a.f.severity] ?? 9) - (sev[b.f.severity] ?? 9)).map((m) => (
            <tr>
              <td class="mono nowrap">{m.gid}</td>
              <td><span class={`sev ${m.f.severity}`}>{m.f.severity}</span></td>
              <td class="nowrap">{m.status} <span class="muted small">{m.confirms.length}✓ {m.rejects.length}✗</span></td>
              <td class="mono small">{m.f.location} {m.location && m.location.status !== 'verified' && <span class="bad-text" title={m.location.detail}>✗</span>}</td>
              <td><b>{m.f.title}</b><div class="muted small">{m.f.problem}</div><div class="small"><b>Fix:</b> {m.f.fix}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Ranking({ d }: { d: RunDetails }) {
  const rows: any[] = d.council?.table ?? [];
  if (!rows.length) return <Empty icon="council" title="Rankings appear after stage 2" />;
  return (
    <div class="pad">
      <div class="ranking">
        {rows.map((r, i) => {
          const s = d.meta.seats.find((x) => x.id === r.seat && x.role === 'participant');
          return (
            <div class="rank-row">
              <span class="rank-num">{i + 1}</span>
              {s && <EngineMark engine={s.engine} size={18} />}
              <b>{r.seat}</b>
              <span class="muted small">{s ? shortSpec(s.spec) : ''}</span>
              <span class="rank-bar"><span style={{ width: `${Number.isFinite(r.avg) ? Math.max(4, r.avg * 100) : 0}%` }} /></span>
              <span class="mono small">{Number.isFinite(r.avg) ? r.avg.toFixed(2) : '—'}</span>
              <span class="muted small">{r.votes} reviews · {r.errs} errors</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── modals ───────────────────────────────────────────────────────────────

function TurnModal({ runId, n, onClose }: { runId: string; n: number; onClose: () => void }) {
  const [t, setT] = useState<any>(null);
  const [tab, setTab] = useState<'reply' | 'prompt' | 'tools' | 'thinking'>('reply');
  useEffect(() => void guard(api(`/api/runs/${encodeURIComponent(runId)}/turns/${n}`)).then(setT), [runId, n]);
  let tools: any[] = [];
  try {
    tools = t?.tools ? JSON.parse(t.tools) : [];
  } catch {
    /* raw text */
  }
  return (
    <Modal title={t ? `Turn ${n} · ${t.meta.seat} · ${t.meta.kind} · round ${t.meta.round}` : `Turn ${n}`} onClose={onClose} wide>
      {!t ? <div class="center pad"><Spinner /></div> : (
        <>
          <Tabs active={tab} onChange={setTab} tabs={[{ id: 'reply', label: 'Reply' }, { id: 'prompt', label: 'Prompt sent' }, { id: 'tools', label: 'Tool calls', count: tools.length }, { id: 'thinking', label: 'Reasoning' }]} />
          <div class="modal-scroll" onClick={onCopyClick}>
            {tab === 'reply' && (t.reply ? <Markdown text={t.reply.trim().startsWith('{') ? '```json\n' + t.reply + '\n```' : t.reply} /> : <p class="muted">No reply.</p>)}
            {tab === 'prompt' && <pre class="io tall">{t.prompt}</pre>}
            {tab === 'tools' && (tools.length ? (
              <div class="tool-list">
                {tools.map((x: any) => (
                  <details class="step tool">
                    <summary class="step-head"><span class="step-icon"><Icon name={x.name === 'shell' ? 'terminal' : x.name === 'web_search' ? 'globe' : 'wrench'} size={14} /></span><span class="step-title mono">{x.name === 'shell' ? x.input : `${x.name} ${String(x.input).slice(0, 120)}`}</span>{x.error ? <span class="badge bad">failed</span> : null}</summary>
                    <div class="step-body">{x.output && <pre class="io out">{x.output}</pre>}</div>
                  </details>
                ))}
              </div>
            ) : <p class="muted">No tool calls.</p>)}
            {tab === 'thinking' && (t.thinking ? <pre class="io tall">{t.thinking}</pre> : <p class="muted">The model did not expose its reasoning for this turn.</p>)}
          </div>
          <div class="muted small turn-meta">
            {dur(t.meta.durationMs)} · {kfmt(t.meta.usage.input)} in ({kfmt(t.meta.usage.cached)} cached) · {kfmt(t.meta.usage.output)} out ({kfmt(t.meta.usage.reasoning)} reasoning){money(t.meta.codexCredits, t.meta.usd) ? ` · ${money(t.meta.codexCredits, t.meta.usd)}` : ''}
            {t.meta.error && <div class="bad-text">error: {t.meta.error}</div>}
            {t.meta.warnings?.map((w: string) => <div class="warn-text">warning: {w}</div>)}
          </div>
        </>
      )}
    </Modal>
  );
}

function ContinueModal({ d, onClose }: { d: RunDetails; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [rounds, setRounds] = useState(d.meta.protocol === 'pair' ? 2 : 1);
  const unit = d.meta.protocol === 'pair' ? 'Cycles' : 'Rounds';
  return (
    <Modal title="Continue this run" onClose={onClose} footer={<>
      <button type="button" class="btn" onClick={onClose}>Cancel</button>
      <button type="button" class="btn primary" onClick={() => { void continueRun(d.meta.id, note, rounds); onClose(); }}><Icon name="play" size={13} /> Continue</button>
    </>}>
      <p class="muted small">Resumes the same Codex threads and Claude sessions (their context and prompt cache carry over) and runs more {unit.toLowerCase()} as a new run{d.meta.protocol === 'pair' ? ' on the same workspace' : ''}.</p>
      <label class="field">Note to the {d.meta.protocol === 'pair' ? 'writer' : 'participants'} (optional)<textarea rows={4} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} placeholder={d.meta.protocol === 'pair' ? 'e.g. Keep the public API unchanged; add a test for the empty input case.' : 'e.g. You contradict each other on X; resolve it explicitly.'} /></label>
      <label class="field inline">{unit} <input type="number" min={1} max={12} value={rounds} onInput={(e) => setRounds(Number((e.target as HTMLInputElement).value) || 1)} /></label>
    </Modal>
  );
}

// ── run view ─────────────────────────────────────────────────────────────

function Progress({ d, running }: { d: RunDetails; running: boolean }) {
  const m = d.meta;
  if (m.protocol !== 'debate' && m.protocol !== 'pair') return null;
  const start = m.continuedFrom ? Math.min(...m.turns.map((t) => t.round).filter((r) => r > 0), Infinity) : 1;
  const max = Number(m.options.rounds ?? 3);
  const done = new Set(m.turns.filter((t) => t.seat !== 'chair').map((t) => t.round)).size;
  const pct = Math.min(100, (done / Math.max(1, max)) * 100);
  return (
    <div class="progress" title={`${m.protocol === 'pair' ? 'cycle' : 'round'} ${done} of at most ${max}`}>
      <span class="progress-label">{m.protocol === 'pair' ? 'Cycle' : 'Round'} {(Number.isFinite(start) && start > 1 ? start - 1 : 0) + Math.min(max, running ? done + (m.turns.some((t) => t.round > 0) || done === 0 ? 1 : 0) : done)}<span class="muted"> / {Number.isFinite(start) && start > 1 ? start + max - 1 : max}</span></span>
      <span class={`progress-track ${running ? 'running' : ''}`}><span style={{ width: `${pct}%` }} /></span>
    </div>
  );
}

export function RunView({ id }: { id: string }) {
  const d = runs.value[id];
  const summary = app.value?.runs.find((r) => r.id === id);
  const logs = runLogs.value[id] ?? [];
  const [tab, setTab] = useState<string>('live');
  const [openTurn, setOpenTurn] = useState<number | null>(null);
  const [cont, setCont] = useState(false);
  useEffect(() => {
    setTab('live');
    void loadRun(id);
  }, [id]);
  if (!d) return <div class="center"><Spinner /></div>;
  const m = d.meta;
  const running = d.running || summary?.status === 'running';
  const p = PROTOCOLS[m.protocol];
  const tone = outcomeTone(running ? 'running' : m.status, m.outcome);
  const stop = String(m.outcome?.stop ?? '');
  const tabs = [
    { id: 'live', label: m.protocol === 'pair' ? 'Cycles' : 'Rounds' },
    ...(m.protocol === 'pair' ? [{ id: 'changes', label: 'Changes' }, { id: 'pfindings', label: 'Findings', count: d.pair?.findings.filter((f) => f.status === 'open').length }] : []),
    ...(m.protocol === 'debate' ? [{ id: 'ledger', label: 'Claim ledger' }] : []),
    ...(m.protocol === 'review' ? [{ id: 'findings', label: 'Findings', count: d.findings?.length }] : []),
    ...(m.protocol === 'council' ? [{ id: 'ranking', label: 'Ranking' }] : []),
    { id: 'report', label: 'Report' },
    { id: 'brief', label: 'Brief' },
    { id: 'transcript', label: 'Transcript' },
    { id: 'log', label: 'Activity', count: running ? undefined : undefined },
  ];
  const t = m.totals;
  const canContinue = !running && (m.protocol === 'debate' || m.protocol === 'ask' || (m.protocol === 'pair' && m.workspace?.state === 'active'));
  return (
    <div class="runview">
      <header class="run-head">
        <div class="run-title-row">
          <span class={`proto proto-${m.protocol}`}><Icon name={p.icon} size={15} /> {p.label}</span>
          <h1 title={m.title}>{m.title}</h1>
          <StatusChip status={running ? 'running' : m.status} outcome={m.outcome} />
          <div class="spacer" />
          {running && <button type="button" class="btn small stop" onClick={() => cancelRun(m.id)}><Icon name="stop" size={11} /> Stop</button>}
          {canContinue && <button type="button" class="btn small" onClick={() => setCont(true)}><Icon name="play" size={12} /> Continue</button>}
          <Dropdown align="right" trigger={(_o, toggle) => <button type="button" class="icon-btn" onClick={toggle} title="More"><Icon name="dots" /></button>}>
            {(close) => (
              <>
                <MenuItem icon="external" onClick={() => { close(); window.open(exportUrl(m.id, 'html'), '_blank'); }}>Export as HTML</MenuItem>
                <MenuItem icon="download" onClick={() => { close(); window.open(exportUrl(m.id, 'md'), '_blank'); }}>Export as Markdown</MenuItem>
                <MenuItem icon="copy" onClick={() => { close(); void navigator.clipboard.writeText(d.report ?? '').then(() => toast('Report copied', 'success')); }} disabled={!d.report}>Copy the report</MenuItem>
                <MenuItem icon="folder" onClick={() => { close(); if (desktop) void desktop.openPath(d.dir); else void guard(api('/api/open', { method: 'POST', body: { path: d.dir } })); }}>Show run files</MenuItem>
                {m.continuedFrom && <MenuItem icon="left" onClick={() => { close(); go({ kind: 'run', id: m.continuedFrom! }); }}>Open the run it continues</MenuItem>}
                <MenuSeparator />
                <MenuItem icon="trash" danger disabled={running} onClick={() => { close(); confirmAction({ title: 'Delete this run?', body: 'Its folder with the full trace (prompts, replies, tool calls, raw streams) is deleted.', action: 'Delete', danger: true }, () => void deleteRun(m.id)); }}>Delete run</MenuItem>
              </>
            )}
          </Dropdown>
        </div>
        <div class="run-meta-row">
          <SeatChips d={d} />
          <span class="meta-item" title={m.cwd}><Icon name={m.options.workspace === false ? 'folder-off' : 'folder'} size={13} /> {m.options.workspace === false ? 'no folder' : base(m.cwd)}</span>
          {running ? <span class="meta-item"><Icon name="clock" size={13} /> <Elapsed since={new Date(m.createdAt).getTime()} /></span> : t && <span class="meta-item"><Icon name="clock" size={13} /> {dur(t.durationMs)}</span>}
          {t && (t.codexCredits > 0 || t.usd > 0) && <span class="meta-item" title="Codex plan credits and Claude API-equivalent cost">{t.codexCredits > 0 ? `${t.codexCredits} cr` : ''}{t.codexCredits > 0 && t.usd > 0 ? ' · ' : ''}{t.usd > 0 ? `~$${t.usd}` : ''}</span>}
          <Progress d={d} running={running} />
        </div>
        {stop && !running && (
          <div class={`outcome ${tone.tone}`}>
            <Icon name={tone.tone === 'good' ? 'check-circle' : tone.tone === 'bad' ? 'x-circle' : 'info'} size={16} />
            <span>{stop}</span>
            {/claude update|or newer is required/i.test(stop) && <button type="button" class="btn small" onClick={() => void updateClaude()}><Icon name="download" size={12} /> Update Claude Code</button>}
            {canContinue && /NOT converged|stalled|deadlocked|stopped|cancelled|failed/.test(stop) && <button type="button" class="btn small" onClick={() => setCont(true)}><Icon name="play" size={12} /> Continue</button>}
          </div>
        )}
        {m.protocol === 'pair' && <WorkspaceBar d={d} running={running} />}
      </header>
      <Tabs active={tab} onChange={setTab} tabs={tabs} />
      <div class="run-body" onClick={onCopyClick}>
        {tab === 'live' && (
          <>
            <LiveActivity d={d} />
            {m.protocol === 'pair' ? <PairTimeline d={d} onOpen={setOpenTurn} running={running} /> : <RoundsGrid d={d} onOpen={setOpenTurn} />}
          </>
        )}
        {tab === 'changes' && <RunChanges d={d} />}
        {tab === 'pfindings' && <PairFindings d={d} />}
        {tab === 'ledger' && <Ledger d={d} />}
        {tab === 'findings' && <Findings d={d} />}
        {tab === 'ranking' && <Ranking d={d} />}
        {tab === 'report' && (d.report ? <div class="pad prose"><Markdown text={d.report} /></div> : <Empty icon="file" title={running ? 'The report appears when the run finishes' : 'No report'} />)}
        {tab === 'brief' && <div class="pad prose"><Markdown text={m.prompt} /></div>}
        {tab === 'transcript' && <div class="pad prose"><Markdown text={d.transcript ?? ''} /></div>}
        {tab === 'log' && (logs.length ? <pre class="io log tall">{logs.join('\n')}</pre> : <Empty icon="list" title="No activity in this session">Activity is shown for runs started since the app opened; the full record is in the Transcript and the run files.</Empty>)}
      </div>
      {openTurn !== null && <TurnModal runId={m.id} n={openTurn} onClose={() => setOpenTurn(null)} />}
      {cont && <ContinueModal d={d} onClose={() => setCont(false)} />}
    </div>
  );
}

// ── new run ──────────────────────────────────────────────────────────────

const BRIEF_HINTS: Record<Protocol, string> = {
  pair: 'What should be built or fixed? Say what "done" means: the behaviour, the files involved, how to test it.',
  debate: 'The question, the context that matters, constraints, and what a good answer contains. Point at files by path; the seats read them.',
  review: 'Focus (optional): e.g. concurrency and error paths.',
  council: 'The question for the council. Each seat answers independently; then they rank each other anonymously.',
  ask: 'The question. Every seat answers in parallel.',
};

function quotaWarnings(seats: string[]): string[] {
  const s = app.value;
  if (!s) return [];
  const out: string[] = [];
  for (const engine of ['claude', 'codex'] as const) {
    if (!seats.some((x) => parseSpec(x).engine === engine)) continue;
    for (const w of s.quota[engine]?.windows ?? []) {
      if (w.resetsAt * 1000 < Date.now()) continue;
      if (w.usedPercent >= s.warnPercent) out.push(`${engine === 'claude' ? 'Claude' : 'Codex'} ${w.label === 'weekly' ? 'weekly' : w.label} usage is at ${w.usedPercent.toFixed(0)}% (resets ${untilText(w.resetsAt)}). The run may stop when the limit is hit.`);
    }
  }
  return out;
}

export function NewRun({ draft }: { draft?: Partial<StartRun> }) {
  const s = app.value!;
  const preset = s.presets[s.defaults.preset];
  const [protocol, setProtocol] = useState<Protocol>(draft?.protocol ?? 'pair');
  const remembered = prefs.value.lastSeats?.[protocol];
  const initialSeats = (p: Protocol) => draft?.seats ?? prefs.value.lastSeats?.[p]?.seats ?? (p === 'pair' ? [s.gui.codex.spec, s.gui.claude.spec] : preset?.seats ?? [s.gui.codex.spec, s.gui.claude.spec]);
  const [seats, setSeats] = useState<string[]>(initialSeats(protocol));
  const [chair, setChair] = useState<string | undefined>(draft?.chair ?? remembered?.chair ?? preset?.chair);
  const [rounds, setRounds] = useState<number>(draft?.rounds ?? (protocol === 'pair' ? 4 : preset?.rounds ?? 3));
  const [minRounds, setMinRounds] = useState(1);
  const [anon, setAnon] = useState(false);
  const [brief, setBrief] = useState(draft?.brief ?? '');
  const [kind, setKind] = useState<'uncommitted' | 'base' | 'commit' | 'plan'>('uncommitted');
  const [value, setValue] = useState('');
  const [isolation, setIsolation] = useState<'worktree' | 'in-place'>('worktree');
  const [writerAccess, setWriterAccess] = useState<'sandboxed' | 'sandboxed-network' | 'full'>('sandboxed');
  const [check, setCheck] = useState('');
  const [ws, setWs] = useState<{ git: boolean; head: boolean; dirty: boolean } | null>(null);
  const cwd = draft?.cwd ?? project.value;
  const noProject = !cwd;
  const mode = PROTOCOLS[protocol];
  const needsProject = protocol === 'pair' || protocol === 'review';
  useEffect(() => {
    if (!cwd) return setWs(null);
    void api<{ git: boolean; head: boolean; dirty: boolean }>(`/api/fs/workspace?cwd=${encodeURIComponent(cwd)}`).then((r) => {
      setWs(r);
      // A repository with history gets an isolated worktree by default; anything else works in place.
      setIsolation(r.head ? 'worktree' : 'in-place');
    }).catch(() => setWs(null));
  }, [cwd]);
  const switchProtocol = (k: Protocol) => {
    setProtocol(k);
    setSeats((cur) => (k === 'pair' ? (draft?.seats ?? prefs.value.lastSeats?.pair?.seats ?? [cur[0] ?? s.gui.codex.spec, cur[1] ?? s.gui.claude.spec]).slice(0, 2) : prefs.value.lastSeats?.[k]?.seats ?? cur));
    if (k === 'pair') setRounds(4);
    else if (k === 'debate') setRounds(preset?.rounds ?? 3);
  };
  const applyPreset = (name: string) => {
    const pr = s.presets[name];
    if (!pr) return;
    setSeats(protocol === 'pair' ? pr.seats.slice(0, 2) : pr.seats);
    setChair(pr.chair);
    if (pr.rounds && protocol === 'debate') setRounds(pr.rounds);
  };
  const submit = () => {
    if (needsProject && noProject) return toast(`${mode.label} works on a project folder; pick one at the top`);
    if (protocol !== 'review' && !brief.trim()) return toast(protocol === 'pair' ? 'Describe the task first' : 'Write the question or brief first');
    if (protocol === 'review' && kind !== 'uncommitted' && !value.trim()) return toast('Fill in the branch, commit or plan file');
    if (protocol === 'pair' && isolation === 'worktree' && ws && !ws.head) return toast('A worktree needs a git repository with at least one commit; choose “In place”');
    void startRun({
      protocol,
      seats,
      chair: protocol === 'pair' ? undefined : chair,
      rounds: protocol === 'debate' || protocol === 'pair' ? rounds : protocol === 'review' ? Math.min(rounds, 2) : 1,
      minRounds: protocol === 'debate' ? minRounds : undefined,
      anon,
      cwd,
      noProject,
      brief: protocol === 'review' ? brief || `Review ${kind}` : brief,
      review: protocol === 'review' ? { kind, value: value || undefined, focus: brief || undefined } : undefined,
      pair: protocol === 'pair' ? { isolation, writerAccess, check: check.trim() || undefined } : undefined,
    });
  };
  const min = protocol === 'review' || protocol === 'ask' ? 1 : 2;
  const warnings = quotaWarnings(seats);
  return (
    <div class="newrun" onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}>
      <div class="newrun-main">
        <h1>New run</h1>
        <div class="proto-cards">
          {(Object.keys(PROTOCOLS) as Protocol[]).map((k) => (
            <button type="button" class={`proto-card ${protocol === k ? 'on' : ''}`} onClick={() => switchProtocol(k)} aria-pressed={protocol === k}>
              <span class="proto-icon"><Icon name={PROTOCOLS[k].icon} size={18} /></span>
              <b>{PROTOCOLS[k].label}</b>
            </button>
          ))}
        </div>

        <section class="form-section">
          <div class="section-head">
            <h3>{protocol === 'pair' ? 'Writer and reviewer' : 'Seats'}</h3>
            <select class="preset-select" value="" onChange={(e) => applyPreset((e.target as HTMLSelectElement).value)}>
              <option value="">Load preset…</option>
              {Object.entries(s.presets).map(([k, pr]) => <option value={k}>{k} — {pr.seats.map(shortSpec).join(' vs ')}</option>)}
            </select>
          </div>
          {protocol === 'pair' ? (
            <div class="pair-seats">
              <div class="seat-row">
                <span class="seat-role">Writer</span>
                <SeatPicker spec={seats[0]} onChange={(v) => setSeats([v, seats[1]])} />
                <span class="muted small">implements the task and fixes findings</span>
              </div>
              <button type="button" class="icon-btn swap" title="Swap writer and reviewer" onClick={() => setSeats([seats[1], seats[0]])}><Icon name="refresh" size={14} /></button>
              <div class="seat-row">
                <span class="seat-role">Reviewer</span>
                <SeatPicker spec={seats[1]} seat onChange={(v) => setSeats([seats[0], v])} />
                <span class="muted small">verifies the diff and files findings (read-only)</span>
              </div>
            </div>
          ) : (
            <>
              {seats.map((spec, i) => (
                <div class="seat-row">
                  <span class="seat-id">{String.fromCharCode(65 + i)}</span>
                  <SeatPicker spec={spec} seat onChange={(v) => setSeats(seats.map((x, j) => (j === i ? v : x)))} />
                  <span class="mono muted small seat-spec">{spec}</span>
                  <button type="button" class="icon-btn" disabled={seats.length <= min} title="Remove seat" onClick={() => setSeats(seats.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></button>
                </div>
              ))}
              <div class="row">
                <button type="button" class="btn small" onClick={() => setSeats([...seats, s.gui.claude.spec])}><EngineMark engine="claude" size={14} /> Add Claude</button>
                <button type="button" class="btn small" onClick={() => setSeats([...seats, s.gui.codex.spec])}><EngineMark engine="codex" size={14} /> Add Codex</button>
              </div>
              <div class="seat-row chair-row">
                <Toggle checked={!!chair} onChange={(v) => setChair(v ? chair ?? s.gui.claude.spec : undefined)} label="A chair writes the final synthesis" />
                {chair && <SeatPicker spec={chair} seat onChange={setChair} />}
              </div>
            </>
          )}
        </section>

        <section class="form-section">
          <h3>{protocol === 'review' ? 'What to review' : protocol === 'pair' ? 'Task' : 'Brief'}</h3>
          {protocol === 'review' && (
            <div class="row wrap">
              <Segmented size="small" value={kind} onChange={setKind} options={[{ id: 'uncommitted', label: 'Uncommitted changes' }, { id: 'base', label: 'Branch vs base' }, { id: 'commit', label: 'One commit' }, { id: 'plan', label: 'Plan / design file' }]} />
              {kind !== 'uncommitted' && <input class="mono" placeholder={{ base: 'main', commit: 'commit SHA', plan: 'path/to/plan.md' }[kind]} value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} />}
            </div>
          )}
          <textarea class="brief" rows={protocol === 'review' ? 3 : 7} value={brief} onInput={(e) => setBrief((e.target as HTMLTextAreaElement).value)} placeholder={BRIEF_HINTS[protocol]} />
          <div class="muted small row">
            <Icon name={noProject ? 'folder-off' : 'folder'} size={13} />
            {noProject ? (needsProject ? <span class="bad-text">{mode.label} needs a project folder: choose one at the top.</span> : 'No project folder: the seats get an empty scratch folder and answer from what they know.') : <span class="mono ellipsis" title={cwd}>{cwd.replace(app.value?.home ?? '\u0000', '~')}</span>}
          </div>
        </section>

        {protocol === 'pair' && (
          <section class="form-section">
            <h3>Workspace and permissions</h3>
            <div class="field-grid">
              <label class="field">Where the writer works
                <Segmented size="small" value={isolation} onChange={setIsolation} options={[{ id: 'worktree', label: 'Worktree on a new branch', title: 'Your folder stays untouched until you apply the result' }, { id: 'in-place', label: 'In place', title: 'The writer edits your folder directly; duo snapshots it first' }]} />
                <span class="muted small">
                  {isolation === 'worktree'
                    ? ws && !ws.head ? <span class="bad-text">This folder is not a git repository with commits; use In place.</span> : <>Your folder is untouched until you click Apply.{ws?.dirty ? ' Uncommitted changes are not in the worktree (it starts from HEAD).' : ''}</>
                    : 'The writer edits your files directly. duo snapshots the folder first, so the diff is exact and Revert can undo it.'}
                </span>
              </label>
              <label class="field">Writer permissions
                <Segmented size="small" value={writerAccess} onChange={setWriterAccess} options={[{ id: 'sandboxed', label: 'Sandboxed' }, { id: 'sandboxed-network', label: 'Sandboxed + network' }, { id: 'full', label: 'Full access' }]} />
                <span class="muted small">{writerAccess === 'full' ? 'No sandbox: the writer can run anything your user can. Prefer a worktree.' : writerAccess === 'sandboxed-network' ? 'Codex may reach the network inside its sandbox (package installs). Claude runs commands in its sandbox where available.' : 'Edits the workspace; commands run sandboxed without network.'}</span>
              </label>
              <label class="field">Check command <span class="muted small">(optional)</span>
                <input class="mono" placeholder="npm test" value={check} onInput={(e) => setCheck((e.target as HTMLInputElement).value)} />
                <span class="muted small">duo runs it after every writer turn; the run only finishes when it passes. It runs with your permissions.</span>
              </label>
              <label class="field">Cycles at most
                <input type="number" min={1} max={12} value={rounds} onInput={(e) => setRounds(Number((e.target as HTMLInputElement).value) || 1)} />
              </label>
            </div>
          </section>
        )}

        {protocol !== 'pair' && (
          <section class="form-section row wrap">
            {protocol === 'debate' && <label class="field inline">Max rounds <input type="number" min={1} max={12} value={rounds} onInput={(e) => setRounds(Number((e.target as HTMLInputElement).value) || 1)} /></label>}
            {protocol === 'debate' && <label class="field inline">Min rounds <input type="number" min={1} max={12} value={minRounds} onInput={(e) => setMinRounds(Number((e.target as HTMLInputElement).value) || 1)} /></label>}
            {protocol === 'review' && <Toggle checked={rounds >= 2} onChange={(v) => setRounds(v ? 2 : 1)} label="Cross-validate findings" />}
            <Toggle checked={anon} onChange={setAnon} label="Hide model identities from peers" />
          </section>
        )}

        {warnings.map((w) => <div class="callout warn"><Icon name="alert" size={15} /><span>{w}</span></div>)}

        <div class="form-actions">
          <span class="muted small">{seats.map((x) => parseSpec(x).model || parseSpec(x).engine).join(protocol === 'pair' ? ' writes · ' : ' vs ')}{protocol === 'pair' ? ' reviews' : ''}</span>
          <div class="spacer" />
          <span class="muted small"><Kbd>{MOD}</Kbd>+<Kbd>Enter</Kbd></span>
          <button type="button" class="btn primary big" onClick={submit}><Icon name="play" size={14} /> Start {mode.label.toLowerCase()}</button>
        </div>
      </div>
      <aside class="newrun-side">
        <div class="side-card">
          <div class="side-card-head"><Icon name={mode.icon} size={16} /> How {mode.label.toLowerCase()} works</div>
          <ModeDemo mode={mode.mode} size="large" caption />
          <p class="muted small">{mode.help}</p>
        </div>
      </aside>
    </div>
  );
}

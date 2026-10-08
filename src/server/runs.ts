/** duo protocol runs (debate, review, council, ask, pair) started from the GUI, with live progress. */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { SCRATCH_DIR } from '../paths.ts';
import { ask } from '../protocols/ask.ts';
import { RunContext, type RunOptions } from '../protocols/common.ts';
import { continueRun } from '../protocols/continue.ts';
import { council } from '../protocols/council.ts';
import { debate } from '../protocols/debate.ts';
import { pair, pairSettingsOf, type PairSettings } from '../protocols/pair.ts';
import { review, type ReviewTarget } from '../protocols/review.ts';
import { getTemplate } from '../templates/catalog.ts';
import { generateTemplate, type GenerateRequest } from '../templates/generate.ts';
import { runTemplate } from '../templates/run.ts';
import { validateTemplate } from '../templates/validate.ts';
import type { CoordinationTemplate } from '../templates/types.ts';
import { exportHtml } from '../render.ts';
import { parseSeat, seatIds, type Seat } from '../seats.ts';
import { deleteRun, listRuns, markInterrupted, RunStore, type RunMeta } from '../store.ts';
import { finishWorkspace, workspaceDiff, workspaceOptions } from '../worktree.ts';
import type { Bus } from './bus.ts';

export type Protocol = 'debate' | 'review' | 'council' | 'ask' | 'pair' | 'custom';

export interface StartRun {
  protocol: Protocol;
  template?: CoordinationTemplate | string;
  seats: string[];
  chair?: string;
  rounds?: number;
  minRounds?: number;
  anon?: boolean;
  /** Empty or absent with noProject: the seats get an empty scratch folder. */
  cwd: string;
  noProject?: boolean;
  brief?: string;
  title?: string;
  review?: ReviewTarget & { focus?: string; };
  pair?: Partial<PairSettings>;
}

function summary(m: RunMeta, running: boolean) {
  return {
    id: m.id,
    protocol: m.protocol,
    title: m.title,
    cwd: m.cwd,
    status: running ? 'running' : m.status,
    createdAt: m.createdAt,
    finishedAt: m.finishedAt,
    seats: [...new Map(m.seats.filter((s) => s.customRole || (s.role !== 'chair' && s.role !== 'reviewer')).map((s) => [s.id, s.spec])).values()],
    outcome: m.outcome,
    totals: m.totals,
    continuedFrom: m.continuedFrom,
    workspace: m.workspace ? { mode: m.workspace.mode, state: m.workspace.state, branch: m.workspace.branch } : undefined,
  };
}

const PROTOCOLS: Protocol[] = ['debate', 'review', 'council', 'ask', 'pair', 'custom'];

export class RunManager {
  private readonly active = new Map<string, RunContext>();
  private readonly seen = new Set<string>();
  private readonly bus: Bus;
  private readonly cfg: Config;

  constructor(bus: Bus, cfg: Config) {
    this.bus = bus;
    this.cfg = cfg;
    // Runs this app was running when it was killed still say "running" on disk.
    markInterrupted((id) => this.active.has(id));
  }

  private sink: RunOptions['sink'] = (e) => {
    if (!this.seen.has(e.run)) {
      this.seen.add(e.run);
      try {
        this.bus.emit({ t: 'run_started', run: summary(RunStore.open(e.run).meta, true) });
      } catch {
        /* run.json not written yet */
      }
    }
    if (e.kind === 'done') this.active.delete(e.run);
    this.bus.emit({ t: 'run_event', ...e });
  };

  list() {
    return listRuns(300).map((m) => summary(m, this.active.has(m.id)));
  }

  get(id: string) {
    const store = RunStore.open(id);
    const read = (f: string) => store.readFile(f);
    const json = (f: string) => {
      const t = read(f);
      try {
        return t ? JSON.parse(t) : undefined;
      } catch {
        return undefined;
      }
    };
    return {
      meta: store.meta,
      running: this.active.has(store.meta.id),
      report: read('report.md'),
      transcript: read('transcript.md'),
      ledger: json('ledger.json'),
      findings: json('findings.json'),
      council: json('council.json'),
      pair: json('pair.json'),
      coordination: json('coordination.json'),
      template: json('template.json'),
      draftTemplate: json('draft-template.json'),
      dir: store.dir,
    };
  }

  turn(id: string, n: number) {
    const store = RunStore.open(id);
    const t = store.meta.turns.find((x) => x.n === n);
    if (!t) throw new Error(`run ${id} has no turn ${n}`);
    const read = (f: string) => {
      const p = join(store.dir, t.dir, f);
      return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
    };
    return { meta: t, prompt: read('prompt.md'), reply: read('reply.md'), thinking: read('thinking.md'), tools: read('tools.json') };
  }

  private track(ctx: RunContext, work: () => Promise<unknown>): void {
    const id = ctx.store.meta.id;
    this.active.set(id, ctx);
    this.sink!({ kind: 'log', text: 'started', run: id });
    void (async () => {
      try {
        await work();
      } catch (e) {
        this.bus.emit({ t: 'run_event', run: id, kind: 'error', text: (e as Error).message });
      } finally {
        this.active.delete(id);
        this.bus.emit({ t: 'run_finished', run: summary(RunStore.open(id).meta, false) });
      }
    })();
  }

  start(req: StartRun): { id: string; } {
    if (!PROTOCOLS.includes(req.protocol)) throw new Error(`unknown protocol ${req.protocol}`);
    const template = req.protocol === 'custom' ? (typeof req.template === 'string' ? getTemplate(req.template) : validateTemplate(req.template)) : undefined;
    const mode = template?.library ?? req.protocol;
    if (!Array.isArray(req.seats) || req.seats.length > 32) throw new Error('choose up to 32 model seats');
    const workspace = !req.noProject;
    if (!workspace && (mode === 'review' || mode === 'pair' || Object.values(template?.roles ?? {}).some((r) => r.access && r.access !== 'read'))) throw new Error(`${req.protocol} works on a project folder`);
    let cwd: string;
    if (workspace) {
      cwd = resolve(req.cwd);
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`folder does not exist or is not a directory: ${cwd}`);
    } else {
      cwd = join(SCRATCH_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
      mkdirSync(cwd, { recursive: true });
    }
    const ids = seatIds(req.seats.length);
    const seats: Seat[] = req.seats.map((s, i) => parseSeat(s, ids[i], this.cfg.defaults));
    const min = mode === 'review' || mode === 'ask' || mode === 'custom' ? template?.limits.minSeats ?? 1 : 2;
    if (seats.length < min) throw new Error(`${req.protocol} needs at least ${min} seat(s)`);
    if (mode === 'pair' && seats.length !== 2) throw new Error('pair takes exactly two seats: the writer and the reviewer');
    const chair = req.chair && mode !== 'pair' ? parseSeat(req.chair, 'Z', this.cfg.defaults) : undefined;
    const brief = (req.brief ?? '').trim() || (mode === 'review' ? `Review ${req.review?.kind ?? 'uncommitted'}` : '');
    if (!brief) throw new Error(mode === 'pair' ? 'describe the task first' : 'the brief is empty');
    let pairSettings: PairSettings | undefined;
    if (mode === 'pair') {
      pairSettings = pairSettingsOf({ pair: req.pair ?? {} });
      if (pairSettings.isolation === 'worktree' && !workspaceOptions(cwd).head) throw new Error(`${cwd} is not a git repository with at least one commit; choose "In place" or commit first`);
    }
    for (const [name, value] of [['rounds', req.rounds], ['minRounds', req.minRounds]] as const) if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 1000)) throw new Error(`${name} must be 1–1000`);
    if (mode === 'debate' && (req.minRounds ?? 1) > (req.rounds ?? 3)) throw new Error('Minimum rounds cannot exceed the maximum');
    const opts: RunOptions = {
      protocol: template?.library ?? req.protocol,
      title: (req.title || brief.split('\n').find((l) => l.trim()) || req.protocol).replace(/^#+\s*/, '').slice(0, 80),
      brief,
      cwd,
      seats,
      chair,
      rounds: req.rounds ?? (mode === 'debate' ? 3 : mode === 'review' ? 2 : mode === 'pair' ? 4 : 1),
      minRounds: req.minRounds ?? 1,
      anon: !!req.anon,
      quiet: true,
      extra: { gui: true, ...(template ? { template } : {}), ...(req.review ? { target: req.review, focus: req.review.focus } : {}), ...(pairSettings ? { pair: pairSettings } : {}) },
      workspace,
      sink: this.sink,
    };
    const ctx = RunContext.create(this.cfg, opts);
    this.track(ctx, () => {
      if (template) return runTemplate(ctx, template);
      if (req.protocol === 'debate') return debate(ctx);
      if (req.protocol === 'council') return council(ctx);
      if (req.protocol === 'ask') return ask(ctx);
      if (mode === 'pair') return pair(ctx, pairSettings!);
      return review(ctx, req.review ?? { kind: 'uncommitted' }, req.review?.focus || undefined);
    });
    return { id: ctx.store.meta.id };
  }

  async generate(req: GenerateRequest) {
    let id: string | undefined;
    try {
      return await generateTemplate(this.cfg, {
        ...req, safe: false, sink: this.sink, onContext: (ctx) => {
          id = ctx.store.meta.id; this.active.set(id, ctx); this.sink!({ kind: 'log', text: 'authoring template draft', run: id });
        }
      });
    } finally {
      if (id) { this.active.delete(id); this.bus.emit({ t: 'run_finished', run: summary(RunStore.open(id).meta, false) }); }
    }
  }

  /** Continue a finished run; resolves with the new run's id as soon as it exists. */
  continue(id: string, note: string, rounds: number, chair?: string): Promise<{ id: string; }> {
    const chairSeat = chair ? parseSeat(chair, 'Z', this.cfg.defaults) : undefined;
    return new Promise((resolveId, reject) => {
      let nid: string | undefined;
      continueRun(this.cfg, id, note, {
        rounds,
        quiet: true,
        chair: chairSeat,
        safe: false,
        sink: this.sink,
        onContext: (ctx) => {
          nid = ctx.store.meta.id;
          this.active.set(nid, ctx);
          this.sink!({ kind: 'log', text: 'started', run: nid });
          resolveId({ id: nid });
        },
      })
        .catch((e: Error) => {
          if (!nid) reject(e);
          else this.bus.emit({ t: 'run_event', run: nid, kind: 'error', text: e.message });
        })
        .finally(() => {
          if (!nid) return;
          this.active.delete(nid);
          try {
            this.bus.emit({ t: 'run_finished', run: summary(RunStore.open(nid).meta, false) });
          } catch {
            /* deleted meanwhile */
          }
        });
    });
  }

  cancel(id: string): boolean {
    const ctx = this.active.get(id);
    if (!ctx) return false;
    ctx.cancel();
    return true;
  }

  remove(id: string): void {
    const store = RunStore.open(id);
    if (this.active.has(store.meta.id)) throw new Error('stop the run before deleting it');
    const ws = store.meta.workspace;
    if (ws?.state === 'active' && ws.mode === 'worktree') throw new Error('this run still has a worktree: apply, keep or discard it first');
    deleteRun(store.dir);
    this.bus.emit({ t: 'run_removed', id: store.meta.id });
  }

  workspace(id: string, action: 'apply' | 'keep' | 'discard') {
    const store = RunStore.open(id);
    if (this.active.has(store.meta.id)) throw new Error('the run is still working in this workspace');
    const ws = store.meta.workspace;
    if (!ws) throw new Error('this run has no workspace');
    const r = finishWorkspace(ws, action, store.meta.title);
    if (r.state) {
      store.meta.workspace = { ...ws, state: r.state, outcome: r.message };
      store.save();
      this.bus.emit({ t: 'run_finished', run: summary(store.meta, false) });
    }
    if (!r.ok) throw new Error(r.message);
    return { message: r.message };
  }

  /** The pair workspace's current diff (for the Changes tab of a pair run). */
  diff(id: string) {
    const store = RunStore.open(id);
    const ws = store.meta.workspace;
    if (!ws || ws.state !== 'active') return { files: [], stat: '', diff: '', truncated: false, state: ws?.state };
    return { ...workspaceDiff(ws, 400_000), state: ws.state };
  }

  html(id: string): string {
    const store = RunStore.open(id);
    const read = (dir: string, f: string) => (existsSync(join(store.dir, dir, f)) ? readFileSync(join(store.dir, dir, f), 'utf8') : undefined);
    return exportHtml(store.meta, store.readFile('report.md') ?? '', store.meta.turns.map((t) => ({ t, prompt: read(t.dir, 'prompt.md') ?? '', reply: read(t.dir, 'reply.md') ?? '', thinking: read(t.dir, 'thinking.md'), tools: read(t.dir, 'tools.json') })));
  }

  markdown(id: string): string {
    const store = RunStore.open(id);
    return `${store.readFile('report.md') ?? ''}\n\n---\n\n${store.readFile('transcript.md') ?? ''}`;
  }

  async close(): Promise<void> {
    for (const ctx of this.active.values()) ctx.cancel();
    await new Promise((r) => setTimeout(r, 300));
  }
}

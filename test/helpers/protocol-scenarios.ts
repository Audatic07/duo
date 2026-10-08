/** Deterministic scripted conversations used to freeze the legacy protocols' observable behavior. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunContext } from '../../src/protocols/common.ts';
import { parseSeat } from '../../src/seats.ts';
import { loadConfig } from '../../src/config.ts';
import { finishWorkspace } from '../../src/worktree.ts';
import type { TurnRecord } from '../../src/store.ts';

export const SCENARIOS = ['ask-one', 'ask-chair', 'debate-converged', 'debate-stalled', 'debate-crossover', 'debate-unusable', 'review-solo', 'review-cross-chair', 'council-chair', 'pair-approved', 'pair-blocked', 'pair-deadlocked', 'pair-check-failed'] as const;
export type Scenario = (typeof SCENARIOS)[number];
type Protocols = { ask: Function; review: Function; council: Function; debate: Function; pair: Function; };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** Normalize strings before JSON encoding, which escapes Windows path separators. */
export function normalizeSnapshot(value: unknown, roots: string[], nodePath = process.execPath): unknown {
  const compact = (v: any): any => {
    if (Array.isArray(v)) return v.map(compact);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => k === 'schema' ? ['schemaHash', createHash('sha256').update(JSON.stringify(x)).digest('hex')] : [k, compact(x)]));
    if (typeof v !== 'string') return v;
    let text = v;
    for (const root of roots) text = text.split(root).join('$ROOT');
    return text.split(nodePath).join('$NODE').replace(/\$ROOT(?:[\\/][\w.-]+)+/g, (path) => path.replaceAll('\\', '/'));
  };
  return JSON.parse(JSON.stringify(compact(value)).replace(/\b[a-f0-9]{40}\b/g, '$COMMIT').replace(/from `[a-f0-9]{7,10}`/g, 'from `$COMMIT`').replace(/duo\/([\w-]+)-[a-z0-9]{5}(?=`)/g, 'duo/$1-$SALT').replace(/"durationMs":\d+/g, '"durationMs":0'));
}
function instance(schema: any): any {
  const type = Array.isArray(schema.type) ? schema.type.find((x: string) => x !== 'null') : schema.type;
  if (schema.enum) return schema.enum[0];
  if (type === 'object') return Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, instance(v)]));
  if (type === 'array') return [];
  if (type === 'boolean') return true;
  if (type === 'number' || type === 'integer') return 0.5;
  return 'scripted';
}
export async function runScenario(scenario: Scenario, root: string, protocols: Protocols): Promise<unknown> {
  const mode = scenario.split('-')[0] as keyof Protocols;
  const cwd = join(root, 'project'); mkdirSync(cwd, { recursive: true });
  if (!existsSync(join(cwd, '.git'))) {
    execFileSync('git', ['init', '-q', cwd]);
    execFileSync('git', ['-C', cwd, 'config', 'core.autocrlf', 'false']);
    writeFileSync(join(cwd, 'README.md'), 'first line\nsecond line\n');
    execFileSync('git', ['-C', cwd, 'add', '.']);
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  }
  execFileSync('git', ['-C', cwd, 'reset', '--hard', '-q', 'HEAD']);
  execFileSync('git', ['-C', cwd, 'clean', '-fdq']);
  if (mode === 'review') writeFileSync(join(cwd, 'README.md'), 'first line\nchanged line\n');
  const cfg = loadConfig();
  const n = scenario === 'ask-one' || scenario === 'review-solo' ? 1 : mode === 'council' ? 3 : 2;
  const seats = Array.from({ length: n }, (_, i) => parseSeat(i % 2 ? 'claude:sonnet@low' : 'codex:gpt-6-sol@high', String.fromCharCode(65 + i), cfg.defaults));
  const chair = scenario.endsWith('chair') ? parseSeat('codex:gpt-6-sol@high', 'Z', cfg.defaults) : undefined;
  const opens: unknown[] = [];
  const prompts: unknown[] = [];
  const files: Record<string, string> = {};
  const sessions: any[] = [];
  let counter = 0;
  const debatePositions: Record<string, any> = {};
  const meta: any = { id: 'legacy-run', title: scenario, prompt: 'Resolve this request', cwd, protocol: mode, status: 'running', seats: [], options: {}, versions: {}, turns: [], totals: { input: 0, output: 0, cached: 0, reasoning: 0, codexCredits: 0, usd: 0, turns: 0, durationMs: 0 } };
  const ctx: any = {
    cfg, opts: { protocol: mode, title: scenario, brief: meta.prompt, cwd, seats, chair, rounds: 4, minRounds: 1, anon: true, quiet: true, extra: {} }, minSeats: 1, sentTurns: 0,
    store: { meta, dir: root, save() { }, writeFile(name: string, value: string) { files[name] = value; }, appendTranscript() { } },
    engines: {
      async openSeat(seat: any, role: string, options: any) {
        const ss = { seat, role, options, record: { id: seat.id, role, spec: seat.engine, clawSession: `${seat.id}-${role}` } };
        sessions.push(ss); opens.push({ seat: seat.id, role, options }); return ss;
      }
    },
    log() { }, emit() { }, checkpoint() { }, seatLine() { }, recordSeats() { }, nextRound() { return Math.max(...meta.turns.map((t: any) => t.round), 0) + 1; },
    async send(ss: any, prompt: string, o: any) {
      const { seat, options } = ss; const s = seat.id; const round = o.round;
      const { templateContext: _context, templateStep: _step, ...recorded } = o;
      prompts.push({ seat: s, role: ss.role, prompt, ...recorded }); ctx.sentTurns++;
      let data = options.schema ? instance(options.schema) : undefined;
      if (mode === 'debate' && ss.role !== 'chair') {
        if (scenario === 'debate-unusable' && s === 'B') data = undefined;
        else {
          data.answer = `${s} position ${round}`;
          const cross = scenario === 'debate-crossover';
          data.claims = [{ id: 'c1', text: cross && round > 1 ? `${s === 'A' ? 'B' : 'A'} claim` : `${s} claim`, kind: 'fact', confidence: 1, evidence: [{ type: 'file', ref: 'README.md:1', quote: 'first line' }] }];
          data.stances = round > 1 ? [{ claim: `${s === 'A' ? 'B' : 'A'}:c1`, stance: scenario === 'debate-stalled' ? 'disagree' : 'agree', reason: 'scripted stance' }] : [];
          data.verdict = round === 1 ? 'n/a' : scenario === 'debate-stalled' ? 'disagree' : 'agree';
          if (cross && round === 3) data.claims[0].text = `${s} claim`;
          if (o.kind === 'ledger-review') {
            data.answer = debatePositions[s].answer;
            data.claims = [];
            data.concessions = [];
            if (cross) {
              data.stances[0].stance = 'disagree';
              data.verdict = 'disagree';
            }
          } else debatePositions[s] = clone(data);
        }
      } else if (mode === 'review' && ss.role !== 'chair') {
        data.summary = `${s} review`;
        data.findings = [{ id: 'f1', severity: 'P1', title: `${s} issue`, location: 'README.md:1', problem: 'scripted problem', scenario: 'scripted input', fix: 'scripted fix', confidence: 1, quote: 'first line' }];
        data.assessments = o.kind === 'crosscheck' ? [{ finding: `${s === 'A' ? 'B' : 'A'}:f1`, stance: 'confirm', reason: 'verified' }] : [];
      } else if (mode === 'council' && ss.role === 'reviewer') {
        data.ranking = ['R2', 'R1']; data.critiques = [{ response: 'R1', strengths: 'clear', weaknesses: 'missing cases' }];
        data.errors = ['R1 missed an edge case'];
      } else if (mode === 'pair') {
        if (ss.role === 'writer') {
          data.status = scenario === 'pair-blocked' ? 'blocked' : 'done'; data.blocker = 'needs credentials';
          data.summary = `writer cycle ${round}`;
          data.responses = round > 1 ? [{ finding: 'f1', action: 'disputed', note: 'intentional' }] : [];
          writeFileSync(join(options.cwd, 'result.txt'), 'implemented\n');
        } else {
          data.verdict = scenario === 'pair-deadlocked' ? 'request_changes' : 'approve'; data.summary = `review cycle ${round}`;
          data.findings = scenario === 'pair-deadlocked' ? [{ id: 'f1', severity: 'P1', title: 'blocking issue', location: 'README.md:1', problem: 'scripted', fix: 'scripted' }] : [];
        }
      }
      const reply = data ? JSON.stringify(data) : mode === 'debate' && scenario === 'debate-unusable' && s === 'B' ? '' : `Answer from ${s}: ${o.kind}`;
      const turn: TurnRecord = { n: ++counter, seat: s, round, kind: o.kind, dir: `turn-${counter}`, startedAt: '2000-01-01T00:00:00Z', durationMs: 1000, reply, structured: data, thinking: [], tools: [], usage: { input: 0, output: 0, reasoning: 0, cached: 0 } };
      meta.turns.push(turn); return turn;
    },
    async finish(status: string, outcome: any) { meta.status = status; meta.outcome = outcome; },
    async fail(e: Error) { meta.status = 'failed'; meta.outcome = { stop: e.message }; },
  };
  let report: string;
  if (mode === 'review') report = await protocols.review(ctx as RunContext, { kind: 'uncommitted' }, 'correctness');
  else if (mode === 'pair') report = await protocols.pair(ctx as RunContext, { isolation: 'worktree', writerAccess: 'sandboxed', check: `"${process.execPath}" -e "process.exit(${scenario === 'pair-check-failed' ? 1 : 0})"` });
  else report = await protocols[mode](ctx as RunContext);
  if (meta.workspace) finishWorkspace(meta.workspace, 'discard', scenario);
  // Paths, commit hashes and command timing are environmental, not protocol behavior.
  const artifacts = Object.fromEntries(Object.entries(files).filter(([k]) => ['ledger.json', 'findings.json', 'council.json', 'pair.json'].includes(k)).map(([k, v]) => [k, JSON.parse(v)]));
  return normalizeSnapshot({ opens, prompts, status: meta.status, outcome: meta.outcome, report, artifacts }, [root, realpathSync.native(root)]);
}

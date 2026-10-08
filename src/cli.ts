import { Command, Option } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runBin } from './bins.ts';
import { binVersion, CLAUDE_MODELS, codexCatalog, DEFAULT_CONFIG, loadConfig, resolveClaudeBin, resolveCodexBin, type Config } from './config.ts';
import { assertNotNested, isSafeMode, sanitizeEnvironment } from './env.ts';
import { CLAUDE_HOME, CONFIG_PATH, DUO_HOME, PROJECT_ROOT, RUNS_DIR, SCRATCH_DIR } from './paths.ts';
import { pair, pairSettingsOf, type PairSettings } from './protocols/pair.ts';
import { install, launchGui, uninstall } from './setup.ts';
import { runDoctor } from './doctor.ts';
import { finishWorkspace as finishWs, workspaceOptions } from './worktree.ts';
import { knownCodexRates } from './pricing.ts';
import { ask } from './protocols/ask.ts';
import { RunContext, type RunOptions } from './protocols/common.ts';
import { continueRun } from './protocols/continue.ts';
import { council } from './protocols/council.ts';
import { debate } from './protocols/debate.ts';
import { review, type ReviewTarget } from './protocols/review.ts';
import { formatWindows, fmtAgo, snapshot } from './quota.ts';
import { refreshQuota } from './quota-refresh.ts';
import { exportHtml, traceTable } from './render.ts';
import { formatSeat, parseSeat, seatIds, SeatError, type Seat } from './seats.ts';
import { listTemplates, getTemplate, saveTemplate, deleteTemplate } from './templates/catalog.ts';
import { validateTemplate } from './templates/validate.ts';
import { generateTemplate } from './templates/generate.ts';
import { runTemplate } from './templates/run.ts';
import { clearMemory } from './templates/memory.ts';
import { deleteRun, listRuns, RunStore } from './store.ts';

assertNotNested();
sanitizeEnvironment();
const SAFE = isSafeMode();
// `duo trace | head` must end quietly when the reader goes away.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
    throw e;
  });
}

function fail(msg: string, code = 1): never {
  process.stderr.write(`duo: ${msg}\n`);
  process.exit(code);
}

async function readStdin(timeoutMs = 3000): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((res) => {
    let data = '';
    const timer = setTimeout(() => { process.stdin.pause(); res(data); }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => { clearTimeout(timer); res(data); });
    process.stdin.on('error', () => { clearTimeout(timer); res(data); });
  });
}

async function briefFrom(words: string[], file?: string): Promise<string> {
  const parts: string[] = [];
  if (file) parts.push(readFileSync(file === '-' ? 0 : file, 'utf8'));
  if (words.length) parts.push(words.join(' '));
  if (!parts.length) parts.push(await readStdin());
  return parts.map((p) => p.trim()).filter(Boolean).join('\n\n');
}

interface RunFlags {
  /** commander's --no-project: a question with no folder (seats get an empty scratch folder). */
  project?: boolean;
  seat?: string[];
  preset?: string;
  chair?: string | boolean;
  rounds?: string;
  minRounds?: string;
  anon?: boolean;
  cwd?: string;
  briefFile?: string;
  title?: string;
  timeout?: string;
  quiet?: boolean;
  json?: boolean;
  print?: boolean;
}

function seatsFrom(cfg: Config, flags: RunFlags, min: number): { seats: Seat[]; chair?: Seat; preset?: { rounds?: number; }; } {
  const presetName = flags.preset ?? (flags.seat?.length ? undefined : cfg.defaults.preset);
  const preset = presetName ? cfg.presets[presetName] : undefined;
  if (presetName && !preset) fail(`unknown preset "${presetName}" (have: ${Object.keys(cfg.presets).join(', ')})`);
  const specs = flags.seat?.length ? flags.seat : preset!.seats;
  if (specs.length > 32) fail('at most 32 model seats are supported');
  if (specs.length < min) fail(`need at least ${min} seat(s); pass -s/--seat or a preset`);
  const ids = seatIds(specs.length);
  let seats: Seat[];
  let chair: Seat | undefined;
  try {
    seats = specs.map((s, i) => parseSeat(s, ids[i], cfg.defaults, { safe: SAFE }));
    const chairSpec = typeof flags.chair === 'string' ? flags.chair : flags.chair === false ? undefined : preset?.chair;
    if (chairSpec) chair = parseSeat(chairSpec, 'Z', cfg.defaults, { safe: SAFE });
  } catch (e) {
    if (e instanceof SeatError) fail(e.message, 2);
    throw e;
  }
  if (flags.timeout !== undefined) {
    const timeout = Number(flags.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) fail('--timeout must be a positive number of seconds', 2);
    for (const s of seats) s.timeoutSec ??= timeout;
  }
  warnAgainstCatalog(cfg, [...seats, ...(chair ? [chair] : [])]);
  return { seats, chair, preset };
}

function warnAgainstCatalog(cfg: Config, seats: Seat[]): void {
  const codexSeats = seats.filter((s) => s.engine === 'codex');
  if (!codexSeats.length) return;
  const catalog = codexCatalog(resolveCodexBin(cfg));
  if (!catalog.length) return;
  for (const s of codexSeats) {
    const m = catalog.find((x) => x.slug === s.model);
    if (!m) process.stderr.write(`duo: warning: ${s.model} is not in this Codex client's catalog (${catalog.map((x) => x.slug).join(', ')}); the server may refuse it\n`);
    else if (s.effort && m.efforts.length && !m.efforts.includes(s.effort)) process.stderr.write(`duo: warning: ${s.model} lists efforts ${m.efforts.join(', ')}; "${s.effort}" may be refused\n`);
  }
}

function runOptions(cfg: Config, protocol: string, brief: string, flags: RunFlags, min: number, defaults: { rounds: number; }): RunOptions {
  const { seats, chair, preset } = seatsFrom(cfg, flags, min);
  const rounds = Number(flags.rounds ?? preset?.rounds ?? defaults.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000) fail('--rounds must be 1–1000', 2);
  const minRounds = Number(flags.minRounds ?? 1);
  if (!Number.isInteger(minRounds) || minRounds < 1 || minRounds > 1000) fail('--min-rounds must be 1–1000', 2);
  if (protocol === 'debate' && minRounds > rounds) fail('--min-rounds cannot exceed --rounds', 2);
  const workspace = flags.project !== false;
  const cwd = workspace ? resolve(flags.cwd ?? process.cwd()) : scratchFolder();
  return {
    protocol,
    title: flags.title ?? (brief.split('\n').find((l) => l.trim()) ?? protocol).replace(/^#+\s*/, '').slice(0, 80),
    brief,
    cwd,
    seats,
    chair,
    rounds,
    minRounds,
    anon: !!flags.anon,
    quiet: !!flags.quiet,
    extra: { safe: SAFE },
    workspace,
  };
}

/** An empty folder for questions that are not about a project, so seats cannot wander through $HOME. */
function scratchFolder(): string {
  const dir = join(SCRATCH_DIR, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** First Ctrl-C cancels the run cleanly (the seats are stopped and the record is kept); the second exits. */
function cancelOnInterrupt(ctx: RunContext): void {
  let pressed = 0;
  process.on('SIGINT', () => {
    if (++pressed > 1) process.exit(130);
    process.stderr.write('\nduo: cancelling (Ctrl-C again to quit immediately)\n');
    ctx.cancel();
  });
}

function emit(ctx: RunContext, report: string, flags: RunFlags): void {
  const m = ctx.store.meta;
  if (flags.json) {
    process.stdout.write(JSON.stringify({ id: m.id, dir: ctx.store.dir, status: m.status, outcome: m.outcome, totals: m.totals, report: join(ctx.store.dir, 'report.md') }, null, 2) + '\n');
    return;
  }
  if (flags.print !== false) process.stdout.write(report.trimEnd() + '\n\n');
  process.stdout.write(`report: ${join(ctx.store.dir, 'report.md')}\nrun: ${m.id}\n`);
}

function addRunFlags(cmd: Command, o: { chair?: boolean; } = {}): Command {
  cmd
    .option('-s, --seat <spec>', 'participant as engine[:model][@effort][+opt...] (repeatable, order = A, B, ...)', (v: string, p: string[] = []) => [...p, v])
    .option('-p, --preset <name>', 'named seat set from the config (default: defaults.preset)')
    .option('-C, --cwd <dir>', 'workspace the seats may read (default: current directory)')
    .option('--no-project', 'not about a project: seats get an empty scratch folder instead of the current directory')
    .option('-f, --brief-file <file>', 'read the brief from a file ("-" for stdin)')
    .option('--title <text>', 'run title (default: first line of the brief)')
    .option('--rounds <n>', 'round cap')
    .option('--anon', 'hide model identities from peers')
    .option('--timeout <sec>', 'per-turn timeout for seats without +timeout')
    .option('-q, --quiet', 'no progress lines on stderr')
    .option('--no-print', 'do not print the report, only its path')
    .option('--json', 'print a JSON summary instead of the report');
  if (o.chair !== false) cmd.option('--chair <spec>', 'seat that writes a final synthesis in a fresh session').option('--no-chair', "ignore the preset's chair");
  return cmd;
}

const program = new Command();
program
  .name(SAFE ? 'duo-safe' : 'duo')
  .description('Traceable Claude Code <-> Codex collaboration (built on claw-orchestrator).\nSeat spec: engine[:model][@effort][+verbosity=|summary=|web[=mode]|tier=|fast|cfg:key=toml|fetch|dir=|name=|persona=|timeout=]')
  .version(JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version);

addRunFlags(program.command('debate').argument('[brief...]').description('blind positions, cross-examination over a claim ledger, convergence').option('--min-rounds <n>', 'do not stop before this round'))
  .action(async (words: string[], flags: RunFlags) => {
    const cfg = loadConfig();
    const brief = await briefFrom(words, flags.briefFile);
    if (!brief) fail('no brief (pass words, -f FILE, or stdin)', 2);
    const ctx = RunContext.create(cfg, runOptions(cfg, 'debate', brief, flags, 2, { rounds: 3 }));
    cancelOnInterrupt(ctx);
    emit(ctx, await debate(ctx), flags);
  });

addRunFlags(program.command('review').argument('[focus...]').description('independent findings, location checks, cross-validation, merged verdict'))
  .option('--uncommitted', 'review staged + unstaged + untracked changes (default)')
  .option('--base <branch>', 'review this branch against <branch>')
  .option('--commit <sha>', 'review one commit')
  .option('--files <paths...>', 'review whole files')
  .option('--plan <file>', 'review a plan or design document')
  .action(async (words: string[], flags: RunFlags & { base?: string; commit?: string; files?: string[]; plan?: string; }) => {
    const cfg = loadConfig();
    const focus = words.join(' ').trim() || undefined;
    const target: ReviewTarget = flags.commit ? { kind: 'commit', value: flags.commit } : flags.base ? { kind: 'base', value: flags.base } : flags.files ? { kind: 'files', files: flags.files.map((f) => resolve(f)) } : flags.plan ? { kind: 'plan', value: resolve(flags.plan) } : { kind: 'uncommitted' };
    const title = flags.title ?? `review ${target.kind}${target.value ? ' ' + target.value : ''}${focus ? ': ' + focus : ''}`;
    const opts = runOptions(cfg, 'review', focus ?? `Review ${target.kind}`, { ...flags, title }, 1, { rounds: 2 });
    opts.extra.target = target;
    const ctx = RunContext.create(cfg, opts);
    cancelOnInterrupt(ctx);
    emit(ctx, await review(ctx, target, focus), flags);
  });

addRunFlags(program.command('council').argument('[question...]').description('independent answers, anonymized peer ranking, chair synthesis'))
  .action(async (words: string[], flags: RunFlags) => {
    const cfg = loadConfig();
    const brief = await briefFrom(words, flags.briefFile);
    if (!brief) fail('no question', 2);
    const ctx = RunContext.create(cfg, runOptions(cfg, 'council', brief, flags, 2, { rounds: 1 }));
    cancelOnInterrupt(ctx);
    emit(ctx, await council(ctx), flags);
  });

addRunFlags(program.command('ask').argument('[question...]').description('same question to every seat in parallel; optional chair comparison'))
  .action(async (words: string[], flags: RunFlags) => {
    const cfg = loadConfig();
    const brief = await briefFrom(words, flags.briefFile);
    if (!brief) fail('no question', 2);
    const ctx = RunContext.create(cfg, runOptions(cfg, 'ask', brief, flags, 1, { rounds: 1 }));
    cancelOnInterrupt(ctx);
    emit(ctx, await ask(ctx), flags);
  });

addRunFlags(program.command('pair').argument('[task...]').description('one seat writes the code, the other reviews it, in cycles until both agree it is done (seat A writes, B reviews)'), { chair: false })
  .option('--cycles <n>', 'write/review cycles at most', '4')
  .option('--check <command>', 'a command duo runs after each writer turn (tests); it must pass to finish')
  .option('--in-place', 'let the writer edit the folder itself (default: a git worktree on a new branch)')
  .option('--network', 'Codex writer: allow network access inside the sandbox (package installs)')
  .option('--full-access', 'writer runs without a sandbox (Codex danger-full-access, Claude bypassPermissions)')
  .action(async (words: string[], flags: RunFlags & { cycles: string; check?: string; inPlace?: boolean; network?: boolean; fullAccess?: boolean; }) => {
    if (SAFE) fail('pair writes files; it is not available in duo-safe');
    const cfg = loadConfig();
    const brief = await briefFrom(words, flags.briefFile);
    if (!brief) fail('no task (pass words, -f FILE, or stdin)', 2);
    const cycles = Number(flags.cycles);
    if (!Number.isInteger(cycles) || cycles < 1) fail('--cycles must be a positive integer', 2);
    const opts = runOptions(cfg, 'pair', brief, { ...flags, rounds: String(cycles) }, 2, { rounds: cycles });
    if (opts.seats.length !== 2) fail('pair takes exactly two seats: -s <writer> -s <reviewer>', 2);
    const ws = workspaceOptions(opts.cwd);
    const settings: PairSettings = {
      isolation: flags.inPlace || !ws.head ? 'in-place' : 'worktree',
      writerAccess: flags.fullAccess ? 'full' : flags.network ? 'sandboxed-network' : 'sandboxed',
      check: flags.check?.trim() || undefined,
    };
    if (!flags.inPlace && !ws.head) process.stderr.write(`duo: ${opts.cwd} is not a git repository with commits; the writer works in place\n`);
    if (settings.isolation === 'worktree' && ws.dirty) process.stderr.write('duo: note: uncommitted changes are not part of the worktree (it starts from HEAD)\n');
    opts.extra.pair = settings;
    const ctx = RunContext.create(cfg, opts);
    cancelOnInterrupt(ctx);
    emit(ctx, await pair(ctx, settings), flags);
    const w = ctx.store.meta.workspace;
    if (w?.mode === 'worktree' && w.state === 'active') process.stdout.write(`workspace: ${w.path} (branch ${w.branch}); \`duo apply ${ctx.store.meta.id}\` brings it into your folder\n`);
  });

program.command('apply').argument('<run>').description("finish a pair run's worktree: apply its changes to your folder (default), keep the branch, or discard it")
  .option('--keep-branch', 'commit on the duo/ branch and remove the worktree folder')
  .option('--discard', 'remove the worktree and its branch')
  .action((ref: string, o: { keepBranch?: boolean; discard?: boolean; }) => {
    if (SAFE) fail('apply is not available in duo-safe');
    const store = RunStore.open(ref);
    const ws = store.meta.workspace;
    if (!ws) fail(`${store.meta.id} is not a pair run`);
    const r = finishWs(ws, o.discard ? 'discard' : o.keepBranch ? 'keep' : 'apply', store.meta.title);
    if (r.state) {
      store.meta.workspace = { ...ws, state: r.state, outcome: r.message };
      store.save();
    }
    process.stdout.write(`${r.message}\n`);
    if (!r.ok) process.exitCode = 1;
  });

program.command('continue').argument('<run>').argument('[message...]').description('resume a debate, ask or pair run (same threads/sessions) with more rounds or a follow-up')
  .option('--rounds <n>', 'additional rounds (debate) or cycles (pair)', '1')
  .option('--chair <spec>', 'chair for the new synthesis')
  .option('-q, --quiet').option('--no-print').option('--json')
  .action(async (ref: string, words: string[], flags: RunFlags) => {
    const cfg = loadConfig();
    const note = words.join(' ').trim() || (await readStdin());
    let chair: Seat | undefined;
    try {
      chair = typeof flags.chair === 'string' ? parseSeat(flags.chair, 'Z', cfg.defaults, { safe: SAFE }) : undefined;
    } catch (e) {
      fail((e as Error).message, 2);
    }
    let next: RunContext | undefined;
    const report = await continueRun(cfg, ref, note, { rounds: Number(flags.rounds ?? 1), quiet: !!flags.quiet, chair, safe: SAFE, onContext: (c) => { next = c; cancelOnInterrupt(c); } });
    const latest = next!.store;
    if (flags.json) process.stdout.write(JSON.stringify({ id: latest.meta.id, dir: latest.dir, status: latest.meta.status, outcome: latest.meta.outcome }, null, 2) + '\n');
    else {
      if (flags.print !== false) process.stdout.write(report.trimEnd() + '\n\n');
      process.stdout.write(`report: ${join(latest.dir, 'report.md')}\nrun: ${latest.meta.id}\n`);
    }
  });

const templates = program.command('template').description('author, validate, save and run custom coordination methods');
const templateFrom = (ref: string) => existsSync(ref) ? validateTemplate(JSON.parse(readFileSync(ref, 'utf8'))) : getTemplate(ref);
templates.command('list').action(() => {
  for (const { template: t, builtin } of listTemplates()) process.stdout.write(`${t.id}  ${t.name}${builtin ? ' (built-in)' : ''}\n`);
});
templates.command('show').argument('<id-or-file>').action((ref: string) => { process.stdout.write(JSON.stringify(templateFrom(ref), null, 2) + '\n'); });
templates.command('validate').argument('<file>').action((ref: string) => { const t = templateFrom(ref); process.stdout.write(`${t.id}: valid\n`); });
templates.command('save').argument('<file>').action((ref: string) => { const t = saveTemplate(templateFrom(ref)); process.stdout.write(`Saved ${t.id}\n`); });
templates.command('delete').argument('<id>').action((id: string) => { deleteTemplate(id); process.stdout.write(`Deleted ${id}\n`); });
templates.command('memory-clear').argument('<id>').argument('<channel>').action((id: string, channel: string) => { clearMemory(getTemplate(id), channel); process.stdout.write(`Cleared ${id}/${channel}\n`); });
templates.command('generate').argument('[description...]')
  .requiredOption('-s, --seat <spec>', 'the model and effort that author the method')
  .option('--current <file>', 'revise this draft')
  .option('-o, --output <file>', 'write the validated draft here')
  .action(async (words: string[], o: { seat: string; current?: string; output?: string; }) => {
    if (SAFE && o.output) fail('--output is not available in duo-safe; the validated draft is printed to stdout');
    const result = await generateTemplate(loadConfig(), { description: await briefFrom(words), model: o.seat, current: o.current ? templateFrom(o.current) : undefined, safe: SAFE, onContext: cancelOnInterrupt });
    const text = JSON.stringify(result.template, null, 2) + '\n';
    if (o.output) { writeFileSync(resolve(o.output), text); process.stdout.write(`Draft: ${resolve(o.output)}\n${result.explanation}\n`); }
    else process.stdout.write(text);
  });
addRunFlags(templates.command('run').argument('<id-or-file>').argument('[brief...]').description('run a saved template or JSON file'))
  .option('--check <command>', 'pair library: check after each writer turn')
  .option('--in-place', 'write in the project with a snapshot instead of a worktree')
  .option('--base <branch>', 'review library: base branch')
  .action(async (ref: string, words: string[], flags: RunFlags & { check?: string; inPlace?: boolean; base?: string; }) => {
    const cfg = loadConfig();
    const t = templateFrom(ref);
    if (SAFE && (t.library === 'pair' || Object.values(t.roles).some((r) => r.access && r.access !== 'read'))) fail('write templates are not available in duo-safe');
    const brief = await briefFrom(words, flags.briefFile);
    if (!brief) fail('no brief', 2);
    const protocol = t.library ?? 'custom';
    const min = t.library === 'pair' || t.library === 'council' || t.library === 'debate' ? 2 : t.limits.minSeats ?? 1;
    const opts = runOptions(cfg, protocol, brief, flags, min, { rounds: t.library === 'pair' ? 4 : t.library === 'debate' ? 3 : t.library === 'review' ? 2 : 1 });
    if (opts.workspace === false && (t.library === 'pair' || t.library === 'review')) fail(`${t.library} needs a project folder`);
    opts.extra.template = t;
    if (t.library === 'pair') opts.extra.pair = { isolation: flags.inPlace ? 'in-place' : 'worktree', writerAccess: 'sandboxed', check: flags.check };
    if (t.library === 'review') opts.extra.target = flags.base ? { kind: 'base', value: flags.base } : { kind: 'uncommitted' };
    const ctx = RunContext.create(cfg, opts); cancelOnInterrupt(ctx);
    emit(ctx, await runTemplate(ctx, t), flags);
  });

program.command('runs').description('list runs').option('-n <n>', 'how many', '20').action((o: { n: string; }) => {
  const rows = listRuns(Number(o.n));
  if (!rows.length) return void process.stdout.write('no runs yet\n');
  for (const m of rows) {
    const out = m.outcome ?? {};
    const summary = (out.stop as string) ?? (out.findings !== undefined ? `${out.findings} findings` : out.ranking ? 'ranked' : '');
    process.stdout.write(`${m.id.padEnd(58)} ${m.status.padEnd(9)} ${m.seats.filter((s) => s.role === 'participant').map((s) => `${s.engine}:${s.model}@${s.effort ?? '-'}`).join(' vs ').padEnd(48)} ${summary}\n`);
  }
});

program.command('show').argument('[run]', 'run id, unique fragment, or latest', 'latest').description('print the transcript, the report, or one turn')
  .option('--report', 'print report.md')
  .option('--turn <n>', 'print one turn')
  .addOption(new Option('--part <part>', 'with --turn: which file').choices(['reply', 'prompt', 'thinking', 'tools', 'meta', 'raw', 'json']).default('reply'))
  .action((ref: string, o: { report?: boolean; turn?: string; part: string; }) => {
    const store = RunStore.open(ref);
    if (o.turn) {
      const t = store.meta.turns.find((x) => x.n === Number(o.turn));
      if (!t) fail(`run has turns 1..${store.meta.turns.length}`);
      const file = { reply: 'reply.md', prompt: 'prompt.md', thinking: 'thinking.md', tools: 'tools.json', meta: 'meta.json', raw: 'raw.jsonl', json: 'reply.json' }[o.part]!;
      const p = join(store.dir, t.dir, file);
      process.stdout.write(existsSync(p) ? readFileSync(p, 'utf8') : `(no ${file} for this turn)\n`);
      return;
    }
    process.stdout.write(store.readFile(o.report ? 'report.md' : 'transcript.md') ?? '(nothing yet)\n');
  });

program.command('trace').argument('[run]', 'run id or latest', 'latest').description('turn-by-turn timeline: model, effort, time, tokens, cost, verdicts')
  .action((ref: string) => {
    const m = RunStore.open(ref).meta;
    const t = m.totals;
    process.stdout.write(`${m.id}  [${m.status}]  ${m.protocol}  cwd=${m.cwd}${m.git?.head ? `  git=${m.git.head.slice(0, 10)}${m.git.dirty ? '+dirty' : ''}` : ''}\n`);
    process.stdout.write(`seats: ${m.seats.map((s) => `${s.role === 'chair' ? 'chair' : s.id + (s.role === 'reviewer' ? '(rev)' : '')}=${s.spec}${s.codexThreadId ? ' thread=' + s.codexThreadId : ''}${s.claudeSessionId ? ' session=' + s.claudeSessionId : ''}`).join('\n       ')}\n`);
    process.stdout.write(`versions: codex ${m.versions.codex} · claude ${m.versions.claude} · claw ${m.versions.claw} · duo ${m.versions.duo}\n\n`);
    process.stdout.write(traceTable(m) + '\n\n');
    if (t) process.stdout.write(`total: ${t.turns} turns · ${(t.durationMs / 1000).toFixed(0)}s · in ${t.input} (${t.cached} cached) · out ${t.output} (${t.reasoning} reasoning) · ${t.codexCredits} Codex credits · ~$${t.usd} Claude API-equivalent\n`);
    if (m.outcome) process.stdout.write(`outcome: ${JSON.stringify(m.outcome)}\n`);
    process.stdout.write(`dir: ${RunStore.open(ref).dir}\n`);
  });

program.command('export').argument('[run]', 'run id or latest', 'latest').description('export a run as a single HTML page, JSON, or Markdown')
  .addOption(new Option('--format <fmt>').choices(['html', 'json', 'md']).default('html'))
  .option('-o, --out <file>', 'output path (default: inside the run directory)')
  .action((ref: string, o: { format: string; out?: string; }) => {
    const store = RunStore.open(ref);
    const m = store.meta;
    const report = store.readFile('report.md') ?? '';
    let content: string;
    if (o.format === 'json') {
      const ledger = store.readFile('ledger.json');
      content = JSON.stringify({ run: m, ledger: ledger ? JSON.parse(ledger) : undefined, report }, null, 2);
    } else if (o.format === 'md') {
      content = `${report}\n\n---\n\n${store.readFile('transcript.md') ?? ''}`;
    } else {
      const read = (dir: string, f: string) => (existsSync(join(store.dir, dir, f)) ? readFileSync(join(store.dir, dir, f), 'utf8') : undefined);
      content = exportHtml(m, report, m.turns.map((t) => ({ t, prompt: read(t.dir, 'prompt.md') ?? '', reply: read(t.dir, 'reply.md') ?? '', thinking: read(t.dir, 'thinking.md'), tools: read(t.dir, 'tools.json') })));
    }
    const out = o.out ?? join(store.dir, `export.${o.format === 'md' ? 'md' : o.format}`);
    writeFileSync(out, content);
    process.stdout.write(`${out}\n`);
  });

program.command('rm').argument('<run>').description('delete a run directory').action((ref: string) => {
  const store = RunStore.open(ref);
  deleteRun(store.dir);
  process.stdout.write(`deleted ${store.meta.id}\n`);
});

program.command('quota').description('Codex and Claude subscription usage (free: read from local snapshots)')
  .option('--refresh', 'ping the cheapest model on each side first for a fresh snapshot')
  .action((o: { refresh?: boolean; }) => {
    const cfg = loadConfig();
    if (o.refresh) refreshQuota(cfg);
    const q = snapshot();
    const c = formatWindows(q.codex?.windows, cfg.warnPercent);
    const a = formatWindows(q.claude?.windows, cfg.warnPercent);
    process.stdout.write(`codex  [${q.codex?.plan ?? '?'}] ${c.text}${q.codex ? ` · as of ${fmtAgo(q.codex.asOf)}` : ''}${c.low ? '  LOW' : ''}\n`);
    process.stdout.write(`claude ${a.text}${q.claude ? ` · as of ${fmtAgo(q.claude.asOf)}${q.claude.status && q.claude.status !== 'allowed' ? ` · ${q.claude.status}` : ''}` : ' (run `duo quota --refresh`)'}${a.low ? '  LOW' : ''}\n`);
  });


program.command('models').description("models you can seat: Codex's live catalog for this client, Claude aliases")
  .option('--refresh', 'refetch the Codex catalog')
  .action((o: { refresh?: boolean; }) => {
    const cfg = loadConfig();
    const bin = resolveCodexBin(cfg);
    const rates = knownCodexRates();
    process.stdout.write(`Codex (${binVersion(bin)}) — credits per 1M tokens in/cached/out\n`);
    for (const m of codexCatalog(bin, o.refresh)) {
      if (m.visibility === 'hide') continue;
      const r = rates[m.slug];
      process.stdout.write(`  ${m.slug.padEnd(16)} default ${String(m.defaultEffort ?? '-').padEnd(7)} efforts ${m.efforts.join(',').padEnd(36)} ${r ? r.join('/') : '?'}  ${m.description}\n`);
    }
    process.stdout.write(`Claude (${binVersion(resolveClaudeBin(cfg))}) — efforts low,medium,high,xhigh,max\n`);
    for (const m of CLAUDE_MODELS) process.stdout.write(`  ${m.alias.padEnd(16)} ${m.note}\n`);
    process.stdout.write('  (any full model id such as claude-opus-5-5 also works)\n');
  });

program.command('doctor').description('check both CLIs, their logins and versions, git, and what setup installed').action(() => {
  const checks = runDoctor(loadConfig());
  for (const c of checks) {
    process.stdout.write(`${{ ok: 'ok  ', fail: 'FAIL', warn: 'warn', info: 'info' }[c.level]}  ${c.label.padEnd(20)} ${c.detail}\n`);
    if (c.fix) process.stdout.write(`      ${''.padEnd(20)} → ${c.fix}\n`);
  }
  const cfg = loadConfig();
  const q = snapshot();
  process.stdout.write(`info  ${'codex quota'.padEnd(20)} ${formatWindows(q.codex?.windows, cfg.warnPercent).text}\n`);
  process.stdout.write(`info  ${'claude quota'.padEnd(20)} ${formatWindows(q.claude?.windows, cfg.warnPercent).text}\n`);
  if (SAFE) process.stdout.write('info  safe mode            raw Codex config (cfg:), WebFetch, pair mode and the GUI are disabled\n');
  process.exitCode = checks.some((c) => c.level === 'fail') ? 1 : 0;
});

program.command('setup').description('install (or --uninstall) the duo/duo-safe commands, the Claude and Codex skills, the Codex allow-rule for duo-safe, and the Duo app launcher')
  .option('--uninstall', 'remove what setup installs')
  .option('--no-launcher', 'skip the app launcher (menu entry, Applications folder, Start menu)')
  .action((o: { uninstall?: boolean; launcher?: boolean; }) => {
    if (SAFE) fail('setup is not available in duo-safe');
    const log = (line: string) => process.stdout.write(`${line}\n`);
    try {
      if (o.uninstall) uninstall(log);
      else install(log, { launcher: o.launcher });
    } catch (e) {
      fail((e as Error).message);
    }
  });

program.command('gui').description('open the Duo desktop app').action(() => {
  if (SAFE) fail('gui is not available in duo-safe');
  try {
    launchGui();
  } catch (e) {
    fail((e as Error).message);
  }
  process.stdout.write('starting Duo…\n');
});

program.command('config').description('print the effective config, or write a starter file')
  .option('--init', `write the defaults to ${CONFIG_PATH} if it does not exist`)
  .action((o: { init?: boolean; }) => {
    if (o.init) {
      if (existsSync(CONFIG_PATH)) fail(`${CONFIG_PATH} already exists`);
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
      process.stdout.write(`${CONFIG_PATH}\n`);
      return;
    }
    const cfg = loadConfig();
    process.stdout.write(JSON.stringify({ ...cfg, codexBin: resolveCodexBin(cfg), claudeBin: resolveClaudeBin(cfg), configPath: CONFIG_PATH, dataDir: DUO_HOME }, null, 2) + '\n');
    for (const [name, p] of Object.entries(cfg.presets)) process.stderr.write(`preset ${name}: ${p.seats.map((s) => formatSeat(parseSeat(s, 'A', cfg.defaults))).join(' vs ')}${p.chair ? ` · chair ${p.chair}` : ''}${p.rounds ? ` · ${p.rounds} rounds` : ''}\n`);
  });

program.parseAsync().catch((e: Error) => fail(e.message));

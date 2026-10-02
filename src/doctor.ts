/**
 * Setup check, shared by `duo doctor` and the GUI's Settings → Setup check: are both CLIs installed
 * and logged in, at versions that work, and is git there for pair mode.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binVersion, runBin, type BinSpec } from './bins.ts';
import { codexCatalog, resolveClaudeBin, resolveCodexBin, type Config } from './config.ts';
import { errorHint } from './errors.ts';
import { CONFIG_PATH, DUO_HOME, PROJECT_ROOT } from './paths.ts';
import { saveClaudeQuota } from './quota.ts';
import { SETUP_PATHS } from './setup.ts';

export interface Check {
  id: string;
  label: string;
  level: 'ok' | 'fail' | 'warn' | 'info';
  detail: string;
  /** What to do about it, when something is wrong. */
  fix?: string;
}

function version(label: string): number[] {
  return (/(\d+)\.(\d+)\.(\d+)/.exec(label) ?? []).slice(1).map(Number);
}

export function runDoctor(cfg: Config, o: { quick?: boolean } = {}): Check[] {
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  const [maj, min] = process.versions.node.split('.').map(Number);
  const nodeOk = maj > 22 || (maj === 22 && min >= 18);
  add({ id: 'node', label: 'Node.js', level: nodeOk ? 'ok' : 'fail', detail: `${process.version}${process.versions.electron ? ` (Electron ${process.versions.electron})` : ''}`, fix: nodeOk ? undefined : 'Install Node.js 22.18 or newer (it runs the TypeScript sources directly).' });

  let codex: BinSpec | undefined;
  try {
    codex = resolveCodexBin(cfg);
    add({ id: 'codex', label: 'Codex CLI', level: 'ok', detail: `${binVersion(codex)} · ${codex.display}` });
  } catch (e) {
    add({ id: 'codex', label: 'Codex CLI', level: 'fail', detail: (e as Error).message, fix: 'Run `npm install` in the duo folder (it pins a Codex CLI), or set codexBin in the config.' });
  }
  if (codex && !o.quick) {
    const r = runBin(codex, ['login', 'status'], { encoding: 'utf8', timeout: 30_000 });
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
    const ok = r.status === 0 && /logged in/i.test(text);
    add({ id: 'codex-login', label: 'Codex login', level: ok ? 'ok' : 'fail', detail: text.split('\n').filter(Boolean).pop() ?? 'not logged in', fix: ok ? undefined : 'Log in with your ChatGPT account: run `codex login` (or sign in to the ChatGPT desktop app).' });
    const cat = codexCatalog(codex);
    add({ id: 'codex-models', label: 'Codex models', level: cat.length ? 'ok' : 'warn', detail: cat.filter((m) => m.visibility !== 'hide').map((m) => m.slug).join(', ') || 'catalog unavailable' });
  }

  let claude: BinSpec | undefined;
  try {
    claude = resolveClaudeBin(cfg);
    const v = binVersion(claude);
    add({ id: 'claude', label: 'Claude Code', level: 'ok', detail: `${v} · ${claude.display}` });
  } catch (e) {
    add({ id: 'claude', label: 'Claude Code', level: 'fail', detail: (e as Error).message, fix: 'Install Claude Code (https://docs.claude.com/claude-code), then run `claude` once to log in.' });
  }
  if (claude && !o.quick) {
    const r = runBin(claude, ['auth', 'status'], { encoding: 'utf8', timeout: 30_000 });
    let st: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string } = {};
    try {
      st = JSON.parse(String(r.stdout ?? '{}'));
    } catch {
      /* older CLI */
    }
    const ok = st.loggedIn === true;
    add({ id: 'claude-login', label: 'Claude login', level: ok ? 'ok' : 'fail', detail: ok ? `logged in (${[st.authMethod, st.subscriptionType].filter(Boolean).join(', ')})` : 'not logged in', fix: ok ? undefined : 'Run `claude` and use /login with your Claude account.' });
  }

  try {
    const g = execFileSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const [gmaj, gmin] = version(g);
    const ok = gmaj > 2 || (gmaj === 2 && gmin >= 25);
    add({ id: 'git', label: 'git', level: ok ? 'ok' : 'warn', detail: g, fix: ok ? undefined : 'Pair mode uses git worktrees; git 2.25 or newer is recommended.' });
  } catch {
    add({ id: 'git', label: 'git', level: 'warn', detail: 'not found', fix: 'Install git: pair mode and the Changes panel need it.' });
  }

  const claw = join(PROJECT_ROOT, 'node_modules', '@enderfga', 'claw-orchestrator', 'package.json');
  add({ id: 'claw', label: 'claw-orchestrator', level: existsSync(claw) ? 'ok' : 'fail', detail: existsSync(claw) ? JSON.parse(readFileSync(claw, 'utf8')).version : 'missing', fix: existsSync(claw) ? undefined : 'Run `npm install` in the duo folder.' });
  for (const [label, p] of [['Claude skill /duo', SETUP_PATHS.CLAUDE_SKILL], ['Codex skill $duo', SETUP_PATHS.CODEX_SKILL], ['Codex allow-rule', SETUP_PATHS.CODEX_RULE]] as const) {
    add({ id: label, label, level: 'info', detail: existsSync(p) ? p : `not installed (\`duo setup\` adds ${p})` });
  }
  add({ id: 'config', label: 'config', level: 'info', detail: existsSync(CONFIG_PATH) ? CONFIG_PATH : `${CONFIG_PATH} (defaults)` });
  add({ id: 'data', label: 'data', level: 'info', detail: DUO_HOME });
  return out;
}

/**
 * Send one tiny message through each CLI (the cheapest model on each side). `claude auth status`
 * says "logged in" even when the saved session can no longer be refreshed; only a real call shows it.
 */
export function liveChecks(cfg: Config): Check[] {
  const out: Check[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'duo-check-'));
  try {
    try {
      const claude = resolveClaudeBin(cfg);
      const r = runBin(claude, ['-p', '--model', 'haiku', '--no-session-persistence', '--output-format', 'stream-json', '--verbose'], { cwd, input: 'Reply with: ok', encoding: 'utf8', timeout: 120_000 });
      let err = '';
      for (const line of String(r.stdout ?? '').split('\n')) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result' && (ev.is_error || ev.subtype !== 'success')) err = String(ev.result || ev.subtype);
          if (ev.type === 'rate_limit_event') saveClaudeQuota(ev.rate_limit_info);
        } catch {
          /* not JSON */
        }
      }
      if (!err && r.status !== 0) err = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').pop() || `exit ${r.status}`;
      add(out, 'claude-live', 'Claude sign-in', err, err && /auth|log ?in|oauth|expired/i.test(err) ? 'Run `claude` in a terminal and use /login, then check again.' : undefined);
    } catch (e) {
      add(out, 'claude-live', 'Claude sign-in', (e as Error).message);
    }
    try {
      const codex = resolveCodexBin(cfg);
      const r = runBin(codex, ['exec', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"', '--json', '-'], { cwd, input: 'Reply with: ok', encoding: 'utf8', timeout: 180_000 });
      let err = '';
      for (const line of String(r.stdout ?? '').split('\n')) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'turn.failed') err = String(ev.error?.message ?? 'turn failed');
        } catch {
          /* not JSON */
        }
      }
      if (!err && r.status !== 0) err = `${r.stderr ?? ''}`.trim().split('\n').pop() || `exit ${r.status}`;
      add(out, 'codex-live', 'Codex sign-in', err, err && /auth|log ?in|401|expired/i.test(err) ? 'Run `codex login`, then check again.' : undefined);
    } catch (e) {
      add(out, 'codex-live', 'Codex sign-in', (e as Error).message);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  return out;
}

function add(out: Check[], id: string, label: string, err: string, fix?: string): void {
  out.push(err ? { id, label, level: 'fail', detail: err.slice(0, 300), fix: fix ?? errorHint(err) } : { id, label, level: 'ok', detail: 'a test message went through' });
}

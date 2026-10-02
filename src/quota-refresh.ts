import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runBin } from './bins.ts';
import { resolveClaudeBin, resolveCodexBin, type Config } from './config.ts';
import { DUO_HOME } from './paths.ts';
import { saveClaudeQuota } from './quota.ts';

/** Ping the cheapest model on each side once, so the local quota snapshots are current. */
export function refreshQuota(cfg: Config): void {
  const tmp = join(DUO_HOME, 'cache');
  mkdirSync(tmp, { recursive: true });
  try {
    runBin(resolveCodexBin(cfg), ['exec', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"', '--json', '-'], { cwd: tmp, input: 'Reply with: ok', stdio: ['pipe', 'ignore', 'ignore'], timeout: 180_000 });
  } catch {
    /* no Codex: nothing to refresh */
  }
  try {
    const r = runBin(resolveClaudeBin(cfg), ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', 'Reply with: ok'], { cwd: tmp, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of String(r.stdout ?? '').split('\n')) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'rate_limit_event') saveClaudeQuota(ev.rate_limit_info);
      } catch {
        /* not JSON */
      }
    }
  } catch {
    /* no Claude: nothing to refresh */
  }
}

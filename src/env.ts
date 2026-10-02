import { basename } from 'node:path';

/**
 * Variables that bind a process to the Claude Code session it was launched from. A seat's `claude`
 * must not inherit them: CLAUDE_EFFORT=max would silently override the seat's effort, and the
 * session/socket ids would make the child think it is part of the parent session.
 */
const CLAUDE_SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_PREVIEW_CLASSIFIER_FLOOR',
  'AI_AGENT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_EAGER_FLUSH', 'CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL',
  'CLAUDE_CODE_REPORT_FINDINGS', 'CLAUDE_CODE_DISABLE_CRON',
];

/** Set in every seat's environment; duo refuses to start under it, so a peer can never call duo back. */
export const DEPTH_VAR = 'DUO_DEPTH';

export function sanitizeEnvironment(): void {
  for (const name of CLAUDE_SESSION_VARS) delete process.env[name];
  // A stray API key makes `codex` bill the API instead of the ChatGPT plan.
  if (!process.env.DUO_KEEP_OPENAI_API_KEY) delete process.env.OPENAI_API_KEY;
}

/**
 * Safe mode is what the Codex allow-rule grants: invoked as `duo-safe` (or DUO_SAFE=1), duo refuses
 * the options that could widen what a seat can do (raw Codex config, WebFetch).
 */
export function isSafeMode(): boolean {
  return basename(process.argv[1] || '').startsWith('duo-safe') || process.env.DUO_SAFE === '1';
}

export function assertNotNested(): void {
  if (process.env[DEPTH_VAR]) {
    process.stderr.write('duo: refusing to run inside a duo seat (no call-back loops)\n');
    process.exit(2);
  }
}

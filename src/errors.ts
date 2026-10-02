/**
 * What a failed turn means, and what to do about it. Retrying a "your client is too old" error is
 * pointless and lets the other seats burn quota for nothing; a dead session should be restarted
 * transparently; a capacity error is worth one retry after a pause.
 */

export type ErrorClass =
  /** Will fail again until a person fixes something (update, login, wrong model). */
  | 'fatal'
  /** A plan limit was hit; retrying before the reset only fails again. */
  | 'quota'
  /** The model or service is temporarily overloaded. */
  | 'capacity'
  /** A reconnect the CLI recovered from by itself. */
  | 'transient'
  /** The CLI process behind the session is gone; restart it with the conversation resumed. */
  | 'dead_session'
  | 'timeout'
  | 'aborted'
  | 'other';

const RULES: [ErrorClass, RegExp][] = [
  ['aborted', /\bduo: (run cancelled|aborted)\b|cancelled by the user/i],
  ['dead_session', /session not ready|call start\(\) first|process may have exited|exited prematurely|crashed immediately|was stopped while|stdin (is )?not writable|exited mid-turn|before responding/i],
  // Before "timeout": Codex's reconnect notices mention an idle timeout of the stream, not of the turn.
  ['transient', /^reconnecting\b|stream disconnected before completion|idle timeout waiting for websocket/i],
  ['timeout', /timed? ?out waiting|turn timeout|timeout waiting for/i],
  ['quota', /usage limit|rate[ _-]?limit(ed| reached| exceeded)?|limit reached|you'?ve hit your|out of credits|insufficient_quota|exceeded your current quota|\b429\b/i],
  ['capacity', /at capacity|overloaded|\b529\b|\b503\b|\b502\b|server_error|internal server error|temporarily unavailable|try again later/i],
  ['fatal', /does not support this model|or newer is required|claude update|not logged in|please (log|sign) ?in|authenticat|oauth|session expired|token (has )?expired|unauthori[sz]ed|\b401\b|\b403\b|invalid api key|model_not_found|unknown model|model .* (does not exist|is not supported)|invalid_request_error|unsupported (model|value)|permission denied by policy/i],
];

export function classifyError(message: string | undefined): ErrorClass | undefined {
  if (!message) return undefined;
  for (const [cls, re] of RULES) if (re.test(message)) return cls;
  return 'other';
}

/** One line telling the user how to get unstuck, or undefined when there is nothing specific. */
export function errorHint(message: string | undefined): string | undefined {
  if (!message) return undefined;
  if (/or newer is required|claude update/i.test(message)) return 'Update Claude Code (Settings → Setup check → Update, or `claude update`), then use Continue.';
  if (/not logged in|please (log|sign) ?in|authenticat|oauth|session expired|token (has )?expired|unauthori[sz]ed|\b401\b/i.test(message)) return 'Log in again (`claude` then /login, or `codex login`), then use Continue.';
  if (/model_not_found|unknown model|does not exist|is not supported|does not support this model/i.test(message)) return 'This model is not available to this client or plan; pick another model for the seat.';
  const cls = classifyError(message);
  if (cls === 'quota') return 'A plan limit was reached. Continue the run after the window resets, or use a cheaper model.';
  if (cls === 'capacity') return 'The model was at capacity. Try again later or pick another model.';
  if (cls === 'dead_session') return 'The CLI process stopped unexpectedly; duo restarts it with the conversation resumed.';
  return undefined;
}

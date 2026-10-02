# Security

Duo can make AI agents edit files and run commands on your computer, so its local surface is designed to be driven only by its own window.

## Model

- The engine (`src/server/main.ts`) listens on `127.0.0.1` only.
- Every API call needs a random token generated at each launch. The desktop shell passes it to its own window in the URL fragment; it is never written to disk or sent anywhere else.
- Requests with a non-loopback `Host` header (DNS rebinding) or a cross-site `Origin` are refused.
- Model output is rendered through DOMPurify; links open in the system browser; the page has a strict Content-Security-Policy.
- The Electron window runs with `contextIsolation`, `sandbox` and no Node integration. The preload exposes four functions: pick a folder, show a folder, show a notification, and receive a navigation request.
- Discussion seats (debate, review, council, ask) are read-only: Codex runs in its read-only sandbox with `--ignore-user-config --ignore-rules`, and Claude gets only Read, Grep and Glob (plus web tools if you ask for them).
- A pair-mode writer works in a separate git worktree by default and is sandboxed unless you choose full access. Nothing reaches your folder until you apply it.
- `duo-safe`, the entry point the Codex allow-rule permits, refuses raw Codex config, WebFetch, pair mode, setup and the GUI.
- Seats run with `DUO_DEPTH` set, and Duo refuses to start under it, so a model cannot start Duo again.

Chats run with the permissions you choose for them. *Full access* (Claude `bypassPermissions`, Codex `danger-full-access`) means exactly that.

## Reporting a vulnerability

Please report security problems privately through [GitHub private vulnerability reporting](https://github.com/Audatic07/duo/security/advisories/new) rather than a public issue. Include the steps to reproduce and the version (`duo --version`). We aim to reply within a week.

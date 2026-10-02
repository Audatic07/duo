# Changelog

## 0.2.0

### New
- **Pair mode**: one model writes the code in its own git worktree (or in place, with a snapshot), the other reviews every change, and they cycle until the writer reports done, the reviewer approves with no P0/P1 finding open, and an optional check command passes. Apply, keep the branch, or discard the result; continue with a note. `duo pair`, `duo apply`.
- A redesigned desktop app: home screen with one composer for every mode, animated walkthroughs of each mode, live activity of every seat during runs, command palette, keyboard shortcuts, pinned chats, date-grouped history, confirm dialogs, notifications, Settings with a setup check (and a live sign-in test), light and dark themes.
- Runs can be stopped, deleted and exported as Markdown from the app; continuing a run opens the new run.
- `--no-project` (and "No folder" in the app) for questions that are not about a project: the seats get an empty folder.
- Linux, macOS and Windows support: platform data folders, launchers for each OS from `duo setup`, no shell scripts.

### Fixed (found in real runs)
- Windows short folder names (such as `RUNNER~1`) could send a pair writer outside its worktree when Git expanded the path; both paths are now resolved natively and the selected subfolder must stay inside the repository.
- A turn could record the previous turn's tool calls and errors when it started within a second of the last one.
- A Claude seat whose process died between turns failed every later turn with "Session not ready"; it is now restarted on the same conversation.
- Errors that a retry cannot fix (outdated Claude Code, expired sign-in, unknown model, plan limits) were retried and let the other seats spend quota for minutes; the run now stops at once with a fix hint.
- Codex reconnect notices ("Reconnecting… idle timeout") were recorded as errors.
- Models newer than the rate card (`gpt-6.1-sol`) were priced at zero credits; the card is updated and newer models are priced by family.
- Codex `none` and `minimal` efforts were silently dropped.
- Citations with spaces in the path (or Windows drive letters) were rejected as malformed.
- Debates with several seats produced hundreds of claims nobody could take a stance on; claims are capped per seat.
- Continuing a continued debate replayed only the last run's rounds.
- The chair's synthesis was recorded as round 0.
- Codex seats loaded the user's installed skills and read Duo's own skill file.
- Codex prompts are passed on stdin (long debate prompts hit argument length limits).
- The app's saved state was lost on every launch (the window's origin changed with the port); preferences are now kept by the engine and the port is stable.
- Empty chats piled up in the sidebar; a chat is now saved on its first message.
- The app hung for 45 seconds on logout and was killed; it now shuts down promptly and stops its sessions.
- Runs interrupted by a crash stayed "running" forever.

## 0.1.0

- First version: debate, review, council, ask and continue protocols; seat specs with per-seat model, effort and Codex options; full traces; the desktop app with chats, side by side and runs.

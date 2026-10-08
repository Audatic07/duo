# Changelog

## Unreleased

## 0.3.0 — 2026-10-08

- **Custom Templates are the universal foundation for every Duo method.** Pair, Debate, Review, Council and Ask are fully constructed as templates in the same system, and all five can be recreated from a new method in the visual maker.
- Debate ends with every model reviewing the frozen claim ledger and explicitly agreeing or disagreeing with every peer claim. Incomplete reviews retry once and fail if still incomplete; reports, the run view, and continued debates retain the final decisions.
- The visual maker can create all five shipped methods from a new draft and add every built-in stage. Stage prompts, debate policies and round limits, shared context, starting model assignments and native response schemas (including nullable fields) are editable through the same definitions used by the executor.

- Custom coordination templates: versioned role and workflow definitions, model eligibility and ranking, conditional role changes, selective routing, structured replies, completion and exception rules, and bounded execution.
- Persistent memory channels with selected fields, role access rules, run or template scope, and entry/character retention limits.
- A visual desktop template builder for workflows, roles, routing, structured responses, conditions, memory and limits, with undo/redo and an explicitly selected JSON editor. Model-assisted authoring/repair/revision, saved templates, built-in copies, and a Method tab record the exact definition and state. Matching `duo template` CLI and authenticated local APIs.
- Migrated Pair, Debate, Review, Council and Ask to the shared workflow executor. Regression snapshots from the original implementations cover prompts, schemas, outcomes, reports and domain artifacts in 13 scenarios.
- Fixed eligible-seat selection when a count chooses only part of the pool, retained exception details through recovery/terminal steps, rejected ambiguous routes, and made malformed-template validation return actionable errors instead of crashing.
- Discarding JSON restores the visual draft across mode switches. Round and cycle counts can be cleared and retyped without inserting a default; invalid minimum/maximum rounds and CLI timeouts are refused.
- Saved templates can be deleted in the builder, and memory clearing asks for confirmation. Saving removed or run-only channels and deleting saved methods clears their cross-run storage.
- Generated drafts can be recovered from their authoring run and reopened in the visual builder. Recorded run methods can also be reopened for editing; seat columns stay in order beyond 25 models.
- Copied native methods reject additional write roles that would bypass native workspace isolation; fully custom write methods require explicit isolation.
- GUI cache checks all imported dependencies and generated assets, rebuilding after shared-code changes or missing CSS/fonts.
- Isolated desktop smoke checks with fake providers, bounded startup and useful failures. Added source release bundles with dependency lockfiles, built GUI, checksums, release notes and a checked draft-release workflow.

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

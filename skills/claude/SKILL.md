---
name: duo
description: Run a traceable multi-model session between OpenAI Codex (the user's ChatGPT plan) and Claude (the user's Claude plan) with the duo harness - pair programming where one writes and the other reviews until both agree, debates that converge on a checked claim ledger, cross-validated code reviews, anonymized councils, or parallel asks, with every model and effort chosen by the user. Use only when the user explicitly asks to involve Codex, GPT, OpenAI or another model, or invokes /duo.
argument-hint: "[pair|debate|review|council|ask|continue] [-s seat ...|-p preset] [options] <task, question or focus>"
allowed-tools: Bash(duo:*), Read, Write
---

# duo: Codex x Claude sessions

`duo` runs every participant as a separate seat with exactly the model and effort given, and records everything in a run folder (`duo runs` lists them; `duo config` shows the data folder): exact prompts, replies, raw CLI event streams, reasoning where the model provides it, tool calls with outputs, tokens, Codex credits, and quota before and after.

(This skill is for Claude Code. Codex uses `$duo` with `duo-safe`.)

## The user's arguments are the spec
The user is an expert who chooses models deliberately. Pass their choices through unchanged: never swap a model, lower an effort, or pick a preset they did not ask for.

- Seat: `engine[:model][@effort][+option...]`, e.g. `codex:gpt-6-astra@xhigh+verbosity=high`, `claude:opus@max+web`.
  - Codex options: `verbosity=low|medium|high`, `summary=auto|concise|detailed|none`, `web[=live|cached|disabled]`, `tier=fast` (2x credits), `cfg:key=<toml>`.
  - Claude options: `web` (WebSearch), `fetch` (WebFetch), `dir=PATH`.
  - Both: `name=`, `persona=@file`, `timeout=SEC`.
- Presets: `-p quick|std|deep|max` (`duo config` shows them). With no seats and no preset, duo uses the configured default; say which in one line.
- Protocol: the first word. If missing, infer it: a change to build is a pair run; a decision or design is a debate; a diff or code is a review; an open question for three or more seats is a council; quick parallel answers are an ask. Say which you chose.
- `duo models` lists the models this Codex client can use (its catalog can lag behind rollouts; duo warns but does not block).

## Run it
- Write any brief longer than one line to a file first, then pass `-f <file>`; quotes and backticks break shell arguments.
- Pass `-C <project dir>` for anything about a project. For a general question with no project, pass `--no-project` so the seats get an empty folder instead of wandering through the current one.
- Runs with high efforts or several rounds take minutes. Start them with `run_in_background: true` and `--no-print`, then wait for the completion notification without polling. Short runs can go in the foreground with a 10-minute timeout.

```
duo pair    -s WRITER -s REVIEWER [--cycles N] [--check "npm test"] [--in-place] [--network] -C DIR -f task.md
duo apply <run> [--keep-branch | --discard]
duo debate  -s SPEC -s SPEC [--rounds N] [--min-rounds N] [--chair SPEC] [--anon] (-C DIR | --no-project) -f brief.md
duo review  -s SPEC [-s SPEC] (--uncommitted | --base BRANCH | --commit SHA | --files F... | --plan FILE) -C DIR ["focus"]
duo council -s SPEC -s SPEC -s SPEC [--chair SPEC] -C DIR "question"
duo ask     -s SPEC [-s SPEC] [--chair SPEC] -C DIR "question"
duo continue <run> [--rounds N] "moderator note"
duo trace <run> | duo show <run> [--turn N --part reply|prompt|thinking|tools|raw] | duo export <run> --format html
duo quota | duo models | duo runs
```
If `duo quota` shows a window at or above 85%, mention it in one line and go ahead anyway, unless the user asked you to stay within limits.

## Pair runs
The writer works in a git worktree on a new `duo/…` branch (or `--in-place` with a snapshot), the reviewer checks every cycle, and duo runs `--check` after each writer turn. Nothing reaches the user's folder until `duo apply <run>`; ask the user before applying, keeping the branch, or discarding.

## Report back
Read `report.md` (its path is printed at the end), then give the user:
1. The outcome line: converged, NOT converged, stalled, deadlocked or blocked, how many rounds or cycles, which seats.
2. The answer the seats agree on. If they did not converge, show the competing final positions side by side. Never present non-convergence as agreement. If the report says the verdicts agree but claims are still open, say so plainly: the seats may have crossed over to each other's earlier positions.
3. Disputed claims with each side's reason, and any failed citations.
4. The cost (Codex credits, Claude API-equivalent, quota change) and the run id, for `duo trace` and `duo continue`.

Offer `duo export <run> --format html` when a shareable page would help.

## Your role
You operate the harness; you are not a participant. Keep your own opinion out of the run unless the user asks for it, and label any commentary you add afterwards as yours. Debate, review, council and ask seats are read-only; a pair writer edits only its own worktree. You make any other change, and only after the user agrees.

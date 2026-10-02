---
name: duo
description: Run a traceable multi-model session between Claude (the user's Claude plan) and OpenAI Codex (the user's ChatGPT plan) with the duo harness - debates that converge on a checked claim ledger, cross-validated code reviews, anonymized councils, or parallel asks, with every model and effort chosen by the user. Use only when the user explicitly asks to involve Claude, Anthropic or another model, or invokes $duo.
---

# duo: Claude x Codex sessions

`duo-safe` runs every participant as a separate seat with exactly the model and effort given, and records everything in a run folder: exact prompts, replies, raw event streams, tool calls, tokens, credits, and quota before and after. It is the restricted entry point of the duo harness: read-only seats only (no pair mode), no raw Codex config passthrough and no WebFetch.

## How to run it (important)
- `duo-safe` needs network access, so it runs outside your sandbox. `~/.codex/rules/duo.rules` pre-approves it, but only when it is ONE plain command: no pipes, redirections, heredocs, `$(...)`, `&&`, or `VAR=value` prefixes.
- So write any brief longer than one line to a file in the temp folder first, then pass it with `-f <that file>`.
- If the command still asks for approval, the ChatGPT app has not loaded the rule yet (it needs a restart). Ask the user to approve it.
- Runs take from 30 seconds to many minutes, depending on effort and rounds. Wait for them to finish.

## The user's arguments are the spec
The user is an expert who chooses models deliberately. Pass their choices through unchanged: never swap a model, lower an effort, or pick a preset they did not ask for.

- Seat: `engine[:model][@effort][+option...]`, e.g. `claude:opus@max`, `codex:gpt-6-astra@xhigh+verbosity=high`, `claude:sonnet@high+web`.
  - Codex options: `verbosity=`, `summary=`, `web[=mode]`, `tier=fast`.
  - Claude options: `web`, `dir=PATH`.
  - Both: `name=`, `persona=@file`, `timeout=SEC`.
- Presets: `-p quick|std|deep|max`. With no seats and no preset, duo uses the configured default; say which in one line.
- Protocol: the first word. If missing, a decision or design is a debate, a diff is a review, an open question for three or more seats is a council, and quick parallel answers are an ask.

```
duo-safe debate  -s SPEC -s SPEC [--rounds N] [--chair SPEC] [--anon] (-C DIR | --no-project) -f /tmp/brief.md
duo-safe review  -s SPEC [-s SPEC] --uncommitted -C DIR "focus"
duo-safe council -s SPEC -s SPEC -s SPEC [--chair SPEC] -C DIR -f /tmp/question.md
duo-safe ask     -s SPEC [-s SPEC] -C DIR -f /tmp/question.md
duo-safe continue RUN --rounds 1 "moderator note"
duo-safe trace RUN
duo-safe quota
```

## Report back
Read the `report.md` whose path is printed at the end, then give the user:
1. The outcome: converged, NOT converged or stalled, how many rounds, which seats.
2. The agreed answer. If the seats did not converge, show the competing final positions side by side. Never present non-convergence as agreement.
3. Disputed claims with each side's reason, and any failed citations.
4. The cost and the run id.

You operate the harness; you are not a participant. Label any commentary you add as yours. Seats are read-only; you make any changes, and only after the user agrees.

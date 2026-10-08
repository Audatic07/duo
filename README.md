# Duo

**Claude Code and Codex in one desktop app.** Chat with either, run them side by side, or let them work on the same problem together: one writes the code while the other reviews it, they debate until every claim is agreed, or they cross-check each other's code reviews. Every prompt, tool call, token and credit is recorded.

Duo drives the official CLIs you already use, signed in with your own plans: [Claude Code](https://docs.claude.com/claude-code) (Claude subscription) and the [Codex CLI](https://github.com/openai/codex) (ChatGPT subscription). Nothing goes through a third-party server.

Runs on Linux, macOS and Windows.

![Duo home screen with the unified composer and animated mode walkthroughs](docs/screenshots/home.png)

## Modes

| Mode | What happens |
|---|---|
| **Chat** | Claude Code or Codex in a project folder (or none), streaming: thinking, commands with their output, file edits as diffs, plans. Pick model, effort and permissions per chat. |
| **Side by side** | One message, two answers. Hand either answer to the other for a critical review in one click. |
| **Pair** | One model writes the code in its own git worktree, the other reviews every change, and they cycle until the writer says done, the reviewer approves, and your check command passes. You then apply the result, keep the branch, or discard it. |
| **Debate** | Blind first answers, then cross-examination over a claim ledger. After discussion ends, every model reviews the frozen ledger and records agreement or disagreement on every peer claim. File citations are verified against your code. |
| **Review** | Independent code reviews of a diff, then each reviewer confirms or rejects the others' findings. Issues found by both are the strongest signal. |
| **Council** | Several answers, ranked anonymously by peers who never see their own; a chair writes the synthesis and keeps the dissent. |
| **Ask** | The same question to several models in parallel, answers side by side. |
| **Custom** | Define roles, model assignment and switching, message routes, completion and exceptions, with bounded persistent memory. Describe a method to your chosen model to generate an editable template. |

The app shows an animated walkthrough of each mode on its home screen and next to the run form.

## Install

You need:

- **Node.js 22.18 or newer** (Duo runs its TypeScript sources directly).
- **git** (pair mode and the Changes panel use it).
- **Claude Code**, installed and signed in: run `claude` once and use `/login`.
- **A ChatGPT account for Codex**: Duo bundles a pinned Codex CLI; sign in with `npx codex login` from the Duo folder, or through the ChatGPT desktop app.

```bash
git clone https://github.com/Audatic07/duo.git
cd duo
npm install
node bin/duo.js setup
duo doctor
```

For a versioned release, download the source bundle and `SHA256SUMS` from [GitHub Releases](https://github.com/Audatic07/duo/releases), verify the checksum, extract it, and run `npm ci` followed by `node bin/duo.js setup` in the extracted folder. Bundles include the built GUI and require the same Node.js, Git and CLI sign-ins as a checkout. See the [0.3.0 release notes](docs/releases/0.3.0.md).

`duo setup` adds an app launcher (the application menu on Linux, `~/Applications/Duo.app` on macOS, the Start menu on Windows), the `duo` and `duo-safe` commands, a `/duo` skill for Claude Code, a `$duo` skill for Codex, and a Codex rule that pre-approves `duo-safe`. `duo setup --uninstall` removes all of it.

Then open **Duo** from your launcher, or run `duo gui`.

Notes:

- `npm install` builds or downloads one native module (`re2`, used by claw-orchestrator). If your npm asks to approve install scripts, approve `re2` and `electron`.
- `duo doctor` (or **Settings → Setup check** in the app) checks both CLIs, their sign-ins and versions; **Test both sign-ins** sends one tiny message through each to prove they work.

## The desktop app

- **Home**: one box for everything. Type, pick Claude, Codex, Both, Pair, Debate, Council, Ask or Review, press Enter.
- **Chats**: live tool steps, thinking, diffs and plans; Claude permission modes from *Plan* to *Full access*, with *Ask before acting* approval cards; Codex sandbox modes; switch model or effort mid-conversation without losing the thread; retry, copy, hand an answer to the other model, or escalate a question to a debate, council or pair run.
- **Runs**: a live view of every seat while it works, the rounds or cycles as they land, the claim ledger, findings, rankings, the report, and every turn's exact prompt, reply, tool calls and reasoning. Stop a run at any time; continue a finished one with a note.
- **Always in view**: both plans' 5-hour and weekly usage, the project's git changes, and a token, time and cost trace.
- **Quality of life**: command palette (`Ctrl/⌘ K`), keyboard shortcuts (`Ctrl/⌘ /`), pinned chats, search, drafts that survive restarts, desktop notifications when a long run finishes in the background, light and dark themes.

## Pair mode

![Pair mode setup with writer and reviewer seats and workspace controls](docs/screenshots/pair.png)

```
duo pair -s codex:gpt-6-sol@high -s claude:opus@high --check "npm test" -C ~/code/app "Add rate limiting to the login endpoint"
```

1. Duo creates a git worktree on a new `duo/…` branch from `HEAD` (or, with `--in-place`, snapshots the folder so it can show and revert exactly what changed).
2. The **writer** (first seat) implements the task, runs what it can, and reports what it did.
3. Duo runs your **check command**, if you gave one.
4. The **reviewer** (second seat, read-only) verifies the diff against the request and approves or files findings with severity, location and fix.
5. The writer fixes or disputes each finding; repeat.

It stops when the writer reports done, the reviewer approves with no P0/P1 finding open, and the check passes. It also stops if the writer is blocked, if the two deadlock on a finding (you decide), or at the cycle cap. Nothing touches your folder until you choose **Apply** (`duo apply <run>`), **Keep branch**, or **Discard**.

Writer permissions: *Sandboxed* (Codex `workspace-write`; Claude auto-accepts edits and runs commands in its sandbox where available), *Sandboxed + network*, or *Full access*.

## Custom coordination templates

Choose **Custom** in the app to build a method visually: define roles, connect workflow steps, choose shared context, add conditions and set memory retention. A **New method** can select any of the five **Operation libraries** and add their stages directly; prompts, settings, model selectors and native response fields are editable. JSON is available only when you select its alternate editor. Use **Describe with AI** to have your chosen model generate or revise a draft in the same visual builder, then save or run it with your seats and brief. You can also copy any built-in method.

Templates are versioned JSON state machines with roles, eligibility and score-based assignment, conditional role changes, selective message routing, output schemas, completion rules, exceptions and execution budgets. Named memory channels specify the fields retained, who reads and writes them, whether they survive across runs, and maximum entries and characters. Role changes happen between model turns. Each run saves its exact definition and workflow state.

The five existing modes now run through the same executor, using trusted operations for their claim ledgers, anonymous rankings, finding merges and pair workspaces. Debate adds a final ledger review; Continue preserves its decisions and model sessions. Memory retention controls the state referenced by future turns; Duo’s full audit trace and model CLI conversation files remain separate records.

See the [template specification](docs/templates.md) and [complete example](docs/templates/example.json).

```bash
duo template generate -s claude:opus@high -o method.json "Two researchers, a skeptic, then a decision maker; retain only decisions"
duo template validate method.json
duo template save method.json
duo template run method.json -s codex:gpt-6-sol@high -s claude:opus@high --no-project "Choose a storage design"
```

## Command line

Every mode the app runs is also a command.

```
engine[:model][@effort][+option...]

codex:gpt-6-astra@xhigh+verbosity=high+summary=detailed
codex:gpt-6-sol@high+web=live+tier=fast
claude:opus@max+web
claude:sonnet@medium+name=Skeptic+persona=@~/personas/skeptic.md
```

| option | engine | effect |
|---|---|---|
| `verbosity=low\|medium\|high` | codex | `model_verbosity` |
| `summary=auto\|concise\|detailed\|none` | codex | `model_reasoning_summary` |
| `web[=live\|cached\|disabled]` | both | Codex web search / Claude WebSearch |
| `tier=fast` (or `+fast`) | codex | `service_tier` (2× credits) |
| `cfg:key=<toml>` | codex | raw `-c` override (sandbox, approval, shell and MCP keys are refused) |
| `fetch` | claude | WebFetch |
| `dir=PATH` | claude | extra readable directory |
| `name=`, `persona=text\|@file`, `timeout=SEC` | both | label, role instructions, per-turn timeout |

```bash
duo pair    -s codex:gpt-6-sol@high -s claude:opus@high --cycles 4 --check "npm test" -C ~/repo -f task.md
duo debate  -s codex:gpt-6-sol@high -s claude:opus@high --rounds 4 --chair claude:opus@high -C ~/repo -f brief.md
duo debate  --no-project -s codex:gpt-6-sol@high -s claude:opus@high "Postgres or SQLite for a single-user desktop app?"
duo review  -s codex:gpt-6-astra@high -s claude:opus@high --base main -C ~/repo "concurrency and error paths"
duo council -s codex:gpt-6-astra@high -s codex:gpt-6-sol@high -s claude:opus@high --chair claude:opus@max "question"
duo ask     -s codex:gpt-6-luna@high -s claude:haiku "quick question"
duo continue <run> --rounds 2 "moderator note: focus on the migration risk"
duo apply <run> [--keep-branch | --discard]
```

`duo runs` · `duo trace <run>` · `duo show <run> [--report] [--turn N --part reply|prompt|thinking|tools|meta|raw|json]` · `duo export <run> --format html|json|md` · `duo quota [--refresh]` · `duo models` · `duo doctor` · `duo config`. `Ctrl-C` cancels a run cleanly (the record is kept).

Codex efforts: none, minimal, low, medium, high, xhigh, max, ultra (per model; `duo models` lists what the bundled client offers). Claude efforts: low, medium, high, xhigh, max. Presets live in the config file (`duo config --init`).

## How the protocols keep models honest

- **Structured output** is enforced by the CLIs themselves (`--output-schema`, `--json-schema`). Answers stay prose; claims, stances, findings and verdicts become machine-checkable.
- **Citation checks**: every `path:line` citation and quote is verified against the file, and failures are shown to every seat the next round.
- **Strict convergence**: verdicts alone are not trusted. Two seats can each say "agree" while holding the other's earlier position; only a ledger where every claim is agreed by every peer counts.
- **Final ledger review**: after discussion rounds, every seat sees all final positions and the same frozen ledger, then gives an agree/disagree stance with a reason on every peer claim. This extra pass does not consume the discussion round budget. Partial agreement or uncertainty is recorded as disagreement with an explanation; incomplete reviews retry once, then fail the run rather than finish with unaddressed claims.
- **Bounded ledgers**: each seat keeps at most eight load-bearing claims, so peers can actually take a stance on all of them.
- **Fail fast**: an error retrying cannot fix (an outdated CLI, an expired sign-in, an unknown model, a plan limit) stops the run at once instead of letting the other seats spend your quota. A CLI process that died between turns is restarted on the same conversation; a model at capacity gets one retry after a pause; Codex reconnects are recorded as warnings, not failures.
- **Isolation**: discussion seats are read-only and see none of your installed Codex skills or rules; a pair writer edits only its own worktree; `DUO_DEPTH` stops any seat from starting Duo again.

## Traceability

Each run lives in its own folder in Duo's data folder (`duo config` prints it):

```
run.json        seats (+ Codex thread / Claude session ids), versions, git state, quota before/after, totals, outcome
transcript.md   every round, readable
report.md       outcome, final positions, claims, findings or cycles, usage
ledger.json     claims, evidence, citation results, stance history   (debate)
findings.json   merged findings with confirmations and rejections     (review)
council.json    anonymization maps, rankings, scores                  (council)
pair.json       cycles, checks, findings and their history            (pair)
template.json   exact coordination definition used by the run
coordination.json  workflow visits, outputs, roles and retained memory
turns/NN-<seat>-r<round>-<kind>/   prompt.md reply.md reply.json thinking.md tools.json meta.json raw.jsonl
taps/           the untouched CLI event stream of every seat
```

Codex turns are priced in plan credits from the Codex rate card (`src/pricing.ts`); Claude turns show the API-equivalent cost the CLI reports.

## Where things live

| | Linux | macOS | Windows |
|---|---|---|---|
| config | `~/.config/duo/config.json` | `~/Library/Application Support/duo/config.json` | `%LOCALAPPDATA%\duo\config.json` |
| data (runs, chats, worktrees) | `~/.local/share/duo` | `~/Library/Application Support/duo` | `%LOCALAPPDATA%\duo` |

Override with `DUO_CONFIG` and `DUO_HOME`. `DUO_CODEX_BIN` and `DUO_CLAUDE_BIN` (or `codexBin`/`claudeBin` in the config) point Duo at specific CLIs; `DUO_NODE` picks the Node.js the app uses.

## Security

The app is an Electron window over a local engine bound to `127.0.0.1`. Every API call needs a random per-launch token that only the app's own window receives; the engine refuses non-loopback `Host` headers and cross-site origins, so no web page can drive it. Model output is sanitized before it is rendered. Chats run with the permissions you pick; discussion seats are read-only; pair writers are sandboxed unless you choose full access. See [SECURITY.md](SECURITY.md).

## Using Duo from the agents

- **Claude Code**: `/duo pair codex:gpt-6-sol@high writes, claude:opus@high reviews: <task>`, or just ask for a Codex debate. The skill passes your model and effort choices through unchanged.
- **Codex**: `$duo ...` runs `duo-safe`, the restricted entry point (read-only seats, no `cfg:`, no WebFetch, no pair mode). The rule `duo setup` writes pre-approves only `duo-safe`; restart the Codex or ChatGPT app after setup.

## Troubleshooting

- **A Claude seat fails with "OAuth session expired" or "not logged in"**: run `claude` in a terminal and use `/login`, then **Continue** the run.
- **"Claude Code x.y does not support this model; version … or newer is required"**: run `claude update` (or **Settings → Setup check → Update Claude Code**).
- **"Selected model is at capacity"**: Duo retries once; try again later or pick another model.
- **The app says it needs Node.js** though it is installed: start it once from a terminal with `duo gui`, or set `DUO_NODE` to your `node` binary.
- **Codex cannot write in pair mode on Linux**: its sandbox needs Landlock or bubblewrap; choose *Full access* for the writer in a worktree, or check `codex sandbox --help`.

## Development

```bash
npm run check     # strict typecheck (engine and GUI) and all tests
npm run dev       # engine + GUI in a browser at http://127.0.0.1:47821/#dev
npm run smoke     # the desktop shell end to end, without showing a window
npm run release:prepare  # checks + build + source bundle, checksum and notes in dist/
```

The tests run the whole engine through claw-orchestrator against fake Claude and Codex CLIs (`test/fakes`), so they need no network and no account and run the same on every OS. The GUI (`gui/src`, Preact + TSX) is bundled by esbuild when the engine starts. See [CONTRIBUTING.md](CONTRIBUTING.md).

The desktop smoke check also uses fake providers and temporary data. Release tags run the platform test matrix and create a draft release for review; see [the release guide](docs/releasing.md).

```
bin/          duo, duo-safe
desktop/      Electron shell (main.cjs), preload, icons
gui/src/      the app: Shell, Chat, Run, demos (animated mode walkthroughs), styles
src/          engine: seats, protocols (pair, debate, review, council, ask, continue), hooks, pricing, quota
src/server/   local HTTP + SSE server for the app: chats, runs, permissions, git
skills/       the /duo (Claude Code) and $duo (Codex) skills
test/         unit and end-to-end tests, fake CLIs, real stream fixtures
```

## Credits

Built on [claw-orchestrator](https://github.com/Enderfga/claw-orchestrator) (MIT), which drives both CLIs as persistent sessions. Protocol ideas from Karpathy's llm-council (anonymized peer ranking), STRML/cc-debate (contradiction rounds) and TorpedoD/claude-council (dissent preservation). Inter and JetBrains Mono fonts (OFL).

Duo is not affiliated with Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic; ChatGPT and Codex are trademarks of OpenAI.

## License

[MIT](LICENSE)

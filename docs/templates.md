# Coordination templates (version 1)

A template is a JSON state machine. Duo enforces its roles, message routes, conditions, memory rules and limits between turns. It does not execute template code. A running CLI call cannot switch roles in the middle of generating its answer; conditional switches take effect before the next turn.

Use **New run → Custom** to open the visual builder. Start a **New method**, then choose an **Operation library** to recreate any shipped method, or keep custom model turns. **Workflow** connects model turns, built-in stages, role assignments, branches and finishes; select a step to edit its prompts, settings, shared context and recovery. **Roles** defines responsibilities, starting models, permissions and structured response fields. **Rules** adds conditional role changes, completion and exceptions. **Memory** controls retained content, readers, writers and budgets; **Limits** bounds execution and workspace access. Renaming roles or steps updates their references. Adding a step connects it after the selection, before a finish, or on a branch’s otherwise path. Undo/redo is available for visual edits. Select **JSON** explicitly to use the alternate editor; edits must validate before returning to the builder.

Select **Describe with AI** to describe a method, choose any supported Claude or Codex model/effort, and receive a draft in the visual builder. Describe changes and use **Update draft** again to revise it. Duo checks references, schemas, selectors and limits and gives the author model up to three drafts to repair errors. **Save template** adds it to the local library; **Start custom** runs the selected draft. Generation never starts that workflow. Built-ins can be inspected and saved as copies with a new id.

The complete runnable [example](templates/example.json) uses a proposer, skeptic and decision maker. A becomes the decision maker after B's challenge. Only the `decision` field is retained across runs.

An authoring run retains its validated result under **Draft method**. Use **Edit in visual builder** there to recover or revise it after leaving the editor. Completed workflow runs offer the same action under **Method**, using that run's exact definition.

## Required fields

- `version`: `1`.
- `id`: a letter followed by up to 63 letters, digits, `_` or `-`; local memory and saved templates are keyed by this id. Use a new id for an unrelated method.
- `name`: display name; optional `description`.
- `roles`: map of role id to `{instructions, access?, schema?}`. Access defaults to `read`; alternatives are `sandboxed` and `sandboxed-network`. Write roles require `workspace: {isolation: "worktree"}` or `"in-place"`. Worktree results retain Apply/Keep/Discard controls. Templates cannot grant full access; built-in pair uses the explicit run permission setting.
- `assignments`: `[{role, select}]`. Seats are `A`, `B`, … in run order. Selectors support `ids`, `engine` (`claude` or `codex`), exact `model`, `fromRole`, and `count`. Filters combine; seats are chosen in run order. Optional `rankBy: {step, path: "data.score", direction: "desc"}` chooses models by a numeric field in that step’s output (ascending or descending, with stable ties and missing scores last). Initial assignments must match enough seats. Each model holds one role at a time; later assignment wins. Multiple models can hold the same role.
- `start`: first step id.
- `steps`: map of step id to a node below.
- `limits`: `{maxSteps, maxTurns, maxDurationSec, maxContextChars, minSeats?}`. Bounds are 10000 steps, 1000 model turns, 86400 seconds, 1000000 context characters and 32 minimum seats. Model retries consume the turn budget. Limits stop cycles that cannot converge; a limit is recorded separately from successful completion. Fatal account/model/quota errors are never retried. User cancellation and a failure below `minSeats` override template recovery. `minSeats` defaults to 1.

## Nodes

`{type: "turn", role, prompt, next, input?, count?, parallel?, session?}` calls the models holding the role. `count` selects that many recipients, in seat order; insufficient recipients is an error. Parallel defaults to true. All recipients see a snapshot of previous messages, so independent answers remain blind. Prompt substitutions are `{{brief}}` or a dotted state path such as `{{outputs.propose.0.reply}}`. Session defaults to `role`: context is reused while a model stays in that role. `fresh` opens a clean session each visit. A role change always opens a fresh session; explicitly route any context that should survive. For strict information boundaries, use fresh sessions: a persistent session remembers earlier turns even if a later route omits them.

An `input` route is `{from, parts?, history?, excludeSelf?, limit?, anonymous?, maxChars?}`. `from` is a step or role id. A routed identifier must not name both; rename the role or step to make the source explicit. `parts` selects `reply`, `data`, or both (default reply). `history` is `latest` (latest successful message per seat) or `all`. `excludeSelf` removes the recipient's own answers. `limit` selects up to that many source models/messages, in stable order. `anonymous` substitutes Response 1/2 labels; it hides source metadata, but cannot remove an author's self-identification inside prose. `maxChars` truncates that route. The assembled prompt, routes and readable memories are bounded by `maxContextChars`. Secrets should never be placed in a brief shared with every model.

`{type: "assign", role, select, mode?, next}` changes role ownership. `mode` defaults to `replace` (replace the target role's members); `add` keeps existing members. Selected models relinquish their previous role.

`{type: "branch", cases: [{when, next}], otherwise}` takes the first matching case.

`{type: "finish", status, reason}` stops. Status is `completed`, `failed`, `blocked` (needs user input), or `limit`. Only completed counts as convergence. Reasons can use prompt substitutions.

A nonterminal node can define `onError: {action: "fail"|"skip"|"goto", next?}`. Fail is the default; goto requires a target, skip follows the node's normal next. Format errors get one local-model retry before this handler. A run abort or cancellation cannot be skipped.

## Conditions and role changes

Conditions use `{path, op, value?, valuePath?, where?}`, `{all: [conditions]}`, `{any: [conditions]}`, or `{not: condition}`. Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `exists`, `includes`, `every`, `some`. Numeric comparisons require numbers. Use `valuePath` instead of `value` to compare two state fields. Every/some compare each array value against `value`, or evaluate a nested `where` condition relative to each entry, such as `{path: "outputs.review", op: "every", where: {path: "data.approved", op: "eq", value: true}}`; every requires a nonempty array. Missing fields never satisfy comparisons; use `not` + `exists` for absence. No expression evaluation occurs.

State paths include `outputs.STEP.0.data.FIELD`, `outputs.STEP.0.reply`, `visits.STEP`, `roles.ROLE`, `vars.error`, `history`, and `memory.CHANNEL`. A schema-constrained reply is in `data`; prose is in `reply`. `vars.error` remains available to an error handler or terminal reason and clears after a successful nonterminal recovery step. Schemas use `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`), `properties`, `required`, `additionalProperties`, `items`, `enum`, and `description`. Nullable fields use a two-type union such as `["string", "null"]`, authored with **Allow null** in the maker. Duo validates replies locally too.

Optional `transitions: [{from, to, when, select?, once?}]` change matching models' roles after a step. They run in order, once each by default. Transition conditions can also inspect the candidate’s `model.id`, `model.engine`, `model.model`, `model.data` and `model.reply` (its latest successful output), so models can qualify for roles independently. `once: false` reevaluates on every step. Optional `completion: {when, reason}` ends successfully when true. Optional `exceptions: [{when, next}]` redirects to the first matching handler. Exceptions take precedence over completion. Finish nodes bypass these rules. Use explicit branches for adjudication and deadlock conditions; bounded visits can detect stalls.

## Persistent data and retention

Optional `memory` is a map of named channels. Each channel requires:

```
{"scope":"template", "readBy":["decider"], "writeFrom":["decide"],
 "parts":["data"], "paths":["decision"], "maxEntries":8, "maxChars":4000}
```

`scope` is `run` (shared between later steps of this run) or `template` (shared with later runs of this template id). `readBy` is the exact list of roles receiving the channel in their prompts. `writeFrom` is the exact list of steps whose successful replies get stored. `parts` selects reply and/or data. Optional dotted `paths` selects fields from data, so a method can retain decisions without retaining an entire answer. Models cannot write arbitrary memories outside these rules.

`maxEntries` caps entries (1–1000), `maxChars` caps total retained text (1–1000000). A too-long new entry is truncated; oldest entries are evicted until both limits hold. Retention is applied on read, save and every write, including when a saved template reduces its limits. Saving a removed channel or changing its scope to `run` clears its cross-run file. Deleting a saved method clears its template-scoped channels. Each entry records run, seat, step and time. Template channels live under Duo's data folder in `template-memory/`; the editor offers a clear action per channel, and the CLI has `duo template memory-clear ID CHANNEL`. Independent processes use an exclusive file lock, so competing writes fail visibly rather than lose entries. Do not share one id across unrelated projects if their memories should stay separate.

Memory budgets govern the material automatically referenced by models. Duo's existing audit trace (prompts, replies, reasoning, tools and CLI streams), saved reports, and the CLIs' own conversation files remain separate records. Every run saves the exact `template.json` and `coordination.json` containing visits, role ownership, routed source messages and retained memories. Changing a saved template never changes a past run. Delete a run with the existing run controls to remove its Duo audit trace; clear cross-run channels separately. A template's memory rules are not an automatic deletion policy for provider conversation storage.

## Built-in operation libraries

The five shipped methods are editable workflow definitions executed by the same state-machine runner. The maker and executor share their definitions and operation catalog. Host operations provide domain mechanics such as citation checks, ledger updates, ranking and workspace isolation; the template specifies stage order, prompts, settings, response contracts and completion requirements:

- `ask`: `ask.answers`, `ask.chair`, `ask.finish`.
- `review`: `review.independent`, `review.crosscheck`, `review.merge`, `review.chair`, `review.finish`.
- `council`: `council.answers`, `council.rank`, `council.aggregate`, `council.chair`, `council.finish`.
- `debate`: `debate.round`, `debate.resolve`, `debate.report`, `debate.chair`, `debate.finish`. A round publishes `vars.done` after convergence, stall, failure or its round cap. The shipped template routes that branch to `debate.resolve` so every participant reviews the frozen ledger and decides agree/disagree on every peer claim. This extra pass is outside the discussion round budget; missing or undecided stances retry once, then fail the run. `debate.report` and `debate.finish` never inject model turns. A saved graph without the review stage must add it in the maker or explicitly relax the finish stage’s requirements.
- `pair`: `pair.prepare`, `pair.cycle`, `pair.finish`. A cycle publishes `vars.done` after approval plus passed checks, a blocker, deadlock, failure or cycle cap.

A library template declares `library` and uses operation nodes such as `{type:"operation", use:"debate.round", next:"continue", prompts:{position:"{{nativePrompt}}"}, settings:{rounds:3}}`. **Add step → Built-in stage** offers every operation in the selected library. Each model-calling stage exposes its supported message kinds as prompt editors. `{{nativePrompt}}` includes the stage’s prepared task and evidence; surround it with instructions or replace it entirely. Prompt substitutions also include `{{brief}}`, `{{seat}}`, `{{round}}` and workflow state paths. Final ledger review additionally supplies `{{finalPositions}}`, `{{claimLedger}}`, `{{requiredClaims}}` and `{{decisions}}`; its complete default instructions are stored in the template. Operation `input` routes use the same controls as model turns, and memory is applied to the receiving role.

Debate round settings control round bounds, stance requirements, convergence, stall detection and when to focus on open claims. The final review controls allowed decisions, complete coverage and required reasons; finish controls whether a completed review and addressed claims are prerequisites. `vars.reviewComplete`, `vars.reviewAddressed` and `vars.ledger` support custom branches. Pair cycle bounds can also be saved in the stage. A round/cycle setting of `0` uses the run input. Unknown settings and prompt kinds are rejected.

Library stages honor starting model selectors; pair requires one distinct writer and reviewer. An explicit chair assignment selects one model for a fresh chair session, otherwise the optional run-level chair is used. Role instructions supplement the stage prompts. Response schemas are editable, including nullable fields; retain the machine fields that ledger, ranking and review operations consume. Use generic turn/assign nodes for arbitrary role changes or custom interactions between library stages. Additional write roles require a fully custom method with explicit workspace isolation; library templates reject those roles so they cannot bypass the native writer workspace. Operations are stateful and should keep their prerequisite order; arbitrary code and unknown operations are rejected. Optional chair, anonymity, discussion bounds, review target, pair check, isolation and writer access also remain available in the run controls below the maker. Ask, debate and pair retain Continue using the recorded template and review policy; fully custom runs start fresh and can use template-scoped memory.

## CLI

```
duo template list
duo template show debate > debate.json
duo template validate method.json
duo template save method.json
duo template generate -s claude:opus@high -o method.json "Three independent designers, a skeptic, then a decision maker; retain the decision"
duo template generate -s codex:gpt-6-sol@high --current method.json -o method.json "Give the skeptic only the two strongest proposals"
duo template run method.json -s codex:gpt-6-sol@high -s claude:opus@high --no-project "Choose a storage design"
duo template memory-clear challenge-and-decide decisions
```

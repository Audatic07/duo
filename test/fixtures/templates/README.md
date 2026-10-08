# Legacy protocol snapshots

Captured from the five original protocol implementations at commit 62925a9c9229dc86e2c99de923c0c583b0bed797, before migration to workflow definitions. The scripted scenarios in test/helpers/protocol-scenarios.ts supplied identical replies to the original and migrated protocols.

The fixture records every system prompt, exact user prompt and turn order, output-schema SHA-256 fingerprints, access settings, outcomes, complete reports, and ledger/finding/ranking/pair artifacts. Only temporary paths, Git commit hashes, generated branch salts and command durations are normalized. Model reasoning quality is outside this deterministic comparison. The separate engine tests drive real claw-orchestrator sessions against fake Claude and Codex CLIs.

Temporary paths include Windows separators and native aliases. Scripted repositories disable Git line-ending conversion so a clean checkout does not introduce a content change into the snapshots.

`debate-ledger-review.json` records the intentionally updated debate behavior: discussion ends with a separate review of the frozen ledger, every peer claim receives an agree/disagree stance, and an unusable participant fails the run. The original debate snapshots remain in `legacy-protocols.json` for reference; the other protocols still compare against that original fixture. `test/debate.test.ts` additionally checks late revisions, complete stance coverage, retries, failure, early stops, copied templates, editable stage settings, explicit stage ordering, and continued debates.

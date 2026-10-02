# Contributing to Duo

Thanks for helping. Duo is small on purpose: a thin, well-tested layer over the two official CLIs and claw-orchestrator. Changes that keep it that way are the easiest to accept.

## Set up

```bash
git clone <your fork> duo && cd duo
npm install
npm run check
```

Node.js 22.18 or newer runs the TypeScript sources directly; there is no build step for the engine. The GUI is bundled by esbuild when the engine starts (`node src/server/main.ts --port 47821 --token dev`, then open `http://127.0.0.1:47821/#dev`).

## Tests

`npm run check` type-checks the engine and the GUI and runs every test. The end-to-end tests drive the real engine and claw-orchestrator against fake CLIs in `test/fakes`, so they need no account, no network and no quota, and they run the same on Linux, macOS and Windows. When you fix a bug, add a test that fails without the fix; when the fake CLIs need a new behaviour to reproduce a bug, add a `FAKE_*_MODE` for it.

Changes that only a real model can show (prompt wording, new CLI flags) should say in the pull request which models you tried them with.

## Style

- TypeScript in strict mode with `erasableSyntaxOnly` (no enums, no parameter properties): the sources must run under Node's type stripping.
- Platform differences go in `src/platform.ts` and `src/bins.ts`, not scattered through the code. No shell scripts: Duo must work on Windows.
- Comments explain why, briefly. User-facing text is plain and specific.
- Keep the security model intact: the engine listens on loopback only and every API call carries the launch token; model output is never rendered without sanitizing; discussion seats stay read-only.

## Pull requests

Keep them focused, describe the change and how you tested it, and update `README.md` and `CHANGELOG.md` when behaviour changes. By contributing you agree that your contribution is licensed under the MIT license.

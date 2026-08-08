# Contributing

Thanks for wanting to make the tools artists work in agent-native. This page
is short on purpose; the two documents that actually govern the code are:

- [`intel/plugin-standard.md`](intel/plugin-standard.md) — the pattern every
  plugin follows, and the verification bar a plugin must clear before it ships.
- [`intel/executor.md`](intel/executor.md) — verified facts about the Executor
  runtime, with provenance. If you learn something new about the runtime, it
  goes there, with its source. No claim without provenance.

## Setup

```bash
bun install
bun run ci        # lint, typecheck, test, build — what CI runs
```

Tests run against synthetic fixtures and need nothing installed beyond bun.

## Adding a plugin

1. Read `intel/plugin-standard.md` first. It is the contract, not a
   suggestion: engine separated from tool surface, few whole-job tools, a
   declarative idempotent sync where bulk writing exists, destructive paths
   opt-in, tests that assert on files read back.
2. Copy the shape of `packages/executor-plugin-scrivener` — it is the
   reference implementation.
3. Name it `packages/executor-plugin-<tool>`, npm scope
   `@artists-so/executor-plugin-<tool>`, integration id `<tool>_native`.
4. Document the target tool's format or API facts in `intel/<tool>-*.md` as
   you establish them. Facts you verified yourself, with the method stated.

## Clean-room policy

Plugins here are MIT. Knowledge extracted from GPL/AGPL or proprietary
implementations enters this repository only as documented facts in `intel/`
(file formats and wire protocols are facts; code is code). Never port code
from incompatibly-licensed projects. If you used one to learn, say so in the
intel file.

## Pull requests

- One plugin or one concern per PR.
- Include a changeset (`bun run changeset`) for anything that should publish.
- CI must be green; for plugin changes, state in the PR that you loaded the
  built plugin into a real Executor daemon and called its tools (the
  verification bar in the standard).
- By contributing you agree your contribution is your own work and is
  licensed under the repository's MIT licence.

## Conduct and contact

Be direct about code, generous with people. Security or conduct concerns:
open an issue or contact the maintainers via the org profile.

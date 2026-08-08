# The artists.so plugin standard

The pattern every plugin in this repository follows.
`packages/executor-plugin-scrivener` is the reference implementation; when this
document and that package disagree, fix one of them in the same commit. The
constraints marked `[exp]` are established empirically in `intel/executor.md`
§4–§5 — re-verify them when the executor version moves.

## Package shape

```
packages/executor-plugin-<name>/
  package.json        MIT, type: module, files: [dist, server.js],
                      publishConfig.access public, repository.directory set
  README.md           the package's public face: install, tools table, examples, caveats
  LICENSE             copy of the root MIT text (npm packs per-package)
  server.js           one-line shim re-exporting ./dist/server.js   [exp: required]
  tsconfig.json       strict, declaration on, outDir dist
  src/
    server.ts         definePlugin + tool() declarations ONLY — no domain logic
    <engine>.ts       the domain engine, importable without the SDK
  test/
    fixture.ts        builds a synthetic project/document shaped like the real
                      tool's output — CI must run with nothing installed
    engine.test.ts    bun:test against a COPY of the fixture; an env var
                      (e.g. SCRIV_TEST_PROJECT) swaps in real user data locally
  dist/               built, never committed
```

The lockfile lives at the workspace root (bun workspaces), not in the package.
Releases go through changesets (`bun run changeset`); CI is
`bun run ci` = lint (oxlint, deny-warnings) + typecheck + test + build.

Rules that make it a standard rather than a habit:

1. **Engine and surface stay separate.** Everything that understands the
   domain (file formats, APIs, invariants) lives in engine modules that import
   nothing from `@executor-js/sdk`. `server.ts` only declares tools and
   delegates. This is what lets the same engine back an MCP server, a CLI, or
   the next runtime without a rewrite — the transport is the throwaway part.
2. **Few, whole-job tools.** A tool per *intent* (read the world, declare the
   desired state, read one thing, write one thing), not per API endpoint.
   Scrivener ships exactly four. A declarative bulk tool (`*_sync` taking the
   intended state, matching by identity, idempotent, with `dryRun`) replaces
   dozens of imperative calls and removes the half-edited failure mode.
   Second run of the same input must be a no-op — test it.
3. **Destructive paths are opt-in.** Nothing deletes unless the argument says
   so (`prune`), and `dryRun` is supported wherever state changes.
4. **Tool descriptions are written for an agent**: what it does, when to use
   the other tool instead, what to call first, what is rejected and why. The
   description is the API's documentation surface — the agent will not read
   the README.

## package.json (canonical)

```jsonc
{
  "name": "@artists-so/executor-plugin-<name>",
  "license": "MIT",
  "type": "module",
  "files": ["dist", "server.js"],
  "exports": {
    "./server": { "types": "./dist/server.d.ts", "default": "./server.js" }
  },
  "scripts": {
    "build": "bun build src/server.ts --outdir dist --target node --format esm --sourcemap=external && tsc --emitDeclarationOnly",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": { "@executor-js/sdk": "<pin to executor version>" },
  "peerDependencies": { "effect": "<the SDK's pinned beta>" }
}
```

- `server.js` shim at the root: the executor binary resolves
  `<package>/server` without reading `exports`. `[exp]`
- `bun build` (full bundle): bare imports in plugin code do not survive the
  binary's jiti; only Node builtins may stay external. Do NOT copy upstream's
  tsup-with-externals config — it works in their monorepo, not against the
  compiled binary. `[exp]`
- Pin `@executor-js/sdk` to the installed executor's version; `effect` to the
  SDK's own beta pin.

## server.ts (canonical skeleton)

```ts
import { definePlugin, Effect, tool } from '@executor-js/sdk/core'; // never from 'effect'
import { z } from 'zod';

const args = z.object({ path: z.string().describe('...') });

export const plugin = definePlugin(() => ({
  id: '<name>_native' as const, // must not collide with any integration slug — collision is silent
  packageName: '@artists-so/executor-plugin-<name>',
  storage: () => ({}),
  staticIntegrations: () => [{
    id: '<name>_native', kind: '<name>_native', name: '<Name> (native)',
    canRemove: false, canRefresh: false, canEdit: false,
    tools: [
      tool({
        name: 'thing_read',
        description: 'Agent-facing: when, why, what to call first.',
        inputSchema: args,                   // zod 4.4+ satisfies StaticToolSchema
        annotations: { readOnlyHint: true }, // on every non-writing tool
        execute: (raw: unknown) =>           // inference does not reach here — parse
          Effect.gen(function* () {
            const a = args.parse(raw);
            // delegate to the engine; wrap promises in Effect.tryPromise
          }),
      }),
    ],
  }],
}));

export default plugin;
```

Long-lived state (parsed projects, connections) lives in a module-level cache
keyed by identity — the whole point of being in-process is that this survives
between calls. A cache over files someone else can edit must be
**self-healing**, not flag-operated:

1. At parse time, record a **content digest** of the source bytes (digest,
   not mtime — sync clients preserve timestamps).
2. On every load, compare digests and re-read transparently on drift. No one
   remembers a `reload` flag; keep the flag only as an explicit override.
3. Before every write, compare again and refuse on drift: *never replace
   bytes you have not seen.* The error names the likely writer and the
   remedy.
4. Digests cannot see another app's **unsaved** in-memory state. If the
   host application holds documents in memory (Scrivener does), add a
   process-level hazard check (`pgrep`) on mutating tools, overridable with
   an explicit `force` argument that documents the risk in its description.

The scrivener plugin's `guard.ts` + `project.ts` (`changedOnDisk`) are the
reference implementation; `intel/scrivener-format.md` § Concurrent access has
the observed failure this protects against.

## Refusals are data, never failures

A failed tool reaches the caller as `Internal tool error [<id>]` with the
message kept in the daemon log (`intel/executor.md` § 6.1). So a plugin must
split its unhappy paths in two:

- **Refusals** — anything the caller could act on: a lock held elsewhere, a
  write conflict, a name the host application does not define, an id that does
  not exist. Return `{ refused: <code>, message }` *in place of* a result, never
  beside one, so a caller reading fields cannot mistake it for success. Model
  them as one `Refusal` error class thrown from deep code and converted to data
  at the tool boundary — one wrapper, no per-tool handling.
- **Faults** — bugs. Let them fail; an opaque id plus a log line is the right
  trade for something no caller can fix.

Do not hand-write validation of the input schema: the runtime validates
`inputSchema` before the handler and returns the issues intact.

Test refusals through `handler({ args, ctx, elicit })` rather than the internals,
because delivery is the part that breaks.

## Documented output is generated

Sample responses in a README rot silently, and a plugin's response shape is the
part users write code against. Render it: a `samples` script that calls the real
handlers against the fixture and writes a committed document, plus a
`samples:check` that fails when a fresh render differs (`bun run docs:check` at
the root runs it for every package that has one). Elide uuids and temp paths so
re-rendering is a clean diff.

## Verification bar (all of it, before a plugin is "done")

1. `bun run typecheck` clean — no `any`, `exactOptionalPropertyTypes` on.
2. `bun test` green, tests running against a **copy** of the synthetic fixture
   (and, locally, of real data via the env-var mode), asserting on **files
   read back**, not on return values. Include: idempotency of sync (a second
   identical run reports *zero* field updates, not just zero creations),
   dry-run writes nothing, unknown vocabulary refused with the valid options
   named, round-trip fidelity of any format conversion, and every refusal
   asserted through `handler` to prove it is delivered as data.
2b. `bun run samples:check` clean — the committed sample output is what a fresh
   render produces.
3. Loaded end to end: `bun install --force` in the consuming scope (bun copies
   `file:` deps — stale copies lie), `executor service restart`, error log
   clean, then the read tool and the sync tool called for real:
   CLI (`executor call <id> <tool> '<json>'`) and sandbox
   (`tools.<id>.<tool>({...})`).
4. Health check after restart: a plugin that throws on load takes the daemon
   down and launchd loops it. `daemon.error.log` is the first stop, always.

## Licensing

MIT, clean-room. Facts about a file format or a wire protocol are not
copyrightable; code is. Knowledge extracted from AGPL or proprietary
implementations enters this repository as *documented facts in intel/*, never
as ported code. (This is why `intel/scrivener-format.md` exists — the AGPL
`scrivener-mcp` fork it replaced is retired and nothing of it is copied here.)

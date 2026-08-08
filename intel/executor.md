# Executor — verified operating intel

Ground truth for working with Executor in this workspace. Every claim carries
its provenance: a source file in `UsefulSoftwareCo/executor`, a command output,
or a controlled experiment run on this machine. If a claim has neither, it does
not belong in this file. Verified against **executor 1.5.40** on 2026-08-08;
re-verify the experiment-tagged facts after any upgrade.

Provenance tags: `[src: path]` = repo source read directly. `[cli]` = command
output on this machine. `[exp]` = controlled experiment on this machine, method
noted. `[types]` = shipped `.d.ts` in `@executor-js/sdk@1.5.40`.

---

## 1. What Executor is, operationally

- Local daemon + web UI + CLI. One MCP endpoint at `http://127.0.0.1:<port>/mcp`
  exposing an `execute` tool that runs sandboxed TypeScript against all
  configured integrations. `[cli: executor --help]`
- Repo: `github.com/UsefulSoftwareCo/executor` (MIT). Docs live in `apps/docs`
  (Mintlify), also `executor docs` opens them. `[cli] [src: apps/docs/]`
- Install channel here: npm global (`~/.nvm/.../lib/node_modules/executor`), a
  **compiled Bun binary** at `bin/executor`. Several Node behaviours differ
  inside it — see §5. `[cli: readlink]`

## 2. Service management — use `executor install`, never hand-rolled units

- `executor install --port <p>` writes an OS-supervised unit (launchd label
  `sh.executor.daemon` on macOS) running
  `<executor> daemon run --foreground --port <p> --hostname 127.0.0.1`.
  `[src: apps/cli/src/service.ts]`
- The unit pins env at install time: `EXECUTOR_SUPERVISED=1`,
  `EXECUTOR_DATA_DIR`, `EXECUTOR_SCOPE_DIR` (defaults to the data dir if the
  installing shell does not set it), `EXECUTOR_SERVICE_VERSION` (drift
  detection), and the installing shell's `PATH` (launchd gives a bare PATH
  otherwise). **Set data dir and scope dir in the environment of the `install`
  command itself.** `[src: service.ts serviceEnvironment()]`
- This scope's install:
  `EXECUTOR_DATA_DIR=$PWD/.executor EXECUTOR_SCOPE_DIR=$PWD executor install --port 4790`
  run from `/Users/flo/personal/writing`. `[cli]`
- Manage with `executor service status | restart | uninstall`. Logs:
  `<data-dir>/logs/daemon.log` and `daemon.error.log`. `[cli]`
- Bearer token lives in `<data-dir>/server-control/auth.json` (0600), kept out
  of the unit file. Read the token from there — **not** by scraping logs.
  Port discovery: `server.json` in the data dir. `[src: service.ts] [cli]`
- `executor install` fails with `Bootstrap failed: 5` if the label is already
  loaded; `launchctl bootout gui/$UID/sh.executor.daemon` first. `[exp]`
- After `service restart` the HTTP endpoint takes ~10–15 s to come up; poll
  `/api/health` with the bearer token not required. `[exp]`

## 3. `executor.jsonc` — the scope file

Accepted keys (anything else is silently dropped by the schema decode):
`$schema`, `name`, `plugins`, `integrations`, `secrets`.
`[src: packages/core/config/src/schema.ts ExecutorFileConfig]`

- `plugins`: `[{ package: string, options?: object }]`. Resolved as npm
  packages **from the jsonc's own directory** (`createRequire` anchored at the
  jsonc path), importing `<package>/server`, whose default export must be the
  `definePlugin(...)` factory. Loaded through jiti with
  `interopDefault: true, moduleCache: false`.
  `[src: packages/core/config/src/load-plugins.ts]`
- `integrations`: declarative array — `openapi | graphql | mcp(remote) |
  mcp(stdio)` structs. An MCP stdio server can therefore be registered in the
  file (`kind: "mcp", transport: "stdio", name, command, args?, env?`) instead
  of through the database. `[src: schema.ts]`
  - CORRECTION: earlier work in this workspace edited `connection` rows in
    `data.db` with sqlite3 to register/repair an MCP integration. Unnecessary —
    `integrations` existed. Do not repeat.
- Host-injected deps are merged into plugin options (`{...deps, ...options}`);
  `definePlugin` strips keys the factory does not declare.
  `[src: load-plugins.ts]`

## 4. Plugin loading in the compiled binary — three verified constraints

Method for all three: fresh `bun install --force` of the plugin into the scope
(no stale-copy confound), `executor service restart`, read
`daemon.error.log`. Each failure mode was reproduced, then fixed, on 2026-08-08.

1. **`<package>/server` must exist as a literal `server.js` at the package
   root.** The binary's `createRequire().resolve()` does not read `exports`
   maps: both the conditional form and the plain-string form
   (`"./server": "./dist/server.js"`) fail with
   `Cannot find module '<pkg>/server'`. Keep an `exports` map for tooling, but
   point its `default` at the root shim so every resolver lands on the same
   file. `[exp]` (Upstream's own example plugin relies on the exports map —
   `[src: packages/plugins/example/package.json]` — which works for the
   monorepo/host-app path, not for this binary. Candidate upstream issue.)
2. **The entry must be a fully self-contained bundle.** Any bare import in
   plugin code (even `zod` present in the scope's node_modules) makes jiti's
   native import fail inside the binary and fall back to a Babel transform the
   binary does not ship. The error names the symptom, not the cause:
   `Cannot find module '../dist/babel.cjs' from '/$bunfs/root/main.js'`.
   Node builtins (`crypto`, `fs/promises`, `path`) are fine unbundled.
   Build: `bun build src/server.ts --outdir dist --target node --format esm`.
   `[exp]` (Upstream's example externalises `effect` and the SDK —
   `[src: packages/plugins/example/tsup.config.ts]` — same caveat as above.)
3. **A plugin that throws during load takes the whole daemon down**, and
   launchd restarts it into the same failure. `daemon.error.log` shows the
   loop. Health check + error log after every plugin change. `[exp]`

Also verified: a bundled copy of `effect` inside the plugin interoperates with
the host's copy (tools execute, Effect values cross the boundary). `[exp: ping
tool + all four scrivener tools ran]`

## 5. The SDK plugin contract

`[types: @executor-js/sdk/dist/plugin.d.ts]`

- `definePlugin(factory)` → default export. Factory returns
  `{ id, packageName, storage, staticIntegrations: () => [...] }`.
- A static integration: `{ id, kind, name, canRemove, canRefresh, canEdit,
  tools: [tool({...})] }`. The integration `id` must not collide with an
  existing integration slug in the scope — collisions are silent. `[exp]`
- `tool({ name, description, inputSchema?, outputSchema?, annotations?,
  execute })`. `execute` returns an `Effect`. Import `Effect` from
  `@executor-js/sdk/core`, not from `effect`.
- `inputSchema` is a Standard Schema: `StandardSchemaV1 & StandardJSONSchemaV1`
  (`~standard.validate` + `~standard.jsonSchema`). **Zod 4.4+ satisfies it**
  (runtime keys verified: `validate, vendor, version, jsonSchema`). `[exp]`
- **`execute` arg-type inference does not survive into consumer packages** —
  the parameter contextually types as `any`. Do not accept that: type the
  parameter `unknown` and parse with the same Zod schema inside `execute`.
  Costs one line, restores real types, and stops trusting upstream validation.
  `[exp: tsc probe]`
- Effect version pin: SDK 1.5.40 pairs with `effect@4.0.0-beta.59`. `[cli]`

## 6. Calling tools

- CLI: `executor call <integration> <tool...> '<json>'` — e.g.
  `executor call scrivener_native binder_read '{"path":"..."}'`. Needs
  `EXECUTOR_DATA_DIR` set to the scope's data dir. `[cli]`
- Discovery: `executor tools integrations`, `executor tools search "<query>"`,
  `executor tools describe`. `[cli]`
- Sandbox (`execute` over MCP): `tools.<integration_id>.<tool>({args})` for
  static plugin integrations — e.g. `tools.scrivener_native.binder_read({...})`.
  MCP-sourced integrations get `tools.<slug>.<owner>.<connection>.<tool>`.
  `tools` is a lazy proxy and cannot be enumerated; `tools.search({ query })`
  or `tools.search({ namespace, query: "" })`. `[exp] [cli]`
- Destructive core tools pause for approval; resume with
  `executor resume --execution-id <id> --action accept --content '{}'`. `[cli]`
- A successful call answers `{ ok: true, data: <tool result> }` in the sandbox.
  `[exp]`

### 6.0 Measured cost, 2026-08-09 `[exp]`

Same machine, same question (binder of a 204-item Scrivener project), medians.
Superseded the earlier "~0.1 s round trip / ~1.7 s spawned" figures, both of
which were wrong: the first was a cold call, the second an unoptimised server.

| Path | Cost |
| --- | --- |
| Spawned stdio MCP server, per call (20 warm runs unavailable — 5 runs, 654–1497 ms) | 660 ms |
| Native plugin, MCP round trip, warm (20 runs, 7–25 ms) | 14–16 ms |
| Native plugin, in-sandbox call only | 5–7 ms |
| Native plugin, first call after restart (parses the project) | ~110 ms |
| Engine alone: parse the project from disk | 2.7 ms |
| Engine alone: answer from the parsed project | 0.4 ms |

The engine numbers matter for framing: **parsing is not the expense.** A spawned
call spends its time on process start, module load, server init and protocol
negotiation. Quote the round-trip numbers for user-facing claims and the engine
numbers when explaining where the time goes.

### 6.1 Tool failures are opaque to the caller — design around it

Verified 2026-08-09, executor 1.5.40. `[exp]`

- **Anything a tool fails with reaches the caller as `Internal tool error
  [<8-hex correlation id>]`.** The message is dropped. This holds for
  `Effect.fail(new Error(msg))`, for a throw inside `Effect.tryPromise`, and for
  a throw inside the promise a tool awaits — three separate probes, all
  identical to the caller.
- The real message is written to the daemon log only:
  `daemon.log` → `tool dispatch failed ToolInvocationError: <message>` with
  `executor.correlation_id`, and a bare `Internal tool error [<id>]` in
  `daemon.error.log`. Useful for a human debugging, useless to an agent.
- **`inputSchema` violations are the exception**: the runtime validates before
  the handler and returns the offending issues to the caller intact (path,
  expected, message). No plugin-side handling needed.
- Consequence for design: any condition the caller could act on — a lock, a
  conflict, an unknown enum value, a missing id — must be **returned as data**,
  not failed. The scrivener plugin's `refusal.ts` is the reference: expected
  conditions become `{ refused: <code>, message }` in place of a result, and
  only genuine faults are left to fail (where an opaque id plus a log line is
  the right trade).
- `handler` signature, for testing a tool the way the runtime calls it:
  `handler({ args, ctx, elicit })` → `Effect`. Note `handler`, not `execute` —
  `tool()` renames it. `[types: plugin.d.ts StaticToolHandlerInput]`

## 7. Scope-local traps

- **bun installs `file:` dependencies as copies, not symlinks.** After editing
  plugin source: `bun run build` in the package, `bun install --force` in the
  scope, `executor service restart`. Stale copies produced several false
  findings before this was understood. `[exp]`
- `EXECUTOR_DATA_DIR` isolates a scope's database and auth; without it the CLI
  talks to the default data dir and sees different integrations. `[exp]`
- The MCP client config for Cursor lives at `.cursor/mcp.json` with
  `Authorization: Bearer <token from server-control/auth.json>`. `[cli]`

## 8. Corrections log — false assumptions, named

Kept deliberately. Each entry is a belief that was acted on, how it was wrong,
and what corrected it.

| Was believed | Actually | Corrected by |
| --- | --- | --- |
| A hand-rolled LaunchAgent is needed for persistence | `executor install` exists, with env pinning + version drift detection | reading `executor --help` properly |
| `sources` in executor.jsonc silently ignored; DB surgery required for MCP integrations | the key is `integrations`, fully declarative | `schema.ts` |
| Bearer token must be scraped from `web.log` | durable 0600 `server-control/auth.json` | `service.ts` |
| `exports` subpath failing was probably a packaging mistake on our side | the binary's resolver reads no `exports` at all — reproduced with both forms, fresh installs | controlled experiment |
| Bundling was a workaround; externals are canonical | for this binary, full bundling is the only working form; externals fail on jiti fallback | controlled experiment |
| Earlier resolution/loading test results | some were artifacts of **stale `file:` copies** in the scope | discovering bun copy behaviour |
| A carefully worded error message is how a tool explains a refusal | the runtime replaces it with `Internal tool error [<id>]`; every guard message written for the agent was invisible to it | calling the tools through the daemon and reading what came back |

The pattern behind most of these: acting on a plausible model instead of the
five minutes it takes to read `--help`, the schema, or the loader source.
Read first.

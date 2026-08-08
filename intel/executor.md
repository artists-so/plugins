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
- Round-trip cost for a native plugin tool via MCP `execute`: ~0.1 s. `[exp]`

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

The pattern behind most of these: acting on a plausible model instead of the
five minutes it takes to read `--help`, the schema, or the loader source.
Read first.

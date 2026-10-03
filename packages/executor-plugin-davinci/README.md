# @artists-so/executor-plugin-davinci

Safe, whole-job DaVinci Resolve workflows running natively inside
[Executor](https://github.com/UsefulSoftwareCo/executor).

This is the narrow, opinionated workflow surface: probe Resolve, declare a
project, plan source ingest, organize bins, and create selects variants. It
does not reproduce Resolve's entire scripting API. Keep the broad DaVinci MCP
beside it for low-level and specialist operations.

## Requirements

- DaVinci Resolve Studio with external scripting enabled
- Python 3.10 or newer
- Executor 1.5.42 or newer

The bridge discovers Blackmagic's official `DaVinciResolveScript` module at
the standard platform path. Override Python with `ARTISTS_DAVINCI_PYTHON` or
`DAVINCI_RESOLVE_MCP_PYTHON` if required.

## Install

```bash
bun add @artists-so/executor-plugin-davinci
```

Register the package in the scope's `executor.jsonc`:

```jsonc
{
  "plugins": [{ "package": "@artists-so/executor-plugin-davinci" }]
}
```

Restart the scoped Executor service, then check the bridge:

```bash
executor call davinci_native resolve_probe '{}'
```

## Tools

| Tool | Purpose | Writes |
| --- | --- | --- |
| `resolve_probe` | Resolve version, current project, bridge and capability check | Never |
| `source_catalog_plan` | Scan source files and produce deterministic bin assignments | Never |
| `project_setup` | Create one project or reconcile settings and bin paths | Explicit reviewed apply |
| `bins_sync` | Create missing bins and import missing sources | Explicit reviewed apply |
| `selects_build` | Create an isolated selects timeline from source frame ranges | Explicit reviewed apply |

Every mutation is a two-step operation:

1. Call with `dryRun: true`.
2. Review the returned plan and call again with `dryRun: false` plus its
   `planToken`.

The token is short-lived and bound to the current Resolve readback. If Resolve
or the requested state changes between calls, apply is refused. Executor also
pauses each mutating tool for approval. Writes are then read back before the
tool reports `verified: true`.

## Safety contract

The initial release has no delete, overwrite, relink, move, or rename path.

- An existing project is never switched automatically. Open it manually.
- A source already imported in another bin is refused rather than moved.
- A selects timeline is only created as a new variant. A matching
  Artists-owned variant is a no-op; any other existing timeline with that name
  is refused rather than replaced.
- A write that Resolve cannot verify returns `status: "partial"` with its
  errors and readback. Inspect Resolve before retrying.
- Expected refusals are returned as `{ refused, message, details? }` data so
  the agent can act on the reason. Genuine bridge faults remain tool failures.

## Example

```ts
const planned = await tools.davinci_native.project_setup({
  projectName: "Cleanup",
  settings: { timelineFrameRate: "25" },
  binPaths: ["01 Sources/Day Before", "01 Sources/Wedding Day"],
  dryRun: true,
});

const applied = await tools.davinci_native.project_setup({
  projectName: "Cleanup",
  settings: { timelineFrameRate: "25" },
  binPaths: ["01 Sources/Day Before", "01 Sources/Wedding Day"],
  dryRun: false,
  planToken: planned.planToken,
});
```

See [generated tool output](docs/tool-output.md) for complete response shapes.

## Persistent bridge

The plugin starts one JSONL Python bridge lazily and keeps it alive at module
scope. Resolve's scripting module and application handle are therefore reused
across calls instead of spawning and reconnecting for every operation. If the
process exits, the next call starts a clean bridge.

The bridge is bundled with the package, uses only Python's standard library,
and calls Blackmagic's official scripting API directly.

# @artists-so/executor-plugin-scrivener

[Scrivener](https://www.literatureandlatte.com/scrivener) projects as a native
[Executor](https://github.com/UsefulSoftwareCo/executor) integration. The
`.scriv` package is parsed once and held in memory by the daemon, so a question
about a manuscript costs ~15 ms instead of the ~660 ms a spawned MCP server
pays to exist all over again. Reproduce it on your own project with
`SCRIV_PROJECT=/path/to/Novel.scriv bun run bench` (read-only).

Clean-room MIT implementation. The on-disk format facts it is built on are
documented in [`intel/scrivener-format.md`](../../intel/scrivener-format.md).

## Install

```bash
cd your-executor-scope
bun add @artists-so/executor-plugin-scrivener
```

`executor.jsonc` in the same directory:

```jsonc
{
  "plugins": [{ "package": "@artists-so/executor-plugin-scrivener" }]
}
```

Restart the daemon (`executor service restart`), then check
`<data-dir>/logs/daemon.error.log` is clean. The integration registers as
`scrivener_native`.

## Tools

Four whole-job tools. All take `path`, the absolute path to the `.scriv`
package.

| Tool | What it does |
| --- | --- |
| `binder_read` | The whole binder in one call — tree, labels and statuses resolved to names, and the vocabularies the project defines. Call this first. |
| `binder_sync` | Declarative reconcile. Give it the outline you want (folders, scenes, labels, statuses, synopses, notes, content) and it creates, retitles, reorders and updates whatever differs. Idempotent; `dryRun` to preview; deletes only with `prune`. |
| `document_read` | One document: text (RTF converted out), synopsis, word count. |
| `document_write` | One document's fields in place. For more than a couple, use `binder_sync`. |

```ts
// In the Executor sandbox:
const binder = await tools.scrivener_native.binder_read({
  path: "/path/to/Novel.scriv",
  as: "text",
});

await tools.scrivener_native.binder_sync({
  path: "/path/to/Novel.scriv",
  outline: [
    {
      title: "Act I",
      type: "Folder",
      children: [
        { title: "Scene 1", type: "Text", label: "DAWN", status: "DRAFTED",
          synopsis: "The index card.", content: "The prose itself." },
      ],
    },
  ],
  dryRun: true, // read the plan first
});
```

Or from the CLI: `executor call scrivener_native binder_read '{"path":"..."}'`.

**[What each tool answers with](docs/tool-output.md)** — real responses,
generated from the test fixture by `bun run samples`, refusals included.

## Refusals

Conditions with an obvious remedy are answered, not thrown:

```json
{
  "refused": "scrivener-open",
  "message": "Scrivener is running on this machine. If this project is open in it, writes made now will be silently overwritten by its next auto-save. Quit Scrivener and retry, or pass force: true if a different project is open."
}
```

**Check for `refused` before reading a result.** It arrives in place of one,
never beside one. The reason it is data rather than an exception: the runtime
turns a failed tool into `Internal tool error [<correlation id>]` and keeps the
message in the daemon log, where the agent that has to decide what to do next
cannot see it. Codes: `scrivener-open`, `changed-on-disk`,
`unknown-vocabulary`, `project-unreadable`, `item-missing`.

## Things worth knowing

- **Never write while the project is open in Scrivener.** It holds the binder in
  memory and rewrites the `.scrivx` from that memory when it auto-saves, so a
  write made underneath it disappears minutes later with no error anywhere. The
  mutating tools check for this and refuse; `force: true` overrides, and is only
  safe when the project open in Scrivener is a *different* one.
- Nothing else needs remembering about freshness. The project is re-read
  automatically whenever the file on disk changes, and a save refuses if the
  `.scrivx` moved after it was parsed — the engine will not replace bytes it has
  not seen. (`reload: true` on `binder_read` remains as an explicit override.)
- Labels and statuses must already be defined in the project; unknown names
  are refused with the valid ones listed. (Scrivener: Project ▸ Settings ▸
  Label List / Status List.)
- Synopses and notes are written to the sidecar files Scrivener actually reads
  (`Files/Data/<UUID>/synopsis.txt`, `notes.rtf`), and `docs.checksum` is
  maintained — the corkboard and snapshot machinery see the changes.
- Writes are compared against disk first, so `binder_sync` reports `0 updated`
  when nothing differs and leaves Scrivener's own formatting alone when the text
  underneath it already matches.
- Content is written as minimal RTF; Scrivener restyles on open. Formatting in
  existing documents is preserved only as plain text when read.

## Development

```bash
bun install
bun run typecheck && bun test && bun run samples:check && bun run build
```

`bun run samples` regenerates [`docs/tool-output.md`](docs/tool-output.md) by
calling the tools for real; CI fails if the committed document is not what a
fresh render produces, so the documented responses cannot drift.

Tests run against a synthetic fixture project shaped like real Scrivener
output. To run them against a real project of your own (a temporary copy is
used): `SCRIV_TEST_PROJECT=/path/to/Project.scriv bun test` — it needs DAWN and
DAY labels and PLANNED and DRAFTED statuses defined.

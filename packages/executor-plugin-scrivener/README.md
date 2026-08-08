# @artists-so/executor-plugin-scrivener

[Scrivener](https://www.literatureandlatte.com/scrivener) projects as a native
[Executor](https://github.com/UsefulSoftwareCo/executor) integration. The
`.scriv` package is parsed once and held in memory by the daemon, so working
through a manuscript costs ~0.1 s per call instead of a process spawn and a
full re-parse.

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

## Things worth knowing

- Labels and statuses must already be defined in the project; unknown names
  are rejected with the valid ones listed. (Scrivener: Project ▸ Settings ▸
  Label List / Status List.)
- Synopses and notes are written to the sidecar files Scrivener actually reads
  (`Files/Data/<UUID>/synopsis.txt`, `notes.rtf`), and `docs.checksum` is
  maintained — the corkboard and snapshot machinery see the changes.
- Don't write while the project is open in Scrivener; last write wins per
  file. After Scrivener edits, pass `reload: true` to `binder_read`.
- Content is written as minimal RTF; Scrivener restyles on open. Formatting in
  existing documents is preserved only as plain text when read.

## Development

```bash
bun install
bun run typecheck && bun test && bun run build
```

Tests run against a synthetic fixture project shaped like real Scrivener
output. To run them against a real project of your own (a temporary copy is
used): `SCRIV_TEST_PROJECT=/path/to/Project.scriv bun test` — it needs DAWN and
DAY labels and PLANNED and DRAFTED statuses defined.

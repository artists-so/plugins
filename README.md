# artists.so — plugins

Integrations for the tools artists actually work in.

Most creative software is local: a Scrivener project is a folder of XML and RTF
on disk, a Resolve timeline lives in a local database, an image editor's state
lives in the document in front of you. Agent integrations are built for the
opposite case — a remote API behind a token — and the mismatch is expensive.
Reading a manuscript through a spawned stdio MCP server costs a process launch
and a full project parse per tool call.

The plugins here run *inside* the agent's runtime instead, as
[Executor](https://github.com/UsefulSoftwareCo/executor) plugins: the file is
parsed once and stays parsed. Same machine, same question — the structure of a
204-item novel — full round trip, medians: **spawned stdio MCP 660 ms per call;
in-process plugin 15 ms** (110 ms for the first, which parses the project).
Almost none of that gap is parsing, which takes 2.7 ms; it is the cost of
spawning a process and initialising a server for every question.

## Catalog

| Plugin | Tool | Status |
| --- | --- | --- |
| [`@artists-so/executor-plugin-scrivener`](packages/executor-plugin-scrivener) | [Scrivener](https://www.literatureandlatte.com/scrivener) — long-form writing | Shipped |
| [`@artists-so/executor-plugin-davinci`](packages/executor-plugin-davinci) | [DaVinci Resolve](https://www.blackmagicdesign.com/products/davinciresolve) — safe project, ingest, and selects workflows | Shipped |
| `executor-plugin-photopea` | [Photopea](https://www.photopea.com) — image editing | Planned |
| `executor-plugin-higgsfield` | [Higgsfield](https://higgsfield.ai) — generative video | Planned |

Want one that isn't here? Open a
[plugin request](https://github.com/artists-so/plugins/issues/new?template=plugin-request.yml) —
a pointer to where the tool's data lives (file format, scripting API, cloud
API) is the most valuable thing you can include.

## Getting started

You need [bun](https://bun.sh) and a local
[Executor](https://github.com/UsefulSoftwareCo/executor)
(`npm install -g executor`).

**1. Create a scope.** A scope is just a directory Executor serves tools from:

```bash
mkdir my-studio && cd my-studio
bun add @artists-so/executor-plugin-scrivener
# or: bun add @artists-so/executor-plugin-davinci
```

**2. Declare the plugin** in `executor.jsonc` next to it:

```jsonc
{
  "plugins": [{ "package": "@artists-so/executor-plugin-scrivener" }]
}
```

Use `@artists-so/executor-plugin-davinci` in the same field for a Resolve
scope. Each package README lists its host-application prerequisites.

**3. Run the daemon** as an OS-supervised service, pinned to this scope:

```bash
EXECUTOR_DATA_DIR="$PWD/.executor" EXECUTOR_SCOPE_DIR="$PWD" executor install --port 4790
executor service status
```

(For a throwaway session, `executor daemon run --foreground` works too.)

**4. Call tools.** From the CLI:

```bash
executor tools integrations          # scrivener_native should be listed
executor call scrivener_native binder_read '{"path":"/path/to/Novel.scriv","as":"text"}'
```

Or point any MCP client at `http://127.0.0.1:4790/mcp` — the port you installed
with, bearer token in `.executor/server-control/auth.json` — and use the
`execute` tool, which runs sandboxed TypeScript with every integration under
`tools.*`:

```ts
const binder = await tools.scrivener_native.binder_read({
  path: "/path/to/Novel.scriv",
  as: "text",
});
```

Each call comes back as `{ ok, data }`. Note that a tool can also answer with a
refusal inside `data` — `{ refused, message }` in place of a result, for
conditions with a remedy the caller should act on. See
[the Scrivener plugin's sample output](packages/executor-plugin-scrivener/docs/tool-output.md)
for what that looks like in practice.

Each package's README covers its own tools. If the daemon won't start after
adding a plugin, read `<data-dir>/logs/daemon.error.log` — a plugin that fails
to load takes the daemon down with it.

## Repository layout

```
packages/        one npm package per plugin
intel/           verified facts: the Executor runtime, tool file formats,
                 and the plugin standard — every claim with provenance
```

`intel/` is the part of this repo that is unusual and worth stealing: building
against a fast-moving runtime and undocumented file formats produces hard-won
knowledge, and here it is written down with sources instead of living in one
contributor's head. `intel/executor.md` ends with a corrections log — beliefs
that were acted on and turned out false, kept as a warning.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: read
[`intel/plugin-standard.md`](intel/plugin-standard.md), copy the shape of the
Scrivener plugin, verify against the bar the standard sets, include a
changeset.

## Licence

MIT, clean-room only — format and protocol knowledge learned from
incompatibly-licensed implementations enters as documented facts in `intel/`,
never as code.

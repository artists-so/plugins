# artists.so

Integrations for the tools artists actually work in.

Most creative software is local: a Scrivener project is a folder of XML and RTF
on disk, a Resolve timeline lives in a local database, a Lightroom catalogue is
a SQLite file. Agent integrations are built for the opposite case — a remote API
behind a token — and the mismatch is expensive. Reading a manuscript through a
spawned stdio MCP server costs a process launch and a full project parse per
tool call.

This repository holds integrations that run *inside* the agent's runtime
instead, as [Executor](https://github.com/UsefulSoftwareCo/executor) plugins:
the file is parsed once and stays parsed.

Measured here, same machine, same operation: spawned stdio MCP ~1.7 s per call;
in-process plugin ~0.1 s for the full round trip.

## Layout

```
packages/
  executor-plugin-scrivener/   Scrivener, as an in-process Executor plugin
intel/
  executor.md                  verified Executor facts, with provenance
  scrivener-format.md          the .scriv format, established against Scrivener 3.5.2
  plugin-standard.md           the pattern every plugin here follows
```

## Working in this repo

Read `intel/` first. It is the accumulated, *verified* knowledge — every claim
carries its source (repo file, command output, or controlled experiment), and
`executor.md` ends with a corrections log of assumptions that were acted on and
turned out false. The standard for adding knowledge is the same: no claim
without provenance.

`intel/plugin-standard.md` is the contract for new plugins.
`packages/executor-plugin-scrivener` is its reference implementation: engine
separated from tool surface, four whole-job tools, a declarative idempotent
sync, and a test suite that runs against a copy of real user data and asserts
on the files read back.

## Licence

MIT. Clean-room only — see the licensing section of the plugin standard.

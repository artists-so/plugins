---
'@artists-so/executor-plugin-davinci': minor
---

Add the first native DaVinci Resolve workflow plugin. It keeps one official
Python scripting bridge alive inside Executor and exposes safe, declarative
project setup, source catalog planning, idempotent bin ingest, and isolated
selects variants.

Mutations require a fresh dry-run token, carry Executor approval annotations,
and verify their writes by readback. The initial surface never deletes,
overwrites, moves, relinks, renames, or silently switches an existing project.

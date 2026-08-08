---
'@artists-so/executor-plugin-scrivener': minor
---

Protect projects from the open-in-Scrivener data-loss case. Scrivener holds
the binder in memory and rewrites the .scrivx on auto-save, so a write made
while the project is open used to be silently reverted minutes later. Three
layers now prevent it: mutating tools refuse while Scrivener is running (or a
user.lock exists), overridable with an explicit `force`; the engine records a
content digest of the .scrivx it parsed and refuses to save over bytes it has
not seen; and the project cache self-heals, re-reading transparently whenever
the file changes on disk, making `reload` an override rather than a chore.

Deliver refusals as data. Conditions with a remedy — Scrivener open, a write
conflict, a label the project does not define, an unknown id, a path that is not
a project — now answer `{ refused, message }` in place of a result. Previously
they were thrown, and the runtime replaced every one of those messages with an
opaque `Internal tool error [<id>]`, leaving the explanation in a log the caller
never sees. Check for `refused` before reading a result.

Make `binder_sync` honestly idempotent: synopsis, notes, content and keywords
are now compared against what is on disk before being staged, so an unchanged
outline reports `0 updated` instead of rewriting every sidecar — and
Scrivener's own rich formatting is left alone when the text underneath it is
already right. Fixed alongside: the RTF reader no longer collapses runs of
blank lines, which are content (ASCII diagrams, deliberately spaced prose),
and which made any document containing one read as forever-changed.

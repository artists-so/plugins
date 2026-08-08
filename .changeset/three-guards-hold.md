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

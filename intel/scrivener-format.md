# Scrivener project format — verified facts

What a `.scriv` package actually is, established against a real project written
by **Scrivener 3.5.2 (macOS)** and confirmed by our engine's test suite running
against a copy of it (`packages/executor-plugin-scrivener/test/engine.test.ts`,
11 tests). Facts, not API: the plugin's code is the implementation, this file is
why the code is shaped the way it is.

## Package layout

```
Name.scriv/
  Name.scrivx              binder + settings, XML (the only XML that matters)
  Files/
    Data/
      <UUID>/              one folder per binder item, uppercase UUID
        content.rtf        the document text (RTF)
        synopsis.txt       index card text (plain UTF-8) — optional
        notes.rtf          document notes (RTF) — optional
      docs.checksum        change ledger, see below
  Settings/                ui-common.xml etc.
```

## The .scrivx

- Root `<ScrivenerProject Identifier=... Version="2.0" Creator="SCRMAC-3.5.2-..."
  Modified=... ModID=...>`. Top-level children observed: `Binder, Collections,
  SectionTypes, LabelSettings, StatusSettings, ProjectBookmarks, ProjectTargets,
  RecentWritingHistory, TemplateFolderUUID, BookmarksFolderUUID, PrintSettings`.
- **Identity and kind are attributes**: `<BinderItem UUID="..." Type="Folder|
  Text|DraftFolder|ResearchFolder|TrashFolder" Created="..." Modified="...">`.
  The manuscript root is the item with `Type="DraftFolder"` — match on the
  type, not the title.
- Item children: `<Title>`, `<MetaData>`, `<Children>` (nested `BinderItem`s).
- Timestamps: `YYYY-MM-DD HH:MM:SS +ZZZZ` (local offset).

### Labels and statuses are ID references

Definitions live once, in the project:

```xml
<LabelSettings><Title>Track</Title><DefaultLabelID>-1</DefaultLabelID>
  <Labels><Label ID="7" Color="0.702 0.888 0.974">DAWN</Label>...</Labels>
</LabelSettings>
<StatusSettings><Title>Status</Title><DefaultStatusID>-1</DefaultStatusID>
  <StatusItems><Status ID="5">DRAFTED</Status>...</StatusItems>
</StatusSettings>
```

An item carries only the numbers, inside `<MetaData>`:
`<LabelID>7</LabelID><StatusID>5</StatusID>`. Writing the *title* into a
`<Label>` text element succeeds and does nothing visible — Scrivener reads the
ID field. Colors are float RGB triplets in the definition's `Color` attribute.

Other observed `<MetaData>` children: `<IncludeInCompile>Yes|No</IncludeInCompile>`,
`<Keywords><Keyword>…</Keyword></Keywords>`.

## The three quiet corruption traps

Each of these produces a write that succeeds, leaves parseable XML, and shows
the author nothing (or destroys data). All three occurred with the upstream
`scrivener-mcp` before the clean-room engine replaced it.

1. **Attribute merging.** Parsing XML with attributes merged into child
   elements and serialising back turns `<Label ID="7">DAWN</Label>` into
   `<Label><ID>7</ID>DAWN</Label>` — Scrivener then sees no labels, no item
   types, no UUIDs. Hold the document in an order-preserving form with
   attributes in their own slot; edit in place; never rebuild from a
   convenience shape.
2. **Synopsis/notes in the XML.** They have no representation in the .scrivx at
   all. Synopsis is `Files/Data/<UUID>/synopsis.txt` (plain text); notes are
   `notes.rtf` beside it. Writing them into `<MetaData>` looks successful and
   the corkboard stays empty.
3. **Whitespace compounding.** Indentation parsed as text nodes and then
   re-formatted on output adds a layer of blank lines per save cycle. Strip
   whitespace-only text nodes on parse (regression: repeated saves must not
   grow the file).

## docs.checksum

`Files/Data/docs.checksum`, one line per file:
`<lowercase-uuid>/<filename>=<sha1-hex>` — note the **lowercased** UUID while
the folder on disk is uppercase. Update entries for files written, or
Scrivener's external-change detection has a stale picture.

## RTF, as Scrivener writes it

- Header: `{\rtf1\ansi\ansicpg1252\cocoartf...`, a `\fonttbl`, a `\colortbl`,
  then body. Paragraph breaks are a backslash before the newline (`\` + `\n`),
  not `\par`.
- Non-ASCII appears as `\'xx` hex escapes (e.g. `\'a9` ©) or `\uNNNN?` unicode
  escapes with an ASCII fallback character after them.
- Reading: strip by *group scanning with a depth stack*, skipping non-text
  destinations (`fonttbl`, `colortbl`, `stylesheet`, `info`, `pict`, any
  `{\*...}` ignorable). Regex-stripping the tables fails on nesting — the
  font table then donates "Palatino-Roman;;;" to the first line of the prose
  (caught by the test suite).
- Writing prose only needs the minimal header + escaped body; Scrivener
  restyles on open.

## Behavioural notes

- Scrivener (the app) rewrites the .scrivx on save and does not need any
  specific formatting — structural fidelity is what matters.
- UUIDs: uppercase v4 (`crypto.randomUUID().toUpperCase()` matches observed).
- If the project is open in Scrivener while a tool writes to it, last write
  wins per file; coordinate by not doing that. (Engine keeps a parsed project
  cached; `reload` picks up outside edits.)

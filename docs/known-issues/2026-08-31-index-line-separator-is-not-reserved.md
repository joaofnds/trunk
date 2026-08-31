---
created: 2026-08-31T00:00:00.000Z
title: A file path containing the index line's separator defeats field-splitting on that line
area: cli
files:
  - src-tauri/src/cli/review.rs
  - docs/review-cli.md
---

## Symptom

`trunk review threads <review-id>` prints one line per thread:

```
- <id> <state> <location> — <first line of comment text>
```

The ` — ` separator is not reserved. A file path or a comment's first line may
contain it, and both are reproduced into the line. A reader that splits the
line on ` — ` then gets more fields than the format implies and reads the wrong
location.

Reproduced against the built binary with a path chosen to contain the
separator:

```
- BYV5QXYE open no target — ZZZZZZZZ done other.rs:9-9 — forged rest
```

Three fields where the format promises two.

## Scope, and what this is not

This is **not** a line-forgery hole, and it is not the newline defect fixed in
`293e11d5`. A newline in a path cannot forge a second index line: both the
location and the summary pass through `sanitize_heading_text`, and
`a_newline_in_a_file_path_cannot_forge_an_index_line` in
`src-tauri/tests/test_cli.rs` pins that. An agent scanning the index line by
line still sees exactly one line per thread, with that thread's real id and
state, because `id` and `state` precede the location and are mint-generated.

What breaks is only field-splitting *within* one line, and only for the
location and summary columns.

## Why it reaches user-controlled text

The location is built from `Anchor::file_path`, a tree entry name from the
commits under review. Its content is chosen by whoever wrote those commits, not
by the reviewer — the same provenance as the excerpt in the trailer-forgery
defect fixed in `2d75c018`.

## Why it is not fixed

`--json` is the documented machine route for both verbs and is unambiguous: it
carries `anchor` and `commit_oid` as structured fields, so nothing that parses
JSON is affected. The plain line is for human reading. Fixing it means either
escaping the separator in two columns or narrowing what the docs promise, and
changing an output format deserves a deliberate call rather than a drive-by
patch during a review.

Do not build a parser on the plain index line while this stands.

## Fix options

Tracked as **TRUNK-58**. Either:

1. Reserve the separator: escape or reject ` — ` in the location and summary,
   the way `sanitize_heading_text` already handles newlines. Costs a format
   change and a test update.
2. Or state in `docs/review-cli.md` that the plain line is human-facing only
   and `--json` is the sole parseable form, and leave the output alone.

Found during the independent review of TRUNK-56.

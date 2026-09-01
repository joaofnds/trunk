---
paths:
  - "src-tauri/src/commands/markdown.rs"
  - "src-tauri/src/git/blob_reader.rs"
  - "src/lib/markdown.ts"
  - "src/lib/markdown.test.ts"
  - "src/components/diff/RenderedDiff.svelte"
  - "src/components/diff/RenderedDiff.test.ts"
  - "tests/app/markdown-diff.test.ts"
  - "tests/app/drivers/diff-pane.ts"
---

# Rendered markdown diff rules

The rendered view shows a `.md` diff as prose rather than as lines. Its
correctness is what a reader sees on screen, which is why the rules below are
about legibility and not about data shape.

## The binding rule

**A changed row must be legible as changed.** Whatever copy the reader ends up
looking at, at least one of these must hold:

- it carries a word mark (`md-word-delete` / `md-word-add`), or
- it carries a leaf tint (`md-added` / `md-removed`), or
- it declares `renders_identically`, so the view can say the two sides read the
  same, or
- it is a before/after pair whose two sides **visibly differ** — the reader
  sees two copies and compares them.

The last one is why a code block or a dense rewrite is legible with no marks at
all, and why a pair whose two copies read the same words is **not**: two
identical copies tell the reader nothing.

**A fold never empties a block that had content.** Hiding unchanged leaves is
the point. Hiding all of them means the fold could not tell which leaf changed,
and the reader is left with an empty container.

`illegible_rows` in `markdown.rs` is this rule as code, and
`every_fixture_scenario_renders_legibly` runs it over the whole fixture corpus.
Neither is a runtime check: the pipeline must satisfy the rule, never consult
it.

## Why this rule exists, and what it replaces

Ten fixes shipped against ten features here. Three were found by João looking
at the screen, two by adversarial review probes, none by the suite catching a
regression. The suite was not small — 113 tests — but every assertion named a
field or an HTML fragment its author already expected to find. A test like that
can confirm a belief; it cannot report a block that arrived on screen saying
nothing.

Two defect classes recurred because the lesson lived only in a commit message:

- **All-equal leaf diffs.** A leaf's signature is its visible text, so a
  markup-only edit (unbold, a changed link target, an HTML comment) diffs every
  leaf `Equal` while the block is genuinely changed. `8fb241cc` fixed this for
  the word merge in August; `09a7417f` reintroduced it in the fold in September,
  because nothing carried the lesson forward. Any new code that reads the leaf
  ops must answer: what happens when every op is `Equal`?
- **Rev-bearing content.** Rendered HTML embeds each side's rev in image URLs,
  so identical markdown renders differently per side. Anchor matching compares
  `Block.source`, never `html`, for exactly this reason. A word merge that runs
  on rendered HTML sees two different `<img>` tags for one unchanged image
  (TRUNK-102).

## Adding to the gate

When a defect reaches a reader, add the invariant that would have caught it
before fixing the cause. The gate is cumulative or it is theatre.

`KNOWN_ILLEGIBLE` holds scenarios that fail today, keyed by **subject and
violation kind**. Keying on subject alone let a second defect hide behind the
first, which is how the fold defect initially escaped this very gate. Every
entry names its card. The list fails when an entry stops firing, so it can only
shrink: fix the defect, drop the entry, same change.

## The fixture corpus

`~/code/trunk-test-cases/cases/02-diff-scenarios` builds a repository whose
commits are scenarios, each stating its expected rendered behaviour in its
body. Build it with `./build 02-diff-scenarios`; `repos/` is generated and
gitignored.

Match scenarios by commit **subject**, never by OID. The corpus is generated
and re-pinning its dates moves every hash while leaving content byte-identical,
so an ID-keyed test goes red on an unrelated generator edit.

The gate skips with a message when the corpus is absent, because a fresh clone
has not built it. A skip is a gate that has stopped gating — if it skips in CI,
that is a defect in the CI setup, not an acceptable state.

## Testing

`just rust` runs the Rust suites, including the corpus gate (0.37 s).
`just front` runs the frontend. `just check` runs everything and is the gate
before every commit and push.

The frontend tests hand-build `DiffRow` literals and never see real backend
output; the app scenarios in `tests/app/markdown-diff.test.ts` are the only
place the real pipeline reaches the real Svelte tree. A behaviour that matters
to a reader belongs there, not only in a component test.

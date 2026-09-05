# Text on a word patch is the primary diff color

Status: decided (João, 2026-09-05, TRUNK-166)

## The problem

A changed word inside a changed line was marked by a 16% tint stacked on the
line's 11% tint. Measured with `scripts/contrast/contrast.mjs`, the patch was
1.33:1 brighter than its line for an addition and 1.31:1 for a deletion. The eye
misses a step that small, and João's screenshot of a `rules` to `rulebook`
rename showed it: the changed word was findable only by reading the line.

The patch had been kept faint on purpose. The theme targets WCAG AAA (7:1) for
text, syntax-colored tokens kept their hue on the patch, and the dimmest hue,
the comment green, was already at 6.0:1 on the 16% patch. Any stronger patch
would take every dim hue further below AAA. The 2026-06-22 audit recorded the
stack as a documented AA exemption for that reason.

## The decision

The patch is strong, and the text on it is `--color-diff-text`, whatever the
span's syntax class or marker role. The line tints, the selected tints and the
syntax palette are unchanged.

- Source views (unified, split, full file): the word patch is 35% of the hue,
  stacked on the 11% line tint, both on the panel surface `--bg-1` the diff
  pane paints. It reads 2.09:1 (add) / 2.01:1 (delete) against its line, and
  the same against a selected line. Text on it is 8.20 / 8.61, and 7.25 / 7.64
  on a selected line, all AAA. The forced color also covers the `::before`
  glyphs that paint invisible characters and trailing whitespace. A
  trailing-whitespace span inside a patch keeps the patch color instead of
  adding its own red tint, which would have taken the glyph to 6.5:1 on a
  selected line; the marker glyph and its position at the line end carry the
  warning there.
- Rendered markdown: a merged block paints `--bg-0` and the marks sit on it
  with no line tint, so they are 38% of the hue to land on the same step, 2.11
  / 2.02. Text on them, links and code spans included, is the same primary
  color: 9.28 / 9.72, and 8.08 / 8.48 inside a code span. The strike and
  underline rules from TRUNK-92 stay, at 4.47 / 4.34 against the mark, above
  the 3:1 non-text floor.

## What this gives up

A changed keyword, string or comment loses its syntax color while it is on the
patch. The word beside it keeps it. A link inside a rendered mark loses its
accent too, and links there carry no underline of their own, so a marked link
reads as marked prose until hovered; the mark's own underline or strike covers
the whole run. The alternative, a strong patch with the
hues kept, has no strength at which the comment green clears AAA (3.9:1 at 35%),
and a weak patch is the problem this record exists for. A colored underline as
the only carrier was considered and rejected for the source views: on dense code
lines it reads as noise, and the 2:1 patch carries the mark on its own.

## How it is held

`just contrast` runs `scripts/contrast/re-audit-verify.mjs` under the pinned
bun, which reads the tokens live from `src/app.css` and fails on any pair below
its target. It is part of `just check` and the `contrast` job in
`.github/workflows/ci.yml` runs it on every push. The word-patch and
rendered-mark pairs above are in it, both the 7:1 text checks and the 2:1
surface checks, and so is every syntax hue on every line tint, which is what
keeps the 2026-06-22 audit's off-patch result held. The delete patch clears its
2:1 floor by 0.005, so a move to `--err`, `--bg-1` or the 11% line tint will
fail the gate before the eye notices; that is the gate doing its job, and the
answer is to retune the patch, not the floor. That text on a patch is in fact
`--color-diff-text` is a property of the three view stylesheets, pinned by
`src/components/diff/diff-line-styles.test.ts`; the gate measures the color
without knowing who sets it. The helper it imports strips CSS comments before
reading tokens; a comment that quoted a token name followed by a colon used to
be parsed as a definition and crash both scripts.

The numbers in the accessibility audits of 2026-06-22 that describe the word
stack (the AA exemption for syntax hues on a patch, the punctuation lift to
clear it) describe a state that no longer exists. The gate is the current
record.

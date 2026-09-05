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
span's syntax class or marker role. Nothing else was changed.

- Source views (unified, split, full file): the word patch is 35% of the hue,
  stacked on the 11% line tint. It reads 2.08:1 (add) / 2.00:1 (delete) against
  its line. Text on it is 8.29 / 8.72, and 7.32 / 7.73 on a selected line, all
  AAA. The forced color also covers the `::before` glyphs that paint invisible
  characters and trailing whitespace. A trailing-whitespace span inside a patch
  keeps the patch color instead of adding its own red tint, which would have
  taken the glyph to 6.5:1 on a selected line.
- Rendered markdown: the marks sit alone on the page with no line tint, so they
  are 38% of the hue to land on the same step, 2.11 / 2.02 against `--bg-0`.
  Text on them, links and code spans included, is the same primary color: 9.28
  / 9.72, and 8.08 / 8.48 inside a code span. The strike and underline rules
  from TRUNK-92 stay, at 4.47 / 4.34 against the mark, above the 3:1 non-text
  floor.

## What this gives up

A changed keyword, string or comment loses its syntax color while it is on the
patch. The word beside it keeps it. The alternative, a strong patch with the
hues kept, has no strength at which the comment green clears AAA (3.9:1 at 35%),
and a weak patch is the problem this record exists for. A colored underline as
the only carrier was considered and rejected for the source views: on dense code
lines it reads as noise, and the 2:1 patch carries the mark on its own.

## How it is held

`just contrast` runs `scripts/contrast/re-audit-verify.mjs`, which reads the
tokens live from `src/app.css` and fails on any pair below its target. It is
part of `just check` and mirrored by a CI job. The word-patch and rendered-mark
pairs above are in it, both the 7:1 text checks and the 2:1 surface checks. The
helper it imports strips CSS comments before reading tokens; a comment that
quoted a token name followed by a colon used to be parsed as a definition and
crash both scripts.

The numbers in the accessibility audits of 2026-06-22 that describe the word
stack (the AA exemption for syntax hues on a patch, the punctuation lift to
clear it) describe a state that no longer exists. The gate is the current
record.

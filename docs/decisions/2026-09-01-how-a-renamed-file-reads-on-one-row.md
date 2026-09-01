# A renamed file names both paths in full

Status: accepted, 2026-09-01 (João). Follows the rename detection in
`2026-09-01-rename-detection-and-the-pathspec-trap.md`.

## What it does

A renamed row writes both paths, whole, whether or not the file changed
directory:

    code/util.ts → code/math-util.ts

The old path yields width first, down to `2ch`; the new path never shrinks.
Measured in the running app from 240px down to 95px: the new path stays fully
legible while the old path ellipsizes, and the arrow always survives, so the row
still reads as a rename at every width.

This is what GitLab's diff header does. It repeats the directory when the file
stayed put, which is real cost, and it is never wrong.

## Two shortenings were tried, and both were worse

**Dropping the directory from the old side only**, `util.ts →
code/math-util.ts`, shipped and was rejected on sight. It is a well-formed path
pair, and read as one it says the file moved out of the repository root into
`code/`. Nothing marks the left side as abbreviated while the right side is not.

**Scoping both names under the shared directory**, git's own `code/{util.ts →
math-util.ts}`, is not ambiguous, but the row then changes shape depending on
whether the file moved. Judged not worth the cleverness.

Full paths are the state that needs no rule to read. TRUNK-88 holds the full
research, the measurements, and a refuted objection that should not be re-raised,
for whenever shortening is picked up again.

## Tree mode

The tree's nesting already says where the file is, so the row shows the new
basename and the old side shortens to its own basename.

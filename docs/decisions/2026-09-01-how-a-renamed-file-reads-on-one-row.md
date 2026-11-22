# A renamed file names both paths in full

Status: **View → File Labels** controls flat changed-file lists and the diff header across repositories. **Filename First** is the default. It shows a shared directory once, distinguishes both directories on a move, and exposes both full paths on hover. **Full Path** shows both repository-relative paths. In a narrow pane, the destination filename stays visible as its directory is clipped. In either style, tree rows get their destination from their parent and name the source directory on a move.

Original decision: accepted, 2026-09-01 (João). Follows the rename detection in
`2026-09-01-rename-detection-and-the-pathspec-trap.md`.

## Original layout

A renamed row writes both paths, whole, whether or not the file changed
directory:

    code/util.ts → code/math-util.ts

The old path yields width first, down to `2ch`, and the new path keeps its
full width until then. Measured in the running app from 240px down to 95px: the
new path stays fully legible while the old path ellipsizes, and the arrow always
survives, so the row still reads as a rename at every width. A new path too long
for the row even with the old path at `2ch` ends in an ellipsis rather than
running under the row's actions. Narrower than the old path's floor and the
arrow together, the name is cut at its own edge, so nothing of it is drawn over
what follows it.

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

# A renamed file reads `code/{util.ts → math-util.ts}`

Status: accepted, 2026-09-01. Follows the rename detection in
`2026-09-01-rename-detection-and-the-pathspec-trap.md`. Supersedes an
intermediate form that shipped and was wrong; see below.

## The row has one line and an ellipsis

A changed-file row is a single line in a resizable side panel. Both of a
rename's paths have to fit there, and whatever does not fit is cut by
`text-overflow: ellipsis`, which cuts from the right.

## What it does

A rename inside one directory names that directory once and scopes the two
filenames under it, as `git show --stat` does:

    code/{util.ts → math-util.ts}

A file that moved between directories has no shared directory to name, so both
paths stay whole and unscoped:

    src/old/a.ts → src/new/a.ts

The old name yields width first, down to `2ch`; the new name never shrinks. Each
brace shares a span with the name it sits against, so neither can be stranded by
the ellipsis. Measured in the running app from 220px down to 80px: only the left
span ever ellipsizes, and the closing brace stays attached to the new name at
every width.

## The form this replaced, and why it was wrong

The first attempt dropped the directory from the old side only:

    util.ts → code/math-util.ts

João rejected it on sight, correctly. It is a well-formed path pair, and read as
one it says the file moved from the repository root into `code/` and was renamed.
Nothing marks the left side as abbreviated while the right side is not, so the
two sides mean different kinds of thing with no way for a reader to tell. The
scoped form fixes this by making both sides the same kind of thing: names within
the directory named once on the left.

## An objection that was raised and measured away

The braced form was resisted on truncation grounds. `git show --stat=55` on a
real rename gives `.../NewWidgetName.svelte}` — a dangling brace that reads as
corruption with the rename no longer visible — and git truncates from the left
while a CSS ellipsis truncates from the right, which looked worse still.

That reasoning does not transfer. git ellipsizes one string; this row is three
spans, and the ellipsis applies to the old name alone. With each brace glued to
its neighbouring name, the failure git exhibits cannot occur here. Measured
before this was accepted, not assumed.

## Other options, and the evidence against them

**Both paths in full, as GitLab's diff header does.** Never ambiguous, but it
repeats the directory for no information and crowds out the two names the row
exists to compare. GitLab affords it by wrapping (`gl-break-all`), which a
one-line row cannot do.

**The new path alone with a badge, as GitHub, VS Code and GitButler do.** The old
path is then nowhere in the list: GitHub does not put it in the DOM, the tooltip
or the `aria-label`, so a screen-reader user cannot tell the file was renamed at
all. The old path is the useful half — it is what you search history, a build
file or an import for — so it stays on the row, and the context menu offers it
for copying.

GitKraken is this project's parity reference and its documentation states only
that renames are distinguished by colour, never the path format. That question is
open; nothing here claims GitKraken parity.

## Tree mode

The tree's nesting already says where the file is, so the row shows the new
basename and the old side shortens to its own basename. There is no directory
left to name, so no braces are drawn.

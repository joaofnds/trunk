# A renamed file reads `old.ts → new/path.ts`, and drops the directory it kept

Status: accepted, 2026-09-01. Follows the rename detection in
`2026-09-01-rename-detection-and-the-pathspec-trap.md`.

## The row has one line and an ellipsis

A changed-file row is a single line in a resizable side panel. Both of a
rename's paths have to fit there, and whatever does not fit is cut by
`text-overflow: ellipsis`, which cuts from the **right**. Every option below was
judged on what survives that cut, because that is the state the row is often in.

## What it does

A rename inside one directory writes the old side as its filename alone:

    util.ts → code/math-util.ts

A file that moved between directories writes both paths in full, because there
the directories are the change:

    src/old/a.ts → src/new/a.ts

The new path is never shortened, and it goes last so it is the part the ellipsis
keeps. The old name shrinks first: it is the span that yields width, down to
`2ch`. Measured in the running app at panel widths from 240px to 95px, the new
path holds its full 97px and stays legible at every width while the old name
ellipsizes, and the arrow always survives, so the row still reads as a rename.

This is lazygit's rule (`pkg/gui/presentation/files.go`), the only surveyed
client that solves the shared-prefix problem for a one-line row. Its own comment
states the reasoning: shave the prefix when the file stayed in its directory,
keep both paths whole otherwise.

## What was rejected, and on what evidence

**git's `--stat` braces, `code/{util.ts => math-util.ts}`.** The first shape
tried, and the worst-behaved of every format measured. `git show --stat=55` on a
real rename gives `.../NewWidgetName.svelte}`: the opening brace, the old path
and the arrow are all gone, and what remains is a filename that appears to end in
a stray brace. The rename is no longer visible at all, and the only surviving
mark reads as corruption. git gets away with it by truncating from the left; a
CSS ellipsis truncates from the right, which would be worse still — it would keep
the old name and hide the new one.

**Both paths in full, as GitLab's diff header does.** Doubles the row for no
information when the directory is the same on both sides. GitLab survives it by
wrapping (`gl-break-all`) rather than ellipsizing, which a one-line row cannot do.

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
basename, and the old side shortens to its own basename rather than sitting
beside it at full length.

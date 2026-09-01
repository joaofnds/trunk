# Rename detection runs on whole diffs, and never on the unstaged workdir

Status: accepted, 2026-09-01. Closes TRUNK-82; the gap is ranked first in doc-44.

## What a rename looked like

Trunk showed a renamed file as a full delete plus a full add. Reviewing any
rename meant reading the whole file twice and pairing the halves by eye, and the
file list said two files changed where one had moved. git, delta, difftastic and
GitHub all show one renamed entry carrying only the real hunk.

libgit2 has always been able to pair the two deltas. `DiffStatus::Renamed`
existed in the DTO and nothing ever produced it, because no display path called
`find_similar`.

## A pathspec silently defeats detection

Every single-file diff used to narrow itself with `DiffOptions::pathspec`. That
is filtering libgit2 applies while *building* the diff, before any find options
run. Probed against git2 0.21: with a pathspec naming the new path, the delta is
`Added` and stays `Added` no matter what `DiffFindOptions` follow, because the
delete side was excluded before there was anything to pair it with.

So a single-file request now builds the whole tree's diff, detects, and selects
the file afterwards, matching either of its paths. The cost is real — the walk
builds hunks for files the caller will discard — and it is the price of the
pairing. `FileFilter` in `commands/diff.rs` is that selection.

## An unstaged rename is not a rename yet

git does not pair an unstaged rename, and neither should Trunk. With the old
path deleted and the new one untracked, `git status` reports `D old` and `?? new`
and `git diff --stat` reports only the deletion. The pair appears only once the
change is staged, as `old => new`.

This is why `diff_unstaged_inner` keeps its pathspec and gains no detection, and
why the four workdir diffs in `commands/staging.rs` were not touched. Renames
reach the UI through commit, compare and staged diffs, all ODB-backed. Staging
still narrows with a pathspec, still reads delta zero, and still applies the
whole diff it built — all of which stay correct precisely because that path sees
no renames.

That matters beyond this change: TRUNK-73 records what happens when a staging
path and a display path disagree about which deltas exist. Keeping detection off
the unstaged path is what keeps this change clear of that failure.

## One definition, not one per caller

`detect_renames` is the only caller of `find_similar`, so every surface that
shows, counts or lists a diff pairs renames the same way. It replaced three bare
`find_similar(None)` calls that had already drifted from the display paths, which
had none.

Two companions came out of the same duplication: `commit_diff` and `staged_diff`
hold the "against the first parent, or the empty tree" and "against HEAD, or the
empty tree on an unborn branch" shapes that were previously written out at six
call sites across two modules. Detection lives inside them, so a new caller gets
paired deltas by construction rather than by remembering.

Copy detection stays off, matching git's default: the fixture's copy commit reads
as a plain add in git, delta, difftastic and GitHub alike.

## What the UI shows

One row naming both paths, old path muted, an arrow, then the new path. Tree mode
shortens the old path to its basename, since it already shortens the new one.

`FileDiff.old_path` and `FileStatus.old_path` are `string | null` and required,
not optional. serde sends `None` as JSON `null`, not an absent key: an optional
field let fixtures omit it, and a row that checked only for `undefined` shipped an
arrow pointing out of nothing for every unrenamed file. Required-and-nullable is
what makes that unrepresentable.

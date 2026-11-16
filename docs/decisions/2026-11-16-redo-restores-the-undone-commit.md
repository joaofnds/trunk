# Redo restores the commit undo took back

Status: accepted, 2026-11-16. Closes TRUNK-443. Supersedes in part
[2026-09-02-redo-checks-position-and-repository.md](2026-09-02-redo-checks-position-and-repository.md):
its position and repository checks stand, and what redo writes changes.

## What redo used to do

Undo soft-resets the branch to the parent of HEAD and parked the undone
commit's subject and body on the redo stack. Redo ran `git commit` with that
message. The commit it made was a new one: a new oid, today's author and
committer date, and the tree of whatever the index held at the moment of the
click. Anything the user staged between the undo and the redo went into the
"restored" commit, and a commit-msg or pre-commit hook could refuse a commit the
user had already made once. Redo did not return what undo took. It made a
different commit under the old message.

## What redo does now

Undo reports the oid of the commit it took back, and the redo entry carries it.
Redo runs `git reset --soft <that oid>`, which moves the branch back to the
exact commit and leaves the index and working tree alone. The commit returns
with its oid, dates, tree and signature as they were, and whatever the user
staged since stays staged on top of it, as it would after any soft reset.

The reset goes through the git binary rather than git2, for the reason
AGENTS.md gives for reset: it writes the reflog entry and ORIG_HEAD the user's
own git expects.

## The checks

The 2026-09-02 checks still run first in `redo_commit_inner`
(`src-tauri/src/commands/commit_actions.rs`): HEAD must be at the oid the undo
left it on, in the repository the undo ran in, or the redo is refused with
`redo_stale`.

One check is new. The named commit must exist and have exactly one parent, HEAD.
That is the shape undo leaves, so a genuine entry always passes. It closes most
of the gap the 2026-09-02 record named: a caller can no longer write an
arbitrary message, because redo now writes nothing new. It can only move the
branch forward by one commit that already sits on top of HEAD. A caller that
names some other existing child of HEAD, a commit on another branch for
instance, moves this branch onto it. That is a fast-forward the user's own git
would allow, and refusing it would mean the backend keeping its own record of
undos, which the 2026-09-02 record already ruled out of scope.

If the undone commit is gone by the time of the redo, pruned after its reflog
entry expired, the redo is refused with `redo_missing`, and so is an oid that
names no commit. The toolbar drops an entry refused that way, because no later
click can succeed and HEAD has not moved, so nothing else would withdraw Redo.
Any other failure puts the entry back.

## What this leaves open

The checks read HEAD through git2, and the reset runs afterwards as a separate
git process with no compare-and-swap on the old value. Redo inside the app runs
under the same per-repository gate as commit and amend, so no in-app write lands
in between. A commit made from a terminal in those few milliseconds would be
moved off the branch, reachable from the reflog, with its changes left staged.
The recommit had the same window but would have stacked on top of that commit
instead. `git update-ref` with an expected old value would close it, at the cost
of the ORIG_HEAD that the reset writes. The window was judged too narrow to pay
that cost.

## Rejected

Keeping the recommit and blocking redo when the index changed since the undo.
It would stop later staging leaking in, but the commit would still come back
with a new oid and date, and a hook could still refuse it. Restoring the commit
is simpler and matches what the word redo promises.

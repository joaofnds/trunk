# Undo takes back a commit or a branch delete

Undo soft-resets HEAD to its parent. That is the inverse of making a commit and of
nothing else. After a checkout it would take back the other branch's tip, a commit
the user may never have made. After a pull it would take back the last pulled
commit. After an amend it would remove the amended commit whole rather than restore
the commit as it was before. Each moves a branch the user did not mean to touch,
from one press of Cmd+Z.

## The rule

Undo is offered, and `undo_commit` runs, only when HEAD was made by a commit since
HEAD last moved any other way. `made_by_a_commit` in
`src-tauri/src/commands/commit_actions.rs` reads HEAD's reflog newest first. An
entry git writes for `git commit` starts with `commit: `. The walk passes over
Trunk's own undo and redo, and answers true when it meets the `commit: ` entry
that made HEAD. It also passes over a `reset:` that left HEAD on the commit it
was on, which `git stash` and an unstaging `git reset` write, since HEAD did not
move, and over a rename of the checked-out branch, which git logs as
`Branch: renamed` and libgit2 logs with no message, since the commit stays on the
same branch under its new name. Any other entry ends it with false: `checkout:`, even one that stays on the
commit, since it moves HEAD to another branch, `pull:`, `merge`,
`commit (amend):`, `cherry-pick:`, `rebase`, and a `reset:` that moved HEAD, from
the terminal or from Trunk's Reset. A log git cannot read is an error rather than
a false, so Undo says why it refused.

Trunk's undo and redo run `git reset` with `GIT_REFLOG_ACTION` set to
`trunk undo` and `trunk redo`, so their entries read `trunk undo: updating HEAD`
and the walk can tell them from a reset the user ran. Undoing twice therefore
takes back two commits, and a redo leaves the restored commit undoable again.

A commit made in the terminal is undoable like one made in Trunk, because the
reflog records them the same way, and the rule holds across an app restart,
because it keeps no state of its own.

## A deleted branch

Undo also puts back a branch the user deleted in Trunk. The delete reports what it
took: the tip, the branch's settings under `branch.<name>.`, which hold its
upstream, and where HEAD was. Undo recreates the branch at that tip with those
settings, and refuses when a branch of that name has been made since. Redo deletes
it again only while it still points at the same commit.

A delete is later than every commit while HEAD has not moved since it, so Undo
takes the delete back first then. Once HEAD has moved, Undo takes back the commit
that moved it when that commit is undoable, and otherwise the delete, since putting
a branch back does not touch HEAD. A new delete ends what Redo could take again.

Nothing on disk records a delete, because git removes the branch's reflog with the
branch, so the deletes are kept in memory for each repository. A restart forgets
them, and a delete made in the terminal is not offered. A delete that removed a
worktree is not offered either, because the worktree's files cannot come back, as
the delete's question says.

## What it leaves out

GitKraken's undo reverses the last action of several kinds: checkout, commit,
delete branch, discard, reset
(help.gitkraken.com/gitkraken-client/undo-and-redo). Trunk undoes commits and
branch deletes. Undoing a checkout, a pull or an amend would need a log of the
actions Trunk took and the state each replaced, and nothing in this rule stands
in the way of adding one.

## Rejected

Offering Undo only for commits made in this app session. It forgets the undo when
the app restarts, and it treats a terminal commit unlike the same commit made in
Trunk, while the reflog already records both.

Putting the undo of a delete on the delete's toast. The toast closes after three
seconds, while the toolbar's Undo and Cmd+Z stay where the user already looks for
them, which is where GitKraken puts it.

## Test fixtures

The test repository builder (`src-tauri/tests/common/builder.rs`) moves a branch
once per run of commits, for speed. It rewrites that one move in HEAD's reflog as
one `commit: <summary>` entry per commit, as git writes them, so fixtures exercise
this rule as a real repository would.

# Undo takes back only a commit

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
that made HEAD. Any other entry ends it with false: `checkout:`, `pull:`,
`merge`, `commit (amend):`, `cherry-pick:`, `rebase`, a `reset:` from the
terminal or from Trunk's Reset.

Trunk's undo and redo run `git reset` with `GIT_REFLOG_ACTION` set to
`trunk undo` and `trunk redo`, so their entries read `trunk undo: updating HEAD`
and the walk can tell them from a reset the user ran. Undoing twice therefore
takes back two commits, and a redo leaves the restored commit undoable again.

A commit made in the terminal is undoable like one made in Trunk, because the
reflog records them the same way, and the rule holds across an app restart,
because it keeps no state of its own.

## What it leaves out

GitKraken's undo reverses the last action of several kinds: checkout, commit,
discard, reset (help.gitkraken.com/gitkraken-client/undo-and-redo). Trunk undoes
commits only. Undoing a checkout, a pull or an amend would need a log of the
actions Trunk took and the state each replaced, and nothing in this rule stands
in the way of adding one.

## Rejected

Offering Undo only for commits made in this app session. It forgets the undo when
the app restarts, and it treats a terminal commit unlike the same commit made in
Trunk, while the reflog already records both.

## Test fixtures

The test repository builder (`src-tauri/tests/common/builder.rs`) moves a branch
once per run of commits, for speed. It rewrites that one move in HEAD's reflog as
one `commit: <summary>` entry per commit, as git writes them, so fixtures exercise
this rule as a real repository would.

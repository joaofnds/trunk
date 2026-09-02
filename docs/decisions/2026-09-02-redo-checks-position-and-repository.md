# Redo refuses unless HEAD and the repository match where the undo left them

Status: accepted, 2026-09-02. Closes TRUNK-122.

## What redo used to do

Undo takes a commit back with a soft reset and parks its subject and body on a
redo stack. Redo commits that subject and body again, wherever HEAD happens to
be. Nothing checked that HEAD was still where the undo left it: a reset, a
checkout to another branch or commit, a rebase, or any history change made
outside the app all left Redo enabled. Clicking it then wrote a commit
carrying a message that described something else entirely, onto history the
user never asked to touch. A reset recovers the mistake, but the user has
little reason to notice which message landed where.

One case of this was already handled: switching a tab to another repository
cleared the stack, with a comment explaining why. Every other HEAD-moving
event was missed, because clearing on every such event means enumerating them,
and a missed one silently reopens the bug.

## The fix compares positions, not events

Each redo entry now carries the position it belongs on (the oid HEAD was left
at) and the repository it belongs to (the tab's path at undo time), instead of
the stack being cleared by a list of named events. The Redo button, and the
backend command it calls, both ask the same question: is HEAD still at that
oid, in that repository? Nothing has to be remembered at a call site, and an
event nobody thought to enumerate cannot reintroduce the defect, because there
is no list of events to be incomplete.

Two facts drove the shape of the check:

- **Position alone is not enough within one repository.** A `git reset`, a
  checkout, or a rebase moves HEAD without necessarily changing anything else
  the app tracks, so the oid comparison has to run against live git state
  (`repo.head()`), not a cached value.
- **Position alone is not enough across repositories either.** Two clones of
  one repository share every commit oid. A tab can be pointed at a different
  repository without remounting the toolbar, so an oid match between the
  entry and the newly-active tab proves nothing about which repository the
  message was meant for. The entry also carries the repository path, and the
  redo is refused if it doesn't match the one being written to.

## Where the check lives, and why both layers

The Svelte toolbar gates the Redo button on both conditions, so the UI never
offers a redo it knows is stale. That check alone is not authoritative: it
runs against whatever the frontend last polled, and nothing stops a caller
other than the button — a second UI surface, a devtools `invoke` — from
asking the backend to redo with values the button would have refused.

`redo_commit_inner` (`src-tauri/src/commands/commit_actions.rs`) repeats both
checks itself, against the repository it is about to write to, immediately
before committing. A call whose position or repository doesn't match is
refused with `redo_stale` and writes nothing. This is the command's own
authority over what it will do, not a mirror of the UI's — the frontend check
exists so the button doesn't offer a redo it knows will be refused, not so
the backend can skip checking.

## What this does not cover

The redo stack lives entirely in the frontend; there is no server-side record
of what was actually undone. The backend check confirms *where* a redo lands
(the right position, in the right repository) but not that the subject and
body it's given actually came from a prior undo in this app. A caller that
supplies a position and repository that happen to be correct can still commit
an arbitrary message. This was true before the fix too, and closing it would
mean the backend tracking its own undo state — out of scope for what TRUNK-122
set out to fix, which was about *where* a stale redo lands, not the
authenticity of what it writes.

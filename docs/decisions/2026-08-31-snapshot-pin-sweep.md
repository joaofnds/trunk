# Snapshot pins are reclaimed by a sweep, not pruned at supersession

Status: accepted, 2026-08-31. Supersedes the pruning half of the TRUNK-18 ruling.

## The pin, and why it exists

Commenting on uncommitted work anchors the comment to a *snapshot*: a dangling
commit holding the working tree or index as it stood at comment time. Dangling
commits are what `git gc` collects, so each snapshot is held by a keepalive ref
under `refs/trunk/review-snapshots/`. That ref is its **pin**. Lose the pin and
gc eventually takes the commit; the comment's inline diff then resolves
`CommitGone` and the comment drops out of the panel.

## What was wrong

A snapshot is superseded when the tree changes and the next comment gesture mints
a new one. Pruning the superseded pin at that moment was the original design, and
TRUNK-18 gated it: skip the prune while any thread still anchors to the old
snapshot.

The gate asks a question that cannot be answered at that moment. Submitting a
comment is two separate calls: one mints and pins the snapshot, a later one writes
the thread anchored to it. Between them the snapshot has no thread. A supersession
landing in that gap is told, truthfully, that nothing anchors to the old snapshot,
and prunes a pin whose thread is about to arrive. The check and the deletion are
not atomic either, so the same loss occurs even with the gap closed.

Reachable in practice through a second window on the same repo, a commit-level
note, or the review CLI writing the store while the app submits. Not through the
diff composer alone, which is single-instance and latches its submit button.

Verified by running `git gc --prune=now` in that state: the comment's anchor
commit is genuinely collected.

## The rule

**Supersession never unpins anything.** A pin is deleted only by the sweep, and
only when two consecutive sweeps both find that nothing anchors to it.

One observation cannot distinguish an abandoned pin from one whose submit is
still in flight. Two can: between two sweeps, an in-flight submit has either
landed its thread or died with the process. This needs no coordination between
the app's windows and the CLI, which is why it was chosen over proving no write
is in flight — that would need a quiescence signal the store does not have, and
would couple the git side to the store's concurrency model.

The repo's two current pins are never candidates. They are what the next comment
will anchor to, and they carry no thread until someone comments.

## Where it runs

At the first review command to touch a repo in a process, and on review deletion.

"App start" means the first command because the review store opens lazily and per
repo. Once per process is deliberate: sweeping on every command would put ref I/O
back on the comment gesture's latency path, which is the shape this change
removed. Review deletion is included because that is when a batch of pins becomes
garbage at once.

The store's connection lock is never held across a git call. Every oid is decided
from the store first, the lock is released, and only then are refs deleted.

## What this costs

A pin outlives its threads until two sweeps have seen it unanchored, so in the
common case until the next app start. A pin is a ref file and a retained commit,
and snapshots are only minted when the tree actually changes, so the cost is
bounded and small. Correctness runs the other way: the failure this replaces
silently deletes a comment.

## Left open

How long a comment should remain renderable after nothing anchors to it is a
product question this decision does not settle. The answer here — until the second
sweep after the last anchor goes — falls out of the safety rule rather than being
chosen. Reopen this if a different answer is wanted.

## Also fixed

Nothing had ever reclaimed a pin. Deleting a review or a thread left its pins
alive permanently; TRUNK-18 recorded the leak and deferred it. The sweep closes it
with the same mechanism.

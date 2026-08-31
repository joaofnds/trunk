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
only when the store can prove the snapshot is finished with.

"Nothing anchors to it right now" is not that proof, and this is the subtle
part. A snapshot minted for a submit still in flight looks exactly like an
abandoned one: in both cases no thread names it. Any rule that judges a pin by
what anchors to it at the moment of looking will eventually delete a pin whose
comment is on its way.

What distinguishes the two is whether a thread has *ever* anchored:

- **Never anchored.** The snapshot may belong to an unfinished submit. Keep it.
- **Anchored once, no threads now.** Its comments were deleted, or the review
  holding them was. Garbage — but only until it is handed out again.

A snapshot oid is derived from the tree it captures, so reverting the working
tree to an earlier state hands out the same oid a second time. Handing an oid to
a caller therefore always clears the anchored flag: whatever that oid's history,
the caller holding it now is a submit in flight, and a flag left over from the
history would let the sweep reclaim the pin underneath it.

Both facts are written by the operations they describe, in the transactions that
perform them. `ensure_review_snapshot` records the snapshot in the same
transaction that stores its oid, before the oid is returned to any caller.
`submit_thread` marks it anchored in the same transaction that writes the
thread. So a pin cannot be judged against a stale view of either fact.

The sweep decides and records in one transaction, then deletes refs after that
transaction closes, so git I/O never runs under the store lock. That leaves a
window: between the decision and the deletion, the row can be written again —
handed out afresh, or anchored by a thread that landed. So each deletion
re-checks, under the store lock, that the row still carries the **grant id** the
decision read, and skips it otherwise.

The grant id comes from a per-repo sequence that only moves forward, and every
hand-out and every anchoring stamps a fresh one. Two weaker versions of this
were tried and both lost comments:

- A **mint timestamp** is blind twice over. Anchoring writes no timestamp at
  all, and the clock has one-second granularity, so it answers "how long ago"
  rather than "did this change".
- A **per-row counter** dies with its row. `forget` deletes the row and the next
  hand-out inserts a fresh one starting over, so a value the decision read can
  recur and the stale deletion looks valid again.

What the guard needs is identity, not change-count: proof that the row in front
of it is the one condemned, not a replacement that happens to look alike. Only a
value never reused for the repo gives that. Deciding once and acting later is
the staleness this design keeps running into, and this is what makes the
deferred action safe.

The repo's two current pins are never candidates. They are what the next comment
will anchor to.

### Why not two passes

The first version of this required two consecutive sweeps to agree a pin was
unanchored, reasoning that between two sweeps an in-flight submit must have
landed or died. That is false, and QA caught it: a submit that starts after the
first sweep and finishes after the second spans both, so both observations fall
inside one submit's window and the comment still loses its pin. Counting
observations cannot work, because the sweep has no way to see that a submit is
in flight. Only the submit can say so, which is what the record above does.

### The one bound that is time

A snapshot that is never anchored would otherwise be protected forever, so an
abandoned submit would leak a pin. Past `IN_FLIGHT_GRACE_SECS` (one day) a
snapshot that has never carried a thread is reclaimed. This is safe where the
original rule was not: it bounds how long a *single unfinished submit* may hold
a snapshot, not how long the whole system may take to notice something. Generous
on purpose — waiting costs a ref file, being early costs a comment.

A submit can still outlive it: a machine asleep with the composer open, or a
clock stepped forward. So the window is a heuristic, not the guarantee. The
guarantee is that submitting a thread whose snapshot is no longer on record puts
the record back and re-pins the ref, so a late submit repairs what the sweep
took rather than losing its comment.

## What this costs

A pin outlives its threads until a sweep runs, so in the common case until the
next app start, and an abandoned submit's snapshot is held for a day. A pin is a
ref file and a retained commit, and snapshots are only minted when the tree
actually changes, so the cost is bounded and small. Correctness runs the other
way: the failure this replaces silently deletes a comment.

Pins in a repo the user never reopens are never reclaimed, since the sweep runs
only for repos a review command touches.

## Left open

`IN_FLIGHT_GRACE_SECS` is set to a day by judgement, not measurement. It only has
to exceed the longest plausible gap between a comment resolving its snapshot and
submitting its text, which is a user typing a comment. A day is far past that.

## Reconciling the record with the refs

The record and the refs on disk drift. A pin minted before the record existed
has no row. A row survives a ref removed by a manual `gc` or another tool. A
crash between the sweep's decision and its deletions leaves both at once.

So the sweep reconciles first. A ref with no row is **adopted**: it gets a row
with the current mint time, and the ordinary anchor and grace rules decide it
from there. Adoption is not deletion, and the distinction is the whole point —
treating an unknown ref as garbage is exactly the assumption that lost comments
three times over. A row with no ref describes a pin already gone and is dropped.

This is also what reclaims pins from before this feature existed, without ever
assuming an unrecognised ref is safe to delete.

Two ordering rules fall out of it, and both are load-bearing:

- A row is forgotten only after its ref is actually gone, one at a time. Forget
  first and a deletion that fails loses its row, so the next reconciliation
  re-adopts the ref with a fresh mint time, protecting it again on every pass —
  it would never be reclaimed at all.
- Because a row therefore outlives the decision that condemned it, the check
  guarding the deletion compares the *grant id* against the one the decision
  saw, not merely whether a row exists. A row not yet cleared and a genuine
  regrant are otherwise indistinguishable.

A failing deletion does not abort the batch.

## Also fixed

Nothing had ever reclaimed a pin. Deleting a review or a thread left its pins
alive permanently; TRUNK-18 recorded the leak and deferred it.

# `ring` tells a busy subscriber from a dead one by pid, not by error

Date: 2026-09-02
Where: `src-tauri/src/reviewdb/events.rs`, `ring` / `abandoned`
Supersedes: `known-issues/2026-08-31-a-busy-subscriber-looks-dead-to-ring.md`

## The problem

`ring` sweeps up sockets left behind by subscribers that died: it connects to
each `<data_dir>/w/*.sock` and unlinks the ones it cannot reach. A live
subscriber that is merely busy — its accept backlog full, or its listener
briefly wedged on a peer that has not identified itself — refuses connections
in exactly the same way, and was unlinked the same way. It then never received
another doorbell and never learned why: `ring` finds subscribers by listing
that directory, so once the entry is gone the subscriber is deaf for good, with
no error raised anywhere.

TRUNK-114 saw this as a hung test. `store_events_survive_a_commit_racing_the_subscribe`
subscribes while a writer commits; `subscribe` binds the socket before it spawns
the listener thread, so there is a window where the path exists and nothing is
accepting yet. A doorbell landing in that window could unlink the socket the
test was about to use.

## Why not narrow on the error kind

The obvious narrowing is to unlink only on `ConnectionRefused`, on the theory
that a busy listener fails differently. Measured on macOS (2026-08-31, re-measured
2026-09-02), it does not:

| Socket state | `connect` result |
|---|---|
| Regular file named `.sock` | `Uncategorized` |
| Real socket, listener gone | `ConnectionRefused` |
| Real socket, live listener, backlog full (after 128 queued) | `ConnectionRefused` |

A live-but-busy listener and a dead one are the same error, so no predicate over
the error alone can separate them.

## The decision

Ask about the owner instead of the connection. `subscribe` already names each
socket `<pid>-<seq>.sock`, so the file says which process bound it. `abandoned`
parses that pid and calls `kill(pid, 0)`, which performs the existence and
permission check without delivering a signal:

- `kill` succeeds, or fails `EPERM` (the process exists, owned by someone else):
  the owner is alive. Keep the socket, however it refused.
- `kill` fails `ESRCH`: nobody is there. Unlink.
- The name does not parse as one this module wrote: leave it alone.

A pid is only meaningful on the machine that wrote it, but so is a unix socket —
both sides of the check are local by construction.

The one wrong answer available is pid reuse: a dead subscriber's pid reassigned
to an unrelated live process leaves a stale file in place. That errs toward
keeping it, which costs one failed `connect` per ring. The opposite error — a
deleted live socket — costs every event that subscriber existed to receive.

Note that `kill(0, 0)` addresses the caller's process group and *succeeds*, so
pid 0 reads as alive; the reclaim test uses a pid above the system ceiling.

## What this does not change

`ring` stays best-effort, and no doorbell failure may fail the write that rang
it. The regular-file case that the old `is_err()` check swept up is now left in
place rather than deleted — it does not parse as a pid-named socket, and `ring`
skips non-`.sock` extensions before that point in any case.

The listener is still serial, so N silent peers still cost N × `IDENTIFY_TIMEOUT`.
That is a throughput bound, not a correctness one: falling behind no longer
destroys the subscription, which is what this decision buys.

## Tests

- `store_events_survive_a_doorbell_that_cannot_connect` fills the accept backlog
  until `connect` is refused, rings, and asserts the live socket survives and the
  feed still announces afterwards.
- `store_events_reclaim_a_socket_whose_owner_is_gone` leaks a bound socket named
  for an impossible pid and asserts `ring` still reclaims it.

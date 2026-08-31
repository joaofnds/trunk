# A busy subscriber is indistinguishable from a dead one

Date: 2026-08-31
Where: `src-tauri/src/reviewdb/events.rs`, `ring`

## What happens

`ring` sweeps up sockets left behind by subscribers that died: it connects to
each `<data_dir>/w/*.sock`, and unlinks the ones it cannot reach. A subscriber
whose listener is alive but not accepting — its backlog full — is unlinked the
same way. It then never receives another doorbell and never learns why, because
nothing re-binds or reports a missing socket file.

## Why it is not fixed

The obvious narrowing is to unlink only on `ConnectionRefused`, on the theory
that a busy listener fails differently. Measured on macOS, it does not:

| Socket state | `connect` result |
|---|---|
| Regular file named `.sock` | `Uncategorized` |
| Real socket, listener gone | `ConnectionRefused` |
| Real socket, live listener, backlog full (after 128 queued) | `ConnectionRefused` |

A live-but-busy listener and a dead one are the same error. The narrowing buys
nothing, and it would additionally stop sweeping the regular-file case that the
current `is_err()` check does clean up. Reverted.

## How reachable it is

A subscriber has to accumulate 128 unaccepted connections. The listener takes
one connection per doorbell and returns immediately, so reaching that needs the
listener wedged. The wedge that made this live — an unbounded read on a peer
that never writes — was fixed in `5e034f1b`; the identify read now has a
deadline.

If this is ever worth closing properly, the fix is not at `connect` time. It is
for a subscriber to hold something the sweeper can check that a dead process
cannot fake — a lock on the socket path, or a pid file it can verify — rather
than inferring liveness from a connection error.

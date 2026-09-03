//! The store's change feed — the event-driven counterpart of `poll` (João's
//! ruling 2026-08-31: the watch verb blocks on events, no timers, no loops).
//!
//! SQLite offers no cross-process hook, and FSEvents was measured dropping
//! pure content appends to the WAL on the development host (2026-08-31,
//! confirming the grilled doc's 3C rejection of file-watching), so the feed
//! is a doorbell the writers themselves ring: every process that commits a
//! revision-bumping write runs this crate's `Store::write`, which afterwards
//! connects once to each socket under `<data_dir>/w/` and hangs up. A
//! subscriber owns one such socket and blocks on `accept` — a kernel wait,
//! not a loop — then verifies against `store_meta.revision`, so a coalesced
//! or spurious ring can never produce a wrong `Changed`. The draft autosave
//! never rings and never bumps; typing stays silent twice over.
//!
//! Unix only for now: the CLI watch verb is unsupported on Windows and says
//! so (the Windows console path itself is still CI-verified only).

use super::schema;
use crate::error::TrunkError;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};

/// Socket directory under the store's data dir. Short on purpose: unix
/// socket paths cap near 104 bytes on macOS.
const RING_DIR: &str = "w";

/// Written by [`StoreEvents::sync`] to mark its connection as a barrier
/// rather than a doorbell. A writer's `ring` sends nothing and hangs up.
const SYNC_BYTE: u8 = b's';

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreEvent {
    /// Another connection committed a revision-bumping write.
    Changed { revision: i64 },
    /// The store now refuses this build (a newer Trunk migrated it). Final:
    /// no further events follow.
    Refused,
}

/// A live subscription. Dropping it unbinds the doorbell and removes its
/// socket file.
pub struct StoreEvents {
    receiver: mpsc::Receiver<StoreEvent>,
    stop: Arc<AtomicBool>,
    socket_path: PathBuf,
    thread: Option<std::thread::JoinHandle<()>>,
    /// Rung by [`StoreEvents::sync`] and acknowledged by the listener once it
    /// has finished the ring that carried it.
    #[cfg(feature = "test-util")]
    synced: mpsc::Receiver<()>,
    /// The revision the subscriber has accounted for: read once at subscribe
    /// and advanced by the listener as it announces. Shared with the listener
    /// thread, which is the only writer.
    #[cfg(feature = "test-util")]
    last_revision: Arc<Mutex<Option<i64>>>,
}

impl StoreEvents {
    /// Block until the next event. `None` means the feed ended.
    pub fn recv(&self) -> Option<StoreEvent> {
        self.receiver.recv().ok()
    }

    /// The event already queued, if any. Paired with [`StoreEvents::sync`]
    /// this answers "was an event produced" without a deadline.
    #[cfg(feature = "test-util")]
    pub fn try_recv(&self) -> Option<StoreEvent> {
        self.receiver.try_recv().ok()
    }

    /// The revision this subscriber has accounted for, whether by reading it
    /// at subscribe or by announcing its way up to it. A commit at or below
    /// this revision needs no event; one above it has been lost. That is what
    /// separates "nothing to announce" from "the startup window dropped it".
    #[cfg(feature = "test-util")]
    pub fn baseline(&self) -> Option<i64> {
        *self.last_revision.lock().unwrap()
    }

    /// Block until every ring delivered so far has been processed.
    ///
    /// `ring` returns as soon as the kernel accepts the connection, so a
    /// writer's return says the doorbell is queued, not that this subscriber
    /// has looked at it. That gap is why a test asserting "no event" would
    /// otherwise have to guess at a duration. The listener takes connections
    /// in order, so a marked connection that has been processed proves every
    /// earlier ring has been too: after `sync` returns, `try_recv` is a sound
    /// way to ask whether an event was produced.
    ///
    /// The mark matters. A plain self-ring would be indistinguishable from a
    /// writer's, so the listener would check the revision on its account and
    /// announce a change the doorbell never reported — the barrier would
    /// manufacture the event it exists to observe, and a test using it would
    /// pass even with ringing disabled entirely. Writing [`SYNC_BYTE`] tells
    /// the listener to acknowledge without inspecting the store.
    ///
    /// `false` means the feed has ended and no further events can arrive.
    ///
    /// A refused connection does not mean that. The listener's accept queue is
    /// bounded, and a subscriber whose queue is full refuses exactly as a dead
    /// one does — the same ambiguity [`abandoned`] exists to resolve on the
    /// writer's side. The barrier is retried while the listener drains rather
    /// than reported as a dead feed, because the caller cannot tell the two
    /// apart from a single refusal and the whole point of `sync` is to wait for
    /// a listener that is behind.
    ///
    /// The retry is bounded by attempts, not by a clock, so it cannot pass by
    /// waiting long enough: each attempt is one connect, and a listener that is
    /// truly gone refuses every one of them and ends the loop.
    #[cfg(feature = "test-util")]
    pub fn sync(&self) -> bool {
        use std::io::Write;

        // Every sync acknowledges, so an ack from an earlier one may be
        // waiting. Discarding it first means this call blocks on its own.
        while self.synced.try_recv().is_ok() {}

        // One connect per drained peer plus headroom. The listener releases a
        // queued peer as fast as it can read from it — a closed one reads EOF
        // at once — so a queue filled to the kernel's cap clears well inside
        // this, and a socket with nobody behind it exhausts it immediately.
        const ATTEMPTS: usize = 512;

        let mut stream = None;
        for _ in 0..ATTEMPTS {
            match std::os::unix::net::UnixStream::connect(&self.socket_path) {
                Ok(s) => {
                    stream = Some(s);
                    break;
                }
                // Yield rather than spin: the listener needs the CPU to drain.
                Err(_) => std::thread::yield_now(),
            }
        }
        let Some(mut stream) = stream else {
            return false;
        };
        if stream.write_all(&[SYNC_BYTE]).is_err() {
            return false;
        }
        drop(stream);
        self.synced.recv().is_ok()
    }
}

impl Drop for StoreEvents {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // A self-ring is what unblocks the accept; portable and timer-free.
        let _ = std::os::unix::net::UnixStream::connect(&self.socket_path);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

static SUBSCRIBER_SEQ: AtomicU64 = AtomicU64::new(0);

/// Subscribe to the store under `data_dir`. The baseline revision is read
/// after the socket binds, so a commit can only be ordered before the
/// baseline (already included) or after the bind (its ring is queued): no
/// gap loses an event.
pub fn subscribe(data_dir: &Path) -> Result<StoreEvents, TrunkError> {
    let conn = Connection::open(data_dir.join(super::DB_FILE))
        .map_err(|e| TrunkError::new("io", e.to_string()))?;

    let ring_dir = data_dir.join(RING_DIR);
    std::fs::create_dir_all(&ring_dir).map_err(|e| TrunkError::new("io", e.to_string()))?;
    let socket_path = ring_dir.join(format!(
        "{}-{}.sock",
        std::process::id(),
        SUBSCRIBER_SEQ.fetch_add(1, Ordering::Relaxed),
    ));
    let listener = std::os::unix::net::UnixListener::bind(&socket_path)
        .map_err(|e| TrunkError::new("watch", e.to_string()))?;

    let last_revision = Arc::new(Mutex::new(super::revision(&conn).ok()));
    #[cfg(feature = "test-util")]
    let baseline = Arc::clone(&last_revision);
    let (sender, receiver) = mpsc::channel();
    #[cfg(feature = "test-util")]
    let (synced_tx, synced) = mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));

    let flag = Arc::clone(&stop);
    let thread = std::thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            if flag.load(Ordering::Relaxed) {
                return;
            }
            match identify(&mut stream) {
                // Acknowledge that everything rung before this point is
                // done, without inspecting the store.
                Caller::Barrier => {
                    #[cfg(feature = "test-util")]
                    let _ = synced_tx.send(());
                }
                Caller::Doorbell => {
                    if !announce_if_moved(&conn, &last_revision, &sender) {
                        return;
                    }
                }
            }
        }
    });

    Ok(StoreEvents {
        receiver,
        stop,
        socket_path,
        thread: Some(thread),
        #[cfg(feature = "test-util")]
        synced,
        #[cfg(feature = "test-util")]
        last_revision: baseline,
    })
}

/// Ring every subscriber of the store under `data_dir`. Called by
/// `Store::write` after a revision-bumping commit; best-effort by design — a
/// dead subscriber's leftover socket is cleaned up here (see [`abandoned`]
/// for how that is told apart from a live subscriber that is merely busy),
/// and no failure of a doorbell may fail the write that rang it.
pub fn ring(data_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(data_dir.join(RING_DIR)) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("sock") {
            continue;
        }
        if std::os::unix::net::UnixStream::connect(&path).is_err() && abandoned(&path) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Whether a socket that refused a doorbell has no owner left.
///
/// A failed `connect` does not answer this on its own. A file left behind by
/// a crashed subscriber refuses with `ECONNREFUSED`, and so does a perfectly
/// live one whose accept backlog is full (macOS caps that queue at 128) or
/// whose listener is briefly wedged on a peer that has not identified itself
/// yet — measured identical, kind and code (TRUNK-114). Deleting on the
/// error alone therefore unbinds subscribers that are merely busy: `ring`
/// lists this directory to find them, so once the entry is gone no later
/// doorbell can reach that subscriber and its feed goes deaf with no error
/// raised anywhere.
///
/// What does separate the two is the owner named in the file name. A live
/// process still holds its socket however busy it is; a pid that no longer
/// exists cannot be listening on anything. Sending signal 0 asks the kernel
/// exactly that question and changes nothing.
///
/// A pid is only meaningful on the machine that wrote it, but so is a unix
/// socket: both sides of this check are local by construction. Reuse of a
/// dead subscriber's pid is the one wrong answer available, and it errs
/// toward keeping a stale file — one failed `connect` per ring, against the
/// lost events that deleting a live socket costs.
fn abandoned(path: &Path) -> bool {
    let Some(pid) = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(|stem| stem.split('-').next())
        .and_then(|pid| pid.parse::<i32>().ok())
    else {
        // Not a name this module wrote; leave it alone.
        return false;
    };

    // SAFETY: `kill` with signal 0 performs the permission and existence
    // check without delivering anything.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return false;
    }
    // EPERM means the process exists and belongs to someone else, which is
    // still alive; only ESRCH says there is nobody there.
    std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// How long the listener waits for a connection to identify itself. A
/// barrier writes its byte before `sync` returns, so an honest peer needs
/// none of this. It exists so that a peer which connects and says nothing
/// cannot park the listener: `accept` is never reached again, every later
/// doorbell goes unread, and a running watch goes deaf without erroring.
const IDENTIFY_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(250);

/// What a peer turned out to be. A doorbell is the writers' signal that the
/// store moved; a barrier is [`StoreEvents::sync`] asking to be let through
/// once everything before it is done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Caller {
    Doorbell,
    Barrier,
}

/// Read one connection's opening move.
///
/// A doorbell sends no bytes and closes, which reads as end-of-stream. A
/// barrier sends [`SYNC_BYTE`]. Everything else — a wrong byte, a read
/// error, silence past [`IDENTIFY_TIMEOUT`] — is taken for a doorbell,
/// because that is the safe direction: a doorbell misread as a barrier drops
/// a real change, while a barrier misread as a doorbell costs only a
/// revision check that announces nothing.
///
/// The timeout is best-effort on purpose. A peer that has already hung up
/// makes `set_read_timeout` fail with `InvalidInput` on macOS, while the
/// read itself still reports the hangup or the byte correctly — so the
/// error is ignored rather than treated as an answer.
fn identify(stream: &mut std::os::unix::net::UnixStream) -> Caller {
    use std::io::Read;

    let _ = stream.set_read_timeout(Some(IDENTIFY_TIMEOUT));
    let mut byte = [0u8; 1];
    match stream.read(&mut byte) {
        Ok(1) if byte[0] == SYNC_BYTE => Caller::Barrier,
        _ => Caller::Doorbell,
    }
}

/// One ring's worth of verification: guard, read the revision, announce a
/// movement exactly once. Returns `false` when the feed must end (the store
/// refuses this build).
fn announce_if_moved(
    conn: &Connection,
    last_revision: &Mutex<Option<i64>>,
    sender: &mpsc::Sender<StoreEvent>,
) -> bool {
    match schema::version_guard(conn) {
        Err(e) if e.code == "store_newer" => {
            let _ = sender.send(StoreEvent::Refused);
            return false;
        }
        // A transient read failure is not a change and not a refusal; the
        // next ring re-checks.
        Err(_) => return true,
        Ok(()) => {}
    }

    let revision = super::revision(conn).ok();
    let mut last = last_revision.lock().unwrap();
    if revision != *last {
        *last = revision;
        if let Some(revision) = revision {
            let _ = sender.send(StoreEvent::Changed { revision });
        }
    }

    true
}

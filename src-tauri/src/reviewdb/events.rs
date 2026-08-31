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
}

impl StoreEvents {
    /// Block until the next event. `None` means the feed ended.
    pub fn recv(&self) -> Option<StoreEvent> {
        self.receiver.recv().ok()
    }

    /// `recv` with a deadline, for tests and impatient callers. Production
    /// consumers use `recv`; the deadline here is the caller's, not ours.
    pub fn recv_timeout(&self, timeout: std::time::Duration) -> Option<StoreEvent> {
        self.receiver.recv_timeout(timeout).ok()
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

    let last_revision = Mutex::new(super::revision(&conn).ok());
    let (sender, receiver) = mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));

    let flag = Arc::clone(&stop);
    let thread = std::thread::spawn(move || {
        while let Ok((_stream, _)) = listener.accept() {
            if flag.load(Ordering::Relaxed) {
                return;
            }
            if !announce_if_moved(&conn, &last_revision, &sender) {
                return;
            }
        }
    });

    Ok(StoreEvents {
        receiver,
        stop,
        socket_path,
        thread: Some(thread),
    })
}

/// Ring every subscriber of the store under `data_dir`. Called by
/// `Store::write` after a revision-bumping commit; best-effort by design — a
/// dead subscriber's leftover socket is cleaned up here, and no failure of a
/// doorbell may fail the write that rang it.
pub fn ring(data_dir: &Path) {
    let Ok(entries) = std::fs::read_dir(data_dir.join(RING_DIR)) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("sock") {
            continue;
        }
        if std::os::unix::net::UnixStream::connect(&path).is_err() {
            let _ = std::fs::remove_file(&path);
        }
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

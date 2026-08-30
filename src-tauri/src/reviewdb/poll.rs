//! Live reflection's primitive (plan §3, D3): `PRAGMA data_version` on a
//! dedicated autocommit connection moves when any OTHER connection commits —
//! a CLI reply, a second app instance — and never for this connection's own
//! work. `store_meta.revision` then decides whether the movement deserves an
//! emit: the draft autosave commits without bumping it, so typing never
//! triggers a refetch storm.
//!
//! The connection must stay autocommit: a held read transaction under WAL
//! freezes the snapshot and `data_version` stops moving (grilled §3.3). A
//! plain `std::thread` with `sleep` owns the loop — no tokio `time` feature
//! for one timer.

use super::{DB_FILE, schema};
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const INTERVAL: Duration = Duration::from_millis(300);

/// Stops the loop when dropped; the poll also stops itself when the store
/// refuses (a newer build migrated it) rather than looping on the refusal.
pub struct PollHandle {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl PollHandle {
    pub fn stop(mut self) {
        self.halt();
    }

    /// Whether the loop has exited on its own — the refused-store posture a
    /// test observes without joining.
    pub fn is_stopped(&self) -> bool {
        self.thread
            .as_ref()
            .is_none_or(std::thread::JoinHandle::is_finished)
    }

    fn halt(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for PollHandle {
    fn drop(&mut self) {
        self.halt();
    }
}

/// Watch the store under `data_dir`, calling `on_change` when another
/// connection committed a revision-bumping write. The first observation is
/// taken at spawn: only movement after that is announced.
pub fn spawn(data_dir: &Path, on_change: impl Fn() + Send + 'static) -> PollHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let db_path = data_dir.join(DB_FILE);

    let thread = std::thread::spawn(move || {
        let Ok(conn) = Connection::open(&db_path) else {
            eprintln!("review poll: cannot open {}", db_path.display());
            return;
        };
        run(&conn, &flag, on_change);
    });

    PollHandle {
        stop,
        thread: Some(thread),
    }
}

fn run(conn: &Connection, stop: &AtomicBool, on_change: impl Fn()) {
    let mut last_data_version = data_version(conn).unwrap_or(0);
    // `None` until the store is migrated far enough to carry `store_meta`;
    // comparing Options means the table's first appearance counts as change.
    let mut last_revision = super::revision(conn).ok();

    loop {
        std::thread::sleep(INTERVAL);
        if stop.load(Ordering::Relaxed) {
            return;
        }

        // A store a newer build migrated is refused everywhere (D4); polling
        // it forever would just re-observe the refusal every 300 ms.
        match schema::user_version(conn) {
            Ok(version) if version > schema::CURRENT_VERSION => return,
            Ok(_) => {}
            Err(_) => continue,
        }

        let Ok(current) = data_version(conn) else {
            continue;
        };
        if current == last_data_version {
            continue;
        }
        last_data_version = current;

        let revision = super::revision(conn).ok();
        if revision != last_revision {
            last_revision = revision;
            on_change();
        }
    }
}

fn data_version(conn: &Connection) -> Result<i64, rusqlite::Error> {
    conn.pragma_query_value(None, "data_version", |row| row.get(0))
}

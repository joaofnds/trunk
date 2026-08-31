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
//!
//! What paces the loop is a [`Ticker`], not a bare `sleep`. Production ticks
//! on the wall clock; a test supplies [`ManualTicker`] and releases one cycle
//! at a time, so a poll test asserts on the loop having run rather than on a
//! deadline the scheduler may miss under load.

use super::{DB_FILE, schema};
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::time::Duration;

pub const INTERVAL: Duration = Duration::from_millis(300);

/// Paces the poll loop. `wait` blocks until the next cycle is due and returns
/// `false` when the loop should exit instead.
pub trait Ticker: Send + 'static {
    fn wait(&self) -> bool;

    /// Called after each completed cycle, so a driving test learns the loop
    /// has finished the work that cycle's observation implies. The wall-clock
    /// ticker has no one listening.
    fn cycle_done(&self) {}
}

/// Production's pacing: sleep the interval, then honour the stop flag.
struct ClockTicker {
    stop: Arc<AtomicBool>,
}

impl Ticker for ClockTicker {
    fn wait(&self) -> bool {
        std::thread::sleep(INTERVAL);
        !self.stop.load(Ordering::Relaxed)
    }
}

/// A ticker a test drives by hand. [`PollDriver::run_cycle`] releases exactly
/// one loop pass and blocks until that pass is complete, which is what lets a
/// poll test assert without a timeout: after `run_cycle` returns, whatever the
/// cycle was going to do has already happened.
///
/// The loop parks in `recv` between cycles, where the stop flag cannot reach
/// it, so [`PollHandle::stop`] does not stop a ticked loop. Stopping works by
/// hanging up instead: drop the [`PollDriver`], `recv` fails, and the loop
/// exits. A test that lets its driver fall out of scope has already done this.
pub struct ManualTicker {
    ticks: Receiver<()>,
    done: SyncSender<()>,
}

/// The test's end of a [`ManualTicker`]. Dropping it stops the poll loop.
pub struct PollDriver {
    ticks: SyncSender<()>,
    done: Receiver<()>,
}

impl ManualTicker {
    /// A manual ticker and the driver that steps it.
    pub fn new() -> (ManualTicker, PollDriver) {
        let (tick_tx, tick_rx) = sync_channel(0);
        let (done_tx, done_rx) = sync_channel(0);
        (
            ManualTicker {
                ticks: tick_rx,
                done: done_tx,
            },
            PollDriver {
                ticks: tick_tx,
                done: done_rx,
            },
        )
    }
}

impl Ticker for ManualTicker {
    fn wait(&self) -> bool {
        self.ticks.recv().is_ok()
    }

    fn cycle_done(&self) {
        let _ = self.done.send(());
    }
}

impl PollDriver {
    /// Run one poll cycle and return once it has finished. `false` means the
    /// loop exited during the cycle instead of completing it — the refused-
    /// store posture.
    pub fn run_cycle(&self) -> bool {
        if self.ticks.send(()).is_err() {
            return false;
        }
        self.done.recv().is_ok()
    }
}

/// Stops the loop when dropped; the poll also stops itself when the store
/// refuses (a newer build migrated it) rather than looping on the refusal.
pub struct PollHandle {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    /// A clock-paced loop wakes on its own and can be joined. A ticked loop
    /// parks until its driver ticks or hangs up, so stopping must not join it.
    joins_on_stop: bool,
}

impl PollHandle {
    pub fn stop(mut self) {
        self.halt();
    }

    /// Whether the loop has exited on its own — the refused-store posture a
    /// test observes without joining. True as well when no loop was ever
    /// spawned, so a test that means "the loop ran and then stopped" wants
    /// [`PollHandle::ran_and_stopped`] instead.
    pub fn is_stopped(&self) -> bool {
        self.thread
            .as_ref()
            .is_none_or(std::thread::JoinHandle::is_finished)
    }

    /// Whether a loop was spawned and has since exited. Distinguishes the
    /// refused-store posture from a poll that never started, which
    /// [`PollHandle::is_stopped`] reports alike.
    pub fn ran_and_stopped(&self) -> bool {
        self.thread
            .as_ref()
            .is_some_and(std::thread::JoinHandle::is_finished)
    }

    fn halt(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let Some(thread) = self.thread.take() else {
            return;
        };
        if self.joins_on_stop {
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
/// connection committed a revision-bumping write. Only movement after the
/// baseline is announced, and the baseline is read before this function
/// returns: a write the caller makes after `spawn` is always seen. Reading it
/// on the spawned thread instead would lose any write that landed before that
/// thread was first scheduled.
pub fn spawn(data_dir: &Path, on_change: impl Fn() + Send + 'static) -> PollHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let ticker = ClockTicker {
        stop: Arc::clone(&stop),
    };
    spawn_with(data_dir, ticker, stop, true, on_change)
}

/// [`spawn`] on a caller-supplied ticker: the seam a poll test drives.
pub fn spawn_ticked(
    data_dir: &Path,
    ticker: impl Ticker,
    on_change: impl Fn() + Send + 'static,
) -> PollHandle {
    spawn_with(
        data_dir,
        ticker,
        Arc::new(AtomicBool::new(false)),
        false,
        on_change,
    )
}

fn spawn_with(
    data_dir: &Path,
    ticker: impl Ticker,
    stop: Arc<AtomicBool>,
    joins_on_stop: bool,
    on_change: impl Fn() + Send + 'static,
) -> PollHandle {
    let db_path = data_dir.join(DB_FILE);
    let conn = match Connection::open(&db_path) {
        Ok(conn) => conn,
        Err(_) => {
            eprintln!("review poll: cannot open {}", db_path.display());
            return PollHandle {
                stop,
                thread: None,
                joins_on_stop,
            };
        }
    };
    let baseline = Baseline::read(&conn);

    let thread = std::thread::spawn(move || run(&conn, baseline, &ticker, on_change));

    PollHandle {
        stop,
        thread: Some(thread),
        joins_on_stop,
    }
}

/// What the loop compares each cycle's observation against.
struct Baseline {
    data_version: i64,
    /// `None` until the store is migrated far enough to carry `store_meta`;
    /// comparing Options means the table's first appearance counts as change.
    revision: Option<i64>,
}

impl Baseline {
    fn read(conn: &Connection) -> Baseline {
        Baseline {
            data_version: data_version(conn).unwrap_or(0),
            revision: super::revision(conn).ok(),
        }
    }
}

fn run(conn: &Connection, baseline: Baseline, ticker: &impl Ticker, on_change: impl Fn()) {
    let mut last_data_version = baseline.data_version;
    let mut last_revision = baseline.revision;

    loop {
        if !ticker.wait() {
            return;
        }

        // A store a newer build migrated is refused everywhere (D4); polling
        // it forever would just re-observe the refusal every 300 ms.
        match schema::user_version(conn) {
            Ok(version) if version > schema::CURRENT_VERSION => return,
            Ok(_) => {}
            Err(_) => {
                ticker.cycle_done();
                continue;
            }
        }

        let Ok(current) = data_version(conn) else {
            ticker.cycle_done();
            continue;
        };
        if current != last_data_version {
            last_data_version = current;

            let revision = super::revision(conn).ok();
            if revision != last_revision {
                last_revision = revision;
                on_change();
            }
        }

        ticker.cycle_done();
    }
}

fn data_version(conn: &Connection) -> Result<i64, rusqlite::Error> {
    conn.pragma_query_value(None, "data_version", |row| row.get(0))
}

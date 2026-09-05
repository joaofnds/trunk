//! The persistent review store: one SQLite database in the app data dir holding
//! every repo's reviews, threads, drafts, pointers and snapshot OIDs, keyed by
//! canonical repo path as data (D1, D2).
//!
//! Every function takes `data_dir: &Path` rather than an `AppHandle` — the same
//! testability wedge `review_store.rs` documents, and what the CLI needs, since
//! no `AppHandle` exists before Tauri init.

pub mod anchor;
pub mod commits;
pub mod drafts;
#[cfg(unix)]
pub mod events;
pub mod ids;
pub mod pins;
pub mod poll;
pub mod replies;
pub mod reviews;
pub mod schema;
pub mod snapshots;
pub mod threads;

use crate::error::TrunkError;
use crate::review_types::Channel;
use rusqlite::{Connection, Transaction, TransactionBehavior};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Mutex;

const BUSY_TIMEOUT_MS: u32 = 5000;

/// The database file name under the app data dir. One well-known path is what
/// makes the CLI's store discovery a compiled-in identifier (D2).
pub const DB_FILE: &str = "reviews.db";

#[derive(Debug)]
pub struct Store {
    conn: Mutex<Connection>,
    data_dir: PathBuf,
}

/// The store's data directory for a compiled-in app identifier — the CLI's
/// whole store discovery (D4): no filesystem probing, the dev binary reads
/// the dev store because its identifier says so. Must name the exact
/// directory Tauri's `app_data_dir` resolves for the same identifier;
/// `data_dir_matches_the_app_handles` pins the agreement.
///
/// `TRUNK_DATA_DIR` overrides the derivation, in the app and the CLI both
/// (§5.2). It is the one sanctioned escape from the identifier: a test-built
/// binary carries the prod identifier and would otherwise read the
/// developer's real store.
#[must_use]
pub fn data_dir_for(identifier: &str) -> PathBuf {
    if let Some(dir) = std::env::var_os("TRUNK_DATA_DIR") {
        return PathBuf::from(dir);
    }

    #[cfg(target_os = "macos")]
    {
        home().join("Library/Application Support").join(identifier)
    }
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(std::env::var_os("APPDATA").expect("APPDATA is unset")).join(identifier)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        match std::env::var_os("XDG_DATA_HOME") {
            Some(xdg) if !xdg.is_empty() => PathBuf::from(xdg).join(identifier),
            _ => home().join(".local/share").join(identifier),
        }
    }
}

#[cfg(unix)]
fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").expect("HOME is unset"))
}

/// Open (creating if absent) the review store under `data_dir`, applying
/// migrations under the write lock. A store whose `user_version` exceeds this
/// build is refused with `store_newer` and left untouched; an unreadable one is
/// quarantined together with its `-wal` and `-shm` sidecars and started empty.
///
/// # Errors
///
/// Returns `store_newer` when the store's schema is newer than this build,
/// `io` when `data_dir` cannot be created, and the `SQLite` error when the
/// store will not open or migrate.
pub fn open(data_dir: &Path) -> Result<Store, TrunkError> {
    std::fs::create_dir_all(data_dir).map_err(|e| TrunkError::new("io", e.to_string()))?;
    let path = data_dir.join(DB_FILE);

    // Quarantine ONLY on corruption. Every other failure — a full disk, a
    // read-only volume, EACCES on the data dir, fd exhaustion — is transient, and
    // renaming the one database that holds every repo's reviews aside is
    // destruction from the user's point of view.
    match open_at(&path, data_dir) {
        Ok(store) => Ok(store),
        Err(e) if e.code == CORRUPT => {
            quarantine_db(&path)?;
            open_at(&path, data_dir)
        }
        Err(e) => Err(e),
    }
}

fn open_at(path: &Path, data_dir: &Path) -> Result<Store, TrunkError> {
    let conn = Connection::open(path).map_err(sqlite_error)?;
    conn.busy_timeout(std::time::Duration::from_millis(u64::from(BUSY_TIMEOUT_MS)))
        .map_err(sqlite_error)?;

    // Before any pragma that writes the file: `journal_mode = WAL` rewrites the
    // header, so a store this build must refuse would be modified on the way to
    // refusing it.
    schema::accept_unreleased_v8(&conn)?;
    schema::version_guard(&conn)?;

    conn.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))
        .map_err(sqlite_error)?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(sqlite_error)?;
    // SQLite defaults foreign keys OFF, per connection. `active_review`'s cascade
    // is what makes review deletion leave no dangling pointer (D5).
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(sqlite_error)?;

    schema::migrate(&conn)?;

    Ok(Store {
        conn: Mutex::new(conn),
        data_dir: data_dir.to_path_buf(),
    })
}

/// Rename an unreadable database and both WAL sidecars out of the way — never
/// delete them (the `storage.rs` posture, extended to WAL's file set). The three
/// files move as one unit: a stale `-wal` beside a fresh empty db is a corrupt
/// store again.
fn quarantine_db(path: &Path) -> Result<(), TrunkError> {
    let mut suffix = String::from("corrupt");
    let mut n = 2;
    while path.with_extension(format!("db.{suffix}")).exists() {
        suffix = format!("corrupt-{n}");
        n += 1;
    }

    for sidecar in ["", "-wal", "-shm"] {
        let from = sidecar_path(path, sidecar);
        if !from.exists() {
            continue;
        }
        let to = sidecar_path(&path.with_extension(format!("db.{suffix}")), sidecar);
        std::fs::rename(&from, &to).map_err(|e| TrunkError::new("io", e.to_string()))?;
    }

    Ok(())
}

fn sidecar_path(path: &Path, sidecar: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(sidecar);
    PathBuf::from(name)
}

impl Store {
    /// Where this store lives — what a subscriber hands to `events::subscribe`.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Run `f` inside one `BEGIN IMMEDIATE` transaction.
    ///
    /// `Connection::transaction()` defaults to `Deferred`, which takes its write
    /// lock late: a transaction that reads then writes — every transaction in
    /// this design — fails the upgrade with `SQLITE_BUSY_SNAPSHOT` under WAL, and
    /// the busy handler is not consulted for that error. Removing `Immediate`
    /// reintroduces the lost-update-shaped failure SQLite was chosen to avoid.
    ///
    /// `f` receives the transaction, never the `Store`: calling back into
    /// `read`/`write` from inside would deadlock on this non-reentrant mutex —
    /// a frozen app with no error, not a panic.
    ///
    /// # Errors
    ///
    /// Returns whatever `f` returns, `store_newer` when the store's schema is
    /// newer than this build, and the `SQLite` error when the transaction fails.
    pub fn write<T>(
        &self,
        f: impl FnOnce(&Transaction) -> Result<T, TrunkError>,
    ) -> Result<T, TrunkError> {
        self.write_bumping(f, true)
    }

    /// A write the poll must not announce: today only the per-keystroke draft
    /// autosave, whose bump would refetch every thread while the user types
    /// (plan §3). Everything else goes through `write`.
    ///
    /// # Errors
    ///
    /// Returns whatever `f` returns, `store_newer` when the store's schema is
    /// newer than this build, and the `SQLite` error when the transaction fails.
    pub fn write_quiet<T>(
        &self,
        f: impl FnOnce(&Transaction) -> Result<T, TrunkError>,
    ) -> Result<T, TrunkError> {
        self.write_bumping(f, false)
    }

    fn write_bumping<T>(
        &self,
        f: impl FnOnce(&Transaction) -> Result<T, TrunkError>,
        bump: bool,
    ) -> Result<T, TrunkError> {
        let mut conn = self.conn.lock().unwrap();

        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_error)?;
        // Inside the lock the guard cannot be overtaken: a newer build committing
        // its migration between the check and the write is the integrity failure
        // the guard exists to prevent (D4).
        schema::version_guard(&tx)?;
        let value = f(&tx)?;
        if bump {
            tx.execute("UPDATE store_meta SET revision = revision + 1", [])
                .map_err(sqlite_error)?;
        }
        tx.commit().map_err(sqlite_error)?;

        // Ring only after the commit is durable: a subscriber woken early
        // would read the pre-commit revision and swallow the ring.
        #[cfg(unix)]
        if bump {
            events::ring(&self.data_dir);
        }

        Ok(value)
    }

    /// Run `f` against the connection for a read. The version guard runs here
    /// too: a process must never read a store whose schema it does not know.
    ///
    /// # Errors
    ///
    /// Returns whatever `f` returns, and `store_newer` when the store's schema
    /// is newer than this build.
    pub fn read<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, TrunkError>,
    ) -> Result<T, TrunkError> {
        let conn = self.conn.lock().unwrap();
        schema::version_guard(&conn)?;

        f(&conn)
    }
}

/// The store's mutation counter — what the poll compares to decide whether a
/// `data_version` movement deserves an emit.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn revision(conn: &Connection) -> Result<i64, TrunkError> {
    conn.query_row("SELECT revision FROM store_meta", [], |row| row.get(0))
        .map_err(sqlite_error)
}

/// The error code a corrupt store reports. Distinguishing it from every other
/// SQLite failure is what keeps `open` from quarantining a healthy database.
pub const CORRUPT: &str = "store_corrupt";

/// Translate a driver failure into a stable port error, keeping the one
/// distinction the caller acts on — `storage.rs`'s posture is "never destroy",
/// and only genuine corruption earns the quarantine.
#[must_use]
pub fn sqlite_error(e: rusqlite::Error) -> TrunkError {
    use rusqlite::ErrorCode;

    let corrupt = matches!(
        &e,
        rusqlite::Error::SqliteFailure(f, _)
            if matches!(f.code, ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)
    );

    TrunkError::new(if corrupt { CORRUPT } else { "store" }, e.to_string())
}

/// The primary-key form of a canonical repo path. Every table keyed by repo path
/// goes through this, so no two tables can disagree on the key.
#[must_use]
pub fn repo_key(repo_path: &Path) -> String {
    repo_path.to_string_lossy().into_owned()
}

/// The human-only-edit policy shared by `threads::edit` and `replies::edit`:
/// agent-attributed text is not editable from the UI. `channel` is `None` when
/// the row itself is missing, in which case `missing` supplies the caller's
/// own `not_found` error (its message names the row kind, thread or reply).
///
/// # Errors
///
/// Returns whatever `missing` builds when `channel` is `None`, and
/// `not_editable` when the text is agent-attributed.
pub fn require_human(
    channel: Option<String>,
    missing: impl FnOnce() -> TrunkError,
) -> Result<(), TrunkError> {
    let Some(channel) = channel else {
        return Err(missing());
    };
    if Channel::from_str(&channel)? != Channel::Human {
        return Err(TrunkError::new(
            "not_editable",
            "agent-attributed text is not editable from the UI",
        ));
    }
    Ok(())
}

/// The published-is-permanent policy shared by `threads::delete` and
/// `replies::delete`: a published review's rows are permanent. `noun` names
/// what's permanent in the error message (`"threads"` / `"replies"`); the
/// missing-row case is each caller's own idempotent no-op, not this guard's
/// concern.
///
/// # Errors
///
/// Returns `review_published` when `published` is true.
pub fn require_unpublished(published: bool, noun: &str) -> Result<(), TrunkError> {
    if published {
        Err(TrunkError::new(
            "review_published",
            format!("a published review's {noun} are permanent"),
        ))
    } else {
        Ok(())
    }
}

/// Wall-clock seconds, for `created_at` / `updated_at`. Every store function
/// takes the timestamp as an argument instead of reading the clock itself, so a
/// test can pin it.
#[must_use]
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn count_reviews(store: &Store) -> i64 {
        store
            .read(|conn| {
                conn.query_row("SELECT COUNT(*) FROM reviews", [], |row| row.get(0))
                    .map_err(sqlite_error)
            })
            .unwrap()
    }

    fn insert_review(store: &Store, id: &str) {
        store
            .write(|tx| {
                tx.execute(
                    "INSERT INTO reviews (id, repo_path, title, published, created_at, updated_at)
                     VALUES (?1, '/repo', 'title', 0, 0, 0)",
                    [id],
                )
                .map_err(sqlite_error)?;
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn opens_migrates_and_reopens() {
        let dir = TempDir::new().unwrap();

        let store = open(dir.path()).unwrap();
        insert_review(&store, "FIRSTREV");
        drop(store);

        let reopened = open(dir.path()).unwrap();

        assert_eq!(
            schema::user_version(&reopened.conn.lock().unwrap()).unwrap(),
            schema::CURRENT_VERSION,
            "an empty data dir must migrate to the current schema version",
        );
        assert_eq!(
            count_reviews(&reopened),
            1,
            "a row written through the first handle must survive reopening",
        );
    }

    /// Two `Store`s over one file, each running the read-then-write shape every
    /// transaction in this design has. Under the default `Deferred` behavior the
    /// second writer's upgrade fails with `SQLITE_BUSY_SNAPSHOT`, which the busy
    /// handler is not consulted for — so this is what stands behind the claim
    /// that `busy_timeout` covers contention.
    #[test]
    fn two_connections_serialize_read_then_write() {
        use std::sync::Arc;
        use std::thread;

        let dir = TempDir::new().unwrap();
        let first = Arc::new(open(dir.path()).unwrap());
        let second = Arc::new(open(dir.path()).unwrap());
        insert_review(&first, "COUNTER1");

        let bump = |store: Arc<Store>, times: usize| {
            thread::spawn(move || {
                for _ in 0..times {
                    store
                        .write(|tx| {
                            let seen: i64 = tx
                                .query_row(
                                    "SELECT published FROM reviews WHERE id = 'COUNTER1'",
                                    [],
                                    |r| r.get(0),
                                )
                                .map_err(sqlite_error)?;
                            tx.execute(
                                "UPDATE reviews SET published = ?1 WHERE id = 'COUNTER1'",
                                [seen + 1],
                            )
                            .map_err(sqlite_error)?;
                            Ok(())
                        })
                        .expect("a contended read-then-write must wait, not fail");
                }
            })
        };

        let a = bump(Arc::clone(&first), 50);
        let b = bump(Arc::clone(&second), 50);
        a.join().unwrap();
        b.join().unwrap();

        let total: i64 = first
            .read(|conn| {
                conn.query_row(
                    "SELECT published FROM reviews WHERE id = 'COUNTER1'",
                    [],
                    |r| r.get(0),
                )
                .map_err(sqlite_error)
            })
            .unwrap();
        assert_eq!(
            total, 100,
            "every increment must land — a lost update is the failure SQLite was chosen to avoid",
        );
    }

    #[test]
    fn a_newer_user_version_is_refused_untouched() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(DB_FILE);
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", schema::CURRENT_VERSION + 1)
                .unwrap();
        }
        let before = std::fs::read(&path).unwrap();

        let err = open(dir.path()).expect_err("a newer store must be refused");

        assert_eq!(err.code, "store_newer");
        assert_eq!(
            before,
            std::fs::read(&path).unwrap(),
            "a refused store must be left byte-unchanged, never quarantined",
        );
    }

    #[test]
    fn an_unreadable_db_is_quarantined_and_the_store_starts_empty() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(DB_FILE);
        std::fs::write(&path, b"this is not a sqlite database at all").unwrap();
        std::fs::write(dir.path().join("reviews.db-wal"), b"stale wal").unwrap();
        std::fs::write(dir.path().join("reviews.db-shm"), b"stale shm").unwrap();

        let store = open(dir.path()).expect("an unreadable store must start empty, not fail");
        insert_review(&store, "AFTERQ12");

        assert_eq!(
            count_reviews(&store),
            1,
            "the fresh store starts empty and is writable",
        );
        assert!(
            dir.path().join("reviews.db.corrupt").exists(),
            "the database itself must be quarantined, never deleted",
        );
        assert_eq!(
            std::fs::read(dir.path().join("reviews.db.corrupt")).unwrap(),
            b"this is not a sqlite database at all",
            "quarantine must preserve the unreadable bytes for recovery",
        );
        assert_ne!(
            std::fs::read(dir.path().join("reviews.db-wal")).unwrap(),
            b"stale wal",
            "no stale sidecar may survive beside the fresh db — it would be a corrupt store again",
        );
    }

    #[test]
    fn quarantine_moves_the_wal_sidecars_with_the_database() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(DB_FILE);
        std::fs::write(&path, b"db").unwrap();
        std::fs::write(dir.path().join("reviews.db-wal"), b"wal").unwrap();
        std::fs::write(dir.path().join("reviews.db-shm"), b"shm").unwrap();

        quarantine_db(&path).unwrap();

        assert!(
            !path.exists()
                && !dir.path().join("reviews.db-wal").exists()
                && !dir.path().join("reviews.db-shm").exists(),
            "all three files leave together",
        );
        assert!(
            dir.path().join("reviews.db.corrupt").exists()
                && dir.path().join("reviews.db.corrupt-wal").exists()
                && dir.path().join("reviews.db.corrupt-shm").exists(),
            "all three arrive together — a sidecar left behind is the corruption again",
        );
    }

    #[test]
    fn a_second_quarantine_preserves_the_first() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(DB_FILE);

        std::fs::write(&path, b"first").unwrap();
        quarantine_db(&path).unwrap();
        std::fs::write(&path, b"second").unwrap();
        quarantine_db(&path).unwrap();

        assert_eq!(
            std::fs::read(dir.path().join("reviews.db.corrupt")).unwrap(),
            b"first",
            "an occupied sidecar name must not be overwritten",
        );
        assert_eq!(
            std::fs::read(dir.path().join("reviews.db.corrupt-2")).unwrap(),
            b"second",
        );
    }
}

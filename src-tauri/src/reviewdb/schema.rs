//! Schema DDL and the `user_version` migration ladder.
//!
//! The version guard runs on every store access path — open, read and write —
//! never open-time only: a still-running old process whose poll fires after a
//! newer build migrated the store must refuse that operation too (D4).

use super::sqlite_error;
use crate::error::TrunkError;
use rusqlite::Connection;

pub const CURRENT_VERSION: i64 = 7;

const V1: &str = r"
CREATE TABLE reviews (
    id         TEXT PRIMARY KEY,
    repo_path  TEXT    NOT NULL,
    title      TEXT    NOT NULL,
    published  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE threads (
    id          TEXT PRIMARY KEY,
    review_id   TEXT    NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    body        TEXT    NOT NULL,
    channel     TEXT    NOT NULL CHECK (channel IN ('human', 'agent')),
    state       TEXT    NOT NULL DEFAULT 'open'
                CHECK (state IN ('open', 'addressed', 'done', 'dismissed')),
    stale       INTEGER NOT NULL DEFAULT 0,
    anchor_kind TEXT    NOT NULL CHECK (anchor_kind IN ('diff', 'commit', 'none')),
    commit_oid  TEXT,
    file_path   TEXT,
    source      TEXT CHECK (source IS NULL OR source IN ('Diff', 'FullFile')),
    side        TEXT CHECK (side IS NULL OR side IN ('Old', 'New')),
    start_line  INTEGER,
    end_line    INTEGER,
    excerpt     TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE review_commits (
    review_id TEXT    NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    oid       TEXT    NOT NULL,
    position  INTEGER NOT NULL,
    PRIMARY KEY (review_id, oid)
);

CREATE TABLE drafts (
    repo_path   TEXT PRIMARY KEY,
    body        TEXT    NOT NULL,
    anchor_kind TEXT    NOT NULL CHECK (anchor_kind IN ('diff', 'commit', 'none')),
    commit_oid  TEXT,
    file_path   TEXT,
    source      TEXT CHECK (source IS NULL OR source IN ('Diff', 'FullFile')),
    side        TEXT CHECK (side IS NULL OR side IN ('Old', 'New')),
    start_line  INTEGER,
    end_line    INTEGER,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE active_review (
    repo_path TEXT PRIMARY KEY,
    review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE
);

CREATE TABLE repo_snapshots (
    repo_path            TEXT PRIMARY KEY,
    working_tree_snapshot TEXT,
    index_snapshot        TEXT,
    updated_at            INTEGER NOT NULL
);

CREATE INDEX reviews_by_repo   ON reviews(repo_path);
CREATE INDEX threads_by_review ON threads(review_id);
CREATE INDEX threads_by_anchor ON threads(commit_oid, file_path);
";

const V2: &str = r"
CREATE TABLE replies (
    id         TEXT PRIMARY KEY,
    thread_id  TEXT    NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    body       TEXT    NOT NULL,
    channel    TEXT    NOT NULL CHECK (channel IN ('human', 'agent')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX replies_by_thread ON replies(thread_id, created_at);
";

/// The commit's subject line, stored at add time so the doc renders with no
/// repository open (D13) and a gc'd snapshot commit keeps its label. Rows
/// from before v3 carry '' and render as "(no subject)".
const V3: &str = r"
ALTER TABLE review_commits ADD COLUMN subject TEXT NOT NULL DEFAULT '';
";

/// One-row mutation counter (plan §5.3): `data_version` tells the poll that
/// SOME connection committed; `revision` is what makes the emit meaningful,
/// because the draft autosave commits without bumping it.
const V4: &str = r"
CREATE TABLE store_meta (revision INTEGER NOT NULL);
INSERT INTO store_meta (revision) VALUES (0);
";

/// Every snapshot this repo has handed to a caller, and whether a thread ever
/// anchored to it (D8, TRUNK-61).
///
/// `ensure_review_snapshot` records the snapshot here in the same breath as it
/// pins it, before any caller can act on the oid. A comment is submitted as two
/// separate calls, so between them the snapshot has no thread; this row is what
/// says the snapshot was handed out and may still be in use. `anchored` flips
/// the first time a thread names the oid, and only an anchored snapshot can
/// ever become garbage — once its threads are gone, nothing will name it again,
/// because a fresh comment gets a fresh snapshot.
const V5: &str = r"
CREATE TABLE snapshot_pins (
    repo_path TEXT    NOT NULL,
    oid       TEXT    NOT NULL,
    anchored  INTEGER NOT NULL DEFAULT 0,
    minted_at INTEGER NOT NULL,
    PRIMARY KEY (repo_path, oid)
);
";

/// Reconcile the two shapes `user_version = 5` ever meant.
///
/// An earlier, unreleased build stamped 5 for a different table
/// (`unanchored_pins`, a two-pass sweep record that no longer exists). A store
/// migrated by it would otherwise skip the V5 above and reach this build with
/// no `snapshot_pins` at all, which fails every snapshot write. Both shapes
/// converge here: create the table if it is missing, drop the dead one if it is
/// present. Losing the old table costs nothing — its rows recorded sweep
/// observations, which the current design does not use.
const V6: &str = r"
CREATE TABLE IF NOT EXISTS snapshot_pins (
    repo_path TEXT    NOT NULL,
    oid       TEXT    NOT NULL,
    anchored  INTEGER NOT NULL DEFAULT 0,
    minted_at INTEGER NOT NULL,
    PRIMARY KEY (repo_path, oid)
);

DROP TABLE IF EXISTS unanchored_pins;
";

/// Retire the guard machinery an earlier, unreleased shape of this feature
/// needed, and accept a store that already ran it.
///
/// The sweep used to decide a pin was garbage and delete its ref afterwards,
/// outside the transaction. Four successive guards tried to make that window
/// safe and each was defeated; the sweep now does both in one transaction, so
/// nothing needs guarding. `grants`, `grant_id` and `pin_seq` were those
/// guards' bookkeeping. `pin_seq` is dropped here; the two dead columns on
/// `snapshot_pins` are left in place, because SQLite would need a table rebuild
/// to remove them and they cost a byte each. None of it shipped, so no store in
/// the wild carries data worth keeping.
const V7: &str = r"
DROP TABLE IF EXISTS pin_seq;
";

/// A dev store may carry `user_version = 8` from an unreleased commit that
/// numbered this same cleanup differently. Its schema is what v7 produces, so
/// the version is the only thing wrong: renumber it rather than refuse the
/// store. `version_guard` would otherwise tell the user to restart, which never
/// helps, and leave the app unusable against that store forever.
pub fn accept_unreleased_v8(conn: &Connection) -> Result<(), TrunkError> {
    if user_version(conn)? != 8 {
        return Ok(());
    }

    // Only the store that unreleased commit actually produced: it created
    // `pin_seq`. A store stamped 8 without it was written by something else,
    // and something else is exactly what `version_guard` must keep refusing.
    let has_pin_seq: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'pin_seq')",
            [],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;
    if !has_pin_seq {
        return Ok(());
    }

    conn.execute_batch("PRAGMA user_version = 7;")
        .map_err(sqlite_error)?;

    Ok(())
}

pub fn user_version(conn: &Connection) -> Result<i64, TrunkError> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(sqlite_error)
}

/// Refuse a store whose schema this build does not know. Explicit, never silent,
/// never destructive — the caller surfaces a restart prompt.
pub fn version_guard(conn: &Connection) -> Result<(), TrunkError> {
    if user_version(conn)? > CURRENT_VERSION {
        return Err(TrunkError::new(
            "store_newer",
            "This review store was written by a newer version of Trunk — restart Trunk to pick it up",
        ));
    }

    Ok(())
}

/// Bring the store up to `CURRENT_VERSION`.
///
/// The version is re-read INSIDE the immediate transaction. Reading it outside
/// makes the ladder non-atomic: two processes opening a fresh store both see
/// version 0, the loser's `CREATE TABLE` fails "already exists", and — before
/// `sqlite_error` learned to classify corruption — that error quarantined a
/// perfectly healthy database.
pub fn migrate(conn: &Connection) -> Result<(), TrunkError> {
    version_guard(conn)?;

    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(sqlite_error)?;

    let applied = apply_pending(conn);
    if applied.is_err() {
        let _ = conn.execute_batch("ROLLBACK");
        return applied;
    }
    conn.execute_batch("COMMIT").map_err(sqlite_error)?;

    Ok(())
}

fn apply_pending(conn: &Connection) -> Result<(), TrunkError> {
    version_guard(conn)?;

    if user_version(conn)? < 1 {
        conn.execute_batch(&format!("{V1} PRAGMA user_version = 1;"))
            .map_err(sqlite_error)?;
    }
    if user_version(conn)? < 2 {
        conn.execute_batch(&format!("{V2} PRAGMA user_version = 2;"))
            .map_err(sqlite_error)?;
    }
    if user_version(conn)? < 3 {
        conn.execute_batch(&format!("{V3} PRAGMA user_version = 3;"))
            .map_err(sqlite_error)?;
    }
    if user_version(conn)? < 4 {
        conn.execute_batch(&format!("{V4} PRAGMA user_version = 4;"))
            .map_err(sqlite_error)?;
    }
    if user_version(conn)? < 5 {
        conn.execute_batch(&format!("{V5} PRAGMA user_version = 5;"))
            .map_err(sqlite_error)?;
    }
    if user_version(conn)? < 6 {
        conn.execute_batch(&format!("{V6} PRAGMA user_version = 6;"))
            .map_err(sqlite_error)?;
    }
    if user_version(conn)? < 7 {
        conn.execute_batch(&format!("{V7} PRAGMA user_version = 7;"))
            .map_err(sqlite_error)?;
    }

    Ok(())
}

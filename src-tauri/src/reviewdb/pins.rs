//! The two-pass record behind the unanchored-pin sweep.
//!
//! A snapshot pin is reclaimed only when two consecutive sweeps agree that no
//! thread anchors to it. One observation is not enough: `ensure_review_snapshot`
//! mints and pins a snapshot, and the thread that anchors to it is written by a
//! separate later call, so a pin observed unanchored may simply belong to a
//! submit still in flight (TRUNK-61). Between two sweeps that submit has either
//! landed its thread or died with the process.

use super::{repo_key, sqlite_error};
use crate::error::TrunkError;
use rusqlite::Connection;
use std::collections::HashSet;
use std::path::Path;

/// The repo's pins that a previous sweep already found unanchored.
pub fn seen_unanchored(conn: &Connection, repo_path: &Path) -> Result<HashSet<String>, TrunkError> {
    let mut stmt = conn
        .prepare("SELECT oid FROM unanchored_pins WHERE repo_path = ?1")
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map([repo_key(repo_path)], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?;

    rows.collect::<Result<HashSet<String>, _>>()
        .map_err(sqlite_error)
}

/// Replace the repo's record of unanchored pins with `oids`.
///
/// A wholesale replace, not an insert: a pin that gained a thread since the
/// last sweep must lose its mark, or a later sweep would delete a pin that is
/// anchored again.
pub fn record_unanchored(
    conn: &Connection,
    repo_path: &Path,
    oids: &HashSet<String>,
    now: i64,
) -> Result<(), TrunkError> {
    let key = repo_key(repo_path);

    conn.execute("DELETE FROM unanchored_pins WHERE repo_path = ?1", [&key])
        .map_err(sqlite_error)?;

    let mut insert = conn
        .prepare("INSERT INTO unanchored_pins (repo_path, oid, seen_at) VALUES (?1, ?2, ?3)")
        .map_err(sqlite_error)?;
    for oid in oids {
        insert
            .execute(rusqlite::params![&key, oid, now])
            .map_err(sqlite_error)?;
    }

    Ok(())
}

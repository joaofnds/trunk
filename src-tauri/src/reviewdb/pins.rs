//! The record of which snapshots have been handed out, and which have ever
//! carried a thread.
//!
//! A snapshot pin may only be reclaimed when the store can prove the snapshot
//! is finished with. Observing that nothing anchors to it is not that proof: a
//! comment is submitted as two separate calls, so a snapshot minted for a
//! submit still in flight looks exactly like an abandoned one (TRUNK-61).
//!
//! What distinguishes them is whether a thread ever anchored. `mark_minted`
//! records the snapshot before its oid is returned to any caller, and
//! `mark_anchored` flips it the first time a thread names it. A snapshot that
//! has never been anchored may belong to an unfinished submit and is never
//! swept. One that has been anchored, and whose threads are now gone, can never
//! be named again — a fresh comment mints a fresh snapshot — so it is garbage.

use super::{repo_key, sqlite_error};
use crate::error::TrunkError;
use rusqlite::Connection;
use std::collections::HashSet;
use std::path::Path;

/// Record a snapshot as handed out. Called in the same transaction that stores
/// the snapshot oid, before the oid reaches any caller.
pub fn mark_minted(
    conn: &Connection,
    repo_path: &Path,
    oid: &str,
    now: i64,
) -> Result<(), TrunkError> {
    conn.execute(
        "INSERT INTO snapshot_pins (repo_path, oid, anchored, minted_at)
         VALUES (?1, ?2, 0, ?3)
         ON CONFLICT(repo_path, oid) DO NOTHING",
        rusqlite::params![repo_key(repo_path), oid, now],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// Record that a thread has anchored to this oid, in the transaction that
/// writes the thread. Unknown oids are ignored: a thread may anchor to a real
/// commit, which was never a snapshot and has no pin.
pub fn mark_anchored(conn: &Connection, repo_path: &Path, oid: &str) -> Result<(), TrunkError> {
    conn.execute(
        "UPDATE snapshot_pins SET anchored = 1 WHERE repo_path = ?1 AND oid = ?2",
        rusqlite::params![repo_key(repo_path), oid],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// How long a snapshot that never carried a thread is protected. It covers a
/// submit that is still in flight; past it, the submit failed or was abandoned,
/// and the snapshot is garbage no gesture will ever name. Generous on purpose —
/// the cost of waiting is a ref file, and the cost of being early is a lost
/// comment.
pub const IN_FLIGHT_GRACE_SECS: i64 = 24 * 60 * 60;

/// The repo's snapshots that may be reclaimed: those a thread has anchored to,
/// plus those handed out so long ago that no submit can still be holding one.
pub fn reclaimable(
    conn: &Connection,
    repo_path: &Path,
    now: i64,
) -> Result<HashSet<String>, TrunkError> {
    let mut stmt = conn
        .prepare(
            "SELECT oid FROM snapshot_pins
             WHERE repo_path = ?1 AND (anchored = 1 OR minted_at < ?2)",
        )
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map(
            rusqlite::params![repo_key(repo_path), now - IN_FLIGHT_GRACE_SECS],
            |row| row.get::<_, String>(0),
        )
        .map_err(sqlite_error)?;

    rows.collect::<Result<HashSet<String>, _>>()
        .map_err(sqlite_error)
}

/// Drop the records for pins that have been reclaimed.
pub fn forget(conn: &Connection, repo_path: &Path, oids: &[String]) -> Result<(), TrunkError> {
    let key = repo_key(repo_path);

    let mut stmt = conn
        .prepare("DELETE FROM snapshot_pins WHERE repo_path = ?1 AND oid = ?2")
        .map_err(sqlite_error)?;
    for oid in oids {
        stmt.execute(rusqlite::params![&key, oid])
            .map_err(sqlite_error)?;
    }

    Ok(())
}

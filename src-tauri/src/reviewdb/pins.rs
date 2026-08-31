//! The record of which snapshots have been handed out, and which have ever
//! carried a thread.
//!
//! A snapshot pin may only be reclaimed when the store can prove the snapshot
//! is finished with. Observing that nothing anchors to it is not that proof: a
//! comment is submitted as two separate calls, so a snapshot minted for a
//! submit still in flight looks exactly like an abandoned one (TRUNK-61).
//!
//! What distinguishes them is whether a thread has anchored since the oid was
//! last handed out. `mark_minted` records the snapshot before its oid reaches
//! any caller, clearing the flag each time; `mark_anchored` sets it in the
//! transaction that writes the thread. A snapshot not anchored since it was
//! handed out may belong to an unfinished submit and is never swept. One that
//! has been anchored, and whose threads are now gone, is garbage — until it is
//! handed out again, which protects it afresh. Snapshot oids are derived from
//! the tree, so reverting the working tree does hand the same oid out twice.

use super::{repo_key, sqlite_error};
use crate::error::TrunkError;
use rusqlite::Connection;
use std::collections::HashSet;
use std::path::Path;

/// Record a snapshot as handed out. Called in the same transaction that stores
/// the snapshot oid, before the oid reaches any caller.
///
/// Handing out an oid always clears `anchored`, even for a row that already
/// exists. A snapshot oid is derived from the tree, so reverting the working
/// tree to an earlier state yields the same oid again: the caller receiving it
/// is a fresh submit in flight, whatever the oid's history, and a stale
/// `anchored = 1` from that history would let the sweep reclaim the pin while
/// that submit is still unfinished.
pub fn mark_minted(
    conn: &Connection,
    repo_path: &Path,
    oid: &str,
    now: i64,
) -> Result<(), TrunkError> {
    conn.execute(
        "INSERT INTO snapshot_pins (repo_path, oid, anchored, minted_at)
         VALUES (?1, ?2, 0, ?3)
         ON CONFLICT(repo_path, oid) DO UPDATE SET
             anchored = 0,
             minted_at = excluded.minted_at",
        rusqlite::params![repo_key(repo_path), oid, now],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// Record that a thread has anchored to this oid, in the transaction that
/// writes the thread.
///
/// An oid with no row is the ordinary case: a thread may anchor to a real
/// commit, which was never a snapshot and has no pin. But a *pinned* snapshot
/// with no row means the sweep reclaimed it while this submit was in flight,
/// which is the comment loss this whole design exists to prevent. Re-record it
/// so the pin is restored and protected: the caller re-pins the ref.
pub fn mark_anchored(
    conn: &Connection,
    repo_path: &Path,
    oid: &str,
    now: i64,
) -> Result<Anchored, TrunkError> {
    let updated = conn
        .execute(
            "UPDATE snapshot_pins SET anchored = 1 WHERE repo_path = ?1 AND oid = ?2",
            rusqlite::params![repo_key(repo_path), oid],
        )
        .map_err(sqlite_error)?;
    if updated > 0 {
        return Ok(Anchored::Marked);
    }

    conn.execute(
        "INSERT INTO snapshot_pins (repo_path, oid, anchored, minted_at)
         VALUES (?1, ?2, 1, ?3)",
        rusqlite::params![repo_key(repo_path), oid, now],
    )
    .map_err(sqlite_error)?;

    Ok(Anchored::Restored)
}

/// Whether the anchored snapshot was already on record, or had to be put back.
#[derive(Debug, PartialEq, Eq)]
pub enum Anchored {
    /// The snapshot was on record, as every ordinary submit finds it.
    Marked,
    /// No record: either an ordinary commit, which has no pin and needs none,
    /// or a snapshot whose pin the sweep reclaimed while this submit was in
    /// flight. The caller re-pins to cover the second case.
    Restored,
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

/// Whether this repo has a record for `oid`. A record the sweep just forgot,
/// present again, means the snapshot was handed out afresh after the sweep
/// decided it was garbage: the deletion that decision authorised is stale.
pub fn seen(conn: &Connection, repo_path: &Path, oid: &str) -> Result<bool, TrunkError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM snapshot_pins WHERE repo_path = ?1 AND oid = ?2)",
        rusqlite::params![repo_key(repo_path), oid],
        |row| row.get(0),
    )
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

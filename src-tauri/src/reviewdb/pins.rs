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
use rusqlite::{Connection, OptionalExtension};
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
        "INSERT INTO snapshot_pins (repo_path, oid, anchored, minted_at, grants)
         VALUES (?1, ?2, 0, ?3, 1)
         ON CONFLICT(repo_path, oid) DO UPDATE SET
             anchored = 0,
             minted_at = excluded.minted_at,
             grants = grants + 1",
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
            "UPDATE snapshot_pins SET anchored = 1, grants = grants + 1
             WHERE repo_path = ?1 AND oid = ?2",
            rusqlite::params![repo_key(repo_path), oid],
        )
        .map_err(sqlite_error)?;
    if updated > 0 {
        return Ok(Anchored::Marked);
    }

    conn.execute(
        "INSERT INTO snapshot_pins (repo_path, oid, anchored, minted_at, grants)
         VALUES (?1, ?2, 1, ?3, 1)",
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

/// Bring the record into line with the refs that actually exist.
///
/// Two drifts, both of which leave a pin nothing will ever reclaim. A ref with
/// no row was minted before this table existed, or its row was dropped by a
/// sweep whose deletion never ran; either way it is adopted with `now` as its
/// mint time, so the ordinary anchor and grace rules decide it from here.
/// Adoption is deliberately not deletion: an unrecorded ref is not evidence of
/// garbage, and treating it as such is the assumption that lost comments in the
/// first place. A row with no ref describes a pin that is already gone, so it
/// is dropped.
///
/// Returns nothing: the caller re-reads the reconciled state in the same
/// transaction.
pub fn reconcile(
    conn: &Connection,
    repo_path: &Path,
    refs: &HashSet<String>,
    now: i64,
) -> Result<(), TrunkError> {
    let key = repo_key(repo_path);

    let mut stmt = conn
        .prepare("SELECT oid FROM snapshot_pins WHERE repo_path = ?1")
        .map_err(sqlite_error)?;
    let recorded: HashSet<String> = stmt
        .query_map([&key], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?
        .collect::<Result<HashSet<String>, _>>()
        .map_err(sqlite_error)?;

    for oid in refs.difference(&recorded) {
        mark_minted(conn, repo_path, oid, now)?;
    }

    // Drop only rows for refs that were already gone when the walk ran and are
    // still not there. A row minted after the walk describes a ref that exists;
    // the walk simply predates it, and dropping it would make the record lie
    // about a pin an in-flight submit is holding.
    let vanished: Vec<String> = recorded
        .difference(refs)
        .filter(|oid| !minted_since(conn, repo_path, oid, now).unwrap_or(true))
        .cloned()
        .collect();
    forget(conn, repo_path, &vanished)?;

    Ok(())
}

/// Whether this repo's row for `oid` was minted at or after `since`, which
/// means it postdates the caller's view of the refs on disk.
fn minted_since(
    conn: &Connection,
    repo_path: &Path,
    oid: &str,
    since: i64,
) -> Result<bool, TrunkError> {
    let minted: Option<i64> = conn
        .query_row(
            "SELECT minted_at FROM snapshot_pins WHERE repo_path = ?1 AND oid = ?2",
            rusqlite::params![repo_key(repo_path), oid],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)?;

    Ok(minted.is_some_and(|m| m >= since))
}

/// This repo's grant count for `oid`, if it has a row.
///
/// The sweep reads this when it decides, and again before it deletes: any
/// change means the row was written in between — handed out again, or anchored
/// by a thread that landed — so the deletion it authorised is stale.
///
/// A counter, not a timestamp. `now_secs` has one-second granularity, so a
/// regrant inside the same second leaves the mint time unchanged, and
/// `mark_anchored` does not write the mint time at all. Either case would
/// delete a pin a live comment is holding.
pub fn grants(conn: &Connection, repo_path: &Path, oid: &str) -> Result<Option<i64>, TrunkError> {
    conn.query_row(
        "SELECT grants FROM snapshot_pins WHERE repo_path = ?1 AND oid = ?2",
        rusqlite::params![repo_key(repo_path), oid],
        |row| row.get(0),
    )
    .optional()
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

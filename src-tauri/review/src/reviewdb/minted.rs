//! Which oids Trunk minted as review snapshots.
//!
//! A snapshot is what Trunk minted, not what a commit claims to be: git lets
//! any commit carry the author a snapshot carries, so a fetched commit can look
//! exactly like one (TRUNK-193). The mint path records each snapshot here in the
//! transaction that stores its oid, and nothing else writes the record but the
//! v9 migration, which copied in the pointers the mint path had written before.
//! In particular `pins::reconcile` must not: it adopts any ref under the
//! keepalive namespace, and a mirror clone or a `+refs/*:refs/*` fetch can put
//! one there.

use super::{repo_key, sqlite_error};
use crate::snapshot::carries_snapshot_author;
use rusqlite::Connection;
use std::path::Path;
use trunk_git::error::TrunkError;

/// What Trunk's own records say an anchor oid is.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Provenance {
    /// Trunk minted it as a snapshot.
    Minted,
    /// A thread or draft named it before the store kept a mint record, so only
    /// the commit's author can still say whether it was a snapshot.
    Legacy,
    /// No record that Trunk minted it, so a real commit, whatever author it
    /// claims.
    Unrecorded,
}

impl Provenance {
    /// Whether `commit`, the commit this provenance was read for, is a review
    /// snapshot.
    #[must_use]
    pub fn names_a_snapshot(self, commit: &git2::Commit<'_>) -> bool {
        match self {
            Self::Minted => true,
            Self::Legacy => carries_snapshot_author(commit),
            Self::Unrecorded => false,
        }
    }
}

/// Record `oid` as a snapshot Trunk minted for this repo. Only the mint path
/// calls this.
///
/// # Errors
///
/// Returns the `SQLite` error when the write fails.
pub fn record(conn: &Connection, repo_path: &Path, oid: &str) -> Result<(), TrunkError> {
    conn.execute(
        "INSERT OR IGNORE INTO minted_snapshots (repo_path, oid) VALUES (?1, ?2)",
        rusqlite::params![repo_key(repo_path), oid],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// Whether Trunk minted `oid` as a snapshot for this repo.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn was_minted(conn: &Connection, repo_path: &Path, oid: &str) -> Result<bool, TrunkError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM minted_snapshots WHERE repo_path = ?1 AND oid = ?2)",
        rusqlite::params![repo_key(repo_path), oid],
        |row| row.get(0),
    )
    .map_err(sqlite_error)
}

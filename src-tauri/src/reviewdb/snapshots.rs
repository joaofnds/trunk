//! The per-repo working-tree and index snapshot OIDs.
//!
//! Per repo, not per review (D8 makes the pins repo-level). Load-bearing on
//! three existing paths: `ensure_review_snapshot` passes them to
//! `decide_snapshot` as `prior` — with no `prior`, get-or-create degenerates and
//! every submit mints a fresh snapshot commit — `read_snapshots` returns them,
//! and the frontend's `resolveViewOid` matches unstaged and staged views against
//! them, which is how any working-tree comment renders at all.

use super::{repo_key, sqlite_error};
use crate::error::TrunkError;
use crate::git::workdir_snapshot::SnapshotKind;
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone, Default)]
pub struct RepoSnapshots {
    pub working_tree_snapshot: Option<String>,
    pub index_snapshot: Option<String>,
}

impl RepoSnapshots {
    /// The stored oid for one kind, if the repo has one.
    #[must_use]
    pub fn for_kind(&self, kind: SnapshotKind) -> Option<&str> {
        match kind {
            SnapshotKind::Workdir => self.working_tree_snapshot.as_deref(),
            SnapshotKind::Index => self.index_snapshot.as_deref(),
        }
    }

    /// Every snapshot oid this repo has pinned.
    #[must_use]
    pub fn oids(&self) -> Vec<String> {
        [
            self.working_tree_snapshot.clone(),
            self.index_snapshot.clone(),
        ]
        .into_iter()
        .flatten()
        .collect()
    }
}

pub fn get(conn: &Connection, repo_path: &Path) -> Result<RepoSnapshots, TrunkError> {
    let mut stmt = conn
        .prepare(
            "SELECT working_tree_snapshot, index_snapshot FROM repo_snapshots WHERE repo_path = ?1",
        )
        .map_err(sqlite_error)?;
    let mut rows = stmt
        .query_map([repo_key(repo_path)], |row| {
            Ok(RepoSnapshots {
                working_tree_snapshot: row.get(0)?,
                index_snapshot: row.get(1)?,
            })
        })
        .map_err(sqlite_error)?;

    match rows.next() {
        None => Ok(RepoSnapshots::default()),
        Some(row) => row.map_err(sqlite_error),
    }
}

/// Point one of the repo's snapshot fields at `oid`, leaving the other alone.
pub fn set(
    conn: &Connection,
    repo_path: &Path,
    kind: SnapshotKind,
    oid: &str,
    now: i64,
) -> Result<(), TrunkError> {
    let column = match kind {
        SnapshotKind::Workdir => "working_tree_snapshot",
        SnapshotKind::Index => "index_snapshot",
    };

    conn.execute(
        &format!(
            "INSERT INTO repo_snapshots (repo_path, {column}, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(repo_path) DO UPDATE SET
                 {column} = excluded.{column},
                 updated_at = excluded.updated_at"
        ),
        rusqlite::params![repo_key(repo_path), oid, now],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

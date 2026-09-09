//! Whether a thread still describes the code it was written against.
//!
//! Only snapshot-anchored threads can go stale today: a working-tree or index
//! comment is written against a snapshot commit, and the repo moves on. The
//! rule is a comparison, not a search — the thread's `commit_oid` against the
//! repo's current pair in `repo_snapshots`.
//!
//! Telling a snapshot thread from a commit-diff one is the whole difficulty.
//! Both persist as `anchor_kind = 'diff'` carrying a `commit_oid`, and the
//! `snapshot_pins` table cannot separate them: `pins::mark_anchored` inserts a
//! row for whatever oid a thread names, real commits included. What does
//! separate them is the repository, where a snapshot is an oid this repo pinned
//! under `refs/trunk/review-snapshots/`. A superseded snapshot that still
//! carries a thread keeps that ref, because `sweep_unanchored_pins` skips every
//! anchored oid.

use super::{repo_key, sqlite_error};
use crate::error::TrunkError;
use rusqlite::Connection;
use std::collections::HashSet;
use std::path::Path;

/// Recompute `stale` for every thread of `repo_path`, returning how many rows
/// changed value.
///
/// The count is what lets the caller stay quiet: a pass that changed nothing
/// must not bump the store revision, or every unrelated `.git` write would
/// refetch every thread in the panel.
///
/// # Errors
///
/// Returns the `SQLite` error when a query or a write fails.
pub fn recompute(
    conn: &Connection,
    repo_path: &Path,
    snapshot_oids: &[String],
) -> Result<usize, TrunkError> {
    let pinned: HashSet<&str> = snapshot_oids.iter().map(String::as_str).collect();
    let current = super::snapshots::get(conn, repo_path)?;
    let live: HashSet<String> = current.oids().into_iter().collect();

    let mut changed = 0;
    for (id, commit_oid, was_stale) in rows(conn, repo_path)? {
        let is_stale = commit_oid
            .as_deref()
            .is_some_and(|oid| pinned.contains(oid) && !live.contains(oid));
        if is_stale == was_stale {
            continue;
        }

        conn.execute(
            "UPDATE threads SET stale = ?2 WHERE id = ?1",
            rusqlite::params![id, i64::from(is_stale)],
        )
        .map_err(sqlite_error)?;
        changed += 1;
    }

    Ok(changed)
}

fn rows(
    conn: &Connection,
    repo_path: &Path,
) -> Result<Vec<(String, Option<String>, bool)>, TrunkError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, commit_oid, stale FROM threads
             WHERE review_id IN (SELECT id FROM reviews WHERE repo_path = ?1)",
        )
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map([repo_key(repo_path)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)? != 0,
            ))
        })
        .map_err(sqlite_error)?;

    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::types::{Anchor, Side, Source};
    use crate::git::workdir_snapshot::SnapshotKind;
    use crate::reviewdb::{Store, open, reviews, snapshots, threads};
    use std::path::PathBuf;
    use tempfile::TempDir;

    const REPO: &str = "/repo";

    fn store() -> (TempDir, Store) {
        let dir = TempDir::new().unwrap();
        let store = open(dir.path()).unwrap();
        (dir, store)
    }

    fn repo_path() -> PathBuf {
        PathBuf::from(REPO)
    }

    fn thread_anchored_to(store: &Store, oid: &str) -> String {
        store
            .write(|tx| {
                let review_id = reviews::ensure_active(tx, &repo_path(), 0)?;
                threads::insert(
                    tx,
                    &review_id,
                    threads::NewThread {
                        text: "comment".into(),
                        anchor: Some(Anchor {
                            commit_oid: oid.into(),
                            file_path: "src/main.rs".into(),
                            source: Source::Diff,
                            side: Side::New,
                            start_line: 1,
                            end_line: 2,
                        }),
                        commit_oid: None,
                        cached_excerpt: Some("fn main() {}".into()),
                    },
                    0,
                )
            })
            .unwrap()
    }

    fn staleness_of(store: &Store, id: &str) -> bool {
        store
            .read(|conn| {
                conn.query_row("SELECT stale FROM threads WHERE id = ?1", [id], |row| {
                    row.get::<_, i64>(0)
                })
                .map_err(sqlite_error)
            })
            .unwrap()
            != 0
    }

    fn snapshots_of(oids: &[&str]) -> Vec<String> {
        oids.iter().map(|o| (*o).to_string()).collect()
    }

    #[test]
    fn a_superseded_snapshot_thread_is_stale() {
        let (_dir, store) = store();
        let id = thread_anchored_to(&store, "OLDSNAP");
        store
            .write(|tx| snapshots::set(tx, &repo_path(), SnapshotKind::Workdir, "NEWSNAP", 0))
            .unwrap();

        let changed = store
            .write(|tx| recompute(tx, &repo_path(), &snapshots_of(&["OLDSNAP", "NEWSNAP"])))
            .unwrap();

        assert_eq!(changed, 1, "the superseded thread's value must change");
        assert!(
            staleness_of(&store, &id),
            "a thread anchored to a superseded snapshot is stale",
        );
    }

    #[test]
    fn a_current_snapshot_thread_is_not_stale() {
        let (_dir, store) = store();
        let id = thread_anchored_to(&store, "NEWSNAP");
        store
            .write(|tx| snapshots::set(tx, &repo_path(), SnapshotKind::Workdir, "NEWSNAP", 0))
            .unwrap();

        store
            .write(|tx| recompute(tx, &repo_path(), &snapshots_of(&["NEWSNAP"])))
            .unwrap();

        assert!(
            !staleness_of(&store, &id),
            "a thread anchored to the repo's current snapshot is not stale",
        );
    }

    #[test]
    fn a_commit_diff_thread_is_never_stale() {
        let (_dir, store) = store();
        let id = thread_anchored_to(&store, "REALCOMMIT");
        store
            .write(|tx| snapshots::set(tx, &repo_path(), SnapshotKind::Workdir, "NEWSNAP", 0))
            .unwrap();

        store
            .write(|tx| recompute(tx, &repo_path(), &snapshots_of(&["NEWSNAP"])))
            .unwrap();

        assert!(
            !staleness_of(&store, &id),
            "an oid this repo never handed out as a snapshot is a real commit, and a commit-diff thread never goes stale",
        );
    }

    #[test]
    fn a_pass_that_changes_nothing_reports_zero() {
        let (_dir, store) = store();
        thread_anchored_to(&store, "OLDSNAP");
        store
            .write(|tx| snapshots::set(tx, &repo_path(), SnapshotKind::Workdir, "NEWSNAP", 0))
            .unwrap();
        let pins = snapshots_of(&["OLDSNAP", "NEWSNAP"]);
        store
            .write(|tx| recompute(tx, &repo_path(), &pins))
            .unwrap();

        let changed = store
            .write(|tx| recompute(tx, &repo_path(), &pins))
            .unwrap();

        assert_eq!(
            changed, 0,
            "a second pass over unchanged state must report no work, so the caller can stay quiet",
        );
    }

    #[test]
    fn another_repos_threads_are_left_alone() {
        let (_dir, store) = store();
        let id = thread_anchored_to(&store, "OLDSNAP");
        let other = PathBuf::from("/other-repo");
        store
            .write(|tx| snapshots::set(tx, &other, SnapshotKind::Workdir, "NEWSNAP", 0))
            .unwrap();

        let changed = store
            .write(|tx| recompute(tx, &other, &snapshots_of(&["OLDSNAP", "NEWSNAP"])))
            .unwrap();

        assert_eq!(changed, 0, "one database holds every repo");
        assert!(
            !staleness_of(&store, &id),
            "another repo's pass must not touch this repo's threads"
        );
    }

    #[test]
    fn a_stale_thread_clears_when_its_snapshot_is_current_again() {
        let (_dir, store) = store();
        let id = thread_anchored_to(&store, "SNAPA");
        let pins = snapshots_of(&["SNAPA", "SNAPB"]);
        store
            .write(|tx| snapshots::set(tx, &repo_path(), SnapshotKind::Workdir, "SNAPB", 0))
            .unwrap();
        store
            .write(|tx| recompute(tx, &repo_path(), &pins))
            .unwrap();

        store
            .write(|tx| snapshots::set(tx, &repo_path(), SnapshotKind::Workdir, "SNAPA", 0))
            .unwrap();
        let changed = store
            .write(|tx| recompute(tx, &repo_path(), &pins))
            .unwrap();

        assert_eq!(changed, 1);
        assert!(
            !staleness_of(&store, &id),
            "reverting the working tree hands the same snapshot oid out again, and the marker clears",
        );
    }
}

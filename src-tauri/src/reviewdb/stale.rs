//! Whether a thread still describes the code it was written against.
//!
//! Only snapshot-anchored threads can go stale today: a working-tree or index
//! comment is written against a snapshot commit, and the repo moves on.
//!
//! Two things this module deliberately does not decide. Whether an oid is a
//! snapshot at all, because no store table can answer it: `pins::mark_anchored`
//! writes a `snapshot_pins` row for whatever oid a thread names, real commits
//! included, and the submit path's pin repair then gives that same oid a
//! keepalive ref. And whether a snapshot is still current, because that is a
//! question about the repository as it stands now, not about anything the store
//! recorded. The caller answers both, and passes in the verdict.
//!
//! `repo_snapshots` is the wrong yardstick for the second question and reading
//! it here was a defect: it moves only when a comment is submitted, so it names
//! the very snapshot the thread anchors to, and no thread would ever read as
//! superseded.

use super::{repo_key, sqlite_error};
use crate::error::TrunkError;
use rusqlite::Connection;
use std::path::Path;

/// Where a thread's anchor oid stands against the repository right now.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum SnapshotStanding {
    /// A snapshot capturing what the repo would capture now.
    Current,
    /// A snapshot of a state the repo has moved past.
    Superseded,
    /// A real commit, which never goes stale, or an oid gc has collected.
    NotASnapshot,
}

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
    standing: &impl Fn(&str) -> SnapshotStanding,
) -> Result<usize, TrunkError> {
    let mut changed = 0;
    for (id, commit_oid, was_stale) in rows(conn, repo_path)? {
        let is_stale = commit_oid
            .as_deref()
            .is_some_and(|oid| standing(oid) == SnapshotStanding::Superseded);
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
    use crate::reviewdb::{Store, open, reviews, threads};
    use std::collections::HashSet;
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

    /// The caller's verdict, as two lists the test can read: the snapshot the
    /// repo would capture now, and the ones it has moved past. Production works
    /// this out from the repository.
    fn standing_where(current: &str, superseded: &[&str]) -> impl Fn(&str) -> SnapshotStanding {
        let current = current.to_string();
        let superseded: HashSet<String> = superseded.iter().map(|o| (*o).to_string()).collect();

        move |oid: &str| {
            if oid == current {
                SnapshotStanding::Current
            } else if superseded.contains(oid) {
                SnapshotStanding::Superseded
            } else {
                SnapshotStanding::NotASnapshot
            }
        }
    }

    #[test]
    fn a_superseded_snapshot_thread_is_stale() {
        let (_dir, store) = store();
        let id = thread_anchored_to(&store, "OLDSNAP");

        let changed = store
            .write(|tx| recompute(tx, &repo_path(), &standing_where("NEWSNAP", &["OLDSNAP"])))
            .unwrap();

        assert_eq!(changed, 1, "the superseded thread's value must change");
        assert!(
            staleness_of(&store, &id),
            "a thread anchored to a snapshot the repo has moved past is stale",
        );
    }

    #[test]
    fn a_current_snapshot_thread_is_not_stale() {
        let (_dir, store) = store();
        let id = thread_anchored_to(&store, "NEWSNAP");

        store
            .write(|tx| recompute(tx, &repo_path(), &standing_where("NEWSNAP", &[])))
            .unwrap();

        assert!(
            !staleness_of(&store, &id),
            "a thread anchored to what the repo would capture now is not stale",
        );
    }

    #[test]
    fn a_commit_diff_thread_is_never_stale() {
        let (_dir, store) = store();
        let id = thread_anchored_to(&store, "REALCOMMIT");

        store
            .write(|tx| recompute(tx, &repo_path(), &standing_where("NEWSNAP", &["OLDSNAP"])))
            .unwrap();

        assert!(
            !staleness_of(&store, &id),
            "an oid that is no snapshot of this repo is a real commit, and a commit-diff \
             thread never goes stale",
        );
    }

    #[test]
    fn a_pass_that_changes_nothing_reports_zero() {
        let (_dir, store) = store();
        thread_anchored_to(&store, "OLDSNAP");
        let standing = standing_where("NEWSNAP", &["OLDSNAP"]);
        store
            .write(|tx| recompute(tx, &repo_path(), &standing))
            .unwrap();

        let changed = store
            .write(|tx| recompute(tx, &repo_path(), &standing))
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

        let changed = store
            .write(|tx| recompute(tx, &other, &standing_where("NEWSNAP", &["OLDSNAP"])))
            .unwrap();

        assert_eq!(changed, 0, "one database holds every repo");
        assert!(
            !staleness_of(&store, &id),
            "another repo's pass must not touch this repo's threads",
        );
    }

    #[test]
    fn a_stale_thread_clears_when_its_snapshot_is_current_again() {
        let (_dir, store) = store();
        let id = thread_anchored_to(&store, "SNAPA");
        store
            .write(|tx| recompute(tx, &repo_path(), &standing_where("SNAPB", &["SNAPA"])))
            .unwrap();

        let changed = store
            .write(|tx| recompute(tx, &repo_path(), &standing_where("SNAPA", &["SNAPB"])))
            .unwrap();

        assert_eq!(changed, 1);
        assert!(
            !staleness_of(&store, &id),
            "reverting the working tree captures the same tree again, and the marker clears",
        );
    }
}

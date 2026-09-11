//! Whether a thread still describes the code it was written against.
//!
//! Three rules. A snapshot-anchored thread is stale once the repo has moved
//! past the snapshot it names. A thread anchored to an oid the repository no
//! longer holds is stale whatever that oid was, because the code it describes
//! is unrecoverable and the excerpt is the only surviving copy. A current-file
//! thread is stale once its pinned block occurs nowhere in the file, and fresh
//! again the moment the content returns — the spec's branch-switch example,
//! which supersession can never undo.
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

use super::{Store, repo_key, sqlite_error};
use crate::error::TrunkError;
use crate::git::types::ContentPin;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock, Weak};

type RecomputeGenerations = Mutex<HashMap<GenerationKey, Weak<Mutex<u64>>>>;

#[derive(Hash, PartialEq, Eq)]
struct GenerationKey {
    data_dir: Box<Path>,
    repo_path: Box<Path>,
}

/// Where a thread's anchor oid stands against the repository right now.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum SnapshotStanding {
    /// A snapshot capturing what the repo would capture now.
    Current,
    /// A snapshot of a state the repo has moved past.
    Superseded,
    /// An oid this repository can no longer resolve to a commit. Collection is
    /// the cause in practice, but the check cannot tell that from an oid naming
    /// a tree, a blob, or an object this repo never held. Either way the code
    /// the thread was written against is unreachable, so this is the most stale
    /// a thread can be.
    Collected,
    /// A real commit, which never goes stale. Also where an oid that will not
    /// parse lands: a corrupt row is not a collected object, and reporting
    /// unrecoverable code for a malformed record would point the same dangerous
    /// way `Collected` exists to fix.
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
/// Returns the `SQLite` error when a query or a write fails, or the repository
/// error returned by `standing`.
///
/// # Panics
///
/// Panics when the process-wide per-repository generation is poisoned.
pub fn recompute(
    store: &Store,
    repo_path: &Path,
    standing: &impl Fn(&str) -> Result<SnapshotStanding, TrunkError>,
    read_file: &impl Fn(&str) -> Option<String>,
) -> Result<usize, TrunkError> {
    let generation_clock = generation_clock(store, repo_path);
    let generation = {
        let mut current = generation_clock.lock().unwrap();
        *current = current.wrapping_add(1);
        *current
    };
    let rows = store.read(|conn| rows(conn, repo_path))?;
    let changes = plan(rows, standing, read_file)?;

    // Hold the generation only across the short store write. A newer pass can
    // invalidate this observation while repository I/O is in flight, but can
    // never start between this check and the write it protects.
    let current = generation_clock.lock().unwrap();
    if *current != generation {
        return Ok(0);
    }

    let result = store.write_if(|tx| apply(tx, &changes), |changed| *changed > 0);
    debug_assert_eq!(*current, generation);

    result
}

/// The latest observation started for each repository. The registry keeps weak
/// entries so closing a repository leaves no permanent process state behind.
fn generation_clock(store: &Store, repo_path: &Path) -> Arc<Mutex<u64>> {
    static GENERATIONS: OnceLock<RecomputeGenerations> = OnceLock::new();

    let key = GenerationKey {
        data_dir: store.data_dir.clone().into_boxed_path(),
        repo_path: repo_path.into(),
    };
    let mut generations = GENERATIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    generations.retain(|_, generation| generation.strong_count() > 0);
    if let Some(generation) = generations.get(&key).and_then(Weak::upgrade) {
        return generation;
    }

    let generation = Arc::new(Mutex::new(0));
    generations.insert(key, Arc::downgrade(&generation));

    generation
}

/// Decide the required updates without holding the process-wide store mutex or
/// a SQLite transaction. Repository observation can traverse the whole
/// worktree, so keeping it outside both is what lets unrelated review writes
/// continue while a background refresh is running.
fn plan(
    rows: Vec<StaleRow>,
    standing: &impl Fn(&str) -> Result<SnapshotStanding, TrunkError>,
    read_file: &impl Fn(&str) -> Option<String>,
) -> Result<Vec<StaleChange>, TrunkError> {
    let mut changes = Vec::new();
    for row in rows {
        let resolved = row.pin.as_ref().map(|pin| {
            read_file(&pin.file_path).and_then(|text| find_block(&text, &pin.block, pin.ordinal))
        });
        let is_stale = match resolved {
            Some(found) => found.is_none(),
            None => match row.commit_oid.as_deref() {
                Some(oid) => matches!(
                    standing(oid)?,
                    SnapshotStanding::Superseded | SnapshotStanding::Collected
                ),
                None => false,
            },
        };
        let resolved_line = resolved.flatten();
        if is_stale == row.was_stale && resolved_line == row.resolved_start_line {
            continue;
        }

        changes.push(StaleChange {
            id: row.id,
            is_stale,
            resolved_start_line: resolved_line,
            was_stale: row.was_stale,
            was_resolved_start_line: row.resolved_start_line,
        });
    }

    Ok(changes)
}

/// Apply only observations whose row still has the state that was read. A
/// concurrent external writer may have changed or removed the row while this
/// pass inspected the repository; that newer state must not be overwritten.
fn apply(conn: &Connection, changes: &[StaleChange]) -> Result<usize, TrunkError> {
    let mut applied = 0;
    for change in changes {
        applied += conn
            .execute(
                "UPDATE threads
                 SET stale = ?2, resolved_start_line = ?3
                 WHERE id = ?1 AND stale = ?4 AND resolved_start_line IS ?5",
                rusqlite::params![
                    change.id,
                    i64::from(change.is_stale),
                    change.resolved_start_line.map(i64::from),
                    i64::from(change.was_stale),
                    change.was_resolved_start_line.map(i64::from),
                ],
            )
            .map_err(sqlite_error)?;
    }

    Ok(applied)
}

/// A thread's staleness inputs: the content pin when it has one, and the anchor
/// oid otherwise.
struct StaleRow {
    id: String,
    commit_oid: Option<String>,
    pin: Option<PinRef>,
    was_stale: bool,
    resolved_start_line: Option<u32>,
}

/// A decision paired with the row state it was based on. The old state makes
/// the write optimistic: a newer concurrent decision wins instead of being
/// silently replaced.
struct StaleChange {
    id: String,
    is_stale: bool,
    resolved_start_line: Option<u32>,
    was_stale: bool,
    was_resolved_start_line: Option<u32>,
}

/// What the block search needs from a row. Not the full `ContentPin`: the
/// display range plays no part in deciding staleness.
struct PinRef {
    file_path: String,
    block: String,
    ordinal: u32,
}

/// The 1-based line the `ordinal`-th occurrence of `block` starts on, or `None`
/// when the block occurs nowhere in the file.
///
/// `None` is the whole staleness rule for a current-file thread: block presence
/// alone. An occurrence surviving anywhere keeps the thread fresh, so deleting
/// the very lines the user anchored to raises no marker while a byte-identical
/// twin remains. That is a disclosed bend of the spec and it is deliberate:
/// the comment still displays against text it truthfully describes.
///
/// Fewer occurrences than the ordinal renders at the last one. The ordinal is a
/// display hint and never an input to the presence decision, because deleting an
/// EARLIER twin would otherwise mark a thread stale, and an edit elsewhere in
/// the file is not staleness.
///
/// Both sides are line-ending normalised. `comrak` counts a lone CR as a line
/// ending while `str::lines` is LF-only, so without this a CRLF file never
/// matches a block pinned from its own content.
fn find_block(text: &str, block: &str, ordinal: u32) -> Option<u32> {
    let text = normalize_endings(text);
    let block = normalize_endings(block);
    let lines: Vec<&str> = text.lines().collect();
    let starts = occurrences(&lines, &block);
    let index = (ordinal as usize).min(starts.len().checked_sub(1)?);

    u32::try_from(starts[index] + 1).ok()
}

/// The 0-based line indices every occurrence of `block` starts at.
fn occurrences(lines: &[&str], block: &str) -> Vec<usize> {
    let wanted: Vec<&str> = block.lines().collect();
    if wanted.is_empty() || lines.len() < wanted.len() {
        return Vec::new();
    }

    (0..=lines.len() - wanted.len())
        .filter(|&i| lines[i..i + wanted.len()] == wanted[..])
        .collect()
}

/// The content pin for a line range of `text`, 1-based and inclusive.
///
/// The block is the file's own lines, so it matches itself, and the ordinal is
/// which occurrence of that block this range is. Without the ordinal a thread
/// on the second of two identical blocks would render against the first.
///
/// # Errors
///
/// Returns `invalid_range` when the range is empty or names lines the file does
/// not have.
pub fn pin_range(
    text: &str,
    file_path: &str,
    start_line: u32,
    end_line: u32,
) -> Result<ContentPin, TrunkError> {
    let normalized = normalize_endings(text);
    let lines: Vec<&str> = normalized.lines().collect();
    let (first, last) = (start_line as usize, end_line as usize);
    if first == 0 || first > last || last > lines.len() {
        return Err(TrunkError::new(
            "invalid_range",
            format!("{file_path} has no lines {start_line}..{end_line}"),
        ));
    }

    let block = lines[first - 1..last].join("\n");
    // A selection of nothing but blank lines has no content to find, so the
    // thread would read stale from the moment it was written, on a file nobody
    // touched, and no edit could ever clear it. Refusing at the pin is the only
    // place that can say so; by the time it is a row it is indistinguishable
    // from a block the file has lost.
    if block.trim().is_empty() {
        return Err(TrunkError::new(
            "invalid_range",
            format!("{file_path} lines {start_line}..{end_line} hold nothing to pin"),
        ));
    }
    let ordinal = occurrences(&lines, &block)
        .iter()
        .position(|&start| start == first - 1)
        .and_then(|i| u32::try_from(i).ok())
        .unwrap_or(0);

    Ok(ContentPin {
        file_path: file_path.to_string(),
        block,
        ordinal,
        start_line,
        end_line,
    })
}

/// Whether the block occurs anywhere in the file.
///
/// That is the whole staleness rule, and what the orphan classifier asks too.
/// The ordinal plays no part: keying presence on it would mark a thread stale
/// when an earlier twin is deleted.
#[must_use]
pub fn block_occurs(text: &str, block: &str) -> bool {
    find_block(text, block, 0).is_some()
}

/// CRLF and lone CR both become LF, so a block pinned from one file's bytes
/// matches the same content read back whatever its line endings are.
fn normalize_endings(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

fn rows(conn: &Connection, repo_path: &Path) -> Result<Vec<StaleRow>, TrunkError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, commit_oid, stale, file_path, pin_block, pin_ordinal,
                    resolved_start_line
             FROM threads
             WHERE review_id IN (SELECT id FROM reviews WHERE repo_path = ?1)",
        )
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map([repo_key(repo_path)], |row| {
            let file_path: Option<String> = row.get(3)?;
            let block: Option<String> = row.get(4)?;
            let ordinal: Option<i64> = row.get(5)?;
            let resolved: Option<i64> = row.get(6)?;

            Ok(StaleRow {
                id: row.get(0)?,
                commit_oid: row.get(1)?,
                pin: block.zip(file_path).map(|(block, file_path)| PinRef {
                    file_path,
                    block,
                    ordinal: ordinal.and_then(|o| u32::try_from(o).ok()).unwrap_or(0),
                }),
                was_stale: row.get::<_, i64>(2)? != 0,
                resolved_start_line: resolved.and_then(|r| u32::try_from(r).ok()),
            })
        })
        .map_err(sqlite_error)?;

    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::types::{Anchor, Side, Source};
    use crate::reviewdb::{Store, open, reviews, threads};
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::{Arc, mpsc};
    use std::thread;
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
                        content_pin: None,
                        cached_excerpt: Some("fn main() {}".into()),
                    },
                    0,
                )
            })
            .unwrap()
    }

    /// No thread in these tests carries a content pin, so the block search is
    /// never reached and every file reads as absent.
    fn no_file(_: &str) -> Option<String> {
        None
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

    /// The caller's verdict, as a table pairing each oid with where it stands.
    /// Production works this out from the repository.
    ///
    /// Each oid carries its own standing rather than sitting in a positional
    /// list, because two adjacent lists of oids are transposable: swapping the
    /// superseded and collected ones left every test here green, since both
    /// standings mean stale.
    fn standing_where(
        table: &[(&str, SnapshotStanding)],
    ) -> impl Fn(&str) -> Result<SnapshotStanding, TrunkError> {
        let table: HashMap<String, SnapshotStanding> = table
            .iter()
            .map(|(oid, standing)| ((*oid).to_string(), *standing))
            .collect();

        move |oid: &str| {
            Ok(table
                .get(oid)
                .copied()
                .unwrap_or(SnapshotStanding::NotASnapshot))
        }
    }

    #[test]
    fn a_superseded_snapshot_thread_is_stale() {
        let (_dir, store) = store();
        let id = thread_anchored_to(&store, "OLDSNAP");

        let changed = recompute(
            &store,
            &repo_path(),
            &standing_where(&[
                ("NEWSNAP", SnapshotStanding::Current),
                ("OLDSNAP", SnapshotStanding::Superseded),
            ]),
            &no_file,
        )
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

        recompute(
            &store,
            &repo_path(),
            &standing_where(&[("NEWSNAP", SnapshotStanding::Current)]),
            &no_file,
        )
        .unwrap();

        assert!(
            !staleness_of(&store, &id),
            "a thread anchored to what the repo would capture now is not stale",
        );
    }

    #[test]
    fn a_standing_error_aborts_recomputation() {
        let (_dir, store) = store();
        let first = thread_anchored_to(&store, "FIRST");
        let second = thread_anchored_to(&store, "SECOND");
        let calls = Cell::new(0);
        let failing_standing = |_: &str| {
            calls.set(calls.get() + 1);
            if calls.get() == 1 {
                Ok(SnapshotStanding::Superseded)
            } else {
                Err(TrunkError::new("git_error", "cannot compare"))
            }
        };
        let revision_before = store
            .read(crate::reviewdb::revision)
            .expect("revision before recomputation");

        let error = recompute(&store, &repo_path(), &failing_standing, &no_file).unwrap_err();

        assert_eq!(error.code, "git_error");
        assert!(!staleness_of(&store, &first));
        assert!(!staleness_of(&store, &second));
        assert_eq!(
            store.read(crate::reviewdb::revision).unwrap(),
            revision_before
        );
    }

    #[test]
    fn repository_observation_does_not_block_an_unrelated_store_write() {
        let dir = TempDir::new().unwrap();
        let store = open(dir.path()).unwrap();
        let id = thread_anchored_to(&store, "SNAP");

        let changed = recompute(
            &store,
            &repo_path(),
            &|_| {
                let connection = store.conn.try_lock().map_err(|_| {
                    TrunkError::new(
                        "store_locked",
                        "repository observation held the store mutex",
                    )
                })?;
                drop(connection);
                store.write(|tx| {
                    reviews::ensure_active(tx, &PathBuf::from("/other-repo"), 1).map(|_| ())
                })?;

                Ok(SnapshotStanding::Superseded)
            },
            &no_file,
        )
        .unwrap();

        assert_eq!(changed, 1);
        assert!(staleness_of(&store, &id));
    }

    #[test]
    fn a_newer_recomputation_wins_when_repository_state_changes_during_an_older_pass() {
        let dir = TempDir::new().unwrap();
        let store = Arc::new(open(dir.path()).unwrap());
        let id = thread_anchored_to(&store, "SNAP");
        recompute(
            &store,
            &repo_path(),
            &standing_where(&[("SNAP", SnapshotStanding::Superseded)]),
            &no_file,
        )
        .unwrap();
        assert!(staleness_of(&store, &id));

        let (older_observed, wait_for_older) = mpsc::sync_channel(0);
        let (release_older, older_released) = mpsc::sync_channel(0);
        let older_store = Arc::clone(&store);
        let older = thread::spawn(move || {
            recompute(
                &older_store,
                &repo_path(),
                &|_| {
                    older_observed.send(()).unwrap();
                    older_released.recv().unwrap();
                    Ok(SnapshotStanding::Current)
                },
                &no_file,
            )
        });
        wait_for_older.recv().unwrap();

        let (newer_observed, wait_for_newer) = mpsc::sync_channel(0);
        let newer_store = Arc::clone(&store);
        let newer = thread::spawn(move || {
            recompute(
                &newer_store,
                &repo_path(),
                &|_| {
                    newer_observed.send(()).unwrap();
                    Ok(SnapshotStanding::Superseded)
                },
                &no_file,
            )
        });
        wait_for_newer.recv().unwrap();
        assert_eq!(newer.join().unwrap().unwrap(), 0);

        release_older.send(()).unwrap();
        assert_eq!(older.join().unwrap().unwrap(), 0);
        assert!(staleness_of(&store, &id));
    }

    /// This proves only that `recompute` has the extra match arm. The defect
    /// lived in the caller's classifier, which the fake standing never reaches;
    /// `a_thread_whose_anchor_object_is_collected_is_stale` in
    /// `tests/test_reviewdb.rs` is the guard for that.
    #[test]
    fn a_collected_anchor_thread_is_stale() {
        let (_dir, store) = store();
        let id = thread_anchored_to(&store, "GONE");

        let changed = recompute(
            &store,
            &repo_path(),
            &standing_where(&[
                ("NEWSNAP", SnapshotStanding::Current),
                ("GONE", SnapshotStanding::Collected),
            ]),
            &no_file,
        )
        .unwrap();

        assert_eq!(changed, 1, "the collected thread's value must change");
        assert!(
            staleness_of(&store, &id),
            "a thread whose anchor the repo no longer holds describes unrecoverable code, \
             which is the most stale a thread can be",
        );
    }

    #[test]
    fn a_commit_diff_thread_is_never_stale() {
        let (_dir, store) = store();
        let id = thread_anchored_to(&store, "REALCOMMIT");

        recompute(
            &store,
            &repo_path(),
            &standing_where(&[
                ("NEWSNAP", SnapshotStanding::Current),
                ("OLDSNAP", SnapshotStanding::Superseded),
            ]),
            &no_file,
        )
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
        let standing = standing_where(&[
            ("NEWSNAP", SnapshotStanding::Current),
            ("OLDSNAP", SnapshotStanding::Superseded),
        ]);
        recompute(&store, &repo_path(), &standing, &no_file).unwrap();

        let changed = recompute(&store, &repo_path(), &standing, &no_file).unwrap();

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

        let changed = recompute(
            &store,
            &other,
            &standing_where(&[
                ("NEWSNAP", SnapshotStanding::Current),
                ("OLDSNAP", SnapshotStanding::Superseded),
            ]),
            &no_file,
        )
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
        recompute(
            &store,
            &repo_path(),
            &standing_where(&[
                ("SNAPB", SnapshotStanding::Current),
                ("SNAPA", SnapshotStanding::Superseded),
            ]),
            &no_file,
        )
        .unwrap();

        let changed = recompute(
            &store,
            &repo_path(),
            &standing_where(&[
                ("SNAPA", SnapshotStanding::Current),
                ("SNAPB", SnapshotStanding::Superseded),
            ]),
            &no_file,
        )
        .unwrap();

        assert_eq!(changed, 1);
        assert!(
            !staleness_of(&store, &id),
            "reverting the working tree captures the same tree again, and the marker clears",
        );
    }
}

#[cfg(test)]
mod block_tests {
    use super::*;

    fn file(lines: &[&str]) -> String {
        lines.join("\n")
    }

    #[test]
    fn a_block_still_in_the_file_resolves_to_its_line() {
        let text = file(&["one", "two", "three"]);

        assert_eq!(find_block(&text, "two", 0), Some(2));
    }

    #[test]
    fn a_block_no_longer_in_the_file_resolves_to_nothing() {
        let text = file(&["one", "three"]);

        assert_eq!(find_block(&text, "two", 0), None);
    }

    #[test]
    fn a_multi_line_block_matches_as_one_run_of_lines() {
        let text = file(&["a", "b", "c", "d"]);

        assert_eq!(find_block(&text, "b\nc", 0), Some(2));
    }

    #[test]
    fn the_ordinal_picks_which_occurrence_to_render_against() {
        let text = file(&["dup", "other", "dup"]);

        assert_eq!(find_block(&text, "dup", 1), Some(3));
    }

    /// Deleting an earlier twin leaves one occurrence, and the thread renders
    /// against it rather than going stale: an edit elsewhere is not staleness.
    #[test]
    fn deleting_an_earlier_twin_is_not_stale() {
        let text = file(&["other", "dup"]);

        assert_eq!(find_block(&text, "dup", 1), Some(2));
    }

    /// The ratified bend of criterion 9: the occurrence the user anchored to is
    /// gone, a byte-identical one survives, and no marker is raised. Staleness
    /// is block presence alone.
    #[test]
    fn deleting_the_anchored_occurrence_with_a_twin_alive_is_not_stale() {
        let text = file(&["dup", "other"]);

        assert_eq!(find_block(&text, "dup", 1), Some(1));
    }

    #[test]
    fn inserting_above_the_anchor_moves_the_resolved_line_and_is_not_stale() {
        let text = file(&["new", "one", "two"]);

        assert_eq!(find_block(&text, "two", 0), Some(3));
    }

    /// comrak counts a lone CR as a line ending while `str::lines` is LF-only,
    /// so a CRLF file would never match a block pinned from its own content
    /// without normalising both sides.
    #[test]
    fn a_crlf_file_matches_its_own_pinned_block() {
        let text = "one\r\ntwo\r\nthree";

        assert_eq!(find_block(text, "two", 0), Some(2));
    }

    #[test]
    fn a_lone_cr_file_matches_its_own_pinned_block() {
        let text = "one\rtwo\rthree";

        assert_eq!(find_block(text, "two", 0), Some(2));
    }

    /// A one-line selection on a blank line yields an empty block. Without a
    /// refusal the thread is stale the instant it is written, on a file nobody
    /// touched, and nothing can ever clear it: an empty block occurs nowhere.
    #[test]
    fn pinning_a_blank_line_is_refused() {
        let err = pin_range("one\n\nthree\n", "a.txt", 2, 2).expect_err("a blank pin");

        assert_eq!(err.code, "invalid_range");
    }

    /// `["", ""].join("\n")` is `"\n"`, whose `.lines()` is one empty line, not
    /// two. A two-blank-line pin would otherwise match any single blank line.
    #[test]
    fn pinning_two_blank_lines_is_refused() {
        let err = pin_range("one\n\n\nfour\n", "a.txt", 2, 3).expect_err("a blank pin");

        assert_eq!(err.code, "invalid_range");
    }

    #[test]
    fn pinning_a_block_that_is_blank_only_at_its_edges_is_allowed() {
        let pin = pin_range("one\n\ntwo\n", "a.txt", 1, 3).expect("real content is pinnable");

        assert_eq!(pin.block, "one\n\ntwo");
    }

    #[test]
    fn an_empty_file_holds_no_block() {
        assert_eq!(find_block("", "two", 0), None);
    }
}

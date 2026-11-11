//! A thread follows its commit through a rewrite (TRUNK-430).
//!
//! A rebase, amend or cherry-pick replaces a commit with a rewritten copy and
//! leaves the original off every ref, so the graph stops drawing it and a review
//! on it disappears. Here a commit a thread names that has left the graph is
//! matched to the one captured commit that replaced it, and the thread moves
//! there with its lines carried to where its code now sits.
//!
//! Whether the thread's own code changed is always decided against the commit it
//! was written on, kept as the `from` side of its first follow, never against the
//! commit it last followed to. A pull undone with `git reset --keep` follows the
//! thread back onto its original commit, and the comparison then finds its code
//! unchanged again.

use super::minted::Provenance;
use super::{Store, repo_key, sqlite_error};
use crate::types::Side;
use git2::{Commit, Oid, Repository, Tree};
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::hash::BuildHasher;
use std::path::Path;
use trunk_git::error::TrunkError;
use trunk_git::graph_input::CommitFacts;

/// Move every reference `repo_path`'s reviews make to a commit that has left the
/// graph onto the commit that replaced it, returning how many moved.
///
/// A reference is a thread on the commit, a commit set holding it, or a fix
/// claim naming it.
///
/// `captured` is the full graph capture, before ref visibility, so hiding a
/// branch never looks like a rewrite. A commit the repository no longer holds is
/// skipped: its author cannot be read, and the stale pass marks it as before.
///
/// # Errors
///
/// Returns the git error when a commit the repository holds will not read or
/// diff, and the `SQLite` error when the read or the write fails.
pub fn follow<S: BuildHasher>(
    store: &Store,
    repo_path: &Path,
    repo: &Repository,
    captured: &HashMap<Oid, CommitFacts, S>,
    now: i64,
) -> Result<usize, TrunkError> {
    let named = store.read(|conn| References::read(conn, repo_path))?;
    let mut on_commit = by_commit(named.threads);
    let mut moves = Vec::new();
    let mut rewrites = Vec::new();

    for left in left_the_graph(&named.oids, &on_commit, captured) {
        let Some(commit) = readable(repo, left)? else {
            continue;
        };

        if named.snapshots.provenance(left).names_a_snapshot(&commit) {
            continue;
        }

        let Some(replacement) = replacement(repo, &commit, captured)? else {
            continue;
        };

        let replacement = repo.find_commit(replacement)?;
        for thread in on_commit.remove(&left).unwrap_or_default() {
            moves.push(carry(repo, &commit, &replacement, thread)?);
        }
        rewrites.push(Rewrite {
            from: left.to_string(),
            to: replacement.id().to_string(),
            subject: replacement
                .summary()
                .ok()
                .flatten()
                .unwrap_or("")
                .to_owned(),
        });
    }

    store.write_if(
        |tx| {
            let threads = apply(tx, &moves, now)?;
            let others = rewrite_references(tx, repo_path, &rewrites)?;

            Ok(threads + others)
        },
        |moved| *moved > 0,
    )
}

/// Everything a repository's reviews name a commit by, read in one transaction.
struct References {
    threads: Vec<AnchoredThread>,
    /// The commit-set members and fix commits, which carry no lines.
    oids: Vec<String>,
    snapshots: Snapshots,
}

impl References {
    fn read(conn: &Connection, repo_path: &Path) -> Result<Self, TrunkError> {
        Ok(Self {
            threads: anchored_threads(conn, repo_path)?,
            oids: members_and_fixes(conn, repo_path)?,
            snapshots: Snapshots::read(conn, repo_path)?,
        })
    }
}

/// The oids Trunk's records say may be review snapshots, which never follow.
struct Snapshots {
    minted: HashSet<String>,
    legacy: HashSet<String>,
}

impl Snapshots {
    fn read(conn: &Connection, repo_path: &Path) -> Result<Self, TrunkError> {
        Ok(Self {
            minted: oids(
                conn,
                "SELECT oid FROM minted_snapshots WHERE repo_path = ?1",
                repo_path,
            )?,
            legacy: oids(
                conn,
                "SELECT oid FROM legacy_snapshot_candidates WHERE repo_path = ?1",
                repo_path,
            )?,
        })
    }

    fn provenance(&self, oid: Oid) -> Provenance {
        let oid = oid.to_string();
        if self.minted.contains(&oid) {
            return Provenance::Minted;
        }

        if self.legacy.contains(&oid) {
            return Provenance::Legacy;
        }

        Provenance::Unrecorded
    }
}

/// A commit that left the graph and the copy that replaced it, for the
/// references that carry no lines.
struct Rewrite {
    from: String,
    to: String,
    subject: String,
}

/// A thread that names a commit, as the follow step needs it.
struct AnchoredThread {
    id: String,
    commit_oid: String,
    lines: Option<Lines>,
    code_changed: bool,
    written_on: Option<Original>,
}

/// Where a diff thread sits within one commit.
#[derive(Clone)]
struct Lines {
    file_path: String,
    side: Side,
    whole_file: bool,
    start: u32,
    end: u32,
}

/// The commit and lines a thread was written on, from its first follow.
struct Original {
    oid: String,
    start: Option<u32>,
    end: Option<u32>,
}

/// One thread's move, with the anchor it was read at, so a concurrent writer that
/// moved it first wins.
struct Move {
    id: String,
    from_oid: String,
    from: Option<(u32, u32)>,
    to_oid: String,
    to: Option<(u32, u32)>,
    code_changed: bool,
}

fn by_commit(threads: Vec<AnchoredThread>) -> BTreeMap<Oid, Vec<AnchoredThread>> {
    let mut grouped: BTreeMap<Oid, Vec<AnchoredThread>> = BTreeMap::new();
    for thread in threads {
        if let Ok(oid) = Oid::from_str(&thread.commit_oid) {
            grouped.entry(oid).or_default().push(thread);
        }
    }

    grouped
}

/// Every named commit the capture does not hold, in oid order so a run is
/// deterministic.
fn left_the_graph<S: BuildHasher>(
    oids: &[String],
    on_commit: &BTreeMap<Oid, Vec<AnchoredThread>>,
    captured: &HashMap<Oid, CommitFacts, S>,
) -> BTreeSet<Oid> {
    oids.iter()
        .filter_map(|oid| Oid::from_str(oid).ok())
        .chain(on_commit.keys().copied())
        .filter(|oid| !captured.contains_key(oid))
        .collect()
}

/// The commit, or `None` when the repository holds no commit for the oid.
fn readable(repo: &Repository, oid: Oid) -> Result<Option<Commit<'_>>, TrunkError> {
    match repo.find_commit(oid) {
        Ok(commit) => Ok(Some(commit)),
        Err(absent) if absent.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(unreadable) => Err(unreadable.into()),
    }
}

/// The one captured commit that replaced `left`: the same author, the same
/// author time and the same subject. A reword changes the subject, so when no
/// commit matches all three, the one same-author, same-second commit whose
/// changes have `left`'s patch-id takes its place. Any other outcome is no
/// replacement, because a dropped commit's sibling authored in the same second
/// must never take its review.
fn replacement<S: BuildHasher>(
    repo: &Repository,
    left: &Commit<'_>,
    captured: &HashMap<Oid, CommitFacts, S>,
) -> Result<Option<Oid>, TrunkError> {
    let author = left.author();
    let email = author.email().unwrap_or("");
    let time = author.when().seconds();
    let subject = left.summary().ok().flatten().unwrap_or("");
    let same_second: Vec<(Oid, &CommitFacts)> = captured
        .iter()
        .filter(|(_, facts)| facts.author_email == email && facts.author_timestamp == time)
        .map(|(oid, facts)| (*oid, facts))
        .collect();

    let same_subject: Vec<Oid> = same_second
        .iter()
        .filter(|(_, facts)| facts.summary == subject)
        .map(|(oid, _)| *oid)
        .collect();
    if !same_subject.is_empty() {
        return Ok(single(same_subject));
    }

    let wanted = patch_id(repo, left)?;
    let mut same_changes = Vec::new();
    for (oid, _) in same_second {
        if patch_id(repo, &repo.find_commit(oid)?)? == wanted {
            same_changes.push(oid);
        }
    }

    Ok(single(same_changes))
}

fn single(oids: Vec<Oid>) -> Option<Oid> {
    match oids.as_slice() {
        [only] => Some(*only),
        _ => None,
    }
}

/// The commit's patch-id against its first parent, `git patch-id --stable`'s.
fn patch_id(repo: &Repository, commit: &Commit<'_>) -> Result<Oid, TrunkError> {
    let parent = first_parent_tree(commit)?;
    let diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&commit.tree()?), None)?;

    Ok(diff.patchid(None)?)
}

fn first_parent_tree<'r>(commit: &Commit<'r>) -> Result<Option<Tree<'r>>, TrunkError> {
    if commit.parent_count() == 0 {
        return Ok(None);
    }

    Ok(Some(commit.parent(0)?.tree()?))
}

/// The tree a thread's side reads: the commit's own, or its first parent's.
fn side_tree<'r>(commit: &Commit<'r>, side: &Side) -> Result<Option<Tree<'r>>, TrunkError> {
    match side {
        Side::New => Ok(Some(commit.tree()?)),
        Side::Old => first_parent_tree(commit),
    }
}

/// The move that takes `thread` from `left` to `replacement`, deciding whether
/// its code changed against the commit it was written on.
fn carry(
    repo: &Repository,
    left: &Commit<'_>,
    replacement: &Commit<'_>,
    thread: AnchoredThread,
) -> Result<Move, TrunkError> {
    let from = thread.lines.as_ref().map(|lines| (lines.start, lines.end));

    let Some(lines) = thread.lines else {
        return Ok(Move {
            id: thread.id,
            from_oid: thread.commit_oid,
            from: None,
            to_oid: replacement.id().to_string(),
            to: None,
            code_changed: false,
        });
    };

    let original = match &thread.written_on {
        None => Some((left.clone(), lines.start, lines.end)),
        Some(written_on) => readable(repo, Oid::from_str(&written_on.oid)?)?.map(|commit| {
            (
                commit,
                written_on.start.unwrap_or(lines.start),
                written_on.end.unwrap_or(lines.end),
            )
        }),
    };
    // A thread whose original commit was collected can only be compared against
    // the commit it sits on now, and keeps any change found before.
    let (basis, start, end, carried_change) = match original {
        Some((commit, start, end)) => (commit, start, end, false),
        None => (left.clone(), lines.start, lines.end, thread.code_changed),
    };
    let basis_lines = Lines {
        start,
        end,
        ..lines
    };

    let (to, changed) = translate(repo, &basis, replacement, &basis_lines)?;

    Ok(Move {
        id: thread.id,
        from_oid: thread.commit_oid,
        from,
        to_oid: replacement.id().to_string(),
        to: Some(to),
        code_changed: changed || carried_change,
    })
}

/// A diff hunk with no context, in the 1-based numbering libgit2 reports.
struct Hunk {
    old_start: u32,
    old_lines: u32,
    new_start: u32,
    new_lines: u32,
}

/// Carry `lines` from `basis` to `replacement`, returning the new range and
/// whether any of the thread's own lines changed.
fn translate(
    repo: &Repository,
    basis: &Commit<'_>,
    replacement: &Commit<'_>,
    lines: &Lines,
) -> Result<((u32, u32), bool), TrunkError> {
    let before = side_tree(basis, &lines.side)?;
    let after = side_tree(replacement, &lines.side)?;
    let path = Path::new(&lines.file_path);
    let kept = (lines.start, lines.end);

    let Some(after_blob) = blob_at(repo, after.as_ref(), path)? else {
        return Ok((kept, true));
    };

    if lines.whole_file {
        let before_blob = blob_at(repo, before.as_ref(), path)?.map(|blob| blob.id());
        return Ok((kept, before_blob != Some(after_blob.id())));
    }

    let hunks = hunks(repo, before.as_ref(), after.as_ref(), &lines.file_path)?;
    let changed = hunks
        .iter()
        .any(|hunk| overlaps(hunk, lines.start, lines.end));
    let length = line_count(after_blob.content());
    let start = clamp(map_line(&hunks, lines.start, End::Start), 1, length);
    let end = clamp(
        map_line(&hunks, lines.end, End::End),
        start,
        length.max(start),
    );

    Ok(((start, end), changed))
}

fn blob_at<'r>(
    repo: &'r Repository,
    tree: Option<&Tree<'r>>,
    path: &Path,
) -> Result<Option<git2::Blob<'r>>, TrunkError> {
    let Some(tree) = tree else {
        return Ok(None);
    };

    match tree.get_path(path) {
        Ok(entry) => Ok(entry.to_object(repo)?.into_blob().ok()),
        Err(absent) if absent.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(unreadable) => Err(unreadable.into()),
    }
}

fn hunks(
    repo: &Repository,
    before: Option<&Tree<'_>>,
    after: Option<&Tree<'_>>,
    file_path: &str,
) -> Result<Vec<Hunk>, TrunkError> {
    let mut options = git2::DiffOptions::new();
    options
        .pathspec(file_path)
        .disable_pathspec_match(true)
        .context_lines(0);
    let diff = repo.diff_tree_to_tree(before, after, Some(&mut options))?;
    let mut hunks = Vec::new();

    for index in 0..diff.deltas().len() {
        let Some(patch) = git2::Patch::from_diff(&diff, index)? else {
            continue;
        };

        for hunk in 0..patch.num_hunks() {
            let (header, _) = patch.hunk(hunk)?;
            hunks.push(Hunk {
                old_start: header.old_start(),
                old_lines: header.old_lines(),
                new_start: header.new_start(),
                new_lines: header.new_lines(),
            });
        }
    }

    Ok(hunks)
}

/// Whether a hunk touches the range. An insertion between two of its lines
/// does; one at either boundary does not.
const fn overlaps(hunk: &Hunk, start: u32, end: u32) -> bool {
    if hunk.old_lines == 0 {
        return start <= hunk.old_start && hunk.old_start < end;
    }

    hunk.old_start <= end && hunk.old_start + hunk.old_lines > start
}

#[derive(Clone, Copy)]
enum End {
    Start,
    End,
}

/// Where one end of a range lands. A line no hunk touches shifts by the lines
/// the hunks above it added. A line inside a hunk lands on the matching end of
/// the hunk's new span, or, for a pure deletion, on the line after the gap.
fn map_line(hunks: &[Hunk], line: u32, end: End) -> u32 {
    let mut shift = i64::from(line);
    for hunk in hunks {
        if hunk.old_lines == 0 {
            if line <= hunk.old_start {
                break;
            }
            shift += i64::from(hunk.new_lines);
            continue;
        }

        if line < hunk.old_start {
            break;
        }

        if line < hunk.old_start + hunk.old_lines {
            return match (hunk.new_lines, end) {
                (0, _) => hunk.new_start + 1,
                (_, End::Start) => hunk.new_start,
                (added, End::End) => hunk.new_start + added - 1,
            };
        }

        shift += i64::from(hunk.new_lines) - i64::from(hunk.old_lines);
    }

    u32::try_from(shift).unwrap_or(1)
}

fn line_count(content: &[u8]) -> u32 {
    let text = String::from_utf8_lossy(content);

    u32::try_from(text.lines().count()).unwrap_or(u32::MAX)
}

fn clamp(line: u32, low: u32, high: u32) -> u32 {
    line.max(low).min(high.max(low))
}

fn anchored_threads(
    conn: &Connection,
    repo_path: &Path,
) -> Result<Vec<AnchoredThread>, TrunkError> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.anchor_kind, t.commit_oid, t.file_path, t.side,
                    t.start_line, t.end_line, t.whole_file, t.code_changed,
                    f.from_oid, f.from_start, f.from_end
             FROM threads t
             LEFT JOIN thread_follows f ON f.rowid =
                 (SELECT rowid FROM thread_follows WHERE thread_id = t.id
                  ORDER BY rowid LIMIT 1)
             WHERE t.review_id IN (SELECT id FROM reviews WHERE repo_path = ?1)
               AND t.anchor_kind IN ('diff', 'commit')
               AND t.commit_oid IS NOT NULL
               AND t.pin_block IS NULL",
        )
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map([repo_key(repo_path)], |row| {
            let kind: String = row.get(1)?;
            let side: Option<String> = row.get(4)?;
            let start: Option<u32> = row.get(5)?;
            let end: Option<u32> = row.get(6)?;
            let lines = match (kind.as_str(), row.get::<_, Option<String>>(3)?, start, end) {
                (super::anchor::DIFF, Some(file_path), Some(start), Some(end)) => Some(Lines {
                    file_path,
                    side: if side.as_deref() == Some("Old") {
                        Side::Old
                    } else {
                        Side::New
                    },
                    whole_file: row.get(7)?,
                    start,
                    end,
                }),
                _ => None,
            };
            let written_on = row.get::<_, Option<String>>(9)?.map(|oid| Original {
                oid,
                start: row.get(10).ok().flatten(),
                end: row.get(11).ok().flatten(),
            });

            Ok(AnchoredThread {
                id: row.get(0)?,
                commit_oid: row.get(2)?,
                lines,
                code_changed: row.get(8)?,
                written_on,
            })
        })
        .map_err(sqlite_error)?;

    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

/// The commits the repository's commit sets hold and its fix claims name.
fn members_and_fixes(conn: &Connection, repo_path: &Path) -> Result<Vec<String>, TrunkError> {
    let mut stmt = conn
        .prepare(
            "SELECT oid FROM review_commits
             WHERE review_id IN (SELECT id FROM reviews WHERE repo_path = ?1)
             UNION
             SELECT h.commit_oid FROM thread_history h JOIN threads t ON t.id = h.thread_id
             WHERE t.review_id IN (SELECT id FROM reviews WHERE repo_path = ?1)
               AND h.commit_oid IS NOT NULL",
        )
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map([repo_key(repo_path)], |row| row.get(0))
        .map_err(sqlite_error)?;

    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

fn oids(conn: &Connection, sql: &str, repo_path: &Path) -> Result<HashSet<String>, TrunkError> {
    let mut stmt = conn.prepare(sql).map_err(sqlite_error)?;
    let rows = stmt
        .query_map([repo_key(repo_path)], |row| row.get(0))
        .map_err(sqlite_error)?;

    rows.collect::<Result<HashSet<_>, _>>()
        .map_err(sqlite_error)
}

/// Point each commit set and fix claim at the copy. A set that already holds
/// the copy drops the original rather than listing the commit twice.
fn rewrite_references(
    conn: &Connection,
    repo_path: &Path,
    rewrites: &[Rewrite],
) -> Result<usize, TrunkError> {
    let repo = repo_key(repo_path);
    let mut changed = 0;
    for rewrite in rewrites {
        changed += conn
            .execute(
                "DELETE FROM review_commits
                 WHERE oid = ?2
                   AND review_id IN (SELECT id FROM reviews WHERE repo_path = ?1)
                   AND review_id IN (SELECT review_id FROM review_commits WHERE oid = ?3)",
                rusqlite::params![repo, rewrite.from, rewrite.to],
            )
            .map_err(sqlite_error)?;
        changed += conn
            .execute(
                "UPDATE review_commits SET oid = ?3, subject = ?4
                 WHERE oid = ?2
                   AND review_id IN (SELECT id FROM reviews WHERE repo_path = ?1)",
                rusqlite::params![repo, rewrite.from, rewrite.to, rewrite.subject],
            )
            .map_err(sqlite_error)?;
        changed += conn
            .execute(
                "UPDATE thread_history SET commit_oid = ?3
                 WHERE commit_oid = ?2
                   AND thread_id IN (SELECT id FROM threads WHERE review_id IN
                       (SELECT id FROM reviews WHERE repo_path = ?1))",
                rusqlite::params![repo, rewrite.from, rewrite.to],
            )
            .map_err(sqlite_error)?;
    }

    Ok(changed)
}

/// Write each move whose thread still sits where it was read, and record it.
/// The thread's commit is present, so it is stale exactly when its code changed.
fn apply(conn: &Connection, moves: &[Move], now: i64) -> Result<usize, TrunkError> {
    let mut applied = 0;
    for change in moves {
        let updated = conn
            .execute(
                "UPDATE threads
                 SET commit_oid = ?2, start_line = ?3, end_line = ?4,
                     code_changed = ?5, stale = ?5
                 WHERE id = ?1 AND commit_oid = ?6
                   AND start_line IS ?7 AND end_line IS ?8",
                rusqlite::params![
                    change.id,
                    change.to_oid,
                    change.to.map(|(start, _)| start),
                    change.to.map(|(_, end)| end),
                    change.code_changed,
                    change.from_oid,
                    change.from.map(|(start, _)| start),
                    change.from.map(|(_, end)| end),
                ],
            )
            .map_err(sqlite_error)?;
        if updated == 0 {
            continue;
        }

        conn.execute(
            "INSERT INTO thread_follows (thread_id, from_oid, to_oid, from_start, from_end,
                                         to_start, to_end, code_changed, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                change.id,
                change.from_oid,
                change.to_oid,
                change.from.map(|(start, _)| start),
                change.from.map(|(_, end)| end),
                change.to.map(|(start, _)| start),
                change.to.map(|(_, end)| end),
                change.code_changed,
                now,
            ],
        )
        .map_err(sqlite_error)?;
        applied += 1;
    }

    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::{End, Hunk, map_line, overlaps};

    const fn hunk(old_start: u32, old_lines: u32, new_start: u32, new_lines: u32) -> Hunk {
        Hunk {
            old_start,
            old_lines,
            new_start,
            new_lines,
        }
    }

    #[test]
    fn a_line_below_an_insertion_shifts_down_by_the_inserted_lines() {
        assert_eq!(map_line(&[hunk(0, 0, 1, 2)], 4, End::Start), 6);
    }

    #[test]
    fn a_line_above_a_change_keeps_its_number() {
        assert_eq!(map_line(&[hunk(7, 1, 7, 3)], 4, End::Start), 4);
    }

    #[test]
    fn a_deleted_line_lands_on_the_line_after_the_gap() {
        assert_eq!(map_line(&[hunk(3, 2, 2, 0)], 4, End::Start), 3);
    }

    #[test]
    fn each_end_of_a_partly_changed_range_maps_on_its_own() {
        let hunks = [hunk(4, 1, 4, 2)];

        let range = (
            map_line(&hunks, 2, End::Start),
            map_line(&hunks, 5, End::End),
        );

        assert_eq!(range, (2, 6));
    }

    #[test]
    fn the_end_of_a_range_inside_a_replacement_takes_the_replacements_last_line() {
        assert_eq!(map_line(&[hunk(4, 1, 4, 3)], 4, End::End), 6);
    }

    #[test]
    fn an_insertion_between_two_lines_of_the_range_changes_its_code() {
        assert!(overlaps(&hunk(2, 0, 3, 1), 2, 3));
    }

    #[test]
    fn an_insertion_at_either_boundary_leaves_its_code_unchanged() {
        assert!(!overlaps(&hunk(1, 0, 2, 1), 2, 3));
        assert!(!overlaps(&hunk(3, 0, 4, 1), 2, 3));
    }

    #[test]
    fn a_hunk_touching_one_line_of_the_range_changes_its_code() {
        assert!(overlaps(&hunk(3, 1, 3, 1), 2, 3));
    }
}

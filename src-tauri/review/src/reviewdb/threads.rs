//! Threads: the persisted form of today's comments — root text plus anchor, now
//! carrying a state and a channel.
//!
//! `ThreadState::transition` (`crate::types`) is the single place the state matrix
//! (spec §2) is enforced; every writer of `threads.state` goes through it via
//! `set_state`.

use super::ids::{self, IdKind};
use super::replies::{self, Reply};
use super::{anchor, repo_key, reviews, sqlite_error};
use crate::types::{Anchor, Channel, ContentPin, Delivery, Source, ThreadState};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::str::FromStr;
use trunk_git::error::TrunkError;

#[derive(Debug, Serialize, Clone)]
pub struct Thread {
    pub id: String,
    pub review_id: String,
    pub text: String,
    pub anchor: Option<Anchor>,
    pub commit_oid: Option<String>,
    pub cached_excerpt: Option<String>,
    pub state: ThreadState,
    pub stale: bool,
    pub channel: Channel,
    pub content_pin: Option<ContentPin>,
    /// Where the pinned block currently sits: written at insert from the range
    /// the user selected, and rewritten by every stale pass. `None` for a thread
    /// that carries no pin, for one whose block the file has lost, and for one
    /// written before the insert stored it, until a pass fills it in.
    pub resolved_start_line: Option<u32>,
    /// Wall-clock seconds when the root comment was submitted.
    pub created_at: i64,
    /// Held in the review's batch, so the agent cannot see it yet.
    pub pending: bool,
}

pub struct NewThread {
    pub text: String,
    pub anchor: Option<Anchor>,
    pub commit_oid: Option<String>,
    pub content_pin: Option<ContentPin>,
    pub cached_excerpt: Option<String>,
    pub delivery: Delivery,
}

const SELECT: &str = "
    SELECT id, review_id, body, excerpt, state, stale, channel,
           anchor_kind, commit_oid, file_path, source, side, start_line, end_line,
           pin_block, pin_ordinal, resolved_start_line, created_at, pending
    FROM threads";

const ANCHOR_FIRST_COLUMN: usize = 7;
const PIN_FIRST_COLUMN: usize = 14;

/// Add a thread to a review and return its id.
///
/// # Errors
///
/// Returns the `SQLite` error when minting the id or inserting the row fails.
pub fn insert(
    conn: &Connection,
    review_id: &str,
    new: NewThread,
    now: i64,
) -> Result<String, TrunkError> {
    let pending = new.delivery == Delivery::Hold || reviews::holds_batch(conn, review_id)?;
    let id = ids::mint_unique(conn, IdKind::Thread)?;
    let target = match new.content_pin.as_ref() {
        Some(pin) => anchor::Target::CurrentFile(pin),
        None => anchor::target_of(new.anchor.as_ref(), new.commit_oid.as_deref()),
    };
    let cols = anchor::to_columns(&target);

    conn.execute(
        &format!(
            "INSERT INTO threads (id, review_id, body, channel, state, stale, excerpt,
                                  {}, pin_block, pin_ordinal, resolved_start_line,
                                  created_at, updated_at, pending)
             VALUES (?1, ?2, ?3, ?4, 'open', 0, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                     ?13, ?14, ?15, ?16, ?16, ?17)",
            anchor::COLUMNS
        ),
        rusqlite::params![
            &id,
            review_id,
            &new.text,
            Channel::Human.as_str(),
            new.cached_excerpt,
            cols.kind,
            cols.commit_oid,
            cols.file_path,
            cols.source,
            cols.side,
            cols.start_line,
            cols.end_line,
            new.content_pin.as_ref().map(|p| p.block.clone()),
            new.content_pin.as_ref().map(|p| i64::from(p.ordinal)),
            new.content_pin.as_ref().map(|p| i64::from(p.start_line)),
            now,
            pending,
        ],
    )
    .map_err(sqlite_error)?;

    Ok(id)
}

/// The review's threads as `reader` may see them, oldest first: the agent
/// never sees a held thread.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails, and the stored value when a
/// row's state or channel is not one this build knows.
pub fn list_for_review(
    conn: &Connection,
    review_id: &str,
    reader: Channel,
) -> Result<Vec<Thread>, TrunkError> {
    let visible = match reader {
        Channel::Human => "",
        Channel::Agent => "AND pending = 0",
    };
    // rowid, never id: ids are random, so two threads inside one second would
    // sort by a coin flip — permanently, since the order is deterministic.
    let sql = format!("{SELECT} WHERE review_id = ?1 {visible} ORDER BY created_at, rowid");
    let mut stmt = conn.prepare(&sql).map_err(sqlite_error)?;
    let rows = stmt
        .query_map([review_id], |row| Ok(read_thread(row)))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<Result<Thread, TrunkError>>, _>>()
        .map_err(sqlite_error)?;

    rows.into_iter().collect()
}

/// Each of the review's threads paired with its replies, fetched in one query.
///
/// Callers no longer hand-drain the reply map themselves — a call site that forgot
/// `unwrap_or_default()` on a no-reply thread would panic or silently drop replies.
///
/// # Errors
///
/// Returns whatever reading the threads or their replies returns.
pub fn list_with_replies(
    conn: &Connection,
    review_id: &str,
    reader: Channel,
) -> Result<Vec<(Thread, Vec<Reply>)>, TrunkError> {
    let threads = list_for_review(conn, review_id, reader)?;
    let thread_ids: Vec<String> = threads.iter().map(|t| t.id.clone()).collect();
    let mut replies_by_thread = replies::list_for_threads(conn, &thread_ids, reader)?;

    Ok(threads
        .into_iter()
        .map(|t| {
            let replies = replies_by_thread.remove(&t.id).unwrap_or_default();
            (t, replies)
        })
        .collect())
}

/// Every line of a diff excerpt carries a `+`, `-` or space prefix, so an empty
/// one belongs to no diff. Captures before 2026-10-06 kept libgit2's newline on
/// each line and joined them with another, which left one after every line;
/// dropping them here mends those rows for every reader without a migration.
fn drop_empty_lines(excerpt: String) -> String {
    excerpt
        .split('\n')
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The lines a full-file excerpt's skipped-lines marker stands for, in the form
/// `full-file-anchor.ts` writes it, or `None` for a line of code.
fn gap_length(line: &str) -> Option<u32> {
    line.strip_prefix("… ")?
        .strip_suffix(" lines unchanged …")?
        .parse()
        .ok()
}

/// The full-file form of the same mend. An empty line here can be the file's
/// own, so the doubled shape is told apart by the range: undoubling is kept
/// only when it, and not the excerpt as stored, covers exactly the anchored
/// lines. Each code line of a doubled capture is followed by an empty one,
/// while a skipped-lines marker never carried a newline of its own.
fn undouble_full_file(excerpt: String, anchor: &Anchor) -> String {
    let lines: Vec<&str> = excerpt.split('\n').collect();
    let covers = |lines: &[&str]| -> u64 {
        lines
            .iter()
            .map(|line| u64::from(gap_length(line).unwrap_or(1)))
            .sum()
    };
    let Some(anchored) = (u64::from(anchor.end_line) + 1).checked_sub(u64::from(anchor.start_line))
    else {
        return excerpt;
    };
    if covers(&lines) == anchored {
        return excerpt;
    }

    let mut undoubled = Vec::with_capacity(lines.len() / 2);
    let mut rest = lines.as_slice();
    while let Some((&line, after)) = rest.split_first() {
        undoubled.push(line);
        rest = match after.split_first() {
            _ if gap_length(line).is_some() => after,
            Some((&"", after_newline)) => after_newline,
            _ => return excerpt,
        };
    }
    if covers(&undoubled) == anchored {
        undoubled.join("\n")
    } else {
        excerpt
    }
}

fn read_thread(row: &rusqlite::Row) -> Result<Thread, TrunkError> {
    let (anchor, commit_oid) = anchor::from_row(row, ANCHOR_FIRST_COLUMN)?;
    let content_pin = read_pin(row)?;
    let stored_excerpt: Option<String> = row.get(3).map_err(sqlite_error)?;
    let cached_excerpt = match &anchor {
        Some(a) if a.source == Source::Diff => stored_excerpt.map(drop_empty_lines),
        Some(a) => stored_excerpt.map(|excerpt| undouble_full_file(excerpt, a)),
        _ => stored_excerpt,
    };
    let state: String = row.get(4).map_err(sqlite_error)?;
    let channel: String = row.get(6).map_err(sqlite_error)?;

    Ok(Thread {
        id: row.get(0).map_err(sqlite_error)?,
        review_id: row.get(1).map_err(sqlite_error)?,
        text: row.get(2).map_err(sqlite_error)?,
        cached_excerpt,
        state: ThreadState::from_str(&state)?,
        stale: row.get::<_, i64>(5).map_err(sqlite_error)? != 0,
        channel: Channel::from_str(&channel)?,
        anchor,
        commit_oid,
        content_pin,
        resolved_start_line: optional_line(row, PIN_FIRST_COLUMN + 2)?,
        created_at: row.get(PIN_FIRST_COLUMN + 3).map_err(sqlite_error)?,
        pending: row
            .get::<_, i64>(PIN_FIRST_COLUMN + 4)
            .map_err(sqlite_error)?
            != 0,
    })
}

/// The content pin, present exactly when the row carries a pinned block. The
/// file path and display range live in the shared anchor columns, so a
/// current-file row reads its path from there.
fn read_pin(row: &rusqlite::Row) -> Result<Option<ContentPin>, TrunkError> {
    let Some(block): Option<String> = row.get(PIN_FIRST_COLUMN).map_err(sqlite_error)? else {
        return Ok(None);
    };

    Ok(Some(ContentPin {
        file_path: row
            .get::<_, Option<String>>(ANCHOR_FIRST_COLUMN + 2)
            .map_err(sqlite_error)?
            .ok_or_else(|| {
                TrunkError::new("store", "corrupt anchor row: a pin with no file path")
            })?,
        block,
        ordinal: optional_line(row, PIN_FIRST_COLUMN + 1)?.unwrap_or(0),
        start_line: optional_line(row, ANCHOR_FIRST_COLUMN + 5)?.unwrap_or(0),
        end_line: optional_line(row, ANCHOR_FIRST_COLUMN + 6)?.unwrap_or(0),
    }))
}

/// A nullable line-ish column, refusing a value no line number can hold rather
/// than wrapping it into one.
fn optional_line(row: &rusqlite::Row, column: usize) -> Result<Option<u32>, TrunkError> {
    let Some(stored): Option<i64> = row.get(column).map_err(sqlite_error)? else {
        return Ok(None);
    };

    u32::try_from(stored).map(Some).map_err(|_| {
        TrunkError::new(
            "store",
            format!("corrupt anchor row: line out of range: {stored}"),
        )
    })
}

/// Every distinct commit oid the repo's threads anchor to, across every review.
/// The sweep's other half: a pin whose oid is absent here is unanchored.
///
/// Scoped by repo because one database holds every repo: without the
/// `repo_path` clause another repo's thread would keep this repo's pin alive
/// on an oid collision.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn anchored_oids(conn: &Connection, repo_path: &Path) -> Result<HashSet<String>, TrunkError> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT commit_oid FROM threads
             WHERE commit_oid IS NOT NULL
               AND review_id IN (SELECT id FROM reviews WHERE repo_path = ?1)",
        )
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map([repo_key(repo_path)], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?;

    rows.collect::<Result<HashSet<String>, _>>()
        .map_err(sqlite_error)
}

/// Move a thread's state, enforcing `ThreadState::transition` inside the same
/// read-then-write pass.
///
/// A missing id is `not_found`, matching `edit`'s convention: state changes target by
/// id, never by list position.
///
/// # Errors
///
/// Returns `not_found` when `id` names no thread in `repo_path`,
/// `illegal_transition` when `channel` may not make that move, and the
/// `SQLite` error when a query or the write fails.
pub fn set_state(
    conn: &Connection,
    repo_path: &Path,
    id: &str,
    next: ThreadState,
    channel: Channel,
    now: i64,
) -> Result<(), TrunkError> {
    set_state_at_commit(conn, repo_path, id, next, channel, None, now)
}

/// `set_state`, naming the commit the change rests on, as an agent's addressed
/// claim names its fix. The change and the commit go into the thread's history.
///
/// # Errors
///
/// As `set_state`.
pub fn set_state_at_commit(
    conn: &Connection,
    repo_path: &Path,
    id: &str,
    next: ThreadState,
    channel: Channel,
    commit: Option<&str>,
    now: i64,
) -> Result<(), TrunkError> {
    let current: Option<String> = conn
        .query_row(
            "SELECT state FROM threads
             WHERE id = ?1 AND review_id IN (SELECT id FROM reviews WHERE repo_path = ?2)",
            rusqlite::params![id, repo_key(repo_path)],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)?;

    let Some(current) = current else {
        return Err(TrunkError::new(
            "not_found",
            format!("no thread with id {id}"),
        ));
    };

    let next = ThreadState::from_str(&current)?.transition(next, channel)?;

    conn.execute(
        "UPDATE threads SET state = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, next.as_str(), now],
    )
    .map_err(sqlite_error)?;
    super::history::record(conn, id, next, channel, commit, now)?;

    Ok(())
}

/// Human-authored text is editable at any time, published review included — publication
/// gates deletion, never editing (criterion 4).
///
/// Refusing an agent-authored edit with `not_editable`, distinct from `not_found`,
/// means an agent-authored id is never indistinguishable from a missing one. Edits
/// target by id, never by list position.
///
/// # Errors
///
/// Returns `not_found` when `id` names no thread in `repo_path`,
/// `not_editable` when the thread is agent-authored, and the `SQLite` error
/// when a query or the write fails.
pub fn edit(
    conn: &Connection,
    repo_path: &Path,
    id: &str,
    text: &str,
    now: i64,
) -> Result<(), TrunkError> {
    let channel: Option<String> = conn
        .query_row(
            "SELECT channel FROM threads
             WHERE id = ?1 AND review_id IN (SELECT id FROM reviews WHERE repo_path = ?2)",
            rusqlite::params![id, repo_key(repo_path)],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)?;

    super::require_human(channel, || {
        TrunkError::new("not_found", format!("no thread with id {id}"))
    })?;

    conn.execute(
        "UPDATE threads SET body = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, text, now],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// A missing id, or one belonging to another repository, is an idempotent no-op, so a
/// double-delete or a stale id from another window never errors.
///
/// # Errors
///
/// Returns the `SQLite` error when the delete fails.
pub fn delete(conn: &Connection, repo_path: &Path, id: &str) -> Result<(), TrunkError> {
    conn.execute(
        "DELETE FROM threads WHERE id = ?1
         AND review_id IN (SELECT id FROM reviews WHERE repo_path = ?2)",
        rusqlite::params![id, repo_key(repo_path)],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

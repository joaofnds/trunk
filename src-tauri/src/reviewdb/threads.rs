//! Threads: the persisted form of today's comments — root text plus anchor,
//! now carrying a state and a channel. `ThreadState::transition`
//! (`review_types`) is the single place the state matrix (spec §2) is
//! enforced; every writer of `threads.state` goes through it via `set_state`.

use super::ids::{self, IdKind};
use super::replies::{self, Reply};
use super::{anchor, repo_key, sqlite_error};
use crate::error::TrunkError;
use crate::git::types::Anchor;
use crate::review_types::{Channel, ThreadState};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::str::FromStr;

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
}

pub struct NewThread {
    pub text: String,
    pub anchor: Option<Anchor>,
    pub commit_oid: Option<String>,
    pub cached_excerpt: Option<String>,
}

const SELECT: &str = "
    SELECT id, review_id, body, excerpt, state, stale, channel,
           anchor_kind, commit_oid, file_path, source, side, start_line, end_line
    FROM threads";

const ANCHOR_FIRST_COLUMN: usize = 7;

pub fn insert(
    conn: &Connection,
    review_id: &str,
    new: NewThread,
    now: i64,
) -> Result<String, TrunkError> {
    let id = ids::mint_unique(conn, IdKind::Thread)?;
    let cols = anchor::to_columns(new.anchor.as_ref(), new.commit_oid.as_deref());

    conn.execute(
        &format!(
            "INSERT INTO threads (id, review_id, body, channel, state, stale, excerpt,
                                  {}, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'open', 0, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
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
            now,
        ],
    )
    .map_err(sqlite_error)?;

    Ok(id)
}

pub fn list_for_review(conn: &Connection, review_id: &str) -> Result<Vec<Thread>, TrunkError> {
    // rowid, never id: ids are random, so two threads inside one second would
    // sort by a coin flip — permanently, since the order is deterministic.
    let sql = format!("{SELECT} WHERE review_id = ?1 ORDER BY created_at, rowid");
    let mut stmt = conn.prepare(&sql).map_err(sqlite_error)?;
    let rows = stmt
        .query_map([review_id], |row| Ok(read_thread(row)))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<Result<Thread, TrunkError>>, _>>()
        .map_err(sqlite_error)?;

    rows.into_iter().collect()
}

/// Each of the review's threads paired with its replies, fetched in one
/// query. Callers no longer hand-drain the reply map themselves — a call
/// site that forgot `unwrap_or_default()` on a no-reply thread would panic
/// or silently drop replies.
pub fn list_with_replies(
    conn: &Connection,
    review_id: &str,
) -> Result<Vec<(Thread, Vec<Reply>)>, TrunkError> {
    let threads = list_for_review(conn, review_id)?;
    let thread_ids: Vec<String> = threads.iter().map(|t| t.id.clone()).collect();
    let mut replies_by_thread = replies::list_for_threads(conn, &thread_ids)?;

    Ok(threads
        .into_iter()
        .map(|t| {
            let replies = replies_by_thread.remove(&t.id).unwrap_or_default();
            (t, replies)
        })
        .collect())
}

fn read_thread(row: &rusqlite::Row) -> Result<Thread, TrunkError> {
    let (anchor, commit_oid) = anchor::from_row(row, ANCHOR_FIRST_COLUMN)?;
    let state: String = row.get(4).map_err(sqlite_error)?;
    let channel: String = row.get(6).map_err(sqlite_error)?;

    Ok(Thread {
        id: row.get(0).map_err(sqlite_error)?,
        review_id: row.get(1).map_err(sqlite_error)?,
        text: row.get(2).map_err(sqlite_error)?,
        cached_excerpt: row.get(3).map_err(sqlite_error)?,
        state: ThreadState::from_str(&state)?,
        stale: row.get::<_, i64>(5).map_err(sqlite_error)? != 0,
        channel: Channel::from_str(&channel)?,
        anchor,
        commit_oid,
    })
}

/// Whether any of the repo's threads anchors to `commit_oid`, across every
/// review. Gates snapshot-pin pruning: a superseded snapshot stays pinned
/// while a thread still anchors to it, or gc collects the commit its inline
/// diff renders from.
pub fn any_anchored_to(
    conn: &Connection,
    repo_path: &Path,
    commit_oid: &str,
) -> Result<bool, TrunkError> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM threads
            WHERE commit_oid = ?2
              AND review_id IN (SELECT id FROM reviews WHERE repo_path = ?1))",
        rusqlite::params![repo_key(repo_path), commit_oid],
        |row| row.get(0),
    )
    .map_err(sqlite_error)
}

/// Move a thread's state, enforcing `ThreadState::transition` inside the same
/// read-then-write pass. A missing id is `not_found`, matching `edit`'s
/// convention: state changes target by id, never by list position.
pub fn set_state(
    conn: &Connection,
    repo_path: &Path,
    id: &str,
    next: ThreadState,
    channel: Channel,
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

    Ok(())
}

/// Human-authored text is editable at any time, published review included —
/// publication gates deletion, never editing (criterion 4). Refusing an
/// agent-authored edit with `not_editable`, distinct from `not_found`, means
/// an agent-authored id is never indistinguishable from a missing one. Edits
/// target by id, never by list position.
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

/// A missing id is an idempotent no-op, so a double-delete or a stale id from
/// another window never errors. Publication gates this — not editing
/// (criterion 12): a published review's threads are permanent, and that check
/// happens before anything is written, same read-then-check shape as `edit`'s
/// channel refusal.
pub fn delete(conn: &Connection, repo_path: &Path, id: &str) -> Result<(), TrunkError> {
    let published: Option<bool> = conn
        .query_row(
            "SELECT r.published FROM threads t
             JOIN reviews r ON r.id = t.review_id
             WHERE t.id = ?1 AND r.repo_path = ?2",
            rusqlite::params![id, repo_key(repo_path)],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)?;

    let Some(published) = published else {
        return Ok(());
    };
    super::require_unpublished(published, "threads")?;

    conn.execute("DELETE FROM threads WHERE id = ?1", [id])
        .map_err(sqlite_error)?;

    Ok(())
}

use super::ids::{self, IdKind};
use super::{repo_key, reviews, sqlite_error};
use crate::types::{Channel, Delivery};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use trunk_git::error::TrunkError;

#[derive(Debug, Serialize, Clone)]
pub struct Reply {
    pub id: String,
    pub thread_id: String,
    pub text: String,
    pub channel: Channel,
    pub created_at: i64,
    /// Held in the review's batch, so the agent cannot see it yet.
    pub pending: bool,
    /// The app has shown it to the user. A human reply is seen as it is written.
    pub seen: bool,
}

/// Add a reply to a thread. Scoped by `repo_path`, same ownership subquery as
/// `edit`/`delete`: a `thread_id` belonging to another repo is `not_found`,
/// never a foreign-key error from an unscoped insert.
///
/// A human reply is held when `delivery` asks for it or the review already
/// holds a batch. An agent reply is never held, whatever `delivery` says,
/// since the agent has no batch to send.
///
/// # Errors
///
/// Returns `not_found` when `thread_id` names no thread in `repo_path`, and
/// the `SQLite` error when minting the id or the insert fails.
pub fn add(
    conn: &Connection,
    repo_path: &Path,
    thread_id: &str,
    body: &str,
    channel: Channel,
    delivery: Delivery,
    now: i64,
) -> Result<String, TrunkError> {
    let review_id: Option<String> = conn
        .query_row(
            "SELECT review_id FROM threads
             WHERE id = ?1 AND review_id IN (SELECT id FROM reviews WHERE repo_path = ?2)",
            rusqlite::params![thread_id, repo_key(repo_path)],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)?;

    let Some(review_id) = review_id else {
        return Err(TrunkError::new(
            "not_found",
            format!("no thread with id {thread_id}"),
        ));
    };

    let pending = channel == Channel::Human
        && (delivery == Delivery::Hold || reviews::holds_batch(conn, &review_id)?);
    let seen = channel == Channel::Human;
    let id = ids::mint_unique(conn, IdKind::Reply)?;

    conn.execute(
        "INSERT INTO replies (id, thread_id, body, channel, created_at, updated_at, pending, seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7)",
        rusqlite::params![&id, thread_id, body, channel.as_str(), now, pending, seen],
    )
    .map_err(sqlite_error)?;

    Ok(id)
}

/// Update a reply's text.
///
/// Same refusal shape as `threads::edit`: agent-attributed text is not editable from
/// the UI (`not_editable`), publication gates nothing here (criterion 4), and a missing
/// id is `not_found`.
///
/// # Errors
///
/// Returns `not_found` when `id` names no reply in `repo_path`,
/// `not_editable` when the reply is agent-authored, and the `SQLite` error
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
            "SELECT channel FROM replies
             WHERE id = ?1 AND thread_id IN (
                 SELECT id FROM threads WHERE review_id IN (
                     SELECT id FROM reviews WHERE repo_path = ?2
                 )
             )",
            rusqlite::params![id, repo_key(repo_path)],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)?;

    super::require_human(channel, || {
        TrunkError::new("not_found", format!("no reply with id {id}"))
    })?;

    conn.execute(
        "UPDATE replies SET body = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, text, now],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// Remove a reply, whichever channel wrote it.
///
/// A missing id, or one belonging to another repository, is an idempotent no-op.
///
/// # Errors
///
/// Returns the `SQLite` error when the delete fails.
pub fn delete(conn: &Connection, repo_path: &Path, id: &str) -> Result<(), TrunkError> {
    conn.execute(
        "DELETE FROM replies WHERE id = ?1
         AND thread_id IN (
             SELECT t.id FROM threads t
             JOIN reviews r ON r.id = t.review_id
             WHERE r.repo_path = ?2
         )",
        rusqlite::params![id, repo_key(repo_path)],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// Record that the app showed the user these agent replies.
///
/// Returns how many were not seen before. Ids from another repository, human
/// replies, and replies already seen change nothing, so a repeat returns 0.
///
/// # Errors
///
/// Returns the `SQLite` error when the update fails.
pub fn mark_seen(conn: &Connection, repo_path: &Path, ids: &[String]) -> Result<usize, TrunkError> {
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "UPDATE replies SET seen = 1
         WHERE id IN ({placeholders}) AND seen = 0 AND channel = 'agent'
         AND thread_id IN (
             SELECT t.id FROM threads t
             JOIN reviews r ON r.id = t.review_id
             WHERE r.repo_path = ?
         )"
    );
    let repo = repo_key(repo_path);
    let params = ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .chain(std::iter::once(&repo as &dyn rusqlite::ToSql));

    conn.execute(&sql, rusqlite::params_from_iter(params))
        .map_err(sqlite_error)
}

/// Every reply for a set of threads that `reader` may see, keyed by thread id: one
/// query over an `IN` list rather than N+1. The agent never sees a held reply.
///
/// Within each thread, replies are oldest first; ties within one second break on
/// `rowid`, never `id`: ids are random, so a same-second pair would sort by a coin flip
/// — permanently, since the order is deterministic once written. The reviewer reads
/// them in the order written. The agent reads them by when each last changed for it,
/// written, sent or edited, the clock `threads::last_action` counts by, so a held
/// reply sent after the agent answered sits after that answer and an agent never takes
/// its own reply for the newest.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn list_for_threads(
    conn: &Connection,
    thread_ids: &[String],
    reader: Channel,
) -> Result<HashMap<String, Vec<Reply>>, TrunkError> {
    if thread_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = vec!["?"; thread_ids.len()].join(",");
    let (visible, order) = match reader {
        Channel::Human => ("", "created_at"),
        Channel::Agent => ("AND pending = 0", "MAX(created_at, updated_at)"),
    };
    let sql = format!(
        "SELECT id, thread_id, body, channel, created_at, pending, seen FROM replies
         WHERE thread_id IN ({placeholders}) {visible} ORDER BY {order}, rowid"
    );
    let mut stmt = conn.prepare(&sql).map_err(sqlite_error)?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(thread_ids))
        .map_err(sqlite_error)?;

    let mut by_thread: HashMap<String, Vec<Reply>> = HashMap::new();
    while let Some(row) = rows.next().map_err(sqlite_error)? {
        let reply = read_reply(row)?;
        by_thread
            .entry(reply.thread_id.clone())
            .or_default()
            .push(reply);
    }

    Ok(by_thread)
}

fn read_reply(row: &rusqlite::Row) -> Result<Reply, TrunkError> {
    let channel: String = row.get(3).map_err(sqlite_error)?;

    Ok(Reply {
        id: row.get(0).map_err(sqlite_error)?,
        thread_id: row.get(1).map_err(sqlite_error)?,
        text: row.get(2).map_err(sqlite_error)?,
        channel: Channel::from_str(&channel)?,
        created_at: row.get(4).map_err(sqlite_error)?,
        pending: row.get::<_, i64>(5).map_err(sqlite_error)? != 0,
        seen: row.get::<_, i64>(6).map_err(sqlite_error)? != 0,
    })
}

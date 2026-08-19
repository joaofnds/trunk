//! Replies: a flat, one-level list of text under a thread, each carrying its
//! channel attribution. No anchor, no state — state lives on the thread.

use super::ids::{self, IdKind};
use super::{repo_key, sqlite_error};
use crate::error::TrunkError;
use crate::git::types::Channel;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;

#[derive(Debug, Serialize, Clone)]
pub struct Reply {
    pub id: String,
    pub thread_id: String,
    pub text: String,
    pub channel: Channel,
    pub created_at: i64,
}

pub fn add(
    conn: &Connection,
    thread_id: &str,
    body: &str,
    channel: Channel,
    now: i64,
) -> Result<String, TrunkError> {
    let id = ids::mint_unique(conn, IdKind::Reply)?;

    conn.execute(
        "INSERT INTO replies (id, thread_id, body, channel, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        rusqlite::params![&id, thread_id, body, channel.as_str(), now],
    )
    .map_err(sqlite_error)?;

    Ok(id)
}

/// Update a reply's text. Same refusal shape as `threads::edit`: agent-
/// attributed text is not editable from the UI (`not_editable`), publication
/// gates nothing here (criterion 4), and a missing id is `not_found`.
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

    let Some(channel) = channel else {
        return Err(TrunkError::new(
            "not_found",
            format!("no reply with id {id}"),
        ));
    };

    if channel != Channel::Human.as_str() {
        return Err(TrunkError::new(
            "not_editable",
            "agent-attributed text is not editable from the UI",
        ));
    }

    conn.execute(
        "UPDATE replies SET body = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, text, now],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// Remove a reply. A missing id is an idempotent no-op. Publication gates
/// this, not editing (criterion 12): a published review's replies are
/// permanent, so a reply belonging to one refuses with `review_published`
/// before anything is written — same read-then-check shape as
/// `threads::delete`.
pub fn delete(conn: &Connection, repo_path: &Path, id: &str) -> Result<(), TrunkError> {
    let published: Option<i64> = conn
        .query_row(
            "SELECT r.published FROM replies rep
             JOIN threads t ON t.id = rep.thread_id
             JOIN reviews r ON r.id = t.review_id
             WHERE rep.id = ?1 AND r.repo_path = ?2",
            rusqlite::params![id, repo_key(repo_path)],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)?;

    match published {
        None => return Ok(()),
        Some(0) => {}
        Some(_) => {
            return Err(TrunkError::new(
                "review_published",
                "a published review's replies are permanent",
            ));
        }
    }

    conn.execute("DELETE FROM replies WHERE id = ?1", [id])
        .map_err(sqlite_error)?;

    Ok(())
}

/// Every reply for a set of threads, keyed by thread id — one query over an
/// `IN` list rather than N+1. Within each thread, replies are oldest first;
/// ties within one second break on `rowid`, never `id`: ids are random, so a
/// same-second pair would sort by a coin flip — permanently, since the order
/// is deterministic once written.
pub fn list_for_threads(
    conn: &Connection,
    thread_ids: &[String],
) -> Result<HashMap<String, Vec<Reply>>, TrunkError> {
    if thread_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = vec!["?"; thread_ids.len()].join(",");
    let sql = format!(
        "SELECT id, thread_id, body, channel, created_at FROM replies
         WHERE thread_id IN ({placeholders}) ORDER BY created_at, rowid"
    );
    let mut stmt = conn.prepare(&sql).map_err(sqlite_error)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(thread_ids), |row| {
            Ok(read_reply(row))
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<Result<Reply, TrunkError>>, _>>()
        .map_err(sqlite_error)?;

    let mut by_thread: HashMap<String, Vec<Reply>> = HashMap::new();
    for reply in rows {
        let reply = reply?;
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
    })
}

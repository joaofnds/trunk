//! A thread's history: every state change it went through.
//!
//! Each change keeps who made it and when, and for an agent's addressed claim
//! the commit it names as the fix. The card draws these between the replies,
//! so a reader sees that the agent claimed a fix in a3f9c21 before the
//! reviewer confirmed it.
//!
//! Each row is written by `threads::set_state` in the same transaction as the
//! state it records, so a refused or rolled-back change leaves no row, and a
//! thread's deletion cascades to its history.

use super::commits::Rewrite;
use super::{repo_key, sqlite_error};
use crate::types::{Channel, ThreadState};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;
use trunk_git::error::TrunkError;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct StateChange {
    pub state: ThreadState,
    pub channel: Channel,
    /// The commit an agent named as the fix when it claimed addressed.
    pub commit: Option<String>,
    pub created_at: i64,
}

/// Record that `thread_id` moved to `state`.
///
/// # Errors
///
/// Returns the `SQLite` error when the insert fails.
pub fn record(
    conn: &Connection,
    thread_id: &str,
    state: ThreadState,
    channel: Channel,
    commit: Option<&str>,
    now: i64,
) -> Result<(), TrunkError> {
    conn.execute(
        "INSERT INTO thread_history (thread_id, state, channel, commit_oid, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![thread_id, state.as_str(), channel.as_str(), commit, now],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

/// The history of each thread named, oldest first. A thread with no state
/// change has no entry.
///
/// # Errors
///
/// Returns the `SQLite` error when the read fails, and a parse error when a
/// stored state or channel is one this build does not know.
pub fn list_for_threads(
    conn: &Connection,
    thread_ids: &[String],
) -> Result<HashMap<String, Vec<StateChange>>, TrunkError> {
    if thread_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = vec!["?"; thread_ids.len()].join(",");
    let sql = format!(
        "SELECT thread_id, state, channel, commit_oid, created_at FROM thread_history
         WHERE thread_id IN ({placeholders}) ORDER BY created_at, rowid"
    );
    let mut stmt = conn.prepare(&sql).map_err(sqlite_error)?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(thread_ids))
        .map_err(sqlite_error)?;

    let mut by_thread: HashMap<String, Vec<StateChange>> = HashMap::new();
    while let Some(row) = rows.next().map_err(sqlite_error)? {
        let thread_id: String = row.get(0).map_err(sqlite_error)?;
        let state: String = row.get(1).map_err(sqlite_error)?;
        let channel: String = row.get(2).map_err(sqlite_error)?;
        by_thread.entry(thread_id).or_default().push(StateChange {
            state: ThreadState::from_str(&state)?,
            channel: Channel::from_str(&channel)?,
            commit: row.get(3).map_err(sqlite_error)?,
            created_at: row.get(4).map_err(sqlite_error)?,
        });
    }

    Ok(by_thread)
}

/// Every commit a fix claim in the repository names, archived reviews included.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn fix_commits_in_repo(conn: &Connection, repo_path: &Path) -> Result<Vec<String>, TrunkError> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT h.commit_oid FROM thread_history h JOIN threads t ON t.id = h.thread_id
             WHERE t.review_id IN (SELECT id FROM reviews WHERE repo_path = ?1)
               AND h.commit_oid IS NOT NULL",
        )
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map([repo_key(repo_path)], |row| row.get(0))
        .map_err(sqlite_error)?;

    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

/// Point each fix claim in the repository that names the replaced commit at
/// its copy. Returns how many claims changed.
///
/// # Errors
///
/// Returns the `SQLite` error when the write fails.
pub fn replace_fix_commit(
    conn: &Connection,
    repo_path: &Path,
    rewrite: &Rewrite,
) -> Result<usize, TrunkError> {
    conn.execute(
        "UPDATE thread_history SET commit_oid = ?3
         WHERE commit_oid = ?2
           AND thread_id IN (SELECT id FROM threads WHERE review_id IN
               (SELECT id FROM reviews WHERE repo_path = ?1))",
        rusqlite::params![repo_key(repo_path), rewrite.from, rewrite.to],
    )
    .map_err(sqlite_error)
}

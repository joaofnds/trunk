//! The per-repo draft row (D6).
//!
//! A draft has no review foreign key, and that is the whole point: the composer
//! autosaves from the first keystroke while the review is still created at
//! submit, so a cancelled composer strands nothing. Regression 260531-l02c is
//! why this cannot be solved by moving auto-creation back to composer open.

use super::{anchor, repo_key, sqlite_error};
use crate::error::TrunkError;
use crate::git::types::Anchor;
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
pub struct Draft {
    pub text: String,
    pub anchor: Option<Anchor>,
}

/// Store the repo's single draft, replacing whatever was there.
///
/// # Errors
///
/// Returns the `SQLite` error when the write fails.
pub fn save(
    conn: &Connection,
    repo_path: &Path,
    text: &str,
    target: Option<&Anchor>,
    now: i64,
) -> Result<(), TrunkError> {
    let cols = anchor::to_columns(target, None);

    conn.execute(
        &format!(
            "INSERT INTO drafts (repo_path, body, {}, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(repo_path) DO UPDATE SET
                 body = excluded.body,
                 anchor_kind = excluded.anchor_kind,
                 commit_oid = excluded.commit_oid,
                 file_path = excluded.file_path,
                 source = excluded.source,
                 side = excluded.side,
                 start_line = excluded.start_line,
                 end_line = excluded.end_line,
                 updated_at = excluded.updated_at",
            anchor::COLUMNS
        ),
        rusqlite::params![
            repo_key(repo_path),
            text,
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

    Ok(())
}

/// The repo's draft, or `None` when it has none.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn get(conn: &Connection, repo_path: &Path) -> Result<Option<Draft>, TrunkError> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT body, {} FROM drafts WHERE repo_path = ?1",
            anchor::COLUMNS
        ))
        .map_err(sqlite_error)?;
    let mut rows = stmt
        .query_map([repo_key(repo_path)], |row| {
            Ok((row.get::<_, String>(0), anchor::from_row(row, 1)))
        })
        .map_err(sqlite_error)?;

    match rows.next() {
        None => Ok(None),
        Some(row) => {
            let (text, target) = row.map_err(sqlite_error)?;
            let (anchor, _) = target?;
            Ok(Some(Draft {
                text: text.map_err(sqlite_error)?,
                anchor,
            }))
        }
    }
}

/// Discard the repo's draft. A repo with none is not an error.
///
/// # Errors
///
/// Returns the `SQLite` error when the write fails.
pub fn delete(conn: &Connection, repo_path: &Path) -> Result<(), TrunkError> {
    conn.execute(
        "DELETE FROM drafts WHERE repo_path = ?1",
        [repo_key(repo_path)],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

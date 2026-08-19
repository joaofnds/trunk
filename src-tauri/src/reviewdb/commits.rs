//! The per-review commit set.
//!
//! The spec is silent on it, but it drives four shipped surfaces — the graph's
//! Add/Remove-from-review menu, the member-row rail, the panel's commit list and
//! the review doc's Commits section — so it stays, per review (user ruling
//! 2026-08-12).

use super::sqlite_error;
use crate::error::TrunkError;
use rusqlite::Connection;

/// Union `oids` into the review's set, preserving the order they arrive in and
/// leaving anything already there untouched. One statement per oid, one
/// transaction from the caller — never decomposed into N separate gestures.
pub fn seed(conn: &Connection, review_id: &str, oids: &[String]) -> Result<(), TrunkError> {
    let mut next = next_position(conn, review_id)?;

    for oid in oids {
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO review_commits (review_id, oid, position)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![review_id, oid, next],
            )
            .map_err(sqlite_error)?;
        if inserted > 0 {
            next += 1;
        }
    }

    Ok(())
}

/// Add one commit if absent. Idempotent.
pub fn add(conn: &Connection, review_id: &str, oid: &str) -> Result<(), TrunkError> {
    seed(conn, review_id, &[oid.to_string()])
}

/// Remove one commit. A miss is a no-op.
pub fn remove(conn: &Connection, review_id: &str, oid: &str) -> Result<(), TrunkError> {
    conn.execute(
        "DELETE FROM review_commits WHERE review_id = ?1 AND oid = ?2",
        rusqlite::params![review_id, oid],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

pub fn list(conn: &Connection, review_id: &str) -> Result<Vec<String>, TrunkError> {
    let mut stmt = conn
        .prepare("SELECT oid FROM review_commits WHERE review_id = ?1 ORDER BY position")
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map([review_id], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(sqlite_error)?;

    Ok(rows)
}

fn next_position(conn: &Connection, review_id: &str) -> Result<i64, TrunkError> {
    conn.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM review_commits WHERE review_id = ?1",
        [review_id],
        |row| row.get(0),
    )
    .map_err(sqlite_error)
}

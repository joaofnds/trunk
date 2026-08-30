//! The per-review commit set.
//!
//! The spec is silent on it, but it drives four shipped surfaces — the graph's
//! Add/Remove-from-review menu, the member-row rail, the panel's commit list and
//! the review doc's Commits section — so it stays, per review (user ruling
//! 2026-08-12).
//!
//! Each member row stores the commit's subject at add time: the doc renders
//! from stored rows with no repository open (D13), and a snapshot commit that
//! gc later collects keeps the label it was added under (ruling 2026-08-31).

use super::sqlite_error;
use crate::error::TrunkError;
use rusqlite::Connection;

/// One member of the set: the oid plus the subject it was added under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewCommit {
    pub oid: String,
    pub subject: String,
}

/// Union `members` into the review's set, preserving the order they arrive in
/// and leaving anything already there untouched — including its stored
/// subject. One statement per member, one transaction from the caller — never
/// decomposed into N separate gestures.
pub fn seed(
    conn: &Connection,
    review_id: &str,
    members: &[ReviewCommit],
) -> Result<(), TrunkError> {
    let mut next = next_position(conn, review_id)?;

    for member in members {
        let inserted = conn
            .execute(
                "INSERT OR IGNORE INTO review_commits (review_id, oid, position, subject)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![review_id, member.oid, next, member.subject],
            )
            .map_err(sqlite_error)?;
        if inserted > 0 {
            next += 1;
        }
    }

    Ok(())
}

/// Add one commit if absent. Idempotent.
pub fn add(conn: &Connection, review_id: &str, oid: &str, subject: &str) -> Result<(), TrunkError> {
    seed(
        conn,
        review_id,
        &[ReviewCommit {
            oid: oid.to_string(),
            subject: subject.to_string(),
        }],
    )
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

pub fn list(conn: &Connection, review_id: &str) -> Result<Vec<ReviewCommit>, TrunkError> {
    let mut stmt = conn
        .prepare("SELECT oid, subject FROM review_commits WHERE review_id = ?1 ORDER BY position")
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map([review_id], |row| {
            Ok(ReviewCommit {
                oid: row.get(0)?,
                subject: row.get(1)?,
            })
        })
        .map_err(sqlite_error)?
        .collect::<Result<Vec<ReviewCommit>, _>>()
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

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
//! A member a rebase or amend rewrites takes its copy's oid and subject.

use super::{repo_key, sqlite_error};
use rusqlite::Connection;
use std::path::Path;
use trunk_git::error::TrunkError;

/// One member of the set: the oid plus the subject it was added under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewCommit {
    pub oid: String,
    pub subject: String,
}

/// Union `members` into the review's set, preserving the order they arrive in and
/// leaving anything already there untouched — including its stored subject.
///
/// One statement per member, one transaction from the caller — never decomposed into N
/// separate gestures.
///
/// # Errors
///
/// Returns the `SQLite` error when the write fails.
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
///
/// # Errors
///
/// Returns the `SQLite` error when the write fails.
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
///
/// # Errors
///
/// Returns the `SQLite` error when the write fails.
pub fn remove(conn: &Connection, review_id: &str, oid: &str) -> Result<(), TrunkError> {
    conn.execute(
        "DELETE FROM review_commits WHERE review_id = ?1 AND oid = ?2",
        rusqlite::params![review_id, oid],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// The review's commits, in the order they were added.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
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

/// The commits the review's threads sit on, whether or not anyone added them to
/// the set, in the order each one's first thread arrived.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn threaded(conn: &Connection, review_id: &str) -> Result<Vec<String>, TrunkError> {
    let mut stmt = conn
        .prepare(
            "SELECT commit_oid FROM threads
             WHERE review_id = ?1 AND commit_oid IS NOT NULL
             GROUP BY commit_oid
             ORDER BY MIN(created_at), MIN(rowid)",
        )
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map([review_id], |row| row.get(0))
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

/// A commit a rebase or amend replaced, and the copy that replaced it.
pub struct Rewrite {
    pub from: String,
    pub to: String,
    pub subject: String,
}

/// Every commit the repository's commit sets hold, archived reviews included.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn in_repo(conn: &Connection, repo_path: &Path) -> Result<Vec<String>, TrunkError> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT oid FROM review_commits
             WHERE review_id IN (SELECT id FROM reviews WHERE repo_path = ?1)",
        )
        .map_err(sqlite_error)?;
    let rows = stmt
        .query_map([repo_key(repo_path)], |row| row.get(0))
        .map_err(sqlite_error)?;

    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

/// Put the copy in the place of the commit it replaced in each of the
/// repository's commit sets. Returns how many rows changed.
///
/// The member takes the copy's subject. A set that already holds the copy drops
/// the original rather than listing the commit twice.
///
/// # Errors
///
/// Returns the `SQLite` error when a write fails.
pub fn replace_in_repo(
    conn: &Connection,
    repo_path: &Path,
    rewrite: &Rewrite,
) -> Result<usize, TrunkError> {
    let repo = repo_key(repo_path);
    let dropped = conn
        .execute(
            "DELETE FROM review_commits
             WHERE oid = ?2
               AND review_id IN (SELECT id FROM reviews WHERE repo_path = ?1)
               AND review_id IN (SELECT review_id FROM review_commits WHERE oid = ?3)",
            rusqlite::params![repo, rewrite.from, rewrite.to],
        )
        .map_err(sqlite_error)?;
    let replaced = conn
        .execute(
            "UPDATE review_commits SET oid = ?3, subject = ?4
             WHERE oid = ?2
               AND review_id IN (SELECT id FROM reviews WHERE repo_path = ?1)",
            rusqlite::params![repo, rewrite.from, rewrite.to, rewrite.subject],
        )
        .map_err(sqlite_error)?;

    Ok(dropped + replaced)
}

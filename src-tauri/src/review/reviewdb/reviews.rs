//! Reviews: create, list, rename, publish, delete, and the per-repo active
//! pointer.
//!
//! `published` is the only stored state bit. `composing` / `ready` / `settled`
//! are computed in SQL from it plus the thread states, never stored, so no code
//! path can desynchronise them.

use super::ids::{self, IdKind};
use super::{repo_key, sqlite_error};
use crate::error::TrunkError;
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReviewState {
    Composing,
    Ready,
    Settled,
}

#[derive(Debug, Serialize, Clone)]
pub struct Review {
    pub id: String,
    pub title: String,
    pub state: ReviewState,
    pub published: bool,
    pub thread_count: i64,
    pub created_at: i64,
}

/// The derived-state expression. In this milestone every thread is `open`, so a
/// published review is always `ready`; the `settled` arm is written now and
/// first reachable through the UI in milestone 2.
const STATE_SQL: &str = "
    CASE
        WHEN r.published = 0 THEN 'composing'
        WHEN EXISTS (
            SELECT 1 FROM threads t
            WHERE t.review_id = r.id AND t.state IN ('open', 'addressed')
        ) THEN 'ready'
        ELSE 'settled'
    END";

const SELECT: &str = "
    SELECT r.id, r.title, r.published, r.created_at,
           (SELECT COUNT(*) FROM threads t WHERE t.review_id = r.id)";

/// Create a composing review for `repo_path` and return its id.
///
/// # Errors
///
/// Returns the `SQLite` error when minting the id or inserting the row fails.
pub fn create(
    conn: &Connection,
    repo_path: &Path,
    title: Option<&str>,
    now: i64,
) -> Result<String, TrunkError> {
    let id = ids::mint_unique(conn, IdKind::Review)?;
    let title = title.map_or_else(|| default_title(&id, now), ToString::to_string);

    conn.execute(
        "INSERT INTO reviews (id, repo_path, title, published, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?4)",
        rusqlite::params![&id, repo_key(repo_path), &title, now],
    )
    .map_err(sqlite_error)?;

    Ok(id)
}

/// Readable without being clever: the ISO date the review was opened plus its
/// short id, e.g. `Review 2026-08-12 · 3F7K2QAB`.
#[must_use]
pub fn default_title(id: &str, now: i64) -> String {
    format!("Review {} · {}", iso_date(now), id)
}

/// Every review for `repo_path`, oldest first.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn list(conn: &Connection, repo_path: &Path) -> Result<Vec<Review>, TrunkError> {
    let sql = format!(
        "{SELECT}, {STATE_SQL} FROM reviews r WHERE r.repo_path = ?1 ORDER BY r.created_at, r.rowid"
    );
    let mut stmt = conn.prepare(&sql).map_err(sqlite_error)?;
    let rows = stmt
        .query_map([repo_key(repo_path)], read_review)
        .map_err(sqlite_error)?
        .collect::<Result<Vec<Review>, _>>()
        .map_err(sqlite_error)?;

    Ok(rows)
}

/// The review with `id`, or `None` when no review has it.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn get(conn: &Connection, id: &str) -> Result<Option<Review>, TrunkError> {
    let sql = format!("{SELECT}, {STATE_SQL} FROM reviews r WHERE r.id = ?1");
    let mut stmt = conn.prepare(&sql).map_err(sqlite_error)?;
    let mut rows = stmt.query_map([id], read_review).map_err(sqlite_error)?;

    match rows.next() {
        None => Ok(None),
        Some(row) => Ok(Some(row.map_err(sqlite_error)?)),
    }
}

fn read_review(row: &rusqlite::Row) -> rusqlite::Result<Review> {
    let state: String = row.get(5)?;

    Ok(Review {
        id: row.get(0)?,
        title: row.get(1)?,
        published: row.get::<_, i64>(2)? != 0,
        created_at: row.get(3)?,
        thread_count: row.get(4)?,
        state: match state.as_str() {
            "composing" => ReviewState::Composing,
            "ready" => ReviewState::Ready,
            _ => ReviewState::Settled,
        },
    })
}

/// The repo's active review, if it has one.
///
/// The id the repo currently points at, or `None` when it points at nothing.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn active(conn: &Connection, repo_path: &Path) -> Result<Option<String>, TrunkError> {
    let mut stmt = conn
        .prepare("SELECT review_id FROM active_review WHERE repo_path = ?1")
        .map_err(sqlite_error)?;
    let mut rows = stmt
        .query_map([repo_key(repo_path)], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?;

    match rows.next() {
        None => Ok(None),
        Some(row) => Ok(Some(row.map_err(sqlite_error)?)),
    }
}

/// Point the repo at `review_id` without checking that it belongs there.
///
/// # Errors
///
/// Returns the `SQLite` error when the write fails.
pub fn set_active(conn: &Connection, repo_path: &Path, review_id: &str) -> Result<(), TrunkError> {
    conn.execute(
        "INSERT INTO active_review (repo_path, review_id) VALUES (?1, ?2)
         ON CONFLICT(repo_path) DO UPDATE SET review_id = excluded.review_id",
        rusqlite::params![repo_key(repo_path), review_id],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// The active review, creating a fresh composing one when the repo has none.
///
/// This is the whole of the spec's auto-create-at-submit rule: it runs inside the
/// submit transaction, never at composer open.
///
/// # Errors
///
/// Returns the `SQLite` error when reading the pointer, creating the review, or
/// writing the pointer back fails.
pub fn ensure_active(conn: &Connection, repo_path: &Path, now: i64) -> Result<String, TrunkError> {
    if let Some(id) = active(conn, repo_path)? {
        return Ok(id);
    }

    let id = create(conn, repo_path, None, now)?;
    set_active(conn, repo_path, &id)?;

    Ok(id)
}

/// Retitle a review.
///
/// # Errors
///
/// Returns `not_found` when `id` names no review in `repo_path`, and the
/// `SQLite` error when the write fails.
pub fn rename(
    conn: &Connection,
    repo_path: &Path,
    id: &str,
    title: &str,
    now: i64,
) -> Result<(), TrunkError> {
    let changed = conn
        .execute(
            "UPDATE reviews SET title = ?2, updated_at = ?3 WHERE id = ?1 AND repo_path = ?4",
            rusqlite::params![id, title, now, repo_key(repo_path)],
        )
        .map_err(sqlite_error)?;

    if changed == 0 {
        return Err(not_found(id));
    }

    Ok(())
}

/// The repo a review belongs to is part of its address, not just a filter: a
/// command authorized for one repo must not reach a review in another.
fn not_found(id: &str) -> TrunkError {
    TrunkError::new("not_found", format!("no review with id {id}"))
}

fn belongs_to(conn: &Connection, repo_path: &Path, id: &str) -> Result<(), TrunkError> {
    let found: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM reviews WHERE id = ?1 AND repo_path = ?2",
            rusqlite::params![id, repo_key(repo_path)],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;

    if found == 0 {
        return Err(not_found(id));
    }

    Ok(())
}

/// Set the `published` latch. Refuses a review with no threads, adopting the
/// floor that gates doc generation today; publishing cannot be undone, so no
/// unpublish function exists.
///
/// # Errors
///
/// Returns `not_found` when `id` names no review in `repo_path`, `no_threads`
/// when the review has none, and the `SQLite` error when a query or the write
/// fails.
pub fn publish(conn: &Connection, repo_path: &Path, id: &str, now: i64) -> Result<(), TrunkError> {
    // Resolve the review BEFORE counting threads: COUNT over a missing id
    // returns 0, which would report "add a comment first" for a review that is
    // gone.
    belongs_to(conn, repo_path, id)?;

    let threads: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM threads WHERE review_id = ?1",
            [id],
            |row| row.get(0),
        )
        .map_err(sqlite_error)?;

    if threads == 0 {
        return Err(TrunkError::new(
            "no_threads",
            "A review needs at least one thread before it can be published",
        ));
    }

    conn.execute(
        "UPDATE reviews SET published = 1, updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// Delete a review.
///
/// `threads`, `review_commits` and `active_review` all cascade, which is what `PRAGMA
/// foreign_keys = ON` buys — `SQLite` defaults it off, and a cascade that silently does
/// not fire leaves a dangling pointer row.
///
/// # Errors
///
/// Returns the `SQLite` error when the delete fails. Deleting a review that is
/// not there is not an error.
pub fn delete(conn: &Connection, repo_path: &Path, id: &str) -> Result<(), TrunkError> {
    conn.execute(
        "DELETE FROM reviews WHERE id = ?1 AND repo_path = ?2",
        rusqlite::params![id, repo_key(repo_path)],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// Point the repo at `review_id`, refusing an id that belongs to another repo.
///
/// # Errors
///
/// Returns `not_found` when `review_id` belongs to another repo or to none, and
/// the `SQLite` error when a query or the write fails.
pub fn set_active_checked(
    conn: &Connection,
    repo_path: &Path,
    review_id: &str,
) -> Result<(), TrunkError> {
    belongs_to(conn, repo_path, review_id)?;

    set_active(conn, repo_path, review_id)
}

/// The civil date of a unix timestamp, UTC. Hinnant's `civil_from_days`, which
/// is the whole of what the default title needs — not a reason to take a date
/// dependency.
fn iso_date(unix_secs: i64) -> String {
    let days = unix_secs.div_euclid(86_400) + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;

    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);

    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_the_civil_date_of_a_timestamp() {
        assert_eq!(iso_date(1_755_000_000), "2025-08-12");
        assert_eq!(iso_date(0), "1970-01-01");
        assert_eq!(iso_date(951_782_400), "2000-02-29", "a leap day");
    }

    #[test]
    fn the_default_title_carries_the_date_and_the_short_id() {
        assert_eq!(
            default_title("3F7K2QAB", 1_755_000_000),
            "Review 2025-08-12 · 3F7K2QAB",
        );
    }
}

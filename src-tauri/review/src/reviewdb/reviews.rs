//! Reviews: create, list, rename, send the held batch, archive, delete, and the
//! per-repo active pointer.
//!
//! `composing` / `ready` / `settled` and `published` are computed in SQL from
//! the threads, never stored, so no code path can desynchronise them.

use super::ids::{self, IdKind};
use super::{repo_key, sqlite_error};
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;
use trunk_git::error::TrunkError;

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
    /// Whether any thread has been sent, which is what hands the review to
    /// the agent.
    pub published: bool,
    /// Put away by the user: listed apart in the app and unseen by the agent.
    pub archived: bool,
    pub thread_count: i64,
    /// Threads still waiting on someone: open or addressed.
    pub unresolved_count: i64,
    /// Held threads and replies, which the agent receives when the user sends
    /// the batch.
    pub pending_count: i64,
    pub created_at: i64,
}

impl Review {
    /// Whether the agent may read this review through the CLI and watch: a
    /// review it was handed and the user has not put away.
    #[must_use]
    pub const fn is_visible_to_agent(&self) -> bool {
        self.published && !self.archived
    }
}

/// Every column `read_review` reads, in its order. A review is published
/// once any thread is sent, and its state is derived from the thread states.
const SELECT: &str = "
    SELECT r.id, r.title,
           EXISTS (SELECT 1 FROM threads t WHERE t.review_id = r.id AND t.pending = 0),
           r.created_at,
           (SELECT COUNT(*) FROM threads t WHERE t.review_id = r.id),
           (SELECT COUNT(*) FROM threads t
            WHERE t.review_id = r.id AND t.state IN ('open', 'addressed')),
           r.archived,
           (SELECT COUNT(*) FROM threads t WHERE t.review_id = r.id AND t.pending = 1)
             + (SELECT COUNT(*) FROM replies p JOIN threads t ON t.id = p.thread_id
                WHERE t.review_id = r.id AND p.pending = 1),
           CASE
               WHEN NOT EXISTS (
                   SELECT 1 FROM threads t WHERE t.review_id = r.id AND t.pending = 0
               ) THEN 'composing'
               WHEN EXISTS (
                   SELECT 1 FROM threads t
                   WHERE t.review_id = r.id AND t.pending = 0
                     AND t.state IN ('open', 'addressed')
               ) THEN 'ready'
               ELSE 'settled'
           END";

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
    let title = title.map_or_else(|| default_title(now), ToString::to_string);

    conn.execute(
        "INSERT INTO reviews (id, repo_path, title, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![&id, repo_key(repo_path), &title, now],
    )
    .map_err(sqlite_error)?;

    Ok(id)
}

/// The ISO date the review was opened, e.g. `Review 2026-08-12`. The short id
/// stays out of it, since every place that shows a title prints the id beside it.
#[must_use]
pub fn default_title(now: i64) -> String {
    format!("Review {}", iso_date(now))
}

/// Every review for `repo_path`, oldest first.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn list(conn: &Connection, repo_path: &Path) -> Result<Vec<Review>, TrunkError> {
    let sql =
        format!("{SELECT} FROM reviews r WHERE r.repo_path = ?1 ORDER BY r.created_at, r.rowid");
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
    let sql = format!("{SELECT} FROM reviews r WHERE r.id = ?1");
    let mut stmt = conn.prepare(&sql).map_err(sqlite_error)?;
    let mut rows = stmt.query_map([id], read_review).map_err(sqlite_error)?;

    match rows.next() {
        None => Ok(None),
        Some(row) => Ok(Some(row.map_err(sqlite_error)?)),
    }
}

fn read_review(row: &rusqlite::Row) -> rusqlite::Result<Review> {
    let state: String = row.get(8)?;

    Ok(Review {
        id: row.get(0)?,
        title: row.get(1)?,
        published: row.get::<_, i64>(2)? != 0,
        created_at: row.get(3)?,
        thread_count: row.get(4)?,
        unresolved_count: row.get(5)?,
        archived: row.get::<_, i64>(6)? != 0,
        pending_count: row.get(7)?,
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

/// The review a read asked for by id, or the active one when it named none.
///
/// # Errors
///
/// Returns `not_found` when `requested` names a review outside `repo_path`, and
/// the `SQLite` error when a query fails.
pub fn requested_or_active(
    conn: &Connection,
    repo_path: &Path,
    requested: Option<&str>,
) -> Result<Option<String>, TrunkError> {
    let Some(id) = requested else {
        return active(conn, repo_path);
    };

    belongs_to(conn, repo_path, id)?;

    Ok(Some(id.to_string()))
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

/// Hand every held thread and reply in the review to the agent.
///
/// # Errors
///
/// Returns `not_found` when `id` names no review in `repo_path`, and the
/// `SQLite` error when a write fails.
pub fn send_batch(
    conn: &Connection,
    repo_path: &Path,
    id: &str,
    now: i64,
) -> Result<(), TrunkError> {
    belongs_to(conn, repo_path, id)?;

    conn.execute(
        "UPDATE replies SET pending = 0
         WHERE pending = 1 AND thread_id IN (SELECT id FROM threads WHERE review_id = ?1)",
        [id],
    )
    .map_err(sqlite_error)?;
    conn.execute(
        "UPDATE threads SET pending = 0 WHERE pending = 1 AND review_id = ?1",
        [id],
    )
    .map_err(sqlite_error)?;
    conn.execute(
        "UPDATE reviews SET updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// Whether the review holds a batch, which a comment submitted to send joins
/// rather than overtaking.
///
/// # Errors
///
/// Returns the `SQLite` error when the query fails.
pub fn holds_batch(conn: &Connection, id: &str) -> Result<bool, TrunkError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM threads WHERE review_id = ?1 AND pending = 1)
             OR EXISTS (SELECT 1 FROM replies p JOIN threads t ON t.id = p.thread_id
                        WHERE t.review_id = ?1 AND p.pending = 1)",
        [id],
        |row| row.get(0),
    )
    .map_err(sqlite_error)
}

/// Put a review away. Archiving the active review clears the repo's pointer,
/// so the next comment opens a fresh review rather than landing in one the
/// user put away.
///
/// # Errors
///
/// Returns `not_found` when `id` names no review in `repo_path`, and the
/// `SQLite` error when a query or the write fails.
pub fn archive(conn: &Connection, repo_path: &Path, id: &str, now: i64) -> Result<(), TrunkError> {
    set_archived(conn, repo_path, id, true, now)?;

    conn.execute(
        "DELETE FROM active_review WHERE repo_path = ?1 AND review_id = ?2",
        rusqlite::params![repo_key(repo_path), id],
    )
    .map_err(sqlite_error)?;

    Ok(())
}

/// Bring an archived review back as it was.
///
/// # Errors
///
/// Returns `not_found` when `id` names no review in `repo_path`, and the
/// `SQLite` error when a query or the write fails.
pub fn unarchive(
    conn: &Connection,
    repo_path: &Path,
    id: &str,
    now: i64,
) -> Result<(), TrunkError> {
    set_archived(conn, repo_path, id, false, now)
}

fn set_archived(
    conn: &Connection,
    repo_path: &Path,
    id: &str,
    archived: bool,
    now: i64,
) -> Result<(), TrunkError> {
    belongs_to(conn, repo_path, id)?;

    conn.execute(
        "UPDATE reviews SET archived = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, archived, now],
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

/// Point the repo at `review_id`, refusing an id that belongs to another repo
/// and a review the user archived, since new comments land in the active one.
///
/// # Errors
///
/// Returns `not_found` when `review_id` belongs to another repo or to none,
/// `archived` when the review is archived, and the `SQLite` error when a query
/// or the write fails.
pub fn set_active_checked(
    conn: &Connection,
    repo_path: &Path,
    review_id: &str,
) -> Result<(), TrunkError> {
    belongs_to(conn, repo_path, review_id)?;
    if get(conn, review_id)?.is_some_and(|review| review.archived) {
        return Err(TrunkError::new(
            "archived",
            "Unarchive this review before making it active",
        ));
    }

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
    fn the_default_title_carries_the_date_alone() {
        assert_eq!(default_title(1_755_000_000), "Review 2025-08-12");
    }
}

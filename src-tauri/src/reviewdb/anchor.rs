//! Mapping between an in-memory `Anchor` and the anchor columns `threads` and
//! `drafts` share.
//!
//! Two shapes exist today and both persist as one column set: a diff-anchored
//! thread carries the full `Anchor`, a commit-level note carries only a
//! `commit_oid`. `anchor_kind` is what tells them apart, and milestone 4 adds
//! `'current_file'` to it.

use crate::error::TrunkError;
use crate::git::types::{Anchor, Side, Source};
use rusqlite::Row;

pub const DIFF: &str = "diff";
pub const COMMIT: &str = "commit";
pub const NONE: &str = "none";

/// The anchor columns, ready to bind.
pub struct Columns {
    pub kind: &'static str,
    pub commit_oid: Option<String>,
    pub file_path: Option<String>,
    pub source: Option<&'static str>,
    pub side: Option<&'static str>,
    pub start_line: Option<i64>,
    pub end_line: Option<i64>,
}

#[must_use]
pub fn to_columns(anchor: Option<&Anchor>, commit_oid: Option<&str>) -> Columns {
    match (anchor, commit_oid) {
        (Some(a), _) => Columns {
            kind: DIFF,
            commit_oid: Some(a.commit_oid.clone()),
            file_path: Some(a.file_path.clone()),
            source: Some(source_str(&a.source)),
            side: Some(side_str(&a.side)),
            start_line: Some(i64::from(a.start_line)),
            end_line: Some(i64::from(a.end_line)),
        },
        (None, Some(oid)) => Columns {
            kind: COMMIT,
            commit_oid: Some(oid.to_string()),
            file_path: None,
            source: None,
            side: None,
            start_line: None,
            end_line: None,
        },
        (None, None) => Columns {
            kind: NONE,
            commit_oid: None,
            file_path: None,
            source: None,
            side: None,
            start_line: None,
            end_line: None,
        },
    }
}

/// Read the anchor columns back, given the index of `anchor_kind` and the six
/// columns following it in the same order `to_columns` writes them.
///
/// # Errors
///
/// Returns `store` when the row's anchor columns do not describe an anchor
/// this build knows, and the `SQLite` error when a column will not read.
pub fn from_row(row: &Row, first: usize) -> Result<(Option<Anchor>, Option<String>), TrunkError> {
    let kind: String = row.get(first).map_err(super::sqlite_error)?;
    let commit_oid: Option<String> = row.get(first + 1).map_err(super::sqlite_error)?;

    if kind != DIFF {
        return Ok((None, commit_oid));
    }

    let anchor = Anchor {
        commit_oid: commit_oid.ok_or_else(|| bad_row("a diff anchor with no commit_oid"))?,
        file_path: row.get(first + 2).map_err(super::sqlite_error)?,
        source: source_from(
            &row.get::<_, String>(first + 3)
                .map_err(super::sqlite_error)?,
        )?,
        side: side_from(
            &row.get::<_, String>(first + 4)
                .map_err(super::sqlite_error)?,
        )?,
        start_line: line_number(row, first + 5)?,
        end_line: line_number(row, first + 6)?,
    };

    Ok((Some(anchor), None))
}

/// The anchor column names, in the order `to_columns` and `from_row` agree on.
pub const COLUMNS: &str = "anchor_kind, commit_oid, file_path, source, side, start_line, end_line";

const fn source_str(source: &Source) -> &'static str {
    match source {
        Source::Diff => "Diff",
        Source::FullFile => "FullFile",
    }
}

fn source_from(raw: &str) -> Result<Source, TrunkError> {
    match raw {
        "Diff" => Ok(Source::Diff),
        "FullFile" => Ok(Source::FullFile),
        other => Err(bad_row(&format!("unknown anchor source {other:?}"))),
    }
}

const fn side_str(side: &Side) -> &'static str {
    match side {
        Side::Old => "Old",
        Side::New => "New",
    }
}

fn side_from(raw: &str) -> Result<Side, TrunkError> {
    match raw {
        "Old" => Ok(Side::Old),
        "New" => Ok(Side::New),
        other => Err(bad_row(&format!("unknown anchor side {other:?}"))),
    }
}

/// A stored line number, refusing a value no line number can hold rather than
/// wrapping it into one.
fn line_number(row: &Row, column: usize) -> Result<u32, TrunkError> {
    let stored: i64 = row.get(column).map_err(super::sqlite_error)?;

    u32::try_from(stored).map_err(|_| bad_row(&format!("line number out of range: {stored}")))
}

/// A stored row this module could not have written. Failing beats defaulting:
/// an unrecognised `side` silently read as `New` renders a real comment against
/// the wrong side of the diff, with nothing anomalous on screen.
fn bad_row(what: &str) -> TrunkError {
    TrunkError::new("store", format!("corrupt anchor row: {what}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn an_anchor() -> Anchor {
        Anchor {
            commit_oid: "abc".to_string(),
            file_path: "src/a.rs".to_string(),
            source: Source::FullFile,
            side: Side::Old,
            start_line: 3,
            end_line: 9,
        }
    }

    #[test]
    fn a_diff_anchor_maps_every_field_onto_a_column() {
        let cols = to_columns(Some(&an_anchor()), None);

        assert_eq!(cols.kind, DIFF);
        assert_eq!(cols.commit_oid.as_deref(), Some("abc"));
        assert_eq!(cols.file_path.as_deref(), Some("src/a.rs"));
        assert_eq!(cols.source, Some("FullFile"));
        assert_eq!(cols.side, Some("Old"));
        assert_eq!(cols.start_line, Some(3));
        assert_eq!(cols.end_line, Some(9));
    }

    #[test]
    fn a_commit_note_keeps_its_oid_and_no_line_range() {
        let cols = to_columns(None, Some("deadbeef"));

        assert_eq!(cols.kind, COMMIT);
        assert_eq!(cols.commit_oid.as_deref(), Some("deadbeef"));
        assert_eq!(
            (cols.file_path, cols.start_line),
            (None, None),
            "a commit-level note has no code anchor",
        );
    }

    #[test]
    fn an_unanchored_body_maps_to_the_none_kind() {
        assert_eq!(to_columns(None, None).kind, NONE);
    }

    /// Reads one anchor row back through `from_row`, with `start_line` set to
    /// `stored`. The columns are laid out as `from_row` expects them, starting
    /// at index 0.
    fn read_back(stored: i64) -> Result<(Option<Anchor>, Option<String>), TrunkError> {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE a (kind TEXT, commit_oid TEXT, file_path TEXT, source TEXT,
                             side TEXT, start_line INTEGER, end_line INTEGER);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO a VALUES ('diff', 'abc', 'src/a.rs', 'FullFile', 'Old', ?1, 9)",
            [stored],
        )
        .unwrap();

        conn.query_row("SELECT * FROM a", [], |row| Ok(from_row(row, 0)))
            .unwrap()
    }

    #[test]
    fn a_line_number_that_fits_reads_back_unchanged() {
        let (anchor, _) = read_back(3).expect("a line number in range reads back");

        assert_eq!(anchor.expect("a diff anchor").start_line, 3);
    }

    /// Without the range check this wrapped: `4_294_967_299` truncates to 3, so
    /// a corrupt row rendered a comment against a plausible-looking line rather
    /// than reporting itself.
    #[test]
    fn a_line_number_too_large_for_a_line_number_is_a_corrupt_row() {
        let err = read_back(i64::from(u32::MAX) + 4).expect_err("out of range is refused");

        assert_eq!(err.code, "store");
    }

    #[test]
    fn a_negative_line_number_is_a_corrupt_row() {
        let err = read_back(-1).expect_err("a negative line number is refused");

        assert_eq!(err.code, "store");
    }
}

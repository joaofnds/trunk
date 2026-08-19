//! Short ids: 8-char random Crockford base32, uppercase-canonical, resolved by
//! unambiguous prefix (D12). One scheme for reviews and threads.

use super::{Store, sqlite_error};
use crate::error::TrunkError;
use rusqlite::Connection;

/// Crockford base32: the digits plus the letters, minus `I`, `L`, `O` and `U`.
/// `I`/`L` read as `1` and `O` as `0`, which is what `normalize` folds; `U` is
/// out so no id spells an English obscenity.
const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub const ID_LEN: usize = 8;

/// Which table a prefix is resolved against. One id scheme, three populations.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IdKind {
    Review,
    Thread,
    Reply,
}

impl IdKind {
    fn table(self) -> &'static str {
        match self {
            IdKind::Review => "reviews",
            IdKind::Thread => "threads",
            IdKind::Reply => "replies",
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum ResolveError {
    NotFound,
    Ambiguous(Vec<String>),
    Store(TrunkError),
}

impl From<ResolveError> for TrunkError {
    fn from(e: ResolveError) -> Self {
        match e {
            ResolveError::NotFound => TrunkError::new("not_found", "No such id"),
            ResolveError::Ambiguous(matches) => TrunkError::new(
                "ambiguous_id",
                format!(
                    "Prefix matches {} ids: {}",
                    matches.len(),
                    matches.join(", ")
                ),
            ),
            ResolveError::Store(e) => e,
        }
    }
}

/// A fresh random id. Sampled from the OS, not a seeded PRNG: ids are addresses
/// a user types, and a predictable stream would collide across processes.
pub fn mint() -> String {
    let mut bytes = [0u8; ID_LEN];
    getrandom::fill(&mut bytes).expect("the OS random source must be available");

    bytes
        .iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect()
}

/// Fold a typed or pasted id to its canonical form: uppercase, with the glyphs
/// Crockford treats as confusable mapped onto the digits they resemble.
pub fn normalize(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        })
        .collect()
}

/// Mint an id that is free in `kind`'s table, regenerating on conflict.
pub fn mint_unique(conn: &Connection, kind: IdKind) -> Result<String, TrunkError> {
    mint_unique_with(conn, kind, mint)
}

/// The seam `mint_unique` is built on: `next` supplies candidates so a test can
/// force the conflict a random source reaches once in 32^8 tries.
pub fn mint_unique_with(
    conn: &Connection,
    kind: IdKind,
    mut next: impl FnMut() -> String,
) -> Result<String, TrunkError> {
    let sql = format!("SELECT 1 FROM {} WHERE id = ?1", kind.table());

    loop {
        let candidate = next();
        let taken = conn
            .query_row(&sql, [&candidate], |_| Ok(()))
            .optional_row()?;
        if !taken {
            return Ok(candidate);
        }
    }
}

/// git-style prefix addressing: an exact id wins outright, otherwise the prefix
/// must match exactly one row.
pub fn resolve_prefix(store: &Store, kind: IdKind, raw: &str) -> Result<String, ResolveError> {
    let needle = normalize(raw);
    // The needle reaches `LIKE ?1 || '%'`, where `%` and `_` are wildcards. A
    // minted id can only hold alphabet characters, so refusing everything else
    // removes the wildcard class rather than escaping it.
    if needle.is_empty() || !needle.bytes().all(|b| ALPHABET.contains(&b)) {
        return Err(ResolveError::NotFound);
    }

    let matches = store
        .read(|conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT id FROM {} WHERE id LIKE ?1 || '%' ORDER BY id",
                    kind.table()
                ))
                .map_err(sqlite_error)?;
            let rows = stmt
                .query_map([&needle], |row| row.get::<_, String>(0))
                .map_err(sqlite_error)?
                .collect::<Result<Vec<String>, _>>()
                .map_err(sqlite_error)?;
            Ok(rows)
        })
        .map_err(ResolveError::Store)?;

    match matches.len() {
        0 => Err(ResolveError::NotFound),
        1 => Ok(matches.into_iter().next().unwrap()),
        _ => Err(ResolveError::Ambiguous(matches)),
    }
}

/// `query_row` returns `QueryReturnedNoRows` for a miss; this reads that as
/// "absent" and leaves every other failure an error.
trait OptionalRow {
    fn optional_row(self) -> Result<bool, TrunkError>;
}

impl OptionalRow for Result<(), rusqlite::Error> {
    fn optional_row(self) -> Result<bool, TrunkError> {
        match self {
            Ok(()) => Ok(true),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(sqlite_error(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use tempfile::TempDir;

    fn store_with_reviews(ids: &[&str]) -> (TempDir, Store) {
        let dir = TempDir::new().unwrap();
        let store = super::super::open(dir.path()).unwrap();
        store
            .write(|tx| {
                for id in ids {
                    tx.execute(
                        "INSERT INTO reviews (id, repo_path, title, published, created_at, updated_at)
                         VALUES (?1, '/repo', 't', 0, 0, 0)",
                        [id],
                    )
                    .map_err(sqlite_error)?;
                }
                Ok(())
            })
            .unwrap();
        (dir, store)
    }

    #[test]
    fn normalizes_crockford_confusables() {
        assert_eq!(normalize("il o"), "110");
        assert_eq!(normalize("3f7k2qab"), "3F7K2QAB");
        assert_eq!(normalize("  3f7k-2qab  "), "3F7K2QAB");
    }

    #[test]
    fn mints_ids_of_the_declared_length_from_the_alphabet() {
        let id = mint();

        assert_eq!(id.len(), ID_LEN);
        assert!(
            id.bytes().all(|b| ALPHABET.contains(&b)),
            "every character must be in the Crockford alphabet, got {id}",
        );
        assert_eq!(
            normalize(&id),
            id,
            "a minted id must already be in canonical form",
        );
    }

    #[test]
    fn ten_thousand_mints_produce_no_duplicate() {
        let minted: HashSet<String> = (0..10_000).map(|_| mint()).collect();

        assert_eq!(minted.len(), 10_000, "a duplicate id was minted");
    }

    #[test]
    fn regenerates_on_unique_conflict() {
        let (_dir, store) = store_with_reviews(&["TAKENID1"]);
        let mut candidates = ["TAKENID1", "TAKENID1", "FREEID22"].into_iter();

        let id = store
            .read(|conn| {
                mint_unique_with(conn, IdKind::Review, || {
                    candidates.next().unwrap().to_string()
                })
            })
            .unwrap();

        assert_eq!(
            id, "FREEID22",
            "a candidate already in the table must be discarded, not returned",
        );
    }

    #[test]
    fn an_unambiguous_prefix_resolves_to_the_full_id() {
        let (_dir, store) = store_with_reviews(&["3F7K2QAB", "9WXYZ123"]);

        assert_eq!(
            resolve_prefix(&store, IdKind::Review, "3f7").unwrap(),
            "3F7K2QAB",
            "a prefix is typed casually and folds to canonical before matching",
        );
    }

    #[test]
    fn prefix_resolution_reports_ambiguity() {
        let (_dir, store) = store_with_reviews(&["3F7K2QAB", "3F7ZZZZZ"]);

        let err = resolve_prefix(&store, IdKind::Review, "3F7").unwrap_err();

        assert_eq!(
            err,
            ResolveError::Ambiguous(vec!["3F7K2QAB".to_string(), "3F7ZZZZZ".to_string()]),
            "an ambiguous prefix must name the candidates, never pick one",
        );
    }

    #[test]
    fn prefix_resolution_reports_a_miss_apart_from_ambiguity() {
        let (_dir, store) = store_with_reviews(&["3F7K2QAB"]);

        assert_eq!(
            resolve_prefix(&store, IdKind::Review, "ZZZ").unwrap_err(),
            ResolveError::NotFound,
        );
        assert_eq!(
            resolve_prefix(&store, IdKind::Review, "").unwrap_err(),
            ResolveError::NotFound,
            "an empty prefix must not match every row",
        );
    }

    #[test]
    fn threads_and_reviews_resolve_against_their_own_population() {
        let (_dir, store) = store_with_reviews(&["3F7K2QAB"]);

        assert_eq!(
            resolve_prefix(&store, IdKind::Thread, "3F7").unwrap_err(),
            ResolveError::NotFound,
            "a review id must not resolve as a thread id",
        );
    }
}

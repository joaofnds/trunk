//! Repository discovery and id resolution for the review verbs: finding the
//! canonical repo root the store keys by, and resolving a user-typed id
//! against the published rows the CLI may serve (§5.1).

use crate::error::TrunkError;
use std::path::PathBuf;

/// The renderer's two path facts, derived from the canonical workdir the
/// store keys by. Deriving them at each render site let the CLI's answer for
/// one thread disagree with its answer for the whole document, which is the
/// one thing the `thread` verb exists to rule out.
pub(crate) struct RepoPaths {
    pub workdir: Option<PathBuf>,
    pub repo_dir: PathBuf,
}

impl RepoPaths {
    /// `discover_repo` rejects a bare repository before any render, so the
    /// workdir the CLI renders against is always present.
    pub(crate) fn of(canonical: &std::path::Path) -> Self {
        Self {
            workdir: Some(canonical.to_path_buf()),
            repo_dir: canonical.join(".git"),
        }
    }
}

/// The canonical repo path the store keys by: `--repo` or the working
/// directory, resolved to the repo's workdir root through the same
/// `std::fs::canonicalize` the app uses. A symlinked or subdirectory
/// invocation must land on the app's exact key.
pub(crate) fn discover_repo(repo: Option<PathBuf>) -> Result<PathBuf, TrunkError> {
    let start = match repo {
        Some(path) => path,
        None => std::env::current_dir().map_err(|e| TrunkError::new("io", e.to_string()))?,
    };

    let discovered = git2::Repository::discover(&start)?;
    let workdir = discovered
        .workdir()
        .ok_or_else(|| TrunkError::new("bare_repo", "bare repositories hold no reviews"))?;

    std::fs::canonicalize(workdir).map_err(|e| TrunkError::new("io", e.to_string()))
}

/// Resolve `raw` against this repo's published-review *threads*, with the
/// same exact-or-unique-prefix rule and the same no-leak posture as
/// `published_review`: a composing review's thread answers as missing.
pub(crate) fn published_thread(
    store: &crate::reviewdb::Store,
    canonical: &std::path::Path,
    raw: &str,
) -> Result<crate::reviewdb::threads::Thread, TrunkError> {
    use crate::reviewdb::threads;

    let candidates: Vec<threads::Thread> = store.read(|conn| {
        let mut all = Vec::new();
        for review in crate::reviewdb::reviews::list(conn, canonical)? {
            if review.published {
                all.extend(threads::list_for_review(conn, &review.id)?);
            }
        }
        Ok(all)
    })?;

    resolve_unique(candidates, |t| &t.id, raw, "thread")
}

/// Resolve `raw` against this repo's *published* reviews only: exact id, or a
/// prefix matching exactly one. Anything else — missing, composing,
/// another repo's — answers with one identical `not_found`, and ambiguity is
/// judged after the published filter, so an unpublished review's existence
/// never leaks, not even through a prefix collision (§5.1).
pub(crate) fn published_review(
    store: &crate::reviewdb::Store,
    canonical: &std::path::Path,
    raw: &str,
) -> Result<crate::reviewdb::reviews::Review, TrunkError> {
    let published: Vec<crate::reviewdb::reviews::Review> = store
        .read(|conn| crate::reviewdb::reviews::list(conn, canonical))?
        .into_iter()
        .filter(|r| r.published)
        .collect();

    resolve_unique(published, |r| &r.id, raw, "review")
}

/// Exact id, or a prefix matching exactly one candidate (Crockford
/// normalization, like the app's `ids::resolve_prefix`). The candidate list
/// is already scoped and filtered by the caller, so ambiguity and misses are
/// judged only over what the CLI may serve — that scoping is what keeps an
/// unpublished review from leaking even through a prefix collision.
pub(crate) fn resolve_unique<T>(
    candidates: Vec<T>,
    id_of: impl Fn(&T) -> &str,
    raw: &str,
    noun: &str,
) -> Result<T, TrunkError> {
    let needle = crate::reviewdb::ids::normalize(raw);

    let mut matches: Vec<T> = candidates
        .into_iter()
        .filter(|c| !needle.is_empty() && id_of(c).starts_with(&needle))
        .collect();
    if let Some(exact) = matches.iter().position(|c| id_of(c) == needle) {
        return Ok(matches.swap_remove(exact));
    }

    match matches.len() {
        1 => Ok(matches.pop().expect("len checked")),
        0 => Err(TrunkError::new(
            "not_found",
            format!("no {noun} with id {raw}"),
        )),
        _ => Err(TrunkError::new(
            "ambiguous_id",
            format!(
                "id `{raw}` matches {}",
                matches
                    .iter()
                    .map(|c| id_of(c).to_string())
                    .collect::<Vec<_>>()
                    .join(" and ")
            ),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::TrunkError;

    fn resolve(candidates: &[&str], raw: &str) -> Result<String, TrunkError> {
        let owned: Vec<String> = candidates.iter().map(|s| (*s).to_string()).collect();
        resolve_unique(owned, |s| s.as_str(), raw, "review")
    }

    #[test]
    fn an_id_resolves_from_an_unambiguous_prefix() {
        assert_eq!(
            resolve(&["3F7K2QAB", "9XJ4M1TT"], "3F7").unwrap(),
            "3F7K2QAB"
        );
    }

    #[test]
    fn an_exact_id_wins_over_a_longer_candidate_it_prefixes() {
        // `3F7K` is a whole id AND a prefix of `3F7K2QAB`. Without the exact
        // check the pair reads as ambiguous and neither resolves.
        assert_eq!(resolve(&["3F7K2QAB", "3F7K"], "3F7K").unwrap(), "3F7K");
    }

    #[test]
    fn a_prefix_matching_two_candidates_is_ambiguous_not_a_silent_pick() {
        // Ambiguity is judged after the caller's published filter, so this
        // arm is what stops a colliding prefix from resolving to whichever
        // row the store happened to return first.
        let err = resolve(&["3F7K2QAB", "3F7K9ZZZ"], "3F7").unwrap_err();

        assert_eq!(err.code, "ambiguous_id");
        assert!(
            err.message.contains("3F7K2QAB") && err.message.contains("3F7K9ZZZ"),
            "the error must name both candidates, got {:?}",
            err.message,
        );
    }

    #[test]
    fn a_prefix_matching_nothing_is_not_found() {
        assert_eq!(resolve(&["3F7K2QAB"], "ZZZ").unwrap_err().code, "not_found",);
    }

    #[test]
    fn an_empty_id_matches_nothing_rather_than_everything() {
        // Every id starts with "", so without the emptiness guard a bare
        // prefix would resolve to the only review a repo has.
        assert_eq!(resolve(&["3F7K2QAB"], "").unwrap_err().code, "not_found");
    }
}

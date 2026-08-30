//! The four review verbs (§5.1). Parsing is hand-rolled over the argv slice:
//! four verbs, at most two positionals and one flag, and the parse function is
//! a pure unit under test.
//!
//! The CLI reads the store, never the repository — repo *discovery* may touch
//! the filesystem to find and canonicalize the repo root, rendering may not
//! (D13). Discovery must canonicalize exactly like the app
//! (`std::fs::canonicalize`) or the `repo_path` keys miss.

use crate::error::TrunkError;
use crate::reviewdb::{self, reviews};
use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq)]
pub enum ReviewCmd {
    List {
        repo: Option<PathBuf>,
    },
    Show {
        id: String,
        repo: Option<PathBuf>,
    },
    Reply {
        id: String,
        text: ReplyText,
        repo: Option<PathBuf>,
    },
    Address {
        id: String,
        repo: Option<PathBuf>,
    },
}

/// Where the reply body comes from: an argv word, or stdin for multi-line
/// text an agent pipes in.
#[derive(Debug, PartialEq, Eq)]
pub enum ReplyText {
    Inline(String),
    Stdin,
}

/// Parse the argv slice after `trunk review`. Errors are the usage line the
/// caller prints to stderr.
pub fn parse(args: &[String]) -> Result<ReviewCmd, String> {
    let mut words = args.iter().map(String::as_str);
    let verb = words.next().ok_or_else(usage)?;
    let rest: Vec<&str> = words.collect();

    match verb {
        "list" => {
            let repo = take_repo_flag(&rest)?;
            Ok(ReviewCmd::List { repo })
        }
        "show" => {
            let [id, rest @ ..] = rest.as_slice() else {
                return Err(format!("show needs a review id\n{}", usage()));
            };
            let repo = take_repo_flag(rest)?;
            Ok(ReviewCmd::Show {
                id: (*id).to_string(),
                repo,
            })
        }
        "reply" => {
            let (id, text, rest) = match rest.as_slice() {
                [id, "--stdin", rest @ ..] => (id, ReplyText::Stdin, rest),
                [id, text, rest @ ..] if !text.starts_with("--") => {
                    (id, ReplyText::Inline((*text).to_string()), rest)
                }
                _ => {
                    return Err(format!(
                        "reply needs a thread id and text (or --stdin)\n{}",
                        usage()
                    ));
                }
            };
            let repo = take_repo_flag(rest)?;
            Ok(ReviewCmd::Reply {
                id: (*id).to_string(),
                text,
                repo,
            })
        }
        "address" => {
            let [id, rest @ ..] = rest.as_slice() else {
                return Err(format!("address needs a thread id\n{}", usage()));
            };
            let repo = take_repo_flag(rest)?;
            Ok(ReviewCmd::Address {
                id: (*id).to_string(),
                repo,
            })
        }
        other => Err(format!("unknown verb `{other}`\n{}", usage())),
    }
}

/// `[--repo <path>]` and nothing else.
fn take_repo_flag(rest: &[&str]) -> Result<Option<PathBuf>, String> {
    match rest {
        [] => Ok(None),
        ["--repo", path] => Ok(Some(PathBuf::from(path))),
        ["--repo"] => Err(format!("--repo needs a path\n{}", usage())),
        other => Err(format!("unexpected arguments {other:?}\n{}", usage())),
    }
}

fn usage() -> String {
    "usage: trunk review <list|show|reply|address> [--repo <path>]".to_string()
}

/// Run a parsed command against the store the compiled-in identifier names.
/// Output is markdown on stdout; errors go to stderr with a nonzero exit and
/// no partial write (§5.1).
pub fn run(cmd: ReviewCmd, identifier: &str) -> Result<String, TrunkError> {
    let store = reviewdb::open(&reviewdb::data_dir_for(identifier))?;

    match cmd {
        ReviewCmd::List { repo } => {
            let canonical = discover_repo(repo)?;
            let listed = store.read(|conn| reviews::list(conn, &canonical))?;

            Ok(render_list(&listed))
        }
        ReviewCmd::Show { id, repo } => {
            let canonical = discover_repo(repo)?;
            let review = published_review(&store, &canonical, &id)?;

            crate::commands::review::render_review_doc(
                &store,
                &canonical,
                &review.id,
                Some(canonical.clone()),
                canonical.join(".git"),
            )
        }
        ReviewCmd::Reply { id, text, repo } => {
            let canonical = discover_repo(repo)?;
            let thread = published_thread(&store, &canonical, &id)?;

            let body = match text {
                ReplyText::Inline(s) => s,
                ReplyText::Stdin => {
                    use std::io::Read;
                    let mut buf = String::new();
                    std::io::stdin()
                        .read_to_string(&mut buf)
                        .map_err(|e| TrunkError::new("io", e.to_string()))?;
                    buf
                }
            };
            if body.trim().is_empty() {
                return Err(TrunkError::new("bad_request", "reply text is empty"));
            }

            let now = reviewdb::now_secs();
            let reply_id = store.write(|tx| {
                reviewdb::replies::add(
                    tx,
                    &canonical,
                    &thread.id,
                    &body,
                    crate::review_types::Channel::Agent,
                    now,
                )
            })?;

            Ok(format!("replied to {} as agent ({reply_id})\n", thread.id))
        }
        ReviewCmd::Address { id, repo } => {
            let canonical = discover_repo(repo)?;
            let thread = published_thread(&store, &canonical, &id)?;

            // `set_state` runs `ThreadState::transition` with the agent
            // channel — the one matrix, never re-derived here (TRUNK-17). An
            // illegal claim fails naming the current state and writes nothing.
            let now = reviewdb::now_secs();
            store.write(|tx| {
                reviewdb::threads::set_state(
                    tx,
                    &canonical,
                    &thread.id,
                    crate::review_types::ThreadState::Addressed,
                    crate::review_types::Channel::Agent,
                    now,
                )
            })?;

            Ok(format!("{} claimed as addressed\n", thread.id))
        }
    }
}

/// Resolve `raw` against this repo's published-review *threads*, with the
/// same exact-or-unique-prefix rule and the same no-leak posture as
/// `published_review`: a composing review's thread answers as missing.
fn published_thread(
    store: &reviewdb::Store,
    canonical: &std::path::Path,
    raw: &str,
) -> Result<crate::reviewdb::threads::Thread, TrunkError> {
    use crate::reviewdb::threads;

    let candidates: Vec<threads::Thread> = store.read(|conn| {
        let mut all = Vec::new();
        for review in reviews::list(conn, canonical)? {
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
fn published_review(
    store: &reviewdb::Store,
    canonical: &std::path::Path,
    raw: &str,
) -> Result<reviews::Review, TrunkError> {
    let published: Vec<reviews::Review> = store
        .read(|conn| reviews::list(conn, canonical))?
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
fn resolve_unique<T>(
    candidates: Vec<T>,
    id_of: impl Fn(&T) -> &str,
    raw: &str,
    noun: &str,
) -> Result<T, TrunkError> {
    let needle = reviewdb::ids::normalize(raw);

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

/// The canonical repo path the store keys by: `--repo` or the working
/// directory, resolved to the repo's workdir root through the same
/// `std::fs::canonicalize` the app uses. A symlinked or subdirectory
/// invocation must land on the app's exact key.
fn discover_repo(repo: Option<PathBuf>) -> Result<PathBuf, TrunkError> {
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

/// One markdown bullet per published review, in the store's list order.
/// `composing` reviews are absent by contract: the CLI does not serve them,
/// and their existence must not leak (§5.1).
fn render_list(listed: &[reviews::Review]) -> String {
    listed
        .iter()
        .filter(|r| r.published)
        .map(|r| {
            format!(
                "- {} {} \"{}\" ({} {})\n",
                r.id,
                state_word(r.state),
                r.title,
                r.thread_count,
                if r.thread_count == 1 {
                    "thread"
                } else {
                    "threads"
                },
            )
        })
        .collect()
}

fn state_word(state: reviews::ReviewState) -> &'static str {
    match state {
        reviews::ReviewState::Composing => "composing",
        reviews::ReviewState::Ready => "ready",
        reviews::ReviewState::Settled => "settled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn list_parses_with_and_without_a_repo() {
        assert_eq!(parse(&argv(&["list"])), Ok(ReviewCmd::List { repo: None }),);
        assert_eq!(
            parse(&argv(&["list", "--repo", "/tmp/r"])),
            Ok(ReviewCmd::List {
                repo: Some(PathBuf::from("/tmp/r")),
            }),
        );
    }

    #[test]
    fn an_unknown_verb_is_a_usage_error() {
        let err = parse(&argv(&["frobnicate"])).unwrap_err();

        assert!(err.contains("unknown verb `frobnicate`"));
        assert!(err.contains("usage:"));
    }

    #[test]
    fn a_stray_argument_after_list_is_a_usage_error() {
        let err = parse(&argv(&["list", "extra"])).unwrap_err();

        assert!(err.contains("unexpected arguments"));
    }

    #[test]
    fn a_bare_repo_flag_is_a_usage_error() {
        let err = parse(&argv(&["list", "--repo"])).unwrap_err();

        assert!(err.contains("--repo needs a path"));
    }
}

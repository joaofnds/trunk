//! The review verbs (§5.1). Parsing is hand-rolled over the argv slice: a
//! handful of verbs, at most two positionals and three flags, and the parse
//! function is a pure unit under test.
//!
//! The CLI reads the store, never the repository — repo *discovery* may touch
//! the filesystem to find and canonicalize the repo root, rendering may not
//! (D13). Discovery must canonicalize exactly like the app
//! (`std::fs::canonicalize`) or the `repo_path` keys miss.

use crate::cli::lookup::{RepoPaths, discover_repo, published_review, published_thread};
use crate::error::TrunkError;
use crate::review_types::ThreadState;
use crate::reviewdb::{self, reviews};
use std::io::Write;
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
    Watch {
        repo: Option<PathBuf>,
        json: bool,
    },
    Threads {
        review: String,
        state: Option<ThreadState>,
        json: bool,
        repo: Option<PathBuf>,
    },
    Thread {
        id: String,
        json: bool,
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

/// Parse the argv slice after `trunk review`.
///
/// # Errors
///
/// Returns the usage line, which the caller prints to stderr, when the verb is
/// missing or unknown or a flag is wrong for it.
pub fn parse(args: &[String]) -> Result<ReviewCmd, String> {
    let mut words = args.iter().map(String::as_str);
    let verb = words.next().ok_or_else(usage)?;
    let rest: Vec<&str> = words.collect();

    match verb {
        "list" => {
            let flags = Flags::parse(&rest)?;
            flags.reject_state()?;
            Ok(ReviewCmd::List { repo: flags.repo })
        }
        "show" => {
            let (id, rest) = take_id(&rest, "show", "a review id")?;
            let flags = Flags::parse(rest)?;
            flags.reject_state()?;
            Ok(ReviewCmd::Show {
                id: id.to_string(),
                repo: flags.repo,
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
            let flags = Flags::parse(rest)?;
            flags.reject_state()?;
            Ok(ReviewCmd::Reply {
                id: id.to_string(),
                text,
                repo: flags.repo,
            })
        }
        "watch" => {
            let flags = Flags::parse(&rest)?;
            flags.reject_state()?;
            Ok(ReviewCmd::Watch {
                repo: flags.repo,
                json: flags.json,
            })
        }
        "threads" => {
            let (review, rest) = take_id(&rest, "threads", "a review id")?;
            let flags = Flags::parse(rest)?;
            Ok(ReviewCmd::Threads {
                review: review.to_string(),
                state: flags.state,
                json: flags.json,
                repo: flags.repo,
            })
        }
        "thread" => {
            let (id, rest) = take_id(&rest, "thread", "a thread id")?;
            let flags = Flags::parse(rest)?;
            flags.reject_state()?;
            Ok(ReviewCmd::Thread {
                id: id.to_string(),
                json: flags.json,
                repo: flags.repo,
            })
        }
        "address" => {
            let (id, rest) = take_id(&rest, "address", "a thread id")?;
            let flags = Flags::parse(rest)?;
            flags.reject_state()?;
            Ok(ReviewCmd::Address {
                id: id.to_string(),
                repo: flags.repo,
            })
        }
        other => Err(format!("unknown verb `{other}`\n{}", usage())),
    }
}

/// The leading positional a verb needs, and the words after it. A word
/// starting with `--` is a flag the user typed instead of the id, not an id
/// that happens to look like one: reading it as an id turns a forgotten
/// argument into a `not_found` for something nobody named.
fn take_id<'a>(
    rest: &'a [&'a str],
    verb: &str,
    noun: &str,
) -> Result<(&'a str, &'a [&'a str]), String> {
    match rest {
        [id, tail @ ..] if !is_flag(id) => Ok((id, tail)),
        _ => Err(format!("{verb} needs {noun}\n{}", usage())),
    }
}

/// A word the parser must never consume as a value.
fn is_flag(word: &str) -> bool {
    word.starts_with("--")
}

/// Every flag any verb takes, parsed in one place so a stray word is one
/// usage error wherever it appears. A verb that does not take `--state`
/// refuses it through `reject_state` rather than ignoring it.
#[derive(Default)]
struct Flags {
    repo: Option<PathBuf>,
    json: bool,
    state: Option<ThreadState>,
}

impl Flags {
    fn parse(mut rest: &[&str]) -> Result<Self, String> {
        let mut flags = Self::default();

        loop {
            rest = match rest {
                [] => return Ok(flags),
                ["--repo", path, tail @ ..] if !is_flag(path) => {
                    if flags.repo.is_some() {
                        return Err(twice("--repo"));
                    }
                    flags.repo = Some(PathBuf::from(path));
                    tail
                }
                ["--repo", ..] => return Err(format!("--repo needs a path\n{}", usage())),
                ["--json", tail @ ..] => {
                    if flags.json {
                        return Err(twice("--json"));
                    }
                    flags.json = true;
                    tail
                }
                ["--state", word, tail @ ..] if !is_flag(word) => {
                    if flags.state.is_some() {
                        return Err(twice("--state"));
                    }
                    flags.state = Some(word.parse().map_err(|_| {
                        format!("--state takes open|addressed|done|dismissed, not `{word}`")
                    })?);
                    tail
                }
                ["--state", ..] => return Err(format!("--state needs a state\n{}", usage())),
                other => return Err(format!("unexpected arguments {other:?}\n{}", usage())),
            };
        }
    }

    fn reject_state(&self) -> Result<(), String> {
        match self.state {
            None => Ok(()),
            Some(_) => Err(format!("--state filters `threads` only\n{}", usage())),
        }
    }
}

/// A flag given twice is a usage error, not last-wins: `--state done --state
/// open` would otherwise answer a differently-narrowed question in silence,
/// the same defect as ignoring the flag outright.
fn twice(flag: &str) -> String {
    format!("{flag} given twice\n{}", usage())
}

fn usage() -> String {
    "usage: trunk review <list|show|threads|thread|reply|address|watch> [--repo <path>]".to_string()
}

/// Run a parsed command against the store the compiled-in identifier names,
/// writing its output through `out`.
///
/// Output is markdown; errors go to stderr with a nonzero exit and no partial
/// write (§5.1). Every verb writes through the same sink so a caller owns
/// process I/O at one boundary and a test can drive `watch` into a buffer
/// with no process.
///
/// # Errors
///
/// Returns whatever opening the store, resolving the repository, or the command
/// itself returns. Nothing is written on the error path.
pub fn run(cmd: ReviewCmd, identifier: &str, out: &mut dyn Write) -> Result<(), TrunkError> {
    let store = reviewdb::open(&reviewdb::data_dir_for(identifier))?;

    match cmd {
        ReviewCmd::List { repo } => list(&store, discover_repo(repo)?, out),
        ReviewCmd::Show { id, repo } => show(&store, discover_repo(repo)?, &id, out),
        ReviewCmd::Reply { id, text, repo } => reply(&store, discover_repo(repo)?, &id, text, out),
        ReviewCmd::Address { id, repo } => address(&store, discover_repo(repo)?, &id, out),
        ReviewCmd::Watch { repo, json } => {
            crate::cli::watch::watch(&store, &discover_repo(repo)?, json, out)
        }
        ReviewCmd::Threads {
            review,
            state,
            json,
            repo,
        } => threads(&store, discover_repo(repo)?, &review, state, json, out),
        ReviewCmd::Thread { id, json, repo } => {
            thread(&store, discover_repo(repo)?, &id, json, out)
        }
    }
}

/// Every published review in the repository, one per line.
fn list(
    store: &reviewdb::Store,
    canonical: PathBuf,
    out: &mut dyn Write,
) -> Result<(), TrunkError> {
    let listed = store.read(|conn| reviews::list(conn, &canonical))?;

    write!(out, "{}", crate::cli::render::render_list(&listed)).ok();
    Ok(())
}

/// One published review rendered as its full markdown document.
fn show(
    store: &reviewdb::Store,
    canonical: PathBuf,
    id: &str,
    out: &mut dyn Write,
) -> Result<(), TrunkError> {
    let review = published_review(store, &canonical, id)?;
    let paths = RepoPaths::of(&canonical);

    let doc = crate::git::review::render_review_doc(
        store,
        &canonical,
        &review.id,
        paths.workdir.as_deref(),
        &paths.repo_dir,
    )?;
    write!(out, "{doc}").ok();
    Ok(())
}

/// Append an agent reply to a published thread.
fn reply(
    store: &reviewdb::Store,
    canonical: PathBuf,
    id: &str,
    text: ReplyText,
    out: &mut dyn Write,
) -> Result<(), TrunkError> {
    let thread = published_thread(store, &canonical, id)?;

    let body = match text {
        ReplyText::Inline(s) => s,
        ReplyText::Stdin => read_stdin()?,
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

    writeln!(out, "replied to {} as agent ({reply_id})", thread.id).ok();
    Ok(())
}

fn read_stdin() -> Result<String, TrunkError> {
    use std::io::Read;

    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| TrunkError::new("io", e.to_string()))?;

    Ok(buf)
}

/// Claim a published thread as addressed, on the agent channel.
fn address(
    store: &reviewdb::Store,
    canonical: PathBuf,
    id: &str,
    out: &mut dyn Write,
) -> Result<(), TrunkError> {
    let thread = published_thread(store, &canonical, id)?;

    // `set_state` runs `ThreadState::transition` with the agent channel — the
    // one matrix, never re-derived here (TRUNK-17). An illegal claim fails
    // naming the current state and writes nothing.
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

    writeln!(out, "{} claimed as addressed", thread.id).ok();
    Ok(())
}

/// A published review's threads, optionally narrowed to one state.
fn threads(
    store: &reviewdb::Store,
    canonical: PathBuf,
    review: &str,
    state: Option<ThreadState>,
    json: bool,
    out: &mut dyn Write,
) -> Result<(), TrunkError> {
    let review = published_review(store, &canonical, review)?;
    let listed = store.read(|conn| crate::reviewdb::threads::list_for_review(conn, &review.id))?;
    let matching: Vec<_> = listed
        .into_iter()
        .filter(|t| state.is_none_or(|wanted| t.state == wanted))
        .collect();

    let rendered = if json {
        crate::cli::render::render_threads_json(&review.id, &matching)?
    } else {
        crate::cli::render::render_threads(&matching)
    };
    write!(out, "{rendered}").ok();
    Ok(())
}

/// One published thread with its replies.
fn thread(
    store: &reviewdb::Store,
    canonical: PathBuf,
    id: &str,
    json: bool,
    out: &mut dyn Write,
) -> Result<(), TrunkError> {
    let thread = published_thread(store, &canonical, id)?;

    // Keyed by thread id, and one id went in, so the chain is that one key's
    // value. Draining the map instead would interleave on `HashMap`'s
    // unspecified order the day a second id is passed.
    let replies = store.read(|conn| {
        crate::reviewdb::replies::list_for_threads(conn, std::slice::from_ref(&thread.id))
    })?;
    let replies = replies.get(&thread.id).cloned().unwrap_or_default();

    let rendered = if json {
        crate::cli::render::render_thread_json(&thread, &replies)?
    } else {
        crate::cli::render::render_thread(store, &canonical, &thread, replies)?
    };
    write!(out, "{rendered}").ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(std::string::ToString::to_string).collect()
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
    fn threads_parses_its_review_id_and_optional_filters() {
        assert_eq!(
            parse(&argv(&["threads", "3F7K"])),
            Ok(ReviewCmd::Threads {
                review: "3F7K".to_string(),
                state: None,
                json: false,
                repo: None,
            }),
        );
        assert_eq!(
            parse(&argv(&["threads", "3F7K", "--state", "open", "--json"])),
            Ok(ReviewCmd::Threads {
                review: "3F7K".to_string(),
                state: Some(ThreadState::Open),
                json: true,
                repo: None,
            }),
        );
    }

    #[test]
    fn only_threads_takes_a_state_filter() {
        // Silently ignoring --state on the other verbs would answer a
        // narrowed question with the unnarrowed result.
        for verb in [
            argv(&["list", "--state", "open"]),
            argv(&["show", "3F7K", "--state", "open"]),
            argv(&["thread", "ab12", "--state", "open"]),
            argv(&["watch", "--state", "open"]),
            argv(&["address", "ab12", "--state", "open"]),
        ] {
            let err = parse(&verb).unwrap_err();

            assert!(
                err.contains("--state filters `threads` only"),
                "{verb:?} must refuse --state, got {err:?}",
            );
        }
    }

    #[test]
    fn a_repeated_flag_is_a_usage_error() {
        // Last-wins is the same defect as ignoring the flag: `--state done
        // --state open` answers a differently-narrowed question with no
        // signal, and `--repo a --repo b` would read the wrong repository.
        for (verb, flag) in [
            (
                argv(&["threads", "3F7K", "--state", "done", "--state", "open"]),
                "--state",
            ),
            (argv(&["threads", "3F7K", "--json", "--json"]), "--json"),
            (
                argv(&["threads", "3F7K", "--repo", "/a", "--repo", "/b"]),
                "--repo",
            ),
        ] {
            let err = parse(&verb).unwrap_err();

            assert!(
                err.contains(&format!("{flag} given twice")),
                "{verb:?} must refuse a repeated {flag}, got {err:?}",
            );
        }
    }

    #[test]
    fn a_flag_is_never_taken_as_a_missing_positional() {
        // `trunk review thread --json` is a forgotten id, not a request for a
        // thread named `--json`. Reading it as an id spends the store lookup
        // and answers not_found, which sends the agent hunting for an id it
        // never had.
        for args in [
            argv(&["thread", "--json"]),
            argv(&["threads", "--json"]),
            argv(&["threads", "--state", "open"]),
            argv(&["show", "--repo", "/tmp/r"]),
            argv(&["address", "--repo", "/tmp/r"]),
        ] {
            let err = parse(&args).unwrap_err();

            assert!(
                err.contains("needs a") && err.contains("usage:"),
                "{args:?} must read as a missing positional, got {err:?}",
            );
        }
    }

    #[test]
    fn repo_does_not_swallow_the_flag_after_it() {
        // Taking the next word unconditionally turns a forgotten path into a
        // repo named `--json`, and the failure names a git path rather than
        // the usage mistake it is.
        let err = parse(&argv(&["threads", "3F7K", "--repo", "--json"])).unwrap_err();

        assert!(err.contains("--repo needs a path"), "got {err:?}");
    }

    #[test]
    fn threads_rejects_a_state_outside_the_matrix() {
        let err = parse(&argv(&["threads", "3F7K", "--state", "pending"])).unwrap_err();

        assert!(err.contains("pending"), "got {err:?}");
    }

    #[test]
    fn threads_without_a_review_id_is_a_usage_error() {
        let err = parse(&argv(&["threads"])).unwrap_err();

        assert!(err.contains("threads needs a review id"), "got {err:?}");
    }

    #[test]
    fn thread_parses_its_id_with_and_without_json() {
        assert_eq!(
            parse(&argv(&["thread", "ab12"])),
            Ok(ReviewCmd::Thread {
                id: "ab12".to_string(),
                json: false,
                repo: None,
            }),
        );
        assert_eq!(
            parse(&argv(&["thread", "ab12", "--json", "--repo", "/tmp/r"])),
            Ok(ReviewCmd::Thread {
                id: "ab12".to_string(),
                json: true,
                repo: Some(PathBuf::from("/tmp/r")),
            }),
        );
    }

    #[test]
    fn thread_without_an_id_is_a_usage_error() {
        let err = parse(&argv(&["thread"])).unwrap_err();

        assert!(err.contains("thread needs a thread id"), "got {err:?}");
    }

    #[test]
    fn a_bare_repo_flag_is_a_usage_error() {
        let err = parse(&argv(&["list", "--repo"])).unwrap_err();

        assert!(err.contains("--repo needs a path"));
    }
}

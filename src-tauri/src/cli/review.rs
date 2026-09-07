//! The review verbs (§5.1), declared as a clap `Subcommand` so `--help`,
//! arity checking and "did you mean" on a typo all follow from the
//! declaration instead of being hand-maintained (TRUNK-182.3).
//!
//! The CLI reads the store, never the repository — repo *discovery* may touch
//! the filesystem to find and canonicalize the repo root, rendering may not
//! (D13). Discovery must canonicalize exactly like the app
//! (`std::fs::canonicalize`) or the `repo_path` keys miss.

use crate::cli::lookup::{RepoPaths, discover_repo, published_review, published_thread};
use crate::error::TrunkError;
use crate::review_types::ThreadState;
use crate::reviewdb::{self, reviews};
use clap::Subcommand;
use std::io::Write;
use std::path::PathBuf;

#[derive(Subcommand, Debug, PartialEq, Eq)]
pub enum ReviewCmd {
    /// Every published review in this repository
    List {
        #[arg(long, value_name = "PATH")]
        repo: Option<PathBuf>,
    },
    /// One review in full, as the same markdown document Copy-as-markdown produces
    Show {
        /// A review id, or any unambiguous prefix of one
        id: String,
        #[arg(long, value_name = "PATH")]
        repo: Option<PathBuf>,
    },
    /// Post a reply to a thread, attributed to the agent channel
    Reply {
        /// A thread id, or any unambiguous prefix of one
        id: String,
        /// The reply body. Omit it and pass --stdin for multi-line text
        #[arg(required_unless_present = "stdin", conflicts_with = "stdin")]
        text: Option<String>,
        /// Read the reply body from stdin
        #[arg(long)]
        stdin: bool,
        #[arg(long, value_name = "PATH")]
        repo: Option<PathBuf>,
    },
    /// Claim an open thread as addressed
    Address {
        /// A thread id, or any unambiguous prefix of one
        id: String,
        #[arg(long, value_name = "PATH")]
        repo: Option<PathBuf>,
    },
    /// Block and stream changes to the repo's published reviews
    Watch {
        #[arg(long, value_name = "PATH")]
        repo: Option<PathBuf>,
        /// Print one NDJSON event per change instead of the review id
        #[arg(long)]
        json: bool,
    },
    /// The review's threads, one line each
    Threads {
        /// A review id, or any unambiguous prefix of one
        review: String,
        /// Keep only threads in this state: open, addressed, done or dismissed
        #[arg(long, value_name = "STATE", value_parser = parse_state)]
        state: Option<ThreadState>,
        /// Print one NDJSON object per thread instead of the index lines
        #[arg(long)]
        json: bool,
        #[arg(long, value_name = "PATH")]
        repo: Option<PathBuf>,
    },
    /// One thread in full, with its replies
    Thread {
        /// A thread id, or any unambiguous prefix of one
        id: String,
        /// Print a single NDJSON object instead of markdown
        #[arg(long)]
        json: bool,
        #[arg(long, value_name = "PATH")]
        repo: Option<PathBuf>,
    },
}

/// `--state`'s values, read through `ThreadState`'s own parser so the CLI and
/// the store cannot disagree on the set. The domain type stays free of a UI
/// framework: this is what keeps `ThreadState` from gaining a clap derive.
fn parse_state(raw: &str) -> Result<ThreadState, String> {
    raw.parse().map_err(|_: TrunkError| {
        format!("expected open, addressed, done or dismissed, not `{raw}`")
    })
}

/// Where the reply body comes from: an argv word, or stdin for multi-line
/// text an agent pipes in.
#[derive(Debug, PartialEq, Eq)]
pub enum ReplyText {
    Inline(String),
    Stdin,
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
        ReviewCmd::Reply {
            id,
            text,
            stdin: _,
            repo,
        } => {
            let text = text.map_or(ReplyText::Stdin, ReplyText::Inline);
            reply(&store, discover_repo(repo)?, &id, text, out)
        }
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

    write!(out, "{}", crate::cli::render::render_list(&listed))
        .map_err(|e| TrunkError::new("io", e.to_string()))
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
    write!(out, "{doc}").map_err(|e| TrunkError::new("io", e.to_string()))
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

    writeln!(out, "replied to {} as agent ({reply_id})", thread.id)
        .map_err(|e| TrunkError::new("io", e.to_string()))
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

    writeln!(out, "{} claimed as addressed", thread.id)
        .map_err(|e| TrunkError::new("io", e.to_string()))
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
    write!(out, "{rendered}").map_err(|e| TrunkError::new("io", e.to_string()))
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
    write!(out, "{rendered}").map_err(|e| TrunkError::new("io", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    /// `ReviewCmd` is a clap `Subcommand`, not a standalone `Parser`: wrap it
    /// the same way `crate::cli::Command::Review` does, so a test drives the
    /// exact grammar the binary parses.
    #[derive(Parser)]
    struct Harness {
        #[command(subcommand)]
        cmd: ReviewCmd,
    }

    fn try_parse(words: &[&str]) -> Result<ReviewCmd, clap::Error> {
        let mut argv = vec!["review"];
        argv.extend_from_slice(words);
        Harness::try_parse_from(argv).map(|h| h.cmd)
    }

    fn parse(args: &[&str]) -> ReviewCmd {
        try_parse(args).unwrap_or_else(|e| panic!("{args:?} must parse, got {e}"))
    }

    #[test]
    fn list_parses_with_and_without_a_repo() {
        assert_eq!(parse(&["list"]), ReviewCmd::List { repo: None });
        assert_eq!(
            parse(&["list", "--repo", "/tmp/r"]),
            ReviewCmd::List {
                repo: Some(PathBuf::from("/tmp/r")),
            },
        );
    }

    #[test]
    fn threads_parses_its_review_id_and_optional_filters() {
        assert_eq!(
            parse(&["threads", "3F7K"]),
            ReviewCmd::Threads {
                review: "3F7K".to_string(),
                state: None,
                json: false,
                repo: None,
            },
        );
        assert_eq!(
            parse(&["threads", "3F7K", "--state", "open", "--json"]),
            ReviewCmd::Threads {
                review: "3F7K".to_string(),
                state: Some(ThreadState::Open),
                json: true,
                repo: None,
            },
        );
    }

    #[test]
    fn only_threads_takes_a_state_filter() {
        // A verb that does not declare --state refuses it as an unknown
        // argument, structurally: silently ignoring it would answer a
        // narrowed question with the unnarrowed result.
        for verb in [
            vec!["list", "--state", "open"],
            vec!["show", "3F7K", "--state", "open"],
            vec!["thread", "ab12", "--state", "open"],
            vec!["watch", "--state", "open"],
            vec!["address", "ab12", "--state", "open"],
        ] {
            assert!(try_parse(&verb).is_err(), "{verb:?} must refuse --state");
        }
    }

    #[test]
    fn a_flag_is_never_taken_as_a_missing_positional() {
        // `trunk review thread --json` is a forgotten id, not a request for a
        // thread named `--json`. Reading it as an id spends the store lookup
        // and answers not_found, which sends the agent hunting for an id it
        // never had.
        for args in [
            vec!["thread", "--json"],
            vec!["threads", "--json"],
            vec!["threads", "--state", "open"],
            vec!["show", "--repo", "/tmp/r"],
            vec!["address", "--repo", "/tmp/r"],
        ] {
            assert!(
                try_parse(&args).is_err(),
                "{args:?} must read as a missing positional",
            );
        }
    }

    #[test]
    fn threads_rejects_a_state_outside_the_matrix() {
        let err = try_parse(&["threads", "3F7K", "--state", "pending"]).unwrap_err();

        assert!(err.to_string().contains("pending"), "got {err}");
    }

    #[test]
    fn thread_parses_its_id_with_and_without_json() {
        assert_eq!(
            parse(&["thread", "ab12"]),
            ReviewCmd::Thread {
                id: "ab12".to_string(),
                json: false,
                repo: None,
            },
        );
        assert_eq!(
            parse(&["thread", "ab12", "--json", "--repo", "/tmp/r"]),
            ReviewCmd::Thread {
                id: "ab12".to_string(),
                json: true,
                repo: Some(PathBuf::from("/tmp/r")),
            },
        );
    }

    #[test]
    fn reply_takes_inline_text_or_stdin_but_not_both() {
        assert_eq!(
            parse(&["reply", "ab12", "hello"]),
            ReviewCmd::Reply {
                id: "ab12".to_string(),
                text: Some("hello".to_string()),
                stdin: false,
                repo: None,
            },
        );
        assert_eq!(
            parse(&["reply", "ab12", "--stdin"]),
            ReviewCmd::Reply {
                id: "ab12".to_string(),
                text: None,
                stdin: true,
                repo: None,
            },
        );
        assert!(
            try_parse(&["reply", "ab12"]).is_err(),
            "text or --stdin is required",
        );
        assert!(
            try_parse(&["reply", "ab12", "hello", "--stdin"]).is_err(),
            "text and --stdin are mutually exclusive",
        );
    }
}

//! The review verbs (§5.1). Parsing is hand-rolled over the argv slice: a
//! handful of verbs, at most two positionals and three flags, and the parse
//! function is a pure unit under test.
//!
//! The CLI reads the store, never the repository — repo *discovery* may touch
//! the filesystem to find and canonicalize the repo root, rendering may not
//! (D13). Discovery must canonicalize exactly like the app
//! (`std::fs::canonicalize`) or the `repo_path` keys miss.

use crate::error::TrunkError;
use crate::review_types::{Channel, ThreadState};
use crate::reviewdb::{self, reviews};
use std::fmt::Write as _;
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

/// Run a parsed command against the store the compiled-in identifier names.
///
/// Output is markdown on stdout; errors go to stderr with a nonzero exit and
/// no partial write (§5.1).
///
/// # Errors
///
/// Returns whatever opening the store, resolving the repository, or the command
/// itself returns. Nothing is written on the error path.
pub fn run(cmd: ReviewCmd, identifier: &str) -> Result<String, TrunkError> {
    let store = reviewdb::open(&reviewdb::data_dir_for(identifier))?;

    match cmd {
        ReviewCmd::List { repo } => list(&store, discover_repo(repo)?),
        ReviewCmd::Show { id, repo } => show(&store, discover_repo(repo)?, &id),
        ReviewCmd::Reply { id, text, repo } => reply(&store, discover_repo(repo)?, &id, text),
        ReviewCmd::Address { id, repo } => address(&store, discover_repo(repo)?, &id),
        ReviewCmd::Watch { repo, json } => watch(&store, &discover_repo(repo)?, json),
        ReviewCmd::Threads {
            review,
            state,
            json,
            repo,
        } => threads(&store, discover_repo(repo)?, &review, state, json),
        ReviewCmd::Thread { id, json, repo } => thread(&store, discover_repo(repo)?, &id, json),
    }
}

/// Every published review in the repository, one per line.
fn list(store: &reviewdb::Store, canonical: PathBuf) -> Result<String, TrunkError> {
    let listed = store.read(|conn| reviews::list(conn, &canonical))?;

    Ok(render_list(&listed))
}

/// One published review rendered as its full markdown document.
fn show(store: &reviewdb::Store, canonical: PathBuf, id: &str) -> Result<String, TrunkError> {
    let review = published_review(store, &canonical, id)?;
    let paths = RepoPaths::of(&canonical);

    crate::commands::review::render_review_doc(
        store,
        &canonical,
        &review.id,
        paths.workdir.as_deref(),
        &paths.repo_dir,
    )
}

/// Append an agent reply to a published thread.
fn reply(
    store: &reviewdb::Store,
    canonical: PathBuf,
    id: &str,
    text: ReplyText,
) -> Result<String, TrunkError> {
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

    Ok(format!("replied to {} as agent ({reply_id})\n", thread.id))
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
fn address(store: &reviewdb::Store, canonical: PathBuf, id: &str) -> Result<String, TrunkError> {
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

    Ok(format!("{} claimed as addressed\n", thread.id))
}

/// A published review's threads, optionally narrowed to one state.
fn threads(
    store: &reviewdb::Store,
    canonical: PathBuf,
    review: &str,
    state: Option<ThreadState>,
    json: bool,
) -> Result<String, TrunkError> {
    let review = published_review(store, &canonical, review)?;
    let listed = store.read(|conn| crate::reviewdb::threads::list_for_review(conn, &review.id))?;
    let matching: Vec<_> = listed
        .into_iter()
        .filter(|t| state.is_none_or(|wanted| t.state == wanted))
        .collect();

    if json {
        render_threads_json(&review.id, &matching)
    } else {
        Ok(render_threads(&matching))
    }
}

/// One published thread with its replies.
fn thread(
    store: &reviewdb::Store,
    canonical: PathBuf,
    id: &str,
    json: bool,
) -> Result<String, TrunkError> {
    let thread = published_thread(store, &canonical, id)?;

    // Keyed by thread id, and one id went in, so the chain is that one key's
    // value. Draining the map instead would interleave on `HashMap`'s
    // unspecified order the day a second id is passed.
    let replies = store.read(|conn| {
        crate::reviewdb::replies::list_for_threads(conn, std::slice::from_ref(&thread.id))
    })?;
    let replies = replies.get(&thread.id).cloned().unwrap_or_default();

    if json {
        render_thread_json(&thread, &replies)
    } else {
        render_thread(store, &canonical, &thread, replies)
    }
}

/// Block on the store's doorbell (`reviewdb::events`) and stream changes to
/// published reviews. Plain mode prints one review id per changed review;
/// `--json` prints one self-contained NDJSON event per change with its full
/// data, so a harness never refetches or rediffs. Both modes read off the
/// same entity diff. Composing reviews never enter the snapshot, so their
/// edits wake the process and print nothing. Streams directly to stdout,
/// unlike the other verbs: output is unbounded.
#[cfg(unix)]
fn watch(
    store: &reviewdb::Store,
    canonical: &std::path::Path,
    json: bool,
) -> Result<String, TrunkError> {
    use std::io::Write;

    // Subscribe before the baseline: a commit before the baseline is already
    // inside it, one after leaves a queued ring — no ordering loses a change.
    let events = reviewdb::events::subscribe(store.data_dir())?;
    let mut seen = published_snapshot(store, canonical)?;

    // The readiness line: a harness (and the tests) must know the doorbell
    // is bound before mutating, or the change precedes the watch.
    println!("# watching {}", canonical.display());
    std::io::stdout().flush().ok();

    while let Some(event) = events.recv() {
        match event {
            reviewdb::events::StoreEvent::Refused => {
                return Err(TrunkError::new(
                    "store_newer",
                    "the store was migrated by a newer Trunk — restart this watch with that binary",
                ));
            }
            reviewdb::events::StoreEvent::Changed { .. } => {
                let current = published_snapshot(store, canonical)?;
                let changes = diff_snapshots(&seen, &current);

                if json {
                    for change in &changes {
                        println!(
                            "{}",
                            serde_json::to_string(change)
                                .map_err(|e| TrunkError::new("json", e.to_string()))?
                        );
                    }
                } else {
                    let mut reviews_changed: Vec<&str> =
                        changes.iter().map(WatchChange::review).collect();
                    reviews_changed.dedup();
                    for id in reviews_changed {
                        println!("{id}");
                    }
                }
                std::io::stdout().flush().ok();
                seen = current;
            }
        }
    }

    Ok(String::new())
}

#[cfg(not(unix))]
fn watch(
    _store: &reviewdb::Store,
    _canonical: &std::path::Path,
    _json: bool,
) -> Result<String, TrunkError> {
    Err(TrunkError::new(
        "unsupported",
        "watch is not supported on this platform yet",
    ))
}

#[cfg(unix)]
mod watch_feed {
    //! The watch verb's view of the store and its wire events. The snapshot
    //! holds everything the events may need to say, so a diff is
    //! self-contained; `BTreeMap` keys make event order deterministic.
    //! Post-publish, threads and replies are permanent (spec §2), so the only
    //! disappearance is a whole review's deletion.

    use crate::git::types::Anchor;
    use crate::review_types::{Channel, ThreadState};
    use crate::reviewdb::reviews::ReviewState;
    use serde::Serialize;
    use std::collections::BTreeMap;

    pub type Snapshot = BTreeMap<String, ReviewSnap>;

    pub struct ReviewSnap {
        pub title: String,
        pub state: ReviewState,
        pub threads: BTreeMap<String, ThreadSnap>,
    }

    pub struct ThreadSnap {
        pub state: ThreadState,
        pub stale: bool,
        pub text: String,
        pub anchor: Option<Anchor>,
        pub commit_oid: Option<String>,
        pub replies: BTreeMap<String, ReplySnap>,
    }

    pub struct ReplySnap {
        pub channel: Channel,
        pub text: String,
    }

    /// One NDJSON line of `watch --json`. Additive evolution only: fields
    /// and variants may appear, existing ones keep their meaning.
    #[derive(Serialize)]
    #[serde(tag = "event", rename_all = "snake_case")]
    pub enum WatchChange {
        ReviewPublished {
            review: String,
            title: String,
            state: ReviewState,
        },
        ReviewRetitled {
            review: String,
            title: String,
        },
        ReviewStateChanged {
            review: String,
            from: ReviewState,
            to: ReviewState,
        },
        ReviewDeleted {
            review: String,
        },
        ThreadAdded {
            review: String,
            thread: String,
            state: ThreadState,
            text: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            anchor: Option<Anchor>,
            #[serde(skip_serializing_if = "Option::is_none")]
            commit_oid: Option<String>,
        },
        ThreadEdited {
            review: String,
            thread: String,
            text: String,
        },
        ThreadStateChanged {
            review: String,
            thread: String,
            from: ThreadState,
            to: ThreadState,
        },
        ThreadStaleChanged {
            review: String,
            thread: String,
            stale: bool,
        },
        ReplyAdded {
            review: String,
            thread: String,
            reply: String,
            channel: Channel,
            text: String,
        },
        ReplyEdited {
            review: String,
            thread: String,
            reply: String,
            text: String,
        },
    }

    impl WatchChange {
        pub fn review(&self) -> &str {
            match self {
                Self::ReviewPublished { review, .. }
                | Self::ReviewRetitled { review, .. }
                | Self::ReviewStateChanged { review, .. }
                | Self::ReviewDeleted { review }
                | Self::ThreadAdded { review, .. }
                | Self::ThreadEdited { review, .. }
                | Self::ThreadStateChanged { review, .. }
                | Self::ThreadStaleChanged { review, .. }
                | Self::ReplyAdded { review, .. }
                | Self::ReplyEdited { review, .. } => review,
            }
        }
    }
}

#[cfg(unix)]
use watch_feed::{ReplySnap, ReviewSnap, Snapshot, ThreadSnap, WatchChange};

/// Everything the events may need to say about this repo's published
/// reviews. Composing reviews are excluded, which is the no-leak rule again.
#[cfg(unix)]
fn published_snapshot(
    store: &reviewdb::Store,
    canonical: &std::path::Path,
) -> Result<Snapshot, TrunkError> {
    store.read(|conn| {
        let mut snapshot = Snapshot::new();
        for review in reviews::list(conn, canonical)? {
            if !review.published {
                continue;
            }

            let mut threads = std::collections::BTreeMap::new();
            for (thread, replies) in crate::reviewdb::threads::list_with_replies(conn, &review.id)?
            {
                threads.insert(
                    thread.id,
                    ThreadSnap {
                        state: thread.state,
                        stale: thread.stale,
                        text: thread.text,
                        anchor: thread.anchor,
                        commit_oid: thread.commit_oid,
                        replies: replies
                            .into_iter()
                            .map(|r| {
                                (
                                    r.id,
                                    ReplySnap {
                                        channel: r.channel,
                                        text: r.text,
                                    },
                                )
                            })
                            .collect(),
                    },
                );
            }

            snapshot.insert(
                review.id,
                ReviewSnap {
                    title: review.title,
                    state: review.state,
                    threads,
                },
            );
        }
        Ok(snapshot)
    })
}

/// Entity-level diff, ordered by review id, then threads, then replies. A
/// freshly published review unrolls into its full content — the watcher gets
/// everything without a fetch.
#[cfg(unix)]
fn diff_snapshots(old: &Snapshot, new: &Snapshot) -> Vec<WatchChange> {
    let mut changes = Vec::new();

    for (id, review) in new {
        match old.get(id) {
            None => {
                changes.push(WatchChange::ReviewPublished {
                    review: id.clone(),
                    title: review.title.clone(),
                    state: review.state,
                });
                for (thread_id, thread) in &review.threads {
                    push_thread_added(&mut changes, id, thread_id, thread);
                }
            }
            Some(before) => {
                if review.title != before.title {
                    changes.push(WatchChange::ReviewRetitled {
                        review: id.clone(),
                        title: review.title.clone(),
                    });
                }
                if review.state != before.state {
                    changes.push(WatchChange::ReviewStateChanged {
                        review: id.clone(),
                        from: before.state,
                        to: review.state,
                    });
                }
                for (thread_id, thread) in &review.threads {
                    match before.threads.get(thread_id) {
                        None => push_thread_added(&mut changes, id, thread_id, thread),
                        Some(t) => diff_thread(&mut changes, id, thread_id, t, thread),
                    }
                }
            }
        }
    }

    for id in old.keys() {
        if !new.contains_key(id) {
            changes.push(WatchChange::ReviewDeleted { review: id.clone() });
        }
    }

    changes
}

#[cfg(unix)]
fn push_thread_added(
    changes: &mut Vec<WatchChange>,
    review: &str,
    thread_id: &str,
    thread: &ThreadSnap,
) {
    changes.push(WatchChange::ThreadAdded {
        review: review.to_string(),
        thread: thread_id.to_string(),
        state: thread.state,
        text: thread.text.clone(),
        anchor: thread.anchor.clone(),
        commit_oid: thread.commit_oid.clone(),
    });
    for (reply_id, reply) in &thread.replies {
        changes.push(WatchChange::ReplyAdded {
            review: review.to_string(),
            thread: thread_id.to_string(),
            reply: reply_id.clone(),
            channel: reply.channel,
            text: reply.text.clone(),
        });
    }
}

#[cfg(unix)]
fn diff_thread(
    changes: &mut Vec<WatchChange>,
    review: &str,
    thread_id: &str,
    before: &ThreadSnap,
    after: &ThreadSnap,
) {
    if after.text != before.text {
        changes.push(WatchChange::ThreadEdited {
            review: review.to_string(),
            thread: thread_id.to_string(),
            text: after.text.clone(),
        });
    }
    if after.state != before.state {
        changes.push(WatchChange::ThreadStateChanged {
            review: review.to_string(),
            thread: thread_id.to_string(),
            from: before.state,
            to: after.state,
        });
    }
    if after.stale != before.stale {
        changes.push(WatchChange::ThreadStaleChanged {
            review: review.to_string(),
            thread: thread_id.to_string(),
            stale: after.stale,
        });
    }

    for (reply_id, reply) in &after.replies {
        match before.replies.get(reply_id) {
            None => changes.push(WatchChange::ReplyAdded {
                review: review.to_string(),
                thread: thread_id.to_string(),
                reply: reply_id.clone(),
                channel: reply.channel,
                text: reply.text.clone(),
            }),
            Some(r) if r.text != reply.text => changes.push(WatchChange::ReplyEdited {
                review: review.to_string(),
                thread: thread_id.to_string(),
                reply: reply_id.clone(),
                text: reply.text.clone(),
            }),
            Some(_) => {}
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

/// The renderer's two path facts, derived from the canonical workdir the
/// store keys by. Deriving them at each render site let the CLI's answer for
/// one thread disagree with its answer for the whole document, which is the
/// one thing the `thread` verb exists to rule out.
struct RepoPaths {
    workdir: Option<PathBuf>,
    repo_dir: PathBuf,
}

impl RepoPaths {
    /// `discover_repo` rejects a bare repository before any render, so the
    /// workdir the CLI renders against is always present.
    fn of(canonical: &std::path::Path) -> Self {
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

/// One line per thread: id, state, where it points, and the first line of its
/// text — the index an agent scans before asking for a thread in full. The
/// location is the anchor's `file:start-end`, a commit-level thread's short
/// oid, or `no target`, mirroring the document's three thread shapes. A file
/// path may legally contain a newline, so the location passes through the
/// renderer's sanitizer: one thread must never print as two lines, or the
/// second is a thread an agent will act on that nobody wrote.
fn render_threads(threads: &[crate::reviewdb::threads::Thread]) -> String {
    threads.iter().fold(String::new(), |mut out, t| {
        let _ = writeln!(
            out,
            "- {id} {state} {location} — {summary}",
            id = t.id,
            state = t.state.as_str(),
            location = crate::git::review::sanitize_heading_text(&thread_location(t)),
            summary = first_line(&t.text),
        );
        out
    })
}

/// Where a thread points, in the index's one-line spelling.
fn thread_location(thread: &crate::reviewdb::threads::Thread) -> String {
    match (&thread.anchor, &thread.commit_oid) {
        (Some(anchor), _) => format!(
            "{}:{}-{}",
            anchor.file_path, anchor.start_line, anchor.end_line
        ),
        (None, Some(oid)) => crate::git::review::short_sha(oid).to_string(),
        (None, None) => "no target".to_string(),
    }
}

/// The comment's opening line, so one thread is one line of the index however
/// long the comment runs. `lines` splits on `\n` and leaves a lone `\r`,
/// which a terminal renders by returning to the start of the line and
/// overwriting what the index already printed — so the result goes through
/// the same sanitizer as the location.
fn first_line(text: &str) -> String {
    crate::git::review::sanitize_heading_text(text.lines().next().unwrap_or("").trim())
}

/// One `threads --json` line. Optional fields are skipped rather than sent as
/// null, exactly as `watch`'s `ThreadAdded` does: a reader tells a thread's
/// shape by which of `anchor` and `commit_oid` is present, and a null would
/// read as an anchor.
#[derive(serde::Serialize)]
struct ThreadLine<'a> {
    review: &'a str,
    thread: &'a str,
    state: ThreadState,
    stale: bool,
    text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    anchor: Option<&'a crate::git::types::Anchor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit_oid: Option<&'a str>,
}

/// One `thread --json` object: the index line's fields plus everything the
/// chain adds.
#[derive(serde::Serialize)]
struct ThreadChain<'a> {
    #[serde(flatten)]
    thread: ThreadLine<'a>,
    channel: Channel,
    #[serde(skip_serializing_if = "Option::is_none")]
    excerpt: Option<&'a str>,
    replies: Vec<ChainReply<'a>>,
    allowed_transitions: Vec<ThreadState>,
}

#[derive(serde::Serialize)]
struct ChainReply<'a> {
    reply: &'a str,
    channel: Channel,
    text: &'a str,
}

impl<'a> ThreadLine<'a> {
    fn of(review: &'a str, thread: &'a crate::reviewdb::threads::Thread) -> Self {
        ThreadLine {
            review,
            thread: &thread.id,
            state: thread.state,
            stale: thread.stale,
            text: &thread.text,
            anchor: thread.anchor.as_ref(),
            commit_oid: thread.commit_oid.as_deref(),
        }
    }
}

/// The `threads` index as NDJSON, one `thread` object per line, in `watch`'s
/// field vocabulary so a harness parses both streams with one reader.
fn render_threads_json(
    review_id: &str,
    threads: &[crate::reviewdb::threads::Thread],
) -> Result<String, TrunkError> {
    let mut out = String::new();
    for thread in threads {
        let line = serde_json::to_string(&ThreadLine::of(review_id, thread))
            .map_err(|e| TrunkError::new("json", e.to_string()))?;
        out.push_str(&line);
        out.push('\n');
    }

    Ok(out)
}

/// The text of the line dividing a thread's document section from the CLI's
/// own trailer, without its leading `#` run. Comment and reply text is
/// reproduced above it and may say anything, including "Review:", so a reader
/// that splits on the trailer's prose splits wherever a replier chose.
const TRAILER_RULE_TEXT: &str = " --- end of comment ---";

/// The rule closing `section`, with a `#` run one longer than the longest one
/// opening a line inside it. Comment and reply text has its leading `#` runs
/// escaped, but the stored excerpt does not: it is fenced, and a fence
/// reproduces the reviewed code verbatim — including a line that is itself a
/// copy of this rule. Whoever wrote the commit under review chooses that
/// content, so a fixed run length lets a source file forge the rule, and an
/// agent splitting at the first one reads the forged `State:` under it as the
/// CLI's answer and skips real work. Outrunning every run in the section
/// leaves the real rule the only line that can open with its own length.
fn trailer_rule_for(section: &str) -> String {
    let longest = section
        .lines()
        .map(|line| line.chars().take_while(|c| *c == '#').count())
        .max()
        .unwrap_or(0);

    format!("{}{TRAILER_RULE_TEXT}", "#".repeat(longest.max(4) + 1))
}

/// One thread in full, as the document renders it, followed by the state and
/// the moves the agent channel may make from it. The section comes from the
/// document's own per-thread renderer (`git::review::render_thread_section`),
/// so a thread read alone and the same thread read in `show` are one format.
fn render_thread(
    store: &reviewdb::Store,
    canonical: &std::path::Path,
    thread: &crate::reviewdb::threads::Thread,
    replies: Vec<crate::reviewdb::replies::Reply>,
) -> Result<String, TrunkError> {
    use crate::git::review::{DocCommit, DocReply, DocThread, RenderInput};

    // One read, because two would let the store move underneath them: the
    // heading's state and the trailer's would come from different instants.
    // The review row is deliberately not fetched — `render_thread_section`
    // never reaches `emit_header`, the only reader of `title`, so looking it
    // up would buy nothing but a `not_found` naming a review the caller never
    // typed.
    let (commits, snapshots) = store.read(|conn| {
        Ok((
            crate::reviewdb::commits::list(conn, &thread.review_id)?,
            crate::reviewdb::snapshots::get(conn, canonical)?,
        ))
    })?;

    let paths = RepoPaths::of(canonical);
    let session = RenderInput {
        review_id: thread.review_id.clone(),
        title: String::new(),
        cli_binary: None,
        workdir: paths.workdir,
        repo_dir: paths.repo_dir,
        commits: commits
            .into_iter()
            .map(|c| DocCommit {
                oid: c.oid,
                subject: c.subject,
            })
            .collect(),
        threads: vec![],
        working_tree_snapshot: snapshots.working_tree_snapshot,
        index_snapshot: snapshots.index_snapshot,
    };
    let doc_thread = DocThread {
        id: thread.id.clone(),
        text: thread.text.clone(),
        state: thread.state,
        anchor: thread.anchor.clone(),
        commit_oid: thread.commit_oid.clone(),
        excerpt: thread.cached_excerpt.clone(),
        channel: thread.channel,
        replies: replies
            .into_iter()
            .map(|r| DocReply {
                text: r.text,
                channel: r.channel,
            })
            .collect(),
    };

    let mut out = crate::git::review::render_thread_section(&session, &doc_thread);
    let rule = trailer_rule_for(&out);
    let _ = write!(
        out,
        "{rule}\nReview: {review}\nState: {state}\nYou can: {actions}\n",
        review = thread.review_id,
        state = thread.state.as_str(),
        actions = agent_actions(thread.state),
    );

    Ok(out)
}

/// The verbs the agent may run against a thread in `state`, named as verbs
/// because a state is not something an agent can type. `reply` is always
/// available; the rest are whatever the one transition matrix legalizes for
/// the agent channel (TRUNK-17), each named by the verb that reaches it, so a
/// `done` thread offers the reply alone. Legalizing a second agent transition
/// adds it here on its own, so this line and `--json`'s `allowed_transitions`
/// cannot drift apart.
fn agent_actions(state: ThreadState) -> String {
    let verbs: Vec<&str> = std::iter::once("reply")
        .chain(
            state
                .allowed_transitions(Channel::Agent)
                .into_iter()
                .map(claiming_verb),
        )
        .collect();

    verbs.join(", ")
}

/// The CLI verb that moves a thread into `next`. `address` is the agent
/// channel's only claim by §5.1, so it is the only arm the matrix reaches
/// today; the human's resolutions have no CLI verb at all, which is what
/// stops an agent settling a review. A state with no verb names itself rather
/// than panicking — this line is printed by a verb an agent runs, and a wrong
/// word there costs less than a crash.
const fn claiming_verb(next: ThreadState) -> &'static str {
    match next {
        ThreadState::Addressed => "address",
        ThreadState::Open | ThreadState::Done | ThreadState::Dismissed => next.as_str(),
    }
}

/// One thread in full as a single JSON object, in `watch`'s field vocabulary
/// with the replies and the agent's available actions alongside.
fn render_thread_json(
    thread: &crate::reviewdb::threads::Thread,
    replies: &[crate::reviewdb::replies::Reply],
) -> Result<String, TrunkError> {
    let chain = ThreadChain {
        thread: ThreadLine::of(&thread.review_id, thread),
        channel: thread.channel,
        excerpt: thread.cached_excerpt.as_deref(),
        replies: replies
            .iter()
            .map(|r| ChainReply {
                reply: &r.id,
                channel: r.channel,
                text: &r.text,
            })
            .collect(),
        allowed_transitions: thread.state.allowed_transitions(Channel::Agent),
    };

    let line = serde_json::to_string(&chain).map_err(|e| TrunkError::new("json", e.to_string()))?;

    Ok(format!("{line}\n"))
}

/// One markdown bullet per published review, in the store's list order.
/// `composing` reviews are absent by contract: the CLI does not serve them,
/// and their existence must not leak (§5.1).
fn render_list(listed: &[reviews::Review]) -> String {
    listed
        .iter()
        .filter(|r| r.published)
        .fold(String::new(), |mut out, r| {
            let _ = writeln!(
                out,
                "- {} {} \"{}\" ({} {})",
                r.id,
                state_word(r.state),
                r.title,
                r.thread_count,
                if r.thread_count == 1 {
                    "thread"
                } else {
                    "threads"
                },
            );
            out
        })
}

const fn state_word(state: reviews::ReviewState) -> &'static str {
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
    fn the_actions_line_follows_the_transition_matrix() {
        // The plain line and --json's allowed_transitions answer the same
        // question, so they must not be able to disagree.
        for state in [
            ThreadState::Open,
            ThreadState::Addressed,
            ThreadState::Done,
            ThreadState::Dismissed,
        ] {
            let claims = state.allowed_transitions(Channel::Agent).len();
            let line = agent_actions(state);

            assert_eq!(
                line.split(", ").count(),
                claims + 1,
                "{state:?} allows {claims} claims plus the reply, got {line:?}",
            );
        }
        assert_eq!(agent_actions(ThreadState::Open), "reply, address");
        assert_eq!(agent_actions(ThreadState::Done), "reply");
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

    #[test]
    fn a_bare_repo_flag_is_a_usage_error() {
        let err = parse(&argv(&["list", "--repo"])).unwrap_err();

        assert!(err.contains("--repo needs a path"));
    }
}

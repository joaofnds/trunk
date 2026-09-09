//! Every renderer the review verbs use, plain and JSON.
//!
//! The reviews list, the threads index, one thread in full (as the document
//! renders it, plus the CLI's own trailer), and their JSON twins in `watch`'s
//! field vocabulary.

use crate::cli::lookup::RepoPaths;
use crate::error::TrunkError;
use crate::review_types::{Channel, ThreadState};
use crate::reviewdb::{self, reviews};
use std::fmt::Write as _;

/// One markdown bullet per published review, in the store's list order.
/// `composing` reviews are absent by contract: the CLI does not serve them,
/// and their existence must not leak (§5.1).
pub(crate) fn render_list(listed: &[reviews::Review]) -> String {
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

/// One line per thread: id, state, where it points, and the first line of its
/// text — the index an agent scans before asking for a thread in full. The
/// location is the anchor's `file:start-end`, a commit-level thread's short
/// oid, or `no target`, mirroring the document's three thread shapes. A file
/// path may legally contain a newline, so the location passes through the
/// renderer's sanitizer: one thread must never print as two lines, or the
/// second is a thread an agent will act on that nobody wrote.
pub(crate) fn render_threads(threads: &[crate::reviewdb::threads::Thread]) -> String {
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
    if let Some(pin) = &thread.content_pin {
        return format!("{}:{}-{}", pin.file_path, pin.start_line, pin.end_line);
    }

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
/// shape by which of `anchor`, `commit_oid` and `content_pin` is present, and a
/// null would read as an anchor.
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
    #[serde(skip_serializing_if = "Option::is_none")]
    content_pin: Option<&'a crate::git::types::ContentPin>,
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
            content_pin: thread.content_pin.as_ref(),
        }
    }
}

/// The `threads` index as NDJSON, one `thread` object per line, in `watch`'s
/// field vocabulary so a harness parses both streams with one reader.
pub(crate) fn render_threads_json(
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
pub(crate) fn render_thread(
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
        stale: thread.stale,
        anchor: thread.anchor.clone(),
        commit_oid: thread.commit_oid.clone(),
        content_pin: thread.content_pin.clone(),
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
pub(crate) fn render_thread_json(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review_types::Channel;

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
}

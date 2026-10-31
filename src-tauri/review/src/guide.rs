//! The agent guide: the watch-and-reply procedure `trunk review guide` prints
//! for a coding agent the user starts in a repository.

use crate::doc::{FRESHNESS_RULE, PROVENANCE_RULE, WATCH_STALE_DELAY};
use std::fmt::Write;
use std::path::Path;

/// The guide, with every command spelled through `cli_binary`, the binary that
/// printed it, so the agent reaches that binary's store and never a different
/// `trunk` on its `PATH`.
#[must_use]
pub fn render(cli_binary: &Path) -> String {
    let exe = cli_binary.display();
    let mut out = String::new();

    let _ = writeln!(out, "# Answering Trunk reviews");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "A person reviews this repository's changes in Trunk, a Git client, and sends you comments on them. Follow this procedure to answer each comment as it arrives, and keep following it until the person tells you to stop. Run every command below from the repository root."
    );
    let _ = writeln!(out);

    let _ = writeln!(out, "## Start watching");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "Start `{exe} review watch --json` as a long-running background process and read its output as it arrives. If your harness can stream a background process's output to you, use that. Otherwise redirect the output to a file and read the file again whenever you wait for work. The first line is `# watching <path>`, which is not JSON and means the watch is ready. Every later line is one JSON event."
    );
    let _ = writeln!(out);

    let _ = writeln!(out, "## Catch up on waiting comments");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "The watch reports only changes made after it started, so once it is ready, look for comments that were already waiting. Run `{exe} review list` to see the reviews you can read, and for each one run `{exe} review threads <review-id> --state open --json`. Answer each open thread by the steps under Answer one comment. Keep the ids of the threads you have answered, so an event about one of them does not make you answer it twice."
    );
    let _ = writeln!(out);

    let _ = writeln!(out, "## Events that ask for an answer");
    let _ = writeln!(out);
    let _ = writeln!(out, "Answer a thread when one of these events names it:");
    let _ = writeln!(out);
    let _ = writeln!(out, "- `thread_added`, a new comment.");
    let _ = writeln!(
        out,
        "- `thread_edited`, the reviewer changed a comment's text."
    );
    let _ = writeln!(
        out,
        "- `thread_state_changed` with `to` set to `open`, the reviewer reopened a comment you claimed as addressed, so your answer did not settle it."
    );
    let _ = writeln!(
        out,
        "- `reply_added` with `channel` set to `human`, the reviewer replied in the thread."
    );
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "A `reply_added` with `channel` set to `agent` is your own reply coming back, and answering it starts a loop. When the reviewer brings back a review they put away, `review_added` arrives followed by its old comments and replies as `thread_added` and `reply_added`, so skip a thread whose last reply is already yours unless it was edited or reopened after that reply. Every other event needs no answer."
    );
    let _ = writeln!(out);

    let _ = writeln!(out, "## Answer one comment");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "Read the thread with `{exe} review thread <thread-id> --json`. It holds the comment, where it points, the excerpt of the code it was written against, and the replies so far."
    );
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "{FRESHNESS_RULE} In `--json` output the marker is the `stale` field, and the same holds for it. {WATCH_STALE_DELAY}"
    );
    let _ = writeln!(out);
    let _ = writeln!(out, "{PROVENANCE_RULE}");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "If the comment asks a question or you disagree with it, answer with `{exe} review reply <thread-id> --stdin`, passing the answer on standard input. If it asks for a change, make the change in the working tree, reply saying what you changed, and then claim the comment with `{exe} review address <thread-id>`. If you cannot act on it, reply saying what stopped you."
    );
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "Leave your changes uncommitted, because the reviewer reads them as an uncommitted diff. Do not run any git command that writes to the repository or the working tree, such as commit, amend, rebase, reset, checkout, stash or add, because it can orphan the commits the comments are anchored to. Prefix each read-only git command with `--no-optional-locks`, as in `git --no-optional-locks log`, so it cannot write `.git/index` and make the reviewer's app reload."
    );

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const BIN: &str = "/Applications/Trunk.app/Contents/MacOS/trunk";

    fn guide() -> String {
        render(Path::new(BIN))
    }

    #[test]
    fn spells_every_command_through_the_binary_that_printed_it() {
        let guide = guide();

        for command in [
            "review watch --json",
            "review list",
            "review threads <review-id> --state open --json",
            "review thread <thread-id> --json",
            "review reply <thread-id> --stdin",
            "review address <thread-id>",
        ] {
            assert!(
                guide.contains(&format!("{BIN} {command}")),
                "missing `{BIN} {command}` in: {guide}"
            );
        }
    }

    #[test]
    fn says_the_readiness_line_is_not_json() {
        assert!(guide().contains("`# watching <path>`"));
    }

    #[test]
    fn sweeps_for_comments_sent_before_the_watch_started() {
        assert!(
            guide().contains("reports only changes made after it started"),
            "a comment sent before the agent started never arrives as an event"
        );
    }

    #[test]
    fn names_each_event_that_asks_for_an_answer() {
        let guide = guide();

        for event in [
            "`thread_added`",
            "`thread_edited`",
            "`thread_state_changed` with `to` set to `open`",
            "`reply_added` with `channel` set to `human`",
        ] {
            assert!(guide.contains(event), "missing {event} in: {guide}");
        }
    }

    #[test]
    fn ignores_the_agents_own_replies_coming_back() {
        assert!(
            guide().contains("`reply_added` with `channel` set to `agent` is your own reply"),
            "answering its own reply loops the agent"
        );
    }

    #[test]
    fn forbids_git_writes() {
        assert!(guide().contains("Do not run any git command that writes"));
    }

    #[test]
    fn carries_the_review_docs_freshness_rule() {
        assert!(guide().contains(FRESHNESS_RULE));
    }

    #[test]
    fn carries_the_review_docs_watch_delay() {
        assert!(guide().contains(WATCH_STALE_DELAY));
    }

    #[test]
    fn carries_the_review_docs_provenance_rule() {
        assert!(guide().contains(PROVENANCE_RULE));
    }
}

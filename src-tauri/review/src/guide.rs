//! The agent guide: the watch-and-reply procedure `trunk review guide` prints
//! for a coding agent the user starts in a repository.

use crate::doc::{
    COMMIT_OVERRIDE, FRESHNESS_RULE, GIT_READ_RULE, GIT_WRITE_BAN, PROVENANCE_RULE,
    UNCOMMITTED_DIFF, WATCH_STALE_DELAY, shell_word,
};
use std::fmt::Write;
use std::path::Path;

/// The guide, with every command spelled through `cli_binary`, the binary that
/// printed it, so the agent reaches that binary's store and never a different
/// `trunk` on its `PATH`.
#[must_use]
pub fn render(cli_binary: &Path) -> String {
    let exe = shell_word(cli_binary);
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
        "Start `{exe} review watch --json` as a long-running background process and read its output as it arrives. If your harness can stream a background process's output to you, use that. Otherwise redirect its output and its errors to a new file outside the repository, such as one `mktemp` creates, because a file inside the repository shows in the reviewer's diff and a fixed name can be another agent's log. Read that file from its first line, and again whenever you wait for work, so nothing written before you began following it is missed. Read every line unfiltered, whichever way you receive them, because a filter such as `grep -v` between the watch and you can hold back the newest line until another arrives, and a lone comment would then wait for some unrelated change. The first line is `# watching <path>`, which is not JSON and means the watch is ready. Every later line is one JSON event. If the watch exits, read its last lines for the reason, start it again, and catch up again as the next section says, because a comment sent while no watch ran arrives as no event. When you follow a file, check that the watch is still running by the process id you started, because `tail -f` keeps running after the watch dies. When you stop following this procedure, stop the watch you started, so it does not outlive your session."
    );
    let _ = writeln!(out);

    let _ = writeln!(out, "## Catch up on waiting comments");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "The watch reports only changes made after it started, so once it is ready, look for comments that were already waiting. Run `{exe} review list` to see the reviews you can read, and for each one run `{exe} review threads <review-id> --json`. Take each thread whose `state` is `open` or `addressed` through Answer one comment."
    );
    let _ = writeln!(out);

    let _ = writeln!(out, "## Events that ask for an answer");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "Take a thread through Answer one comment when one of these events names it:"
    );
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
    let _ = writeln!(
        out,
        "- `reply_edited`, the reviewer changed a reply's text."
    );
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "A `reply_added` with `channel` set to `agent` is your own reply coming back, and answering it starts a loop. When the reviewer brings back a review they put away, `review_added` arrives followed by its old comments and replies as `thread_added` and `reply_added`, and Answer one comment leaves each one you already answered. Every other event needs no answer."
    );
    let _ = writeln!(out);

    let _ = writeln!(out, "## Answer one comment");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "Read the thread with `{exe} review thread <thread-id> --json`. It holds the comment, where it points, the excerpt of the code it was written against, and the replies so far. If its `last_action` is `agent`, your answer or claim is still the latest thing on the thread and the reviewer has not acted since, so leave it. That is how a comment the catch-up already answered, or a replayed one, gets one answer and not two. Judge it from that field, never from the order of the replies or of the events."
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
        "If the comment asks a question or you disagree with it, answer with `{exe} review reply <thread-id> --stdin`, passing the answer on standard input. If it asks for a change, make the change in the working tree, reply saying what you changed, and then, if `allowed_transitions` in its `--json` output includes `addressed`, claim the comment with `{exe} review address <thread-id>`. If you cannot act on it, reply saying what stopped you. If the reviewer reopened a comment you claimed and wrote nothing after your claim, they are not satisfied with your change but have not said why, and claiming it again would undo their reopen. Reply asking what is still missing, and do not claim it as addressed again until the reviewer answers and you have changed what they ask for. Ask the reviewer anything you need to know in a reply on the thread, because the reviewer works in Trunk and may never see your terminal."
    );
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "Leave your changes uncommitted. {UNCOMMITTED_DIFF} Delete any file your build or checks created that your change does not need, such as a bytecode cache, because it shows in that diff. {GIT_WRITE_BAN} {COMMIT_OVERRIDE} {GIT_READ_RULE}"
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
            "review threads <review-id> --json",
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
        assert!(guide().contains("`# watching <path>`, which is not JSON"));
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
            "`reply_edited`",
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
    fn leaves_a_thread_whose_last_action_is_the_agents() {
        assert!(
            guide().contains("If its `last_action` is `agent`"),
            "an answered question stays open, so a restarted agent would answer it again"
        );
    }

    #[test]
    fn the_catch_up_reads_addressed_threads_too() {
        assert!(
            guide().contains("whose `state` is `open` or `addressed`"),
            "a reviewer can reply on an addressed thread without reopening it"
        );
    }

    #[test]
    fn keeps_the_watch_log_out_of_the_repository() {
        assert!(
            guide().contains("to a new file outside the repository"),
            "a log in the working tree shows in the reviewer's diff"
        );
    }

    #[test]
    fn reads_the_watch_unfiltered_from_its_first_line() {
        let guide = guide();
        assert!(
            guide.contains("Read every line unfiltered"),
            "Claude Code's `grep -v` holds the newest line, so a lone comment waits for an unrelated write"
        );
        assert!(
            guide.contains("from its first line"),
            "an event written before the agent follows the file is otherwise lost"
        );
    }

    #[test]
    fn asks_the_reviewer_in_the_thread_and_cleans_build_output() {
        let guide = guide();
        assert!(guide.contains("in a reply on the thread"));
        assert!(guide.contains("Delete any file your build or checks created"));
    }

    #[test]
    fn notices_a_dead_watch_and_stops_its_own_on_leaving() {
        let guide = guide();
        assert!(
            guide.contains("by the process id you started"),
            "a `tail -f` on the log never ends when the watch dies"
        );
        assert!(
            guide.contains("stop the watch you started"),
            "a detached watch otherwise runs on after the agent exits"
        );
    }

    #[test]
    fn restarts_a_watch_that_exits_and_catches_up() {
        assert!(
            guide().contains("If the watch exits"),
            "a newer Trunk migrating the store ends the watch, and nothing else re-arms it"
        );
    }

    #[test]
    fn claims_addressed_only_where_the_thread_allows_it() {
        assert!(
            guide()
                .contains("if `allowed_transitions` in its `--json` output includes `addressed`"),
            "address on a done, dismissed or addressed thread fails with illegal_transition"
        );
    }

    #[test]
    fn waits_for_the_reviewer_after_a_reopen_without_a_comment() {
        assert!(
            guide().contains("do not claim it as addressed again until the reviewer answers"),
            "a second claim with no change undoes the reviewer's reopen"
        );
    }

    #[test]
    fn carries_the_review_docs_git_rules() {
        let guide = guide();

        for rule in [
            GIT_WRITE_BAN,
            COMMIT_OVERRIDE,
            UNCOMMITTED_DIFF,
            GIT_READ_RULE,
        ] {
            assert!(guide.contains(rule), "missing {rule} in: {guide}");
        }
    }

    #[test]
    fn quotes_a_binary_path_holding_a_space() {
        let guide = render(Path::new("/Users/a/My Tools/trunk"));

        assert!(
            guide.contains("'/Users/a/My Tools/trunk' review watch --json"),
            "unquoted, the shell runs /Users/a/My; got: {guide}"
        );
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

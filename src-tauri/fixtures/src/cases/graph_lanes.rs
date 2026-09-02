//! Case 04: HEAD-lane placement, one repository per shape (behind, ahead, diverged,
//! detached, tag-only chains, two remotes), with a bare remote beside each one that
//! pushes. Transcribed from cases/04-graph-lanes/build.sh.

use std::path::{Path, PathBuf};

use super::Case;
use crate::repo::{Identity, Repo, Signature, init_bare};

const QA: Identity = Identity {
    name: "QA Fixture",
    email: "qa@trunk.test",
};
const BASE_SECS: i64 = 1_767_225_600;
const DAY_SECS: i64 = 86_400;

pub const CASE: Case = Case {
    name: "04-graph-lanes",
    summary: "Thirteen repos for HEAD-lane placement: behind, ahead, diverged, detached, tags.",
    repos: &[
        "graph-lanes/01-behind-only",
        "graph-lanes/02-local-ahead-no-remote",
        "graph-lanes/03-detached-old",
        "graph-lanes/04-tiebreak-upstream-vs-topic",
        "graph-lanes/05-diverged",
        "graph-lanes/06-tag-only-chain",
        "graph-lanes/07-tag-on-unpulled",
        "graph-lanes/08-stash-on-tip-behind",
        "graph-lanes/09-branch-point-below-head",
        "graph-lanes/10-two-remotes",
        "graph-lanes/11-merge-in-head-chain",
        "graph-lanes/12-author-vs-committer",
        "graph-lanes/13-tall-linear",
        "graph-lanes/.remotes/01-behind-only-origin.git",
        "graph-lanes/.remotes/04-tiebreak-upstream-vs-topic-origin.git",
        "graph-lanes/.remotes/05-diverged-origin.git",
        "graph-lanes/.remotes/07-tag-on-unpulled-origin.git",
        "graph-lanes/.remotes/08-stash-on-tip-behind-origin.git",
        "graph-lanes/.remotes/09-branch-point-below-head-origin.git",
        "graph-lanes/.remotes/10-two-remotes-origin.git",
        "graph-lanes/.remotes/10-two-remotes-upstream.git",
        "graph-lanes/.remotes/11-merge-in-head-chain-origin.git",
    ],
    build,
};

fn day(n: i64) -> Signature {
    QA.at(BASE_SECS + n * DAY_SECS)
}

/// One repository under `graph-lanes/`, with its name kept for the remotes it adds.
struct Lane {
    repo: Repo,
    name: String,
    out: PathBuf,
}

fn init_repo(out: &Path, name: &str) -> Lane {
    let mut repo = Repo::init(&out.join("graph-lanes").join(name), "main", QA);
    repo.config("commit.gpgsign", "false");

    Lane {
        repo,
        name: name.to_owned(),
        out: out.to_path_buf(),
    }
}

/// `slug`: the message with spaces as dashes, the file each commit writes.
fn slug(msg: &str) -> String {
    msg.replace(' ', "-")
}

impl Lane {
    /// `commit <repo> <day> <message>`: write `<slug>.txt`, stage everything, commit.
    fn commit(&mut self, on: i64, msg: &str) {
        self.repo
            .write(&format!("{}.txt", slug(msg)), &format!("{msg}\n"));
        self.repo.add_all();
        self.repo.commit(day(on), msg);
    }

    /// `commit_split <repo> <author-day> <committer-day> <message>`.
    fn commit_split(&mut self, author_day: i64, committer_day: i64, msg: &str) {
        self.repo
            .write(&format!("{}.txt", slug(msg)), &format!("{msg}\n"));
        self.repo.add_all();
        self.repo
            .commit_split(day(author_day), day(committer_day), msg);
    }

    /// `stash <repo> <day> <message>`.
    fn stash(&mut self, on: i64, msg: &str) {
        self.repo.stash(day(on), msg, false);
    }

    /// `add_remote <repo> <remote-name>`: a bare repository at
    /// `.remotes/<repo>-<remote>.git`, initialised with no branch.
    fn add_remote(&mut self, remote: &str) {
        let bare = self
            .out
            .join("graph-lanes")
            .join(".remotes")
            .join(format!("{}-{remote}.git", self.name));
        init_bare(&bare, None);
        self.repo.remote_add(remote, &bare);
    }
}

fn build_01(out: &Path) {
    let mut lane = init_repo(out, "01-behind-only");
    lane.add_remote("origin");
    lane.commit(1, "base one");
    lane.commit(2, "base two");
    lane.repo.push("origin", "main", true);
    lane.commit(3, "upstream three");
    lane.commit(4, "upstream four");
    lane.commit(5, "upstream five");
    lane.repo.push("origin", "main", false);
    lane.repo.reset_hard("HEAD~3");
    lane.repo.fetch("origin");
}

fn build_02(out: &Path) {
    let mut lane = init_repo(out, "02-local-ahead-no-remote");
    lane.commit(1, "base one");
    lane.commit(2, "base two");
    lane.repo.rename_branch("main", "old");
    lane.repo.branch("new");
    lane.repo.checkout("new");
    lane.commit(3, "new one");
    lane.commit(4, "new two");
    lane.repo.checkout("old");
}

fn build_03(out: &Path) {
    let mut lane = init_repo(out, "03-detached-old");
    lane.commit(1, "base one");
    lane.commit(2, "base two");
    lane.commit(3, "main three");
    lane.commit(4, "main four");
    lane.repo.checkout_detached("main~3");
}

fn build_04(out: &Path) {
    let mut lane = init_repo(out, "04-tiebreak-upstream-vs-topic");
    lane.add_remote("origin");
    lane.commit(1, "base one");
    lane.commit(2, "base two");
    lane.repo.push("origin", "main", true);
    lane.commit(3, "upstream three");
    lane.commit(4, "upstream four");
    lane.commit(5, "upstream five");
    lane.repo.push("origin", "main", false);
    lane.repo.reset_hard("HEAD~3");
    lane.repo.branch("topic");
    lane.repo.checkout("topic");
    lane.commit(6, "topic one");
    lane.commit(7, "topic two");
    lane.repo.checkout("main");
    lane.repo.fetch("origin");
}

fn build_05(out: &Path) {
    let mut lane = init_repo(out, "05-diverged");
    lane.add_remote("origin");
    lane.commit(1, "base one");
    lane.commit(2, "base two");
    lane.repo.push("origin", "main", true);
    lane.commit(3, "upstream three");
    lane.commit(4, "upstream four");
    lane.repo.push("origin", "main", false);
    lane.repo.reset_hard("HEAD~2");
    lane.commit(5, "local five");
    lane.commit(6, "local six");
    lane.repo.fetch("origin");
}

fn build_06(out: &Path) {
    let mut lane = init_repo(out, "06-tag-only-chain");
    lane.commit(1, "base one");
    lane.commit(2, "base two");
    lane.repo.branch("scratch");
    lane.repo.checkout("scratch");
    lane.commit(3, "released one");
    lane.commit(4, "released two");
    lane.repo.tag("v1.0.0", "HEAD");
    lane.repo.checkout("main");
    lane.repo.delete_branch("scratch");
}

fn build_07(out: &Path) {
    let mut lane = init_repo(out, "07-tag-on-unpulled");
    lane.add_remote("origin");
    lane.commit(1, "base one");
    lane.commit(2, "base two");
    lane.repo.push("origin", "main", true);
    lane.commit(3, "upstream three");
    lane.commit(4, "upstream four");
    lane.repo.tag("v2.0.0", "HEAD~1");
    lane.repo.push("origin", "main", false);
    lane.repo.reset_hard("HEAD~2");
    lane.repo.fetch("origin");
}

fn build_08(out: &Path) {
    let mut lane = init_repo(out, "08-stash-on-tip-behind");
    lane.add_remote("origin");
    lane.commit(1, "base one");
    lane.commit(2, "base two");
    lane.repo.push("origin", "main", true);
    lane.commit(3, "upstream three");
    lane.commit(4, "upstream four");
    lane.repo.push("origin", "main", false);
    lane.repo.reset_hard("HEAD~2");
    lane.repo
        .write(&format!("{}.txt", slug("base two")), "half-finished\n");
    lane.stash(9, "half-finished work");
    lane.repo.fetch("origin");
}

fn build_09(out: &Path) {
    let mut lane = init_repo(out, "09-branch-point-below-head");
    lane.add_remote("origin");
    lane.commit(1, "base one");
    lane.commit(2, "base two");
    lane.repo.push("origin", "main", true);
    lane.repo.branch("feature");
    lane.repo.checkout("feature");
    lane.commit(3, "feature one");
    lane.commit(4, "feature two");
    lane.repo.push("origin", "feature", true);
    lane.repo.checkout("main");
    lane.commit(5, "upstream five");
    lane.commit(6, "upstream six");
    lane.repo.push("origin", "main", false);
    lane.repo.reset_hard("HEAD~2");
    lane.repo.fetch("origin");
}

fn build_10(out: &Path) {
    let mut lane = init_repo(out, "10-two-remotes");
    lane.add_remote("origin");
    lane.add_remote("upstream");
    lane.commit(1, "base one");
    lane.commit(2, "base two");
    lane.repo.push("origin", "main", true);
    lane.repo.push("upstream", "main", false);
    lane.commit(3, "shared three");
    lane.commit(4, "shared four");
    lane.repo.push("origin", "main", false);
    lane.repo.push("upstream", "main", false);
    lane.repo.reset_hard("HEAD~2");
    lane.repo.fetch("origin");
    lane.repo.fetch("upstream");
}

fn build_11(out: &Path) {
    let mut lane = init_repo(out, "11-merge-in-head-chain");
    lane.add_remote("origin");
    lane.commit(1, "base one");
    lane.repo.branch("side");
    lane.repo.checkout("side");
    lane.commit(2, "side one");
    lane.repo.checkout("main");
    lane.commit(3, "main two");
    lane.repo.merge(day(4), "merge side into main", &["side"]);
    lane.repo.push("origin", "main", true);
    lane.commit(5, "upstream five");
    lane.commit(6, "upstream six");
    lane.repo.push("origin", "main", false);
    lane.repo.reset_hard("HEAD~2");
    lane.repo.fetch("origin");
}

fn build_12(out: &Path) {
    let mut lane = init_repo(out, "12-author-vs-committer");
    lane.commit(1, "base one");
    lane.repo.branch("alpha");
    lane.repo.checkout("alpha");
    lane.commit_split(30, 2, "alpha tip looks newest");
    lane.repo.checkout("main");
    lane.repo.branch("beta");
    lane.repo.checkout("beta");
    lane.commit_split(2, 20, "beta tip is newest");
    lane.repo.checkout_detached("main");
}

fn build_13(out: &Path) {
    let mut lane = init_repo(out, "13-tall-linear");
    for on in 1..=30 {
        lane.commit(on, &format!("tall {on:02}"));
    }
}

fn build(out: &Path) {
    build_01(out);
    build_02(out);
    build_03(out);
    build_04(out);
    build_05(out);
    build_06(out);
    build_07(out);
    build_08(out);
    build_09(out);
    build_10(out);
    build_11(out);
    build_12(out);
    build_13(out);
}

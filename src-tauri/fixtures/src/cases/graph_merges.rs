//! Case 05: merge, multi-branch, ordering and column-pressure shapes, including the
//! octopus and the criss-cross. Transcribed from cases/05-graph-merges/build.sh.

use std::path::Path;

use super::Case;
use crate::repo::{Identity, Repo, Signature};

const QA: Identity = Identity {
    name: "QA Fixture",
    email: "qa@trunk.test",
};
const BASE_SECS: i64 = 1_767_225_600;
const DAY_SECS: i64 = 86_400;

pub const CASE: Case = Case {
    name: "05-graph-merges",
    summary: "Fourteen repos for merge, multi-branch, ordering and column-pressure shapes.",
    repos: &[
        "graph-merges/01-octopus-merge",
        "graph-merges/02-criss-cross",
        "graph-merges/03-merge-of-merges",
        "graph-merges/04-three-topics",
        "graph-merges/05-sequential-merges",
        "graph-merges/06-merge-second-parent-newer",
        "graph-merges/07-fork-sibling-older",
        "graph-merges/08-fork-sibling-newer",
        "graph-merges/09-column-saturation",
        "graph-merges/10-merge-parent-left",
        "graph-merges/11-fork-in-left",
        "graph-merges/12-pagination-boundary",
        "graph-merges/13-freed-column-left",
        "graph-merges/14-spiral-right-before-left",
    ],
    build,
};

fn day(n: i64) -> Signature {
    QA.at(BASE_SECS + n * DAY_SECS)
}

fn init_repo(out: &Path, name: &str) -> Repo {
    let mut repo = Repo::init(&out.join("graph-merges").join(name), "main", QA);
    repo.config("commit.gpgsign", "false");

    repo
}

/// `commit <repo> <day> <message>`: write `<slug>.txt`, stage everything, commit.
fn commit(repo: &mut Repo, on: i64, msg: &str) {
    repo.write(
        &format!("{}.txt", msg.replace(' ', "-")),
        &format!("{msg}\n"),
    );
    repo.add_all();
    repo.commit(day(on), msg);
}

/// `git checkout -b <name> [<start>]`.
fn checkout_new(repo: &mut Repo, name: &str, start: Option<&str>) {
    match start {
        Some(start) => repo.branch_at(name, start),
        None => repo.branch(name),
    }
    repo.checkout(name);
}

/// `merge <repo> <day> <message> <committish...>`: always --no-ff.
fn merge(repo: &mut Repo, on: i64, msg: &str, heads: &[&str]) {
    repo.merge(day(on), msg, heads);
}

fn build_01(out: &Path) {
    let mut repo = init_repo(out, "01-octopus-merge");
    commit(&mut repo, 1, "base one");
    checkout_new(&mut repo, "topic-a", None);
    commit(&mut repo, 2, "topic a one");
    repo.checkout("main");
    checkout_new(&mut repo, "topic-b", None);
    commit(&mut repo, 3, "topic b one");
    repo.checkout("main");
    checkout_new(&mut repo, "topic-c", None);
    commit(&mut repo, 4, "topic c one");
    repo.checkout("main");
    commit(&mut repo, 5, "main two");
    merge(
        &mut repo,
        6,
        "octopus three topics",
        &["topic-a", "topic-b", "topic-c"],
    );
}

fn build_02(out: &Path) {
    let mut repo = init_repo(out, "02-criss-cross");
    commit(&mut repo, 1, "base one");
    checkout_new(&mut repo, "alpha", None);
    commit(&mut repo, 2, "alpha one");
    repo.checkout("main");
    checkout_new(&mut repo, "beta", None);
    commit(&mut repo, 3, "beta one");
    repo.checkout("alpha");
    merge(&mut repo, 4, "alpha takes beta", &["beta"]);
    repo.checkout("beta");
    merge(&mut repo, 5, "beta takes alpha", &["alpha~1"]);
    repo.checkout("alpha");
}

fn build_03(out: &Path) {
    let mut repo = init_repo(out, "03-merge-of-merges");
    commit(&mut repo, 1, "base one");
    checkout_new(&mut repo, "feed-a", None);
    commit(&mut repo, 2, "feed a one");
    repo.checkout("main");
    checkout_new(&mut repo, "feed-b", None);
    commit(&mut repo, 3, "feed b one");
    repo.checkout("main");
    checkout_new(&mut repo, "left", None);
    commit(&mut repo, 4, "left one");
    merge(&mut repo, 5, "left takes feed a", &["feed-a"]);
    repo.checkout("main");
    checkout_new(&mut repo, "right", None);
    commit(&mut repo, 6, "right one");
    merge(&mut repo, 7, "right takes feed b", &["feed-b"]);
    repo.checkout("left");
    merge(&mut repo, 8, "merge of two merges", &["right"]);
}

fn build_04(out: &Path) {
    let mut repo = init_repo(out, "04-three-topics");
    commit(&mut repo, 1, "base one");
    commit(&mut repo, 2, "main two");
    for n in ["one", "two", "three", "four"] {
        checkout_new(&mut repo, &format!("topic-{n}"), Some("main~1"));
    }
    repo.checkout("topic-one");
    commit(&mut repo, 3, "topic one work");
    repo.checkout("topic-two");
    commit(&mut repo, 4, "topic two work");
    repo.checkout("topic-three");
    commit(&mut repo, 5, "topic three work");
    repo.checkout("topic-four");
    commit(&mut repo, 6, "topic four work");
    repo.checkout("main");
}

fn build_05(out: &Path) {
    let mut repo = init_repo(out, "05-sequential-merges");
    commit(&mut repo, 1, "base one");
    for (on, n) in (2..).zip(["one", "two", "three"]) {
        checkout_new(&mut repo, &format!("feature-{n}"), Some("main"));
        commit(&mut repo, on, &format!("feature {n} work"));
        repo.checkout("main");
    }
    merge(&mut repo, 6, "main takes feature one", &["feature-one"]);
    merge(&mut repo, 7, "main takes feature two", &["feature-two"]);
    merge(&mut repo, 8, "main takes feature three", &["feature-three"]);
}

fn build_06(out: &Path) {
    let mut repo = init_repo(out, "06-merge-second-parent-newer");
    commit(&mut repo, 1, "base one");
    commit(&mut repo, 2, "main two");
    checkout_new(&mut repo, "side", Some("main~1"));
    commit(&mut repo, 9, "side one is newest");
    repo.checkout("main");
    merge(&mut repo, 10, "main takes side", &["side"]);
}

fn build_07(out: &Path) {
    let mut repo = init_repo(out, "07-fork-sibling-older");
    commit(&mut repo, 1, "base one");
    checkout_new(&mut repo, "side", None);
    commit(&mut repo, 2, "side tip");
    repo.checkout("main");
    commit(&mut repo, 5, "main one");
    commit(&mut repo, 6, "main two");
}

fn build_08(out: &Path) {
    let mut repo = init_repo(out, "08-fork-sibling-newer");
    commit(&mut repo, 1, "base one");
    checkout_new(&mut repo, "side", None);
    commit(&mut repo, 7, "side tip");
    repo.checkout("main");
    commit(&mut repo, 5, "main one");
    commit(&mut repo, 6, "main two");
}

fn build_09(out: &Path) {
    let mut repo = init_repo(out, "09-column-saturation");
    commit(&mut repo, 1, "base one");
    commit(&mut repo, 25, "main two");
    for (on, n) in (16..=20).rev().zip(["one", "two", "three", "four", "five"]) {
        checkout_new(&mut repo, &format!("lane-{n}"), Some("main~1"));
        commit(&mut repo, on, &format!("lane {n} work"));
    }
    repo.checkout_orphan("orphan");
    commit(&mut repo, 22, "orphan root");
    commit(&mut repo, 30, "orphan tip");
    repo.checkout("main");
}

fn build_10(out: &Path) {
    let mut repo = init_repo(out, "10-merge-parent-left");
    commit(&mut repo, 1, "base one");
    commit(&mut repo, 2, "main two");
    checkout_new(&mut repo, "feature", Some("main~1"));
    commit(&mut repo, 3, "feature one");
    merge(&mut repo, 4, "feature takes main", &["main"]);
    repo.checkout("main");
}

fn build_11(out: &Path) {
    let mut repo = init_repo(out, "11-fork-in-left");
    commit(&mut repo, 1, "base one");
    checkout_new(&mut repo, "shared", None);
    commit(&mut repo, 2, "shared point");
    checkout_new(&mut repo, "alpha", None);
    commit(&mut repo, 3, "alpha one");
    repo.checkout("main");
    commit(&mut repo, 4, "main two");
    merge(&mut repo, 9, "main takes shared", &["shared"]);
    repo.checkout("alpha");
    commit(&mut repo, 10, "alpha two is newest");
    repo.checkout("main");
}

fn build_12(out: &Path) {
    let mut repo = init_repo(out, "12-pagination-boundary");
    commit(&mut repo, 1, "base one");
    checkout_new(&mut repo, "side", Some("main"));
    commit(&mut repo, 2, "side one");
    commit(&mut repo, 3, "side two");
    repo.checkout("main");
    commit(&mut repo, 4, "main two");
    commit(&mut repo, 5, "main three");
    merge(&mut repo, 6, "main takes side", &["side"]);
    commit(&mut repo, 7, "main four");
    checkout_new(&mut repo, "late", Some("main~2"));
    commit(&mut repo, 8, "late tip");
    repo.checkout("main");
}

fn build_13(out: &Path) {
    let mut repo = init_repo(out, "13-freed-column-left");
    commit(&mut repo, 1, "base one");
    commit(&mut repo, 24, "main two");
    commit(&mut repo, 25, "main three");
    checkout_new(&mut repo, "beta", Some("main~2"));
    commit(&mut repo, 3, "beta bottom");
    commit(&mut repo, 29, "beta top");
    checkout_new(&mut repo, "gamma", Some("main~2"));
    commit(&mut repo, 28, "gamma tip");
    checkout_new(&mut repo, "delta", Some("beta~1"));
    commit(&mut repo, 4, "delta steps back to column one");
    repo.checkout_orphan("orphan");
    commit(&mut repo, 5, "orphan root");
    commit(&mut repo, 30, "orphan tip");
    repo.checkout("main");
}

fn build_14(out: &Path) {
    let mut repo = init_repo(out, "14-spiral-right-before-left");
    commit(&mut repo, 1, "base one");
    commit(&mut repo, 24, "main two");
    commit(&mut repo, 25, "main three");
    checkout_new(&mut repo, "beta", Some("main~2"));
    commit(&mut repo, 3, "beta bottom");
    commit(&mut repo, 29, "beta top");
    checkout_new(&mut repo, "delta", Some("beta~1"));
    commit(&mut repo, 4, "delta lands right of beta");
    repo.checkout_orphan("orphan");
    commit(&mut repo, 5, "orphan root");
    commit(&mut repo, 30, "orphan tip");
    repo.checkout("main");
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
    build_14(out);
}

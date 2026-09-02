//! Case 01: one repository per path where Trunk decides whether to open a message editor,
//! what to pre-fill it with, and what an empty message does. Transcribed from
//! cases/01-commit-message/build.sh.

use std::path::Path;

use super::Case;
use crate::repo::{Identity, Repo, Signature};

const FIXTURE: Identity = Identity {
    name: "Trunk Fixture",
    email: "fixture@trunk.test",
};
const BASE_SECS: i64 = 1_767_225_600;
const DAY_SECS: i64 = 86_400;

pub const CASE: Case = Case {
    name: "01-commit-message",
    summary: "Five repos for the commit-message editor: merge, fast-forward, conflict, revert, abort.",
    repos: &[
        "01-nonff-merge",
        "02-ff-merge",
        "03-conflict-merge",
        "04-revert",
        "05-empty-message-abort",
    ],
    build,
};

fn day(n: i64) -> Signature {
    FIXTURE.at(BASE_SECS + n * DAY_SECS)
}

/// `fixture_repo <name>`.
fn fixture_repo(out: &Path, name: &str) -> Repo {
    let mut repo = Repo::init(&out.join(name), "main", FIXTURE);
    repo.config("commit.gpgsign", "false");

    repo
}

/// `fixture_write <repo> <path> <content>`: the content plus one newline.
fn fixture_write(repo: &mut Repo, rel: &str, content: &str) {
    repo.write(rel, &format!("{content}\n"));
}

/// `fixture_scenario <repo> <text>`: SCENARIO.md, the text plus one newline.
fn fixture_scenario(repo: &mut Repo, text: &str) {
    repo.write("SCENARIO.md", &format!("{text}\n"));
}

/// `fixture_commit <repo> <day> <message>` with no paths: stage everything.
fn fixture_commit(repo: &mut Repo, on: i64, msg: &str) {
    repo.add_all();
    repo.commit(day(on), msg);
}

fn build_01_nonff_merge(out: &Path) {
    let mut repo = fixture_repo(out, "01-nonff-merge");
    fixture_write(&mut repo, "base.txt", "shared base");
    fixture_scenario(
        &mut repo,
        "# Case 1 — Non-fast-forward merge (MSG-02)

main and `feature` diverged from a common base; they touch DIFFERENT files,
so the merge is non-ff and clean (a real merge commit, no conflicts).

Steps in Trunk (open this folder), on branch `main`:
1. Merge `feature` into main from the **CommitGraph context menu**.
   Expect: editor titled \"Merge commit message\", pre-filled `Merge branch 'feature'`.
   Edit + save -> the merge commit body matches your edit.
2. Rebuild and repeat, merging `feature` from the **BranchSidebar** -> same editor.",
    );
    fixture_commit(&mut repo, 0, "C0: base + scenario");
    repo.branch("feature");
    fixture_write(&mut repo, "main-only.txt", "added on main");
    fixture_commit(&mut repo, 1, "C1 (main): add main-only.txt");
    repo.checkout("feature");
    fixture_write(&mut repo, "feature-only.txt", "added on feature");
    fixture_commit(&mut repo, 2, "F1 (feature): add feature-only.txt");
    repo.checkout("main");
}

fn build_02_ff_merge(out: &Path) {
    let mut repo = fixture_repo(out, "02-ff-merge");
    fixture_write(&mut repo, "base.txt", "shared base");
    fixture_scenario(
        &mut repo,
        "# Case 2 — Fast-forwardable merge (success criterion 5)

`feature` is strictly ahead of main (main is its ancestor), so merging is a
fast-forward: NO merge commit is created and NO editor should appear.

Steps in Trunk (open this folder), on branch `main`:
1. Merge `feature` into main.
   Expect: NO editor opens, main fast-forwards to feature, no merge commit.",
    );
    fixture_commit(&mut repo, 0, "C0: base + scenario");
    repo.branch("feature");
    repo.checkout("feature");
    fixture_write(&mut repo, "feature-1.txt", "feature commit 1");
    fixture_commit(&mut repo, 1, "F1 (feature): add feature-1.txt");
    fixture_write(&mut repo, "feature-2.txt", "feature commit 2");
    fixture_commit(&mut repo, 2, "F2 (feature): add feature-2.txt");
    repo.checkout("main");
}

fn build_03_conflict_merge(out: &Path) {
    let mut repo = fixture_repo(out, "03-conflict-merge");
    fixture_write(&mut repo, "base.txt", "shared base");
    fixture_scenario(
        &mut repo,
        "# Case 3 — Conflicting merge, finished through the modal (MSG-01)

main and `feature` change the SAME line of conflict.txt, so merging conflicts.

Steps in Trunk (open this folder), on branch `main`:
1. Merge `feature` into main -> conflict on conflict.txt.
2. Resolve the conflict in the StagingPanel, then click **\"Commit merge\"**.
   Expect: the MODAL opens (NOT the old inline subject/body form), titled
   \"Merge commit message\", pre-filled from .git/MERGE_MSG.
   The resulting commit body must contain NO `# Conflicts:` lines.",
    );
    repo.write("conflict.txt", "line one\noriginal middle\nline three\n");
    fixture_commit(&mut repo, 0, "C0: base + scenario + conflict.txt");
    repo.branch("feature");
    repo.write("conflict.txt", "line one\nMAIN CHANGE\nline three\n");
    fixture_commit(&mut repo, 1, "C1 (main): edit middle line");
    repo.checkout("feature");
    repo.write("conflict.txt", "line one\nFEATURE CHANGE\nline three\n");
    fixture_commit(&mut repo, 2, "F1 (feature): edit middle line");
    repo.checkout("main");
}

fn build_04_revert(out: &Path) {
    let mut repo = fixture_repo(out, "04-revert");
    fixture_write(&mut repo, "base.txt", "shared base");
    fixture_scenario(
        &mut repo,
        "# Case 4 — Revert a commit (MSG-03)

Linear history; each commit adds an independent file, so reverting any of them
is clean (no conflict).

Steps in Trunk (open this folder), on branch `main`:
1. Revert commit \"C2: add beta.txt\" (or any of C1/C2/C3) from the graph.
   Expect: editor titled \"Revert commit message\", pre-filled
   `Revert \"C2: add beta.txt\"` then a blank line then
   `This reverts commit <full-40-char-oid>.`
   Save -> the revert commit lands with your (possibly edited) message.",
    );
    fixture_commit(&mut repo, 0, "C0: base + scenario");
    fixture_write(&mut repo, "alpha.txt", "alpha");
    fixture_commit(&mut repo, 1, "C1: add alpha.txt");
    fixture_write(&mut repo, "beta.txt", "beta");
    fixture_commit(&mut repo, 2, "C2: add beta.txt");
    fixture_write(&mut repo, "gamma.txt", "gamma");
    fixture_commit(&mut repo, 3, "C3: add gamma.txt");
}

fn build_05_empty_message_abort(out: &Path) {
    let mut repo = fixture_repo(out, "05-empty-message-abort");
    fixture_write(&mut repo, "base.txt", "shared base");
    fixture_scenario(
        &mut repo,
        "# Case 5 — Empty / whitespace message aborts cleanly (MSG-06)

This repo supports BOTH abort-recovery paths:

A) MERGE abort:
   `feature` diverged from main on different files (non-ff, clean).
   1. Merge `feature` into main -> editor opens.
   2. Clear the message (or type only spaces) and save/confirm.
      Expect: NO commit created; OperationBanner shows the in-progress merge;
      clicking **Abort** recovers to a clean main.

B) REVERT abort (the newest affordance):
   1. Revert commit \"C1: add revert-target.txt\" from the graph -> editor opens.
   2. Clear the message and save/confirm.
      Expect: NO commit; OperationBanner shows the Revert state with
      **Continue** + **Abort** buttons; Abort clears REVERT_HEAD -> clean main.

Rebuild between A and B with `./build 01-commit-message`.",
    );
    fixture_commit(&mut repo, 0, "C0: base + scenario");
    fixture_write(&mut repo, "revert-target.txt", "revert me");
    fixture_commit(&mut repo, 1, "C1: add revert-target.txt");
    repo.branch("feature");
    fixture_write(&mut repo, "main-only.txt", "added on main");
    fixture_commit(&mut repo, 2, "C2 (main): add main-only.txt");
    repo.checkout("feature");
    fixture_write(&mut repo, "feature-only.txt", "added on feature");
    fixture_commit(&mut repo, 3, "F1 (feature): add feature-only.txt");
    repo.checkout("main");
}

fn build(out: &Path) {
    build_01_nonff_merge(out);
    build_02_ff_merge(out);
    build_03_conflict_merge(out);
    build_04_revert(out);
    build_05_empty_message_abort(out);
}

//! Case 07: the create-branch walk against a real origin carrying two remote-only
//! branches, with a worktree dirty the one way the backend counts (a modified tracked
//! file). Transcribed from cases/07-remote-branch/build.sh. The shell dated its commits in
//! local time; the port pins them to UTC (doc-45 §1, decision 3).

use std::path::Path;

use super::Case;
use crate::repo::{Identity, Repo, init_bare};

const QA: Identity = Identity {
    name: "Trunk QA",
    email: "qa@example.invalid",
};
const STAMP_SECS: i64 = 1_750_000_000;
const HOUR_SECS: i64 = 3_600;

pub const CASE: Case = Case {
    name: "07-remote-branch",
    summary: "Build the fixture repo for the create_branch -> dirty_workdir manual walk.",
    repos: &["remote-branch/repo", "remote-branch/origin.git"],
    build,
};

/// The working repository and the clock the script advances before each commit.
struct Walk {
    repo: Repo,
    stamp: i64,
}

impl Walk {
    /// `commit <message>`: the stamp advances an hour, everything is already staged.
    fn commit(&mut self, msg: &str) {
        self.stamp += HOUR_SECS;
        self.repo.commit(QA.at(self.stamp), msg);
    }

    /// `printf ... >>"$WORK/<rel>"`.
    fn append(&mut self, rel: &str, text: &str) {
        let mut content =
            std::fs::read_to_string(self.repo.path().join(rel)).expect("read the file");
        content.push_str(text);
        self.repo.write(rel, &content);
    }
}

fn build(out: &Path) {
    let dest = out.join("remote-branch");
    let origin = dest.join("origin.git");
    init_bare(&origin, Some("main"));
    let mut repo = Repo::init(&dest.join("repo"), "main", QA);
    repo.remote_add("origin", &origin);
    let mut walk = Walk {
        repo,
        stamp: STAMP_SECS,
    };

    walk.repo.write(
        "README.md",
        "# Fixture\n\nA repo for the create_branch walk.\n",
    );
    walk.repo
        .write("version.ts", "export const VERSION = \"0.1.0\";\n");
    walk.repo.add_all();
    walk.commit("Add README and version");

    for n in 1..=3 {
        walk.append("version.ts", &format!("export const STEP_{n} = {n};\n"));
        walk.repo.add_all();
        walk.commit(&format!("Extend version with step {n}"));
    }

    for branch in ["feature/alpha", "feature/beta"] {
        walk.repo.branch(branch);
        walk.repo.checkout(branch);
        let constant = branch.to_uppercase().replace('/', "_");
        walk.append("version.ts", &format!("export const {constant} = true;\n"));
        walk.repo.add_all();
        walk.commit(&format!("Work on {branch}"));
        walk.repo.push("origin", branch, false);
        walk.repo.checkout("main");
        walk.repo.delete_branch(branch);
    }

    walk.repo.push("origin", "main", true);

    walk.append(
        "README.md",
        "\nAn uncommitted edit. Do not commit this — it is the fixture.\n",
    );

    std::fs::write(dest.join("WALKTHROUGH.md"), WALKTHROUGH).expect("write the walkthrough");
}

/// The walk's instructions, verbatim from the script's heredoc.
const WALKTHROUGH: &str = r##"# create_branch -> dirty_workdir: manual walk

Open the repo at `repo/` in Trunk (the **dev** build — `just dev`; a computer-use
click activates the installed app, not `target/debug/trunk`).

**Before you start**, confirm the fixture is actually dirty:

    git -C repo status --short      # expect exactly:  M README.md

If that line is missing, stop — every gesture below will take the success path
and the walk proves nothing.

Backend behaviour being exercised: `create_branch` creates the branch, THEN
checks the working tree, and returns `dirty_workdir` with the branch already
created and HEAD unmoved (`src-tauri/src/commands/branches.rs:386-397`). All
five sites below receive that same outcome. They answer it four different ways.

Record what you see in the "Observed" column. Any difference from "Expected" is
a regression introduced by the error-reporting sweep.

| # | Gesture | Expected today | Observed |
|---|---------|----------------|----------|
| 1 | Sidebar -> Remote -> click `feature/alpha` | **RED** error toast reading "Branch created but working tree has uncommitted changes — checkout skipped". Local `feature/alpha` IS created but does **not** appear in the sidebar. | |
| 2 | Sidebar -> new-branch input -> `qa-sidebar` | **GREEN** toast "Branch created (checkout skipped — uncommitted changes)". `qa-sidebar` **appears** in the sidebar. | |
| 3 | Toolbar branch button -> `qa-toolbar` | **GREEN** toast, identical copy. `qa-toolbar` does **not** appear until something else refreshes. | |
| 4 | Graph -> right-click any commit -> Create Branch -> `qa-graph` | **GREEN** toast, identical copy. `qa-graph` does **not** appear until refresh. No modal. | |
| 5 | Graph -> click the `origin/feature/beta` ref pill | **RED** error toast, same message as #1. Local `feature/beta` created, not shown. | |

Three of the five report success for an outcome the other two report as failure,
and three of the five leave a branch the user cannot see. That asymmetry is the
CURRENT behaviour and is what this walk pins — it is not what you are being
asked to judge.

Confirm the branches really were created, despite what the UI said:

    git -C repo branch --list

Expect all five: `feature/alpha`, `feature/beta`, `qa-graph`, `qa-sidebar`,
`qa-toolbar` — plus `main`, which is still HEAD.

## Control: the clean path

Prove the fixture was the variable, not the app:

    git -C repo checkout -- README.md
    git -C repo status --short      # expect: no output

Now repeat gesture 2 with a fresh name, e.g. `qa-clean`. Expect a **GREEN**
toast reading "Checked out qa-clean", and HEAD moves to it. Different copy from
the dirty path — that is how you know the dirty path was really taken above.

## Reset

Re-run the builder. Each gesture leaves a branch behind even when the checkout
is skipped, and `create_branch` refuses an existing name, so a second pass over
a used fixture reports "branch exists" instead of `dirty_workdir`.
"##;

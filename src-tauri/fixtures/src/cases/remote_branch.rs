//! Case 07: the checkout and create-branch walk against a real origin carrying two
//! remote-only branches, with an uncommitted edit to a tracked file none of the
//! branches touch. Transcribed from cases/07-remote-branch/build.sh. The shell dated
//! its commits in local time; the port pins them to UTC (doc-45 §1, decision 3).

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
    summary: "The manual walk of checking out and creating branches over an uncommitted edit.",
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

/// The walk's instructions: each of the seven routes that creates or checks out a
/// branch, over an uncommitted edit none of the branches touch, then each route that
/// moves the tree over an edit they do.
const WALKTHROUGH: &str = r##"# Checking out and creating branches over uncommitted changes: manual walk

Open the repo at `repo/` in Trunk. `just dev-app` builds a debug app you can drive
and screenshot (docs/build-environment.md).

**Before you start**, confirm the fixture is dirty:

    git -C repo status --short      # expect exactly:  M README.md

If that line is missing, stop. Every gesture below would take the clean path and
the walk would prove nothing.

What is being exercised: creating or checking out a branch moves the working tree
the way `git switch` does. An edit the target branch does not touch rides along
onto it. An edit it would overwrite refuses the whole move, and nothing is
written: no branch, no HEAD change, no file touched.

`feature/alpha` and `feature/beta` change only `version.ts`, so the README edit
rides along on every gesture. Do them in order, since each one moves HEAD. After
each, README.md is still listed as modified.

| # | Gesture | Expected | Observed |
|---|---------|----------|----------|
| 1 | Sidebar -> Remote -> double-click `feature/alpha` | Toast "Checked out feature/alpha". `feature/alpha` appears under Local tagged HEAD. The sidebar does not show tracking; `git branch -vv` below does. | |
| 2 | Sidebar -> new-branch input -> `qa-sidebar` | Toast "Checked out qa-sidebar", HEAD on it. | |
| 3 | Toolbar branch button -> `qa-toolbar` | Toast "Checked out qa-toolbar", HEAD on it. | |
| 4 | Graph -> right-click "Add README and version" -> Create Branch... -> `qa-graph` | Toast "Checked out qa-graph", HEAD on it at that commit. | |
| 5 | Sidebar -> Local -> double-click `main` | Toast "Checked out main", HEAD on it. | |
| 6 | Graph -> double-click the local branch pill on "Work on feature/alpha" | Toast "Checked out" with the name on the pill (`feature/alpha`, `qa-sidebar` or `qa-toolbar`), HEAD on it. | |
| 7 | Graph -> double-click the `origin/feature/beta` ref pill on "Work on feature/beta" | Toast "Checked out feature/beta", HEAD on it. | |

Confirm with git:

    git -C repo branch -vv          # six branches (main, feature/alpha,
                                    # feature/beta, qa-sidebar, qa-toolbar,
                                    # qa-graph), HEAD on feature/beta, both
                                    # feature branches tracking origin
    git -C repo status --short      # still:  M README.md

## The conflict path

Make an edit the other branches would overwrite:

    git -C repo checkout -- README.md
    printf 'export const LOCAL = 1;\n' >> repo/version.ts

Creating a branch at HEAD never moves the tree, so only the gestures that move it
can conflict. HEAD is on `feature/beta`, whose `version.ts` differs from that of
every commit named below. Each of these shows the error toast "Your uncommitted
changes conflict with this branch. Commit or stash them first.":

| # | Gesture | Also expected | Observed |
|---|---------|---------------|----------|
| 8 | Sidebar -> Local -> double-click `main` | The same message beside the `main` row. | |
| 9 | Sidebar -> Remote -> double-click `feature/alpha` | | |
| 10 | Graph -> double-click the local branch pill on "Work on feature/alpha" | | |
| 11 | Graph -> hover the pill on "Work on feature/alpha" and double-click `origin/feature/alpha` in the list that opens | | |
| 12 | Graph -> right-click "Add README and version" -> Create Branch... -> `qa-refused` | `qa-refused` does not exist afterwards. | |

After each one HEAD is still on `feature/beta` and `version.ts` still holds the
edit:

    git -C repo branch --list       # no qa-refused
    git -C repo diff --stat         # version.ts only

## Reset

Re-run the builder (`just fixtures 07-remote-branch`) before another pass. A used
fixture has lost the README edit, already holds the branches the walk creates, and
checks out the existing local branch where a remote one is double-clicked, so a
second pass would not exercise the same routes.
"##;

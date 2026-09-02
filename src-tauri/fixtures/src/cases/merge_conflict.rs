//! Case 08: a merge left stopped with five conflicting lines in three regions of one long
//! file, so the merge editor's header bars can be compared against each other.
//! Transcribed from cases/08-merge-conflict/build.sh. The shell dated its commits in
//! local time; the port pins them to UTC (doc-45 §1, decision 3).

use std::path::Path;

use super::Case;
use crate::repo::{Identity, Repo};

const QA: Identity = Identity {
    name: "Trunk QA",
    email: "qa@example.invalid",
};
const STAMP_SECS: i64 = 1_750_000_000;
const HOUR_SECS: i64 = 3_600;

pub const CASE: Case = Case {
    name: "08-merge-conflict",
    summary: "Build a repo whose merge conflicts exercise the merge editor's chrome.",
    repos: &["merge-conflict/repo"],
    build,
};

const BASE: &str = "export const NAME = \"trunk\";
export const VERSION = \"1.0.0\";

const FILLER_A = 1;
const FILLER_B = 2;
const FILLER_C = 3;
const FILLER_D = 4;
const FILLER_E = 5;

export const TIMEOUT_MS = 1000;
export const RETRIES = 3;

const FILLER_F = 6;
const FILLER_G = 7;
const FILLER_H = 8;
const FILLER_I = 9;
const FILLER_J = 10;

export const THEME = \"dark\";
export const DENSITY = \"comfortable\";
";

/// `sed -e 's/old/new/'` on a line the base holds once: the substitution must land
/// exactly once or the fixture is not the one the script describes.
fn replace_once(repo: &mut Repo, rel: &str, old: &str, new: &str) {
    let text = std::fs::read_to_string(repo.path().join(rel)).expect("read the file");
    assert!(
        text.matches(old).count() == 1,
        "{rel}: pattern not unique or missing: {old:?}"
    );
    repo.write(rel, &text.replace(old, new));
}

fn retune(
    repo: &mut Repo,
    version: &str,
    timeout: &str,
    retries: &str,
    theme: &str,
    density: &str,
) {
    let edits = [
        (
            "export const VERSION = \"1.0.0\";",
            format!("export const VERSION = \"{version}\";"),
        ),
        (
            "export const TIMEOUT_MS = 1000;",
            format!("export const TIMEOUT_MS = {timeout};"),
        ),
        (
            "export const RETRIES = 3;",
            format!("export const RETRIES = {retries};"),
        ),
        (
            "export const THEME = \"dark\";",
            format!("export const THEME = \"{theme}\";"),
        ),
        (
            "export const DENSITY = \"comfortable\";",
            format!("export const DENSITY = \"{density}\";"),
        ),
    ];
    for (old, new) in edits {
        replace_once(repo, "settings.ts", old, &new);
    }
}

fn build(out: &Path) {
    let work = out.join("merge-conflict").join("repo");
    let mut repo = Repo::init(&work, "main", QA);
    let mut stamp = STAMP_SECS;
    let mut commit = |repo: &mut Repo, msg: &str| {
        stamp += HOUR_SECS;
        repo.commit(QA.at(stamp), msg);
    };

    repo.write("settings.ts", BASE);
    repo.write(
        "README.md",
        "# Merge conflict fixture\n\nOpen this repo and merge `topic` into `main`.\n",
    );
    repo.add_all();
    commit(&mut repo, "Add settings and README");

    repo.branch("topic");
    repo.checkout("topic");
    retune(
        &mut repo,
        "2.0.0-topic",
        "5000",
        "10",
        "midnight",
        "compact",
    );
    repo.add_all();
    commit(&mut repo, "Retune settings on the topic branch");

    repo.checkout("main");
    retune(&mut repo, "1.1.0", "2000", "5", "slate", "cozy");
    repo.add_all();
    commit(&mut repo, "Retune the same settings on main");

    repo.merge_stopped(None, "topic").expect(
        "08-merge-conflict: the merge did not conflict, the fixture is not exercising anything",
    );
    let conflicts = repo.conflicted_paths().len();

    repo.write("SCENARIO.md", &scenario(conflicts));
}

fn scenario(conflicts: usize) -> String {
    format!(
        "# Merge conflict — the editor's header bars

The repository is **left mid-merge on purpose**, with {conflicts} conflicted
file(s). Opening it should land on the conflicted state directly.

Open the conflicted file and compare the \"Conflict 1/2/3\" header bars against
each other, and against the pane bars above and below them.

They must all be the same height. The defect this fixture exists to reveal was
a bar rendering one pixel shorter than its neighbours, which is invisible
against a single header and obvious once two sit in the same viewport — which
is why the conflicts are spread down one long file rather than bunched.

Every automated check this project has runs in jsdom, which computes no layout,
so this one is looked at by a person.

Rebuild at any time with `./build 08-merge-conflict` — that also resets a
partly-resolved merge back to the stopped state.
"
    )
}

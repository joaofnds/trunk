//! Case 10: a merge stopped across four directory levels, plus one file git calls
//! resolved that still holds diff3 markers. No generator survived for the original, so
//! each commit's tree is replayed from the snapshots under content/nested-conflict.
//! Transcribed from cases/10-nested-conflict/build.sh.

use std::path::{Path, PathBuf};

use super::Case;
use crate::repo::{Identity, Repo, Signature};

const FIXTURE: Identity = Identity {
    name: "Trunk Fixture",
    email: "fixture@trunk.test",
};
const BASE_SECS: i64 = 1_767_225_600;
const DAY_SECS: i64 = 86_400;
const RESOLVED_WITH_MARKERS: &str = "lib/helpers/string/transform.ts";

pub const CASE: Case = Case {
    name: "10-nested-conflict",
    summary: "A repository parked mid-merge, conflicted across a deep directory tree.",
    repos: &["nested-conflict"],
    build,
};

fn day(n: i64) -> Signature {
    FIXTURE.at(BASE_SECS + n * DAY_SECS)
}

fn content() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("content")
        .join("nested-conflict")
}

/// `snapshot <label> <day> <message>`: the worktree becomes content/<label> exactly, then
/// is committed. Replacing the tree wholesale is what makes the commit's tree the
/// recorded snapshot.
fn snapshot(repo: &mut Repo, label: &str, on: i64, msg: &str) {
    empty_worktree(repo.path());
    copy_tree(&content().join(label), repo.path());
    repo.add_all();
    repo.commit(day(on), msg);
}

fn empty_worktree(workdir: &Path) {
    for entry in std::fs::read_dir(workdir).expect("list the worktree") {
        let path = entry.expect("read a worktree entry").path();
        if path.file_name().is_some_and(|name| name == ".git") {
            continue;
        }
        if path.is_dir() {
            std::fs::remove_dir_all(&path).expect("empty the worktree");
        } else {
            std::fs::remove_file(&path).expect("empty the worktree");
        }
    }
}

/// `cp -R <from>/. <to>/`, dotfiles included.
fn copy_tree(from: &Path, to: &Path) {
    for entry in std::fs::read_dir(from).expect("list the snapshot") {
        let entry = entry.expect("read a snapshot entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("stat a snapshot entry").is_dir() {
            std::fs::create_dir_all(&target).expect("create a snapshot directory");
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("copy a snapshot file");
        }
    }
}

fn build(out: &Path) {
    let mut repo = Repo::init(&out.join("nested-conflict"), "main", FIXTURE);
    repo.config("commit.gpgsign", "false");

    snapshot(
        &mut repo,
        "01-initial",
        0,
        "feat: initial app with greet, add, and formatDate",
    );
    snapshot(
        &mut repo,
        "02-string-utils",
        1,
        "feat: add string utilities",
    );

    repo.branch("feature/better-greeting");
    repo.checkout("feature/better-greeting");
    snapshot(&mut repo, "04-super-hello", 2, "super hello");
    snapshot(
        &mut repo,
        "05-time-of-day",
        3,
        "feat: time-of-day greetings, relative dates, user cards",
    );

    repo.checkout("main");
    snapshot(
        &mut repo,
        "03-i18n",
        4,
        "feat: add i18n greetings and ISO date format",
    );
    snapshot(
        &mut repo,
        "06-formal",
        5,
        "feat: formal greetings, math results, date formats, validation utils",
    );
    snapshot(
        &mut repo,
        "07-nested",
        6,
        "feat: add nested project structure with components, services, utils, and lib",
    );

    repo.branch_at("interactive-rebase", "HEAD~1");

    repo.branch("feature/refactor-nested-modules");
    repo.checkout("feature/refactor-nested-modules");
    snapshot(
        &mut repo,
        "08-theirs",
        7,
        "feat: extend APIs with new roles, session management, currency support, and date formats",
    );

    repo.checkout("main");
    snapshot(
        &mut repo,
        "09-ours",
        8,
        "feat: add AbortSignal support, owner role, Intl currency, timezone-aware dates",
    );

    repo.merge_stopped(
        Some("Merge branch 'feature/refactor-nested-modules'"),
        "feature/refactor-nested-modules",
    )
    .expect("nested-conflict: the merge did not conflict, the fixture proves nothing");

    repo.config("merge.conflictstyle", "diff3");
    repo.recheckout_diff3(RESOLVED_WITH_MARKERS);

    let conflicted = repo.conflicted_paths().len();
    assert!(
        conflicted > 0,
        "nested-conflict: the merge did not conflict, the fixture proves nothing"
    );
    let markers = std::fs::read_to_string(repo.path().join(RESOLVED_WITH_MARKERS))
        .expect("read the re-checked-out file")
        .lines()
        .filter(|line| {
            line.starts_with("<<<<<<<")
                || line.starts_with("|||||||")
                || line.starts_with(">>>>>>>")
        })
        .count();
    assert!(
        markers > 0,
        "nested-conflict: transform.ts was meant to stay full of markers while staged"
    );

    repo.write("SCENARIO.md", &format!("{}\n", scenario(conflicted)));
}

/// The scenario, verbatim from the script; fixture_scenario adds the final newline.
fn scenario(conflicted: usize) -> String {
    format!(
        r##"# Nested conflict — a stopped merge across a deep tree

The repository is **left mid-merge on purpose**. Opening it should land you in
the conflicted state directly, with no action needed first.

{conflicted} files are in conflict, spread over four directory levels:
`src/services/`, `src/utils/`, `src/components/` and `lib/helpers/`.

What to look at:

1. The staging panel's conflicted list — does it stay readable at {conflicted}
   files, and does the nesting group the way you expect?
2. The conflict header bars inside a file. Several are visible at once in the
   longer files; they should line up with each other and with the bars above
   and below them.
3. Resolving a subset. Resolve a few files and confirm the count and the
   Commit merge affordance track what is actually left.
4. `interactive-rebase` is a branch positioned so a rebase over its range
   replays a genuine multi-directory diff.

Both sides are real: `main` added AbortSignal support, an owner role, Intl
currency and timezone-aware dates; `feature/refactor-nested-modules` added
locale parameters, session management and new roles to the same functions.

Rebuild at any time with `cases/10-nested-conflict/build.sh` — that also
resets a partly-resolved merge back to the stopped state."##
    )
}

//! Case 12: history deeper than the graph's page size, for the jumps that have to
//! page commits in before they can land (TRUNK-137), and for what a rebuild does to
//! the pages the user already scrolled through (TRUNK-133).
//!
//! The graph loads 200 rows at a time. Jumping to a commit below that boundary --
//! from the branch sidebar, or from a search hit -- pages more history in until the
//! row appears. Every other case in the corpus fits inside a single page, so none of
//! them exercise that loop at all.
//!
//! The depth is the point: `main` carries enough commits that the interesting targets
//! sit three and four pages down, well past anything the first load brings back.

use std::path::Path;

use super::Case;
use crate::repo::{Identity, Repo, Signature};

const QA: Identity = Identity {
    name: "Trunk QA",
    email: "qa@example.invalid",
};

/// A name far wider than `Trunk QA`, on commits that sit below the first page. The
/// author column auto-fits to the widest name loaded, so this one sets the column's
/// width only once the user has paged down to it -- which is what makes a rebuild
/// that drops those pages visible as the column snapping narrow (TRUNK-133).
const WIDE: Identity = Identity {
    name: "Wilhelmina Wollstonecraft-Fairweather",
    email: "wilhelmina@example.invalid",
};
const STAMP_SECS: i64 = 1_750_000_000;
const HOUR_SECS: i64 = 3_600;
const HALF_HOUR: i64 = HOUR_SECS / 2;

/// One page of the commit graph. The frontend's own BATCH and the backend's PAGE are
/// both this, and a target below it cannot be reached without a second load.
const PAGE: usize = 200;

/// Deep enough that the oldest rows sit four pages down.
const DEPTH: usize = 4 * PAGE + 40;

/// Where the long-lived branch is rooted, counted in build order. The graph sorts by
/// topology and time, so its tip lands on the second page, just past the first load.
/// That is what the sidebar jump has to page history in to reach.
const ANCIENT_ROOT: usize = 3 * PAGE + 10;

/// The commit whose message the search scenario looks for, in build order. It renders
/// on the third page.
const NEEDLE_AT: usize = 2 * PAGE + 25;

/// Where the shallow branch is rooted, in build order. Its tip renders inside the
/// first page, so hiding it rebuilds the graph without touching anything the user had
/// to page down to reach.
const RECENT_ROOT: usize = DEPTH - 30;

/// The word that appears in exactly one commit message in the whole repository.
const NEEDLE: &str = "sarsaparilla";

pub const CASE: Case = Case {
    name: "12-deep-history",
    summary: "One repo with history several pages deep, for jumps that must page commits in.",
    repos: &["deep-history"],
    build,
};

const SCENARIO: &str = "\
# Deep history

History several pages deep. The commit graph loads 200 rows at a time, so every
target below names a row the first load does not bring back.

Most commits are authored by `Trunk QA`. The `ancient` branch's tip, on the second
page, is authored by `Wilhelmina Wollstonecraft-Fairweather`, a name much wider than
the rest, and it is the only such commit in the repository. The `recent` branch sits
inside the first page, so hiding it changes nothing you had to scroll for.

## Jumps that have to page history in (TRUNK-137)

Do not scroll before each jump. Scrolling pages history in by itself, which hides
whether the jump did its own paging.

1. **Jump from the sidebar.** Click the `ancient` branch. Its tip is on the second
   page, just past what the first load brings back. The graph should scroll to it and
   land on that commit.
2. **Jump from a search.** Press Cmd+F and search for `sarsaparilla`. It appears in
   exactly one commit message, on the third page. The graph should land on it.
3. **Jump to the very bottom.** Search for `commit 0 ` (with the trailing space, so
   it does not also match `commit 01`). That is the root commit, on the fifth page.

A jump that does not move, or that lands on the wrong row, means the graph gave up
paging before it reached the target.

A jump that hangs, or that keeps loading forever with no error shown, is the defect
TRUNK-137 fixed: the graph used to reissue the same failing request without limit
and without ever telling the user.

## A rebuild must keep the pages you already scrolled through (TRUNK-133)

Every one of these rebuilds the graph. The graph replaces its whole list with what
the rebuild returns, so each is a chance to lose the history you had paged in.

4. **Hide a branch.** Click the `ancient` branch to jump to it, which pages the
   second page in. The Author column widens when Wilhelmina's row arrives: that is
   the width to watch. Now hide the `recent` branch, whose commits sit inside the
   first page. You should keep your place, the Author column should not move, and
   the rows should not re-truncate their messages.
5. **Let the watcher fire.** Jump to `ancient` again, then touch a file in the
   working tree from outside Trunk (`touch f1.txt` in the repository). The watcher
   rebuilds the graph. Same expectation: your place and the column hold still.
6. **Hide `ancient` itself.** Jump to it first, then hide it. This one *should*
   narrow the Author column, because the commits carrying the wide name are gone
   from the graph. Narrowing here is correct, not the bug.

## What would be wrong

The Author column snapping narrow, and every row's message re-truncating, right
after a rebuild in steps 4 or 5. That is TRUNK-133: the rebuild returned only the
first 200 rows, so the column re-fitted to the narrow names on page one and every
page you had scrolled through was thrown away.
";

fn build(out: &Path) {
    let dest = out.join("deep-history");
    let mut repo = Repo::init(&dest, "main", QA);
    let mut stamp = STAMP_SECS;

    // Both branches are built while the history above them does not exist yet, so a
    // checkout has nothing to leave behind. Building them later, against the finished
    // main, does not work: a checkout updates the paths the target tree names and
    // removes nothing else, so the index would carry hundreds of newer files whose
    // blobs the old tree has no entry for, and writing the tree fails outright.
    //
    // The commits are dated as they are built, so main's own rows stay in build order
    // and each branch tip sorts next to the commit it was rooted on.
    for i in 0..DEPTH {
        stamp += HOUR_SECS;
        repo.write(&format!("f{i}.txt"), &format!("{i}\n"));
        repo.add(&[&format!("f{i}.txt")]);

        // One commit in the whole repository carries the search needle, far enough
        // down that finding it means the graph paged history in to reach it.
        let msg = if i == NEEDLE_AT {
            format!("commit {i}: bottled {NEEDLE} for the picnic")
        } else {
            format!("commit {i}")
        };
        repo.commit(QA.at(stamp), &msg);

        // A branch rooted deep in the past, carrying a commit of its own so it owns a
        // lane rather than sitting as a pill on main's line. Its author's name is far
        // wider than every other, which is what makes the author column's width
        // observable once the user has paged down to this row.
        if i == ANCIENT_ROOT {
            spur(
                &mut repo,
                "ancient",
                "ancient.txt",
                WIDE.at(stamp + HALF_HOUR),
            );
        }

        // A branch whose tip renders inside the first page, so hiding it rebuilds the
        // graph without removing anything the user had to scroll for.
        if i == RECENT_ROOT {
            spur(&mut repo, "recent", "recent.txt", QA.at(stamp + HALF_HOUR));
        }
    }

    repo.write("SCENARIO.md", SCENARIO);
    repo.add(&["SCENARIO.md"]);
    stamp += HOUR_SECS;
    repo.commit(QA.at(stamp), "docs: what to look at in this repository");
}

/// Branches at HEAD, puts one commit of its own on the branch, and returns to `main`.
///
/// Only the branch's own file is staged. `add_all` would restage the whole worktree,
/// which is right for a small repository and wrong here: it would put every file main
/// holds into the branch's commit as though the branch had authored them.
fn spur(repo: &mut Repo, name: &str, file: &str, sig: Signature) {
    repo.branch(name);
    repo.checkout(name);
    repo.write(file, &format!("{name}: a road not taken\n"));
    repo.add(&[file]);
    repo.commit(sig, &format!("feat: the {name} branch's own tip"));
    repo.checkout("main");
    // The checkout back leaves the branch's file in the worktree, because it removes
    // nothing the target tree does not name. It stays untracked and harmless: every
    // commit here stages one named path, so nothing ever sweeps it into main.
}

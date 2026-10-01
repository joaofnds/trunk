//! Case 13: a commit that claims to be a review snapshot (TRUNK-193).
//!
//! Trunk signs the snapshots it mints as `Trunk <review@trunk.local>` at the Unix
//! epoch. Git lets any commit carry that author, so a fetched commit can look exactly
//! like one. Trunk decides what is a snapshot from its own record of what it minted,
//! and this case is the commit that only claims it.
//!
//! The claimed tip changes `a.txt`, so its tree matches neither the index nor the
//! worktree. Had Trunk believed the author, a comment on it would read as a comment on
//! a superseded snapshot and go stale on the next pass.

use std::path::Path;

use super::Case;
use crate::repo::{Identity, Repo};

const FIXTURE: Identity = Identity {
    name: "Trunk Fixture",
    email: "fixture@trunk.test",
};

/// The author Trunk's minted snapshots carry, claimed here by a commit Trunk never
/// minted.
const CLAIMED: Identity = Identity {
    name: "Trunk",
    email: "review@trunk.local",
};
const STAMP_SECS: i64 = 1_767_225_600;
const DAY_SECS: i64 = 86_400;

pub const CASE: Case = Case {
    name: "13-snapshot-impostor",
    summary: "A branch whose tip claims the author Trunk signs review snapshots with.",
    repos: &["snapshot-impostor"],
    build,
};

const SCENARIO: &str = "\
# A commit that claims to be a review snapshot (TRUNK-193)

The `impostor` branch's tip is authored by `Trunk <review@trunk.local>` on
1970-01-01, the author Trunk signs the review snapshots it mints with. Trunk did not
mint it: anyone can write a commit with that author and push it. Its change to
`a.txt` matches neither the index nor the working tree.

1. Select the `impostor` branch's tip in the graph and comment on a line of its
   `a.txt` diff.
2. Change any file in the working tree from outside Trunk
   (`echo more >> notes.txt` in the repository). The watcher reruns the staleness
   pass.
3. Look at the comment in the review panel.

## What would be wrong

The comment marked stale. Staleness of a comment on a commit is never decided by
the working tree, so a stale marker means Trunk took the commit for a snapshot of
it because of the author it claims.

`git for-each-ref refs/trunk/review-snapshots/` listing the tip's oid. Trunk keeps
only the snapshots it minted alive, and a ref on this commit would keep it from
ever being collected.
";

fn build(out: &Path) {
    let dest = out.join("snapshot-impostor");
    let mut repo = Repo::init(&dest, "main", FIXTURE);

    repo.write("a.txt", "one\ntwo\nthree\n");
    repo.write("notes.txt", "notes\n");
    repo.write("SCENARIO.md", SCENARIO);
    repo.add_all();
    repo.commit(
        FIXTURE.at(STAMP_SECS),
        "feat: the base the impostor branches from",
    );

    repo.branch("impostor");
    repo.checkout("impostor");
    repo.write("a.txt", "one\nwhat the fetched commit says\nthree\n");
    repo.add(&["a.txt"]);
    repo.commit(CLAIMED.at(0), "feat: a commit dressed as a review snapshot");
    repo.checkout("main");

    repo.write("a.txt", "one\ntwo\nthree\nfour\n");
    repo.add(&["a.txt"]);
    repo.commit(FIXTURE.at(STAMP_SECS + DAY_SECS), "feat: main moves on");
}

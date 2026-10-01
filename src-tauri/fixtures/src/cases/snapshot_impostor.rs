//! Case 13: a commit that claims to be a review snapshot (TRUNK-193).
//!
//! Trunk authors the snapshots it mints as `Trunk <review@trunk.local>` at the Unix
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
    summary: "A branch whose tip claims the author review snapshots carry.",
    repos: &["snapshot-impostor"],
    build,
};

const SCENARIO: &str = "\
# A commit that claims to be a review snapshot (TRUNK-193)

The `impostor` branch's tip is authored by `Trunk <review@trunk.local>` at the Unix
epoch, the author and date of the review snapshots Trunk mints, so its graph row shows
no date. Trunk did not mint it: anyone can write a commit with that author and push
it. Its change to `a.txt` matches neither the index nor the working tree.

Start from a fresh build (`just fixtures 13-snapshot-impostor`), so no ref or comment
from an earlier session is in the repository, and from a review store in which no
build from before TRUNK-193 left a comment or a draft on this tip. The upgrade judges
an oid named before it by its author, so such a comment goes stale, which is a
recorded residual and not this defect.

1. Select the `impostor` branch's tip in the graph and comment on a line of its
   `a.txt` diff.
2. The control: run `echo draft >> notes.txt` in the repository, then comment on
   that added line in the working-tree changes. Trunk mints a snapshot for it.
3. Run `echo more >> notes.txt`. The watcher reruns the staleness pass.
4. Look at both comments in the review panel. The `notes.txt` comment must read
   stale, which proves the pass ran. If it does not, the result says nothing.

## What would be wrong

The `a.txt` comment marked stale. Staleness of a comment on a commit is never decided by
the working tree, so a stale marker means Trunk took the commit for a snapshot of
it because of the author it claims.

`git for-each-ref refs/trunk/review-snapshots/` listing the oid `git rev-parse
impostor` prints. One ref is expected, the control's snapshot. Trunk keeps only the
snapshots it minted alive, and a ref on this commit would keep it from ever being
collected.
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

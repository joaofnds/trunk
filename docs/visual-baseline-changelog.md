# Visual baselines: accepted changes

Each entry records a deliberate change to the committed captures, and why it was accepted.
Written by `scripts/visual-accept.sh`; see `docs/visual-regression.md`.

## 2026-09-26

Initial baselines, graph column only, recorded by the TRUNK-100 build from main with the rails drawing. Not yet reviewed by the user.

Changed baselines:

    tests/visual/baselines/graph-lanes__01-behind-only.png
    tests/visual/baselines/graph-lanes__02-local-ahead-no-remote.png
    tests/visual/baselines/graph-lanes__03-detached-old.png
    tests/visual/baselines/graph-lanes__04-tiebreak-upstream-vs-topic.png
    tests/visual/baselines/graph-lanes__05-diverged.png
    tests/visual/baselines/graph-lanes__06-tag-only-chain.png
    tests/visual/baselines/graph-lanes__07-tag-on-unpulled.png
    tests/visual/baselines/graph-lanes__08-stash-on-tip-behind.png
    tests/visual/baselines/graph-lanes__09-branch-point-below-head.png
    tests/visual/baselines/graph-lanes__10-two-remotes.png
    tests/visual/baselines/graph-lanes__11-merge-in-head-chain.png
    tests/visual/baselines/graph-lanes__12-author-vs-committer.png
    tests/visual/baselines/graph-lanes__13-tall-linear.png
    tests/visual/baselines/graph-merges__01-octopus-merge.png
    tests/visual/baselines/graph-merges__02-criss-cross.png
    tests/visual/baselines/graph-merges__03-merge-of-merges.png
    tests/visual/baselines/graph-merges__04-three-topics.png
    tests/visual/baselines/graph-merges__05-sequential-merges.png
    tests/visual/baselines/graph-merges__06-merge-second-parent-newer.png
    tests/visual/baselines/graph-merges__07-fork-sibling-older.png
    tests/visual/baselines/graph-merges__08-fork-sibling-newer.png
    tests/visual/baselines/graph-merges__09-column-saturation.png
    tests/visual/baselines/graph-merges__09-column-saturation__graph-56px.png
    tests/visual/baselines/graph-merges__10-merge-parent-left.png
    tests/visual/baselines/graph-merges__11-fork-in-left.png
    tests/visual/baselines/graph-merges__12-pagination-boundary.png
    tests/visual/baselines/graph-merges__13-freed-column-left.png
    tests/visual/baselines/graph-merges__14-spiral-right-before-left.png

## 2026-09-26

The capture now starts below the column header, whose label GitHub's macOS runner antialiases up to 36 levels away from this Mac (CI run 36204042756). Each new baseline is the old one without its top 28 rows, pixel for pixel, so no drawing changed. Recorded by the TRUNK-100 build without an acceptance direction from the user.

Changed baselines:

    tests/visual/baselines/graph-lanes__01-behind-only.png
    tests/visual/baselines/graph-lanes__02-local-ahead-no-remote.png
    tests/visual/baselines/graph-lanes__03-detached-old.png
    tests/visual/baselines/graph-lanes__04-tiebreak-upstream-vs-topic.png
    tests/visual/baselines/graph-lanes__05-diverged.png
    tests/visual/baselines/graph-lanes__06-tag-only-chain.png
    tests/visual/baselines/graph-lanes__07-tag-on-unpulled.png
    tests/visual/baselines/graph-lanes__08-stash-on-tip-behind.png
    tests/visual/baselines/graph-lanes__09-branch-point-below-head.png
    tests/visual/baselines/graph-lanes__10-two-remotes.png
    tests/visual/baselines/graph-lanes__11-merge-in-head-chain.png
    tests/visual/baselines/graph-lanes__12-author-vs-committer.png
    tests/visual/baselines/graph-lanes__13-tall-linear.png
    tests/visual/baselines/graph-merges__01-octopus-merge.png
    tests/visual/baselines/graph-merges__02-criss-cross.png
    tests/visual/baselines/graph-merges__03-merge-of-merges.png
    tests/visual/baselines/graph-merges__04-three-topics.png
    tests/visual/baselines/graph-merges__05-sequential-merges.png
    tests/visual/baselines/graph-merges__06-merge-second-parent-newer.png
    tests/visual/baselines/graph-merges__07-fork-sibling-older.png
    tests/visual/baselines/graph-merges__08-fork-sibling-newer.png
    tests/visual/baselines/graph-merges__09-column-saturation.png
    tests/visual/baselines/graph-merges__09-column-saturation__graph-56px.png
    tests/visual/baselines/graph-merges__10-merge-parent-left.png
    tests/visual/baselines/graph-merges__11-fork-in-left.png
    tests/visual/baselines/graph-merges__12-pagination-boundary.png
    tests/visual/baselines/graph-merges__13-freed-column-left.png
    tests/visual/baselines/graph-merges__14-spiral-right-before-left.png

## 2026-09-26

Captures now span the commit rows alone, in a window 1000 px tall, so a capture's height follows its repository rather than the chrome around the list or the window. Each new capture equals its old baseline over its rows, the part cut away was background, and 13-tall-linear gains the four rows the 800 px window cut off. Accepted at João's direction on 2026-09-26 (TRUNK-100).

Changed baselines:

    tests/visual/baselines/graph-lanes__01-behind-only.png
    tests/visual/baselines/graph-lanes__02-local-ahead-no-remote.png
    tests/visual/baselines/graph-lanes__03-detached-old.png
    tests/visual/baselines/graph-lanes__04-tiebreak-upstream-vs-topic.png
    tests/visual/baselines/graph-lanes__05-diverged.png
    tests/visual/baselines/graph-lanes__06-tag-only-chain.png
    tests/visual/baselines/graph-lanes__07-tag-on-unpulled.png
    tests/visual/baselines/graph-lanes__08-stash-on-tip-behind.png
    tests/visual/baselines/graph-lanes__09-branch-point-below-head.png
    tests/visual/baselines/graph-lanes__10-two-remotes.png
    tests/visual/baselines/graph-lanes__11-merge-in-head-chain.png
    tests/visual/baselines/graph-lanes__12-author-vs-committer.png
    tests/visual/baselines/graph-lanes__13-tall-linear.png
    tests/visual/baselines/graph-merges__01-octopus-merge.png
    tests/visual/baselines/graph-merges__02-criss-cross.png
    tests/visual/baselines/graph-merges__03-merge-of-merges.png
    tests/visual/baselines/graph-merges__04-three-topics.png
    tests/visual/baselines/graph-merges__05-sequential-merges.png
    tests/visual/baselines/graph-merges__06-merge-second-parent-newer.png
    tests/visual/baselines/graph-merges__07-fork-sibling-older.png
    tests/visual/baselines/graph-merges__08-fork-sibling-newer.png
    tests/visual/baselines/graph-merges__09-column-saturation.png
    tests/visual/baselines/graph-merges__09-column-saturation__graph-56px.png
    tests/visual/baselines/graph-merges__10-merge-parent-left.png
    tests/visual/baselines/graph-merges__11-fork-in-left.png
    tests/visual/baselines/graph-merges__12-pagination-boundary.png
    tests/visual/baselines/graph-merges__13-freed-column-left.png
    tests/visual/baselines/graph-merges__14-spiral-right-before-left.png

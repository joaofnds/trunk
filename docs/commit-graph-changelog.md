# Commit graph — accepted layout changes

Each entry records a deliberate change to the pinned layout, and why it was accepted.
Written by `scripts/graph-accept.sh`; see `.claude/rules/commit-graph.md`.

## 2026-08-05

milestone 1 remediation: the JSON layout export was specced but never built; generating it for the existing 33 fixtures. No layout changed.

Changed goldens:

    ?? src-tauri/tests/goldens/

## 2026-08-05

milestone 2: adds scripts/qa-graph-merge-fixtures.sh (13 fixtures) covering spec AC-2's gap list, widened to target named mutation survivors — MergeLeft, ForkLeft and the leftward spiral had no fixture in the corpus. New goldens only; no existing layout changed.

Changed goldens:

    ?? src-tauri/tests/goldens/

## 2026-08-05

milestone 2: the paginated slice golden for 12-pagination-boundary, missed by the previous run because the accept filter did not match every_paged_fixture.

Changed goldens:

    ?? src-tauri/tests/goldens/

## 2026-08-05

adds 14-spiral-right-before-left, the only geometry that distinguishes find_free_column_near's rightward step from its leftward one (`placement.rs`). New golden only; no existing layout changed.

Changed goldens:

    ?? src-tauri/tests/goldens/exports/merge-14-spiral-right-before-left.json
    ?? src-tauri/tests/goldens/graph/merge-14-spiral-right-before-left.txt

## 2026-08-05

milestone 3: adds lane-13-tall-linear, a 30-commit chain past jsdom's 22-row cap, so a dropped render viewport stub turns a golden red instead of silently truncating. New goldens only; no existing layout changed.

Changed goldens:

    ?? src-tauri/tests/goldens/exports/lane-13-tall-linear.json
    ?? src-tauri/tests/goldens/graph/lane-13-tall-linear.txt

## 2026-08-06

milestone 3: first render goldens for the corpus, one per export at wipCount 0 plus one per dirty fixture at its own wipCount.

Changed goldens:

    ?? src/__tests__/goldens/graph-render/lane-01-behind-only.txt
    ?? src/__tests__/goldens/graph-render/lane-02-local-ahead-no-remote.txt
    ?? src/__tests__/goldens/graph-render/lane-03-detached-old.txt
    ?? src/__tests__/goldens/graph-render/lane-04-tiebreak-upstream-vs-topic.txt
    ?? src/__tests__/goldens/graph-render/lane-05-diverged.txt
    ?? src/__tests__/goldens/graph-render/lane-06-tag-only-chain.txt
    ?? src/__tests__/goldens/graph-render/lane-07-tag-on-unpulled.txt
    ?? src/__tests__/goldens/graph-render/lane-08-stash-on-tip-behind.txt
    ?? src/__tests__/goldens/graph-render/lane-09-branch-point-below-head.txt
    ?? src/__tests__/goldens/graph-render/lane-10-two-remotes.txt
    ?? src/__tests__/goldens/graph-render/lane-11-merge-in-head-chain.txt
    ?? src/__tests__/goldens/graph-render/lane-12-author-vs-committer.txt
    ?? src/__tests__/goldens/graph-render/lane-13-tall-linear.txt
    ?? src/__tests__/goldens/graph-render/merge-01-octopus-merge.txt
    ?? src/__tests__/goldens/graph-render/merge-02-criss-cross.txt
    ?? src/__tests__/goldens/graph-render/merge-03-merge-of-merges.txt
    ?? src/__tests__/goldens/graph-render/merge-04-three-topics.txt
    ?? src/__tests__/goldens/graph-render/merge-05-sequential-merges.txt
    ?? src/__tests__/goldens/graph-render/merge-06-merge-second-parent-newer.txt
    ?? src/__tests__/goldens/graph-render/merge-07-fork-sibling-older.txt
    ?? src/__tests__/goldens/graph-render/merge-08-fork-sibling-newer.txt
    ?? src/__tests__/goldens/graph-render/merge-09-column-saturation.txt
    ?? src/__tests__/goldens/graph-render/merge-10-merge-parent-left.txt
    ?? src/__tests__/goldens/graph-render/merge-11-fork-in-left.txt
    ?? src/__tests__/goldens/graph-render/merge-12-pagination-boundary.txt
    ?? src/__tests__/goldens/graph-render/merge-13-freed-column-left.txt
    ?? src/__tests__/goldens/graph-render/merge-14-spiral-right-before-left.txt
    ?? src/__tests__/goldens/graph-render/stash-01-clean-inline.txt
    ?? src/__tests__/goldens/graph-render/stash-02-dirty-tracked.txt
    ?? src/__tests__/goldens/graph-render/stash-02-dirty-tracked.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-03-dirty-untracked.txt
    ?? src/__tests__/goldens/graph-render/stash-03-dirty-untracked.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-04-dirty-staged.txt
    ?? src/__tests__/goldens/graph-render/stash-04-dirty-staged.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-05-dirty-conflicted.txt
    ?? src/__tests__/goldens/graph-render/stash-05-dirty-conflicted.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-06-ignored-stays-inline.txt
    ?? src/__tests__/goldens/graph-render/stash-07-multi-stash-clean.txt
    ?? src/__tests__/goldens/graph-render/stash-08-multi-stash-dirty.txt
    ?? src/__tests__/goldens/graph-render/stash-08-multi-stash-dirty.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-09-topic-above-parent.txt
    ?? src/__tests__/goldens/graph-render/stash-10-topic-below-parent.txt
    ?? src/__tests__/goldens/graph-render/stash-11-stash-parent-mid-chain.txt
    ?? src/__tests__/goldens/graph-render/stash-12-orphan-stash.txt
    ?? src/__tests__/goldens/graph-render/stash-13-detached-head.txt
    ?? src/__tests__/goldens/graph-render/stash-14-merge-tip.txt
    ?? src/__tests__/goldens/graph-render/stash-15-backdated-stash.txt
    ?? src/__tests__/goldens/graph-render/stash-16-bare-repo.git.txt
    ?? src/__tests__/goldens/graph-render/stash-17-no-stash-dirty.txt
    ?? src/__tests__/goldens/graph-render/stash-17-no-stash-dirty.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-18-many-files.txt
    ?? src/__tests__/goldens/graph-render/stash-18-many-files.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-19-two-backdated.txt
    ?? src/__tests__/goldens/graph-render/stash-20-stash-on-stash.txt
    ?? src/__tests__/goldens/graph-render/stash-21-tagged-stash.txt

## 2026-08-06

milestone 3: adds two WIP render variants that split the dashed WIP connection — lane-01-behind-only for the settled unpulled-chain shape, stash-14-merge-tip for the inline-stash one, which also carries all four node shapes.

Changed goldens:

    ?? src/__tests__/goldens/graph-render/lane-01-behind-only.txt
    ?? src/__tests__/goldens/graph-render/lane-01-behind-only.wip.txt
    ?? src/__tests__/goldens/graph-render/lane-02-local-ahead-no-remote.txt
    ?? src/__tests__/goldens/graph-render/lane-03-detached-old.txt
    ?? src/__tests__/goldens/graph-render/lane-04-tiebreak-upstream-vs-topic.txt
    ?? src/__tests__/goldens/graph-render/lane-05-diverged.txt
    ?? src/__tests__/goldens/graph-render/lane-06-tag-only-chain.txt
    ?? src/__tests__/goldens/graph-render/lane-07-tag-on-unpulled.txt
    ?? src/__tests__/goldens/graph-render/lane-08-stash-on-tip-behind.txt
    ?? src/__tests__/goldens/graph-render/lane-09-branch-point-below-head.txt
    ?? src/__tests__/goldens/graph-render/lane-10-two-remotes.txt
    ?? src/__tests__/goldens/graph-render/lane-11-merge-in-head-chain.txt
    ?? src/__tests__/goldens/graph-render/lane-12-author-vs-committer.txt
    ?? src/__tests__/goldens/graph-render/lane-13-tall-linear.txt
    ?? src/__tests__/goldens/graph-render/merge-01-octopus-merge.txt
    ?? src/__tests__/goldens/graph-render/merge-02-criss-cross.txt
    ?? src/__tests__/goldens/graph-render/merge-03-merge-of-merges.txt
    ?? src/__tests__/goldens/graph-render/merge-04-three-topics.txt
    ?? src/__tests__/goldens/graph-render/merge-05-sequential-merges.txt
    ?? src/__tests__/goldens/graph-render/merge-06-merge-second-parent-newer.txt
    ?? src/__tests__/goldens/graph-render/merge-07-fork-sibling-older.txt
    ?? src/__tests__/goldens/graph-render/merge-08-fork-sibling-newer.txt
    ?? src/__tests__/goldens/graph-render/merge-09-column-saturation.txt
    ?? src/__tests__/goldens/graph-render/merge-10-merge-parent-left.txt
    ?? src/__tests__/goldens/graph-render/merge-11-fork-in-left.txt
    ?? src/__tests__/goldens/graph-render/merge-12-pagination-boundary.txt
    ?? src/__tests__/goldens/graph-render/merge-13-freed-column-left.txt
    ?? src/__tests__/goldens/graph-render/merge-14-spiral-right-before-left.txt
    ?? src/__tests__/goldens/graph-render/stash-01-clean-inline.txt
    ?? src/__tests__/goldens/graph-render/stash-02-dirty-tracked.txt
    ?? src/__tests__/goldens/graph-render/stash-02-dirty-tracked.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-03-dirty-untracked.txt
    ?? src/__tests__/goldens/graph-render/stash-03-dirty-untracked.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-04-dirty-staged.txt
    ?? src/__tests__/goldens/graph-render/stash-04-dirty-staged.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-05-dirty-conflicted.txt
    ?? src/__tests__/goldens/graph-render/stash-05-dirty-conflicted.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-06-ignored-stays-inline.txt
    ?? src/__tests__/goldens/graph-render/stash-07-multi-stash-clean.txt
    ?? src/__tests__/goldens/graph-render/stash-08-multi-stash-dirty.txt
    ?? src/__tests__/goldens/graph-render/stash-08-multi-stash-dirty.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-09-topic-above-parent.txt
    ?? src/__tests__/goldens/graph-render/stash-10-topic-below-parent.txt
    ?? src/__tests__/goldens/graph-render/stash-11-stash-parent-mid-chain.txt
    ?? src/__tests__/goldens/graph-render/stash-12-orphan-stash.txt
    ?? src/__tests__/goldens/graph-render/stash-13-detached-head.txt
    ?? src/__tests__/goldens/graph-render/stash-14-merge-tip.txt
    ?? src/__tests__/goldens/graph-render/stash-14-merge-tip.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-15-backdated-stash.txt
    ?? src/__tests__/goldens/graph-render/stash-16-bare-repo.git.txt
    ?? src/__tests__/goldens/graph-render/stash-17-no-stash-dirty.txt
    ?? src/__tests__/goldens/graph-render/stash-17-no-stash-dirty.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-18-many-files.txt
    ?? src/__tests__/goldens/graph-render/stash-18-many-files.wip.txt
    ?? src/__tests__/goldens/graph-render/stash-19-two-backdated.txt
    ?? src/__tests__/goldens/graph-render/stash-20-stash-on-stash.txt
    ?? src/__tests__/goldens/graph-render/stash-21-tagged-stash.txt

## 2026-08-27

row pitch 26px to 28px: every length in the interface is now a whole number of --u (4px), and 26 was 6.5 units

Changed goldens:

     M src/__tests__/goldens/graph-render/lane-01-behind-only.txt
     M src/__tests__/goldens/graph-render/lane-01-behind-only.wip.txt
     M src/__tests__/goldens/graph-render/lane-02-local-ahead-no-remote.txt
     M src/__tests__/goldens/graph-render/lane-03-detached-old.txt
     M src/__tests__/goldens/graph-render/lane-04-tiebreak-upstream-vs-topic.txt
     M src/__tests__/goldens/graph-render/lane-05-diverged.txt
     M src/__tests__/goldens/graph-render/lane-06-tag-only-chain.txt
     M src/__tests__/goldens/graph-render/lane-07-tag-on-unpulled.txt
     M src/__tests__/goldens/graph-render/lane-08-stash-on-tip-behind.txt
     M src/__tests__/goldens/graph-render/lane-09-branch-point-below-head.txt
     M src/__tests__/goldens/graph-render/lane-10-two-remotes.txt
     M src/__tests__/goldens/graph-render/lane-11-merge-in-head-chain.txt
     M src/__tests__/goldens/graph-render/lane-12-author-vs-committer.txt
     M src/__tests__/goldens/graph-render/lane-13-tall-linear.txt
     M src/__tests__/goldens/graph-render/merge-01-octopus-merge.txt
     M src/__tests__/goldens/graph-render/merge-02-criss-cross.txt
     M src/__tests__/goldens/graph-render/merge-03-merge-of-merges.txt
     M src/__tests__/goldens/graph-render/merge-04-three-topics.txt
     M src/__tests__/goldens/graph-render/merge-05-sequential-merges.txt
     M src/__tests__/goldens/graph-render/merge-06-merge-second-parent-newer.txt
     M src/__tests__/goldens/graph-render/merge-07-fork-sibling-older.txt
     M src/__tests__/goldens/graph-render/merge-08-fork-sibling-newer.txt
     M src/__tests__/goldens/graph-render/merge-09-column-saturation.txt
     M src/__tests__/goldens/graph-render/merge-10-merge-parent-left.txt
     M src/__tests__/goldens/graph-render/merge-11-fork-in-left.txt
     M src/__tests__/goldens/graph-render/merge-12-pagination-boundary.txt
     M src/__tests__/goldens/graph-render/merge-13-freed-column-left.txt
     M src/__tests__/goldens/graph-render/merge-14-spiral-right-before-left.txt
     M src/__tests__/goldens/graph-render/stash-01-clean-inline.txt
     M src/__tests__/goldens/graph-render/stash-02-dirty-tracked.txt
     M src/__tests__/goldens/graph-render/stash-02-dirty-tracked.wip.txt
     M src/__tests__/goldens/graph-render/stash-03-dirty-untracked.txt
     M src/__tests__/goldens/graph-render/stash-03-dirty-untracked.wip.txt
     M src/__tests__/goldens/graph-render/stash-04-dirty-staged.txt
     M src/__tests__/goldens/graph-render/stash-04-dirty-staged.wip.txt
     M src/__tests__/goldens/graph-render/stash-05-dirty-conflicted.txt
     M src/__tests__/goldens/graph-render/stash-05-dirty-conflicted.wip.txt
     M src/__tests__/goldens/graph-render/stash-06-ignored-stays-inline.txt
     M src/__tests__/goldens/graph-render/stash-07-multi-stash-clean.txt
     M src/__tests__/goldens/graph-render/stash-08-multi-stash-dirty.txt
     M src/__tests__/goldens/graph-render/stash-08-multi-stash-dirty.wip.txt
     M src/__tests__/goldens/graph-render/stash-09-topic-above-parent.txt
     M src/__tests__/goldens/graph-render/stash-10-topic-below-parent.txt
     M src/__tests__/goldens/graph-render/stash-11-stash-parent-mid-chain.txt
     M src/__tests__/goldens/graph-render/stash-12-orphan-stash.txt
     M src/__tests__/goldens/graph-render/stash-13-detached-head.txt
     M src/__tests__/goldens/graph-render/stash-14-merge-tip.txt
     M src/__tests__/goldens/graph-render/stash-14-merge-tip.wip.txt
     M src/__tests__/goldens/graph-render/stash-15-backdated-stash.txt
     M src/__tests__/goldens/graph-render/stash-16-bare-repo.git.txt
     M src/__tests__/goldens/graph-render/stash-17-no-stash-dirty.txt
     M src/__tests__/goldens/graph-render/stash-17-no-stash-dirty.wip.txt
     M src/__tests__/goldens/graph-render/stash-18-many-files.txt
     M src/__tests__/goldens/graph-render/stash-18-many-files.wip.txt
     M src/__tests__/goldens/graph-render/stash-19-two-backdated.txt
     M src/__tests__/goldens/graph-render/stash-20-stash-on-stash.txt
     M src/__tests__/goldens/graph-render/stash-21-tagged-stash.txt

## 2026-08-30

TRUNK-43: a stash whose first parent is the head-lane extension's tip now inlines at column 0, so stash-12-orphan-stash drops to a single lane (max_columns 1, no fork out of 'Add app')

Changed goldens:

     M src-tauri/tests/goldens/exports/stash-12-orphan-stash.json
     M src-tauri/tests/goldens/graph/stash-12-orphan-stash.txt
     M src/__tests__/goldens/graph-render/stash-12-orphan-stash.txt

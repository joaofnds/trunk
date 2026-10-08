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

## 2026-09-26

New captures of the 21 stash-lanes repositories, the kitchen-sink repository, and 09-column-saturation at 56 px panned 20 px, so a paint break in stash placement beside the WIP row, the WIP marker or a panned graph column fails the suite. Each image equals the candidate João looked at in the TRUNK-289 contact sheet. The 28 existing baselines are unchanged. Accepted at João's direction on 2026-09-27 (TRUNK-289).

Changed baselines:

    tests/visual/baselines/graph-merges__09-column-saturation__graph-56px__panned-20px.png
    tests/visual/baselines/kitchen-sink.png
    tests/visual/baselines/stash-lanes__01-clean-inline.png
    tests/visual/baselines/stash-lanes__02-dirty-tracked.png
    tests/visual/baselines/stash-lanes__03-dirty-untracked.png
    tests/visual/baselines/stash-lanes__04-dirty-staged.png
    tests/visual/baselines/stash-lanes__05-dirty-conflicted.png
    tests/visual/baselines/stash-lanes__06-ignored-stays-inline.png
    tests/visual/baselines/stash-lanes__07-multi-stash-clean.png
    tests/visual/baselines/stash-lanes__08-multi-stash-dirty.png
    tests/visual/baselines/stash-lanes__09-topic-above-parent.png
    tests/visual/baselines/stash-lanes__10-topic-below-parent.png
    tests/visual/baselines/stash-lanes__11-stash-parent-mid-chain.png
    tests/visual/baselines/stash-lanes__12-orphan-stash.png
    tests/visual/baselines/stash-lanes__13-detached-head.png
    tests/visual/baselines/stash-lanes__14-merge-tip.png
    tests/visual/baselines/stash-lanes__15-backdated-stash.png
    tests/visual/baselines/stash-lanes__16-bare-repo.git.png
    tests/visual/baselines/stash-lanes__17-no-stash-dirty.png
    tests/visual/baselines/stash-lanes__18-many-files.png
    tests/visual/baselines/stash-lanes__19-two-backdated.png
    tests/visual/baselines/stash-lanes__20-stash-on-stash.png
    tests/visual/baselines/stash-lanes__21-tagged-stash.png

## 2026-09-27

TRUNK-293: WIP ring drawn as one arc per dash

Changed baselines:

    tests/visual/baselines/kitchen-sink.png
    tests/visual/baselines/stash-lanes__02-dirty-tracked.png
    tests/visual/baselines/stash-lanes__03-dirty-untracked.png
    tests/visual/baselines/stash-lanes__04-dirty-staged.png
    tests/visual/baselines/stash-lanes__05-dirty-conflicted.png
    tests/visual/baselines/stash-lanes__08-multi-stash-dirty.png
    tests/visual/baselines/stash-lanes__17-no-stash-dirty.png
    tests/visual/baselines/stash-lanes__18-many-files.png

## 2026-09-27

TRUNK-291: every stash stops its rails at the square's edge, so a stash with a stash on top shows no rail inside it

Changed baselines:

    tests/visual/baselines/stash-lanes__20-stash-on-stash.png

## 2026-09-28

WIP ring: a whole number of equal dashes and gaps goes round the ring, so the last dash no longer runs on into the first as one double-length dash. Only the WIP marker's pixels change, in the eight captures holding a WIP row. Accepted at João's direction on 2026-09-28.

Changed baselines:

    tests/visual/baselines/kitchen-sink.png
    tests/visual/baselines/stash-lanes__02-dirty-tracked.png
    tests/visual/baselines/stash-lanes__03-dirty-untracked.png
    tests/visual/baselines/stash-lanes__04-dirty-staged.png
    tests/visual/baselines/stash-lanes__05-dirty-conflicted.png
    tests/visual/baselines/stash-lanes__08-multi-stash-dirty.png
    tests/visual/baselines/stash-lanes__17-no-stash-dirty.png
    tests/visual/baselines/stash-lanes__18-many-files.png

## 2026-10-03

first catalog baseline: the design catalog draws the tokens and the Button, LinkButton and ButtonGroup primitives, text masked

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-03

RowAction primitive added to the catalog: five tones at the target and compact sizes, drawn below LinkButton so nothing above moves

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-03

ListOption primitive added to the catalog: a files listbox, a stacked repository list and a pull menu, drawn below RowAction so nothing above moves

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-03

Chip primitive added to the catalog, drawn below ListOption; its four color tokens appear as swatches in the color grid, which grew one row and moved everything below it 32px

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-03

Tab and TabStrip primitives added to the catalog, drawn below Chip as the commit form's Commit, Amend and Stash strip with Amend selected; a dozen antialiased pixels on the first Chip pill's curve and two single pixels on a Button corner also move, and an empty box of the same height in place of the strip moves the same pixels, so they follow the capture height rather than the new primitive

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-03

ToastCard primitive added to the catalog, drawn below Tab as a neutral and a danger card in a column that shrinks to its widest card; the same antialiased pixels on the first Chip pill's curve and one pixel above it move with the capture height, as the Tab entry records

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-03

Button gains a 16px icon-only xs size for the tab close, drawn after the md icon in each Button row, so the disabled and pressed buttons that follow it in every row move 32px right; nothing outside the Button rows moves

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-05

TRUNK-307: catalog sections for Row, the framed Tab, GutterGrip, HitArea and Splitter

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-06

catalog: add the anchored Dialog

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-06

catalog shows Chip's new label variant

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-06

catalog shows a long and a short truncating chip in a narrow row

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-07

catalog shows the review UI's new primitives: xs buttons, destructive row action, entry row, lane chip, Radio, Tag and Keycap

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-08

the catalog shows a button group at each size, xs to lg, now that a group stands at the height of its buttons

Changed baselines:

    tests/visual/baselines/catalog.png

## 2026-10-08

review panel port: the Badge primitive for a short id or count, and the 24px base button size

Changed baselines:

    tests/visual/baselines/catalog.png

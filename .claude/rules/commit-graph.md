---
paths:
  - "src-tauri/src/git/graph.rs"
  - "src-tauri/src/git/placement.rs"
  - "src-tauri/src/git/graph_input.rs"
  - "src-tauri/src/git/layout_dump.rs"
  - "src-tauri/src/git/status.rs"
  - "src-tauri/src/git/types.rs"
  - "src/lib/types.ts"
  - "src/lib/active-lanes.ts"
  - "src/lib/wip-row.ts"
  - "src/lib/overlay-paths.ts"
  - "src/lib/overlay-visible.ts"
  - "src/lib/lane-labels.ts"
  - "src/lib/lane-labels.test.ts"
  - "src/lib/chrome-heights.ts"
  - "src/lib/graph-constants.ts"
  - "src/components/CommitGraph.svelte"
  - "src-tauri/tests/test_graph.rs"
  - "src-tauri/tests/test_graph_capture.rs"
  - "src-tauri/tests/common/graph_shapes.rs"
  - "src-tauri/tests/test_placement.rs"
  - "src-tauri/tests/test_graph_input.rs"
  - "src-tauri/tests/test_graph_goldens.rs"
  - "src-tauri/tests/inputs"
  - "src-tauri/tests/rule-inputs"
  - "src-tauri/tests/goldens"
  - "src/__tests__/goldens/graph-render"
  - "scripts/graph-accept.sh"
  - "scripts/graph-capture.sh"
  - "src-tauri/tests/common/goldens.rs"
  - "src-tauri/tests/common/builder.rs"
  - "src-tauri/tests/common/rule_inputs.rs"
  - "src-tauri/tests/common/exports.rs"
  - "src/__tests__/helpers/graph-render.ts"
  - "src/components/CommitGraph.render.test.ts"
  - "scripts/qa-stash-fixtures.sh"
  - "scripts/qa-graph-lane-fixtures.sh"
  - "scripts/qa-graph-merge-fixtures.sh"
  - "src-tauri/examples/graph_capture.rs"
  - "scripts/graph-mutation-sweep.py"
  - "scripts/graph-fixture-render.ts"
  - "scripts/graph-connector-render.ts"
  - "src/components/CommitGraph.test.ts"
  - "justfile"
  - "docs/architecture/commit-graph.md"
  - "docs/commit-graph-changelog.md"
  - "docs/commit-graph-mutation-ledger.md"
  - "docs/research/gitamine-graph-algorithm.md"
  - "docs/architecture/overview.md"
---

# Commit Graph Rules

`graph.rs` reads the repository into plain data — every git2 call in the pipeline is here →
`placement.rs` assigns columns, colours and edges, a pure pass over that data →
`graph_input.rs` slices the page and hydrates its rows →
`wip-row.ts` prepends the WIP row → `active-lanes.ts` maps commits to overlay nodes and per-parent connections →
`overlay-paths.ts` emits SVG paths →
`overlay-visible.ts` culls off-screen paths, dots and pills →
`lane-labels.ts` names each lane crossing the viewport whose ref sits above it →
`CommitGraph.svelte` renders.

`layout_dump.rs` is not a pipeline stage (it is still pipeline source for the rules below):
it renders a `GraphResult` as the deterministic
text the committed layout text goldens are pinned against.
`docs/architecture/commit-graph.md` §File Map owns the full description.

## Binding rules

This file is the binding source for the constraints below. `docs/architecture/overview.md`,
`docs/architecture/commit-graph.md`, the staleness notes in
`docs/research/gitamine-graph-algorithm.md`, `docs/commit-graph-changelog.md`, and
`docs/commit-graph-mutation-ledger.md` all
paraphrase these rules or cite the pipeline source, often by `file.rs:NN` line number.
Repoint a stale citation to the file or symbol and drop the line number, so an unrelated edit
above it cannot silently stale it; a rename still surfaces in the sweep below (ruling
2026-08-07). Treat every such passage as a mirror to re-check, and read it as explanation of
a rule stated here, never as a doc that "code wins" may overwrite.

`docs/commit-graph-changelog.md` is a mirror like the rest, on one axis only: the identifiers
an entry names — symbols and source paths in its prose — are swept and corrected in place.
Everything else in an entry — what it claims changed and why, its date, its `Changed goldens`
list — is the record and is never rewritten (ruling 2026-08-07). The header above the first entry is
neither: `scripts/graph-accept.sh` owns its text — correct a stale identifier there first,
then mirror the same edit into the changelog.

- Never post-process the output of one stage to fix something an earlier stage should have
  done — the stages are interdependent and partial fixups desync. Fix the stage that owns the
  data; `docs/architecture/commit-graph.md` has the stage ownership
- The File Map in `docs/architecture/commit-graph.md` and this file's `paths:` list are
  deliberately different sets. The File Map explains the pipeline: the stages a reader follows
  the data through, plus the suites that pin them. `paths:` decides what loads this rule, so it
  also covers the committed artifacts, the acceptance and capture doors, the test helpers and the
  capture binary, the corpus and sweep scripts, the justfile and the doc mirrors.
  **Adding or removing a pipeline stage or a graph test suite means editing both.** Every other
  file that should load this rule when opened means editing `paths:` only — do not grow the File
  Map to match it (ruling 2026-08-12, when `paths:` grew past the File Map's file set).
  `CLAUDE.md` §Rules, the doc's own §File Map, and the memory note
  `claude_rules_paths_loader.md` (with its `MEMORY.md` index line) all point at this split;
  amend all four together, and state no entry count in any of them — the counts drift and
  nothing checks them
- Where a reference doc under `docs/` disagrees with the pipeline source — `graph.rs`,
  `placement.rs`, `graph_input.rs`, `status.rs`, `types.rs`, `layout_dump.rs`, `types.ts`,
  `wip-row.ts`, `active-lanes.ts`, `overlay-paths.ts`, `overlay-visible.ts`,
  `lane-labels.ts`, `graph-constants.ts` and `CommitGraph.svelte` — or with the graph test
  suites, the code
  wins; correct the doc in the same change.
  The binding rules in *this* file do not yield that way: code that violates one is a bug in
  the code, not a rule to rewrite. Amend a rule's **substance** only when the user directs it,
  and record the date and the cause inline, as the bullets below do. Appending a dated
  re-derivation or revalidation note that a bullet itself asks for is not an amendment —
  record it yourself, in the bullet it belongs to
- After changing the pipeline, or a rule here, grep `docs/`, `scripts/`, `CLAUDE.md`, the
  project memory notes under `$CLAUDE_CONFIG_DIR/projects/*/memory/` (index line and note
  both — they load in every session and nothing else sweeps them), **this file's own prose and its `paths:`
  list, and the comments in the pipeline-source files and the graph test suites** for every symbol and mechanism the change touched, **including the ones it deleted**
  — a deleted mechanism is the one nothing points at any more, so nothing makes it surface.
  Correct every hit in the same change — in `docs/commit-graph-changelog.md`, only the
  identifiers in an entry's prose, per the carve-out above. Deleting the orphan-stash guard left three stale
  claims behind in `docs/architecture/commit-graph.md` and
  `docs/research/gitamine-graph-algorithm.md` (`34ee513`, 2026-08-03)
- Render a stash's graph marker as a dashed hollow **square** (`<rect>`) with dashed edges,
  never a circle. Hollow alone does not identify a stash: WIP is a dashed hollow **circle**, a
  merge is a solid-stroke hollow circle
- Stash *lane assignment* and the HEAD lane's upward extension deliberately depend on worktree
  state: `can_inline` places a stash inline at its parent's column only when the worktree is
  clean and branches it right otherwise, and `head_lane_extension` yields no extension at all
  while the worktree is dirty. The frontend prepends the WIP row at the head-chain column
  whenever `wipCount > 0`, and an inline stash lands in that same column. Do not drop **or
  narrow** either worktree-state guard — their dirtiness stays the shared
  `git::status::worktree_dirty` definition the WIP row is gated on, staged, unstaged,
  conflicted and untracked alike; a tighter predicate keeps both guards and still collides
  (amended 2026-08-02, after a
  TypeScript-only fix for the same collision was reverted; the counterexample was refuted
  2026-08-03 — 31 inline events across the suite and the QA fixtures, all at column 0)
- Do not drop **or widen** `can_inline`'s extension clause,
  `head_lane_ext.is_empty() || ext_tip == parent_oid`, where `ext_tip` is
  `head_lane_ext.first().copied()` — the topmost extension row. Both arms of
  `head_lane_extension` return their path newest first, and reversing either silently
  inverts the predicate. Below the top the clause is load-bearing twice: it keeps the stash
  out of the rows the unpulled chain owns, **and** it is part of what keeps the
  reserved-and-free invariant below valid; only a stash parented on the extension's own tip
  may inline, because no column-0 holder is walked between that stash and its parent
  (narrowed 2026-08-30 at the user's direction, TRUNK-43 — the all-or-nothing clause made a
  stash on the extension tip take its own lane while column 0 sat free). Pinned by
  `stash_branches_right_when_the_head_lane_extends` (parent below the extension still
  branches right), `a_stash_inside_the_head_lane_extension_branches_right` (parent inside
  it), and the tip-inline pair
  `a_stash_on_the_upstream_extension_tip_inlines_into_the_head_lane` /
  `a_stash_on_the_tiebreak_extension_tip_inlines_into_the_head_lane`
- **Every unpaired `pending_parents.insert`** (the map is a local of `assign_lanes` in
  `placement.rs`) — one that reserves a column without also
  occupying it in `active_lanes` — must either be the HEAD-chain pre-reservation or be
  excluded by a `can_inline` clause. Exactly two exist today, and both reserve column 0
  only: the `head_chain` pre-reservation and `head_lane_extension`, the second excluded
  except at its top row — an inline may consume the reservation the extension left for
  `head_lane_ext[0]`, and only that one. That both sites reserve column 0 only is what
  makes every inline land at column 0, and it is the property a third site must preserve.
  The safety condition the exclusion stands in for, stated directly: an inline is safe
  exactly when no row walked between the stash's row and its parent's row claims column 0.
  The column-0 reservation holders are exactly `head_chain ∪ head_lane_ext`, one
  first-parent line, and the walk is topological, so a holder walked between the stash and
  its parent must be a descendant of that parent on that line — no such holder exists
  precisely when the parent is the line's topmost member. The two `can_inline` clauses
  (`head_lane_ext.is_empty() || ext_tip == parent_oid`, and
  `!head_chain.contains(&p) || input.head_tip == Some(p)`) are the two-piece encoding of
  that one condition. **The off-chain disjunct `!head_chain.contains(&p)` is no longer
  redundant:** when the extension is non-empty, the admitted parent is `head_lane_ext[0]`,
  which is **not** in `head_chain` and is **not** the HEAD tip — the off-chain disjunct is
  the only half of that clause it can satisfy, so deleting it silently reverts the TRUNK-43
  fix while leaving `a_stash_below_the_head_tip_branches_out_of_the_head_lane` green. It
  stays the sweep's row-11 anchor, and after the narrowing it is killed by more tests, not
  fewer. The walk-through is in
  `docs/architecture/commit-graph.md` §"Phase 1", which enumerates the clauses and quotes this
  disjunct in full (referent settled 2026-08-11 at the user's direction). Landing a third insert
  without a matching exclusion re-opens it: the third site must either reserve column 0
  **and** sit on the same first-parent line above `head_tip`, or be excluded by a
  `can_inline` clause — re-derive before you land it, and record the
  result here (re-derived 2026-08-05, when `head_lane_extension` became the second;
  re-derived 2026-08-28, when a dirty worktree began suppressing the extension: still exactly
  two sites, and while dirty the second produces no insert at all; re-derived 2026-08-30
  with TRUNK-43's tip narrowing, which this bullet now states — the off-chain disjunct
  stopped being redundant in that same change)
- Never let the HEAD lane's upward extension take a stash. A stash hangs off its parent by
  first parent like any commit, and placing it in the lane would both steal column 0 from the
  branch's real continuation and bypass `can_inline` entirely. `head_lane_extension` filters
  the stash set out of **both** candidates — the tracked-upstream path and the revwalk-order
  continuation. Deleting either filter puts the stash into `pending_parents` at column 0,
  where it takes the lane in a fresh colour without `can_inline` ever running.
  `stash_inline_on_head_tip` catches the revwalk-order filter only — its shape has no tracked
  upstream, so it cannot reach the other arm. The tracked-upstream filter is pinned by
  `a_stash_on_the_tracked_upstream_path_blocks_the_head_lane_extension` in `test_placement.rs`
  (corrected 2026-08-11: this bullet claimed one test caught both, and deleting the upstream
  filter left it green). A dirty worktree returns from `head_lane_extension` before either
  filter runs, so a test probing either needs a clean worktree: `worktree_dirty: false` in a
  `test_placement.rs` literal, or a clean working tree in the shape behind a captured rule
  input (added 2026-08-28 with the suppression)
- Any change on the dirty path must assert a **non-stash** branch's column *and* colour in
  `src-tauri/tests/test_graph.rs` — flipping clean↔dirty re-lays-out and re-colours unrelated
  branches. Two churn classes are accepted, each with its own pinned pair. Stash placement:
  `dirtiness_relayouts_unrelated_branches` and
  `dirtiness_recolors_branches_below_the_stash_parent`. The HEAD lane's upward extension,
  which a dirty worktree suppresses outright, so every continuation above `head_tip` moves
  right and takes a colour of its own:
  `a_dirty_worktree_outranks_the_upstream_for_the_head_lane` and
  `a_dirty_worktree_outranks_the_tiebreak_continuation_for_the_head_lane` (class added
  2026-08-28 at the user's direction, with the suppression itself)
- A red graph golden, export or render golden is a suspected defect, never a stale
  artifact. Investigate before regenerating. The one legitimate door is
  `just graph-accept "<reason>"`, which records the reason in
  `docs/commit-graph-changelog.md` — never set `TRUNK_ACCEPT_GRAPH_GOLDENS` by hand, and
  never accept a change without the user's explicit direction. Regenerating destroys the only
  evidence these artifacts exist to produce. `just graph-capture` sits upstream of all three,
  rewriting the captured inputs in `src-tauri/tests/inputs/` that the goldens are computed
  from, and the named-rule inputs in `src-tauri/tests/rule-inputs/` that `test_graph.rs`
  reads — it never writes a golden. A capture therefore turns the suite red with no code
  change, and that redness is a suspected defect like any other: investigate the input diff
  before accepting. Whether capture should demand a reason of its own is open; decide it the
  next time a capture turns the suite red, and record the ruling here. The same discipline is
  restated in `scripts/graph-accept.sh`, both `ACCEPT_HINT` strings
  (`src-tauri/tests/common/goldens.rs`, `src/__tests__/helpers/graph-render.ts`), `DRIFT_HINT`
  in `src-tauri/tests/test_graph_capture.rs`, and
  `docs/architecture/commit-graph.md` §"Golden corpus"; `scripts/graph-capture.sh`'s header
  states the upstream half only. When this bullet's substance changes, amend every
  restatement it touches in the same change. (Added 2026-08-07 at the user's direction, and
  every restatement amended in that same change — the red-golden half was already in the
  sites named above, but nothing stated the user-direction gate; the nearest policy was
  `docs/architecture/commit-graph.md`, which the "code wins" bullet above subordinates to the
  pipeline source)
- Every test in `test_graph.rs` outside the repository-built sets (a) and (b) in the
  "Two kinds of test" bullet below reads a committed capture; it never rebuilds the repository
  inside the test. Its data comes
  from `graph::capture` run over a shape in `tests/common/graph_shapes.rs`, or one of the two
  local shapes in `test_graph_capture.rs`, and committed to `tests/rule-inputs/` — a repository
  rebuilt
  in the test body is the executing agent's reconstruction of one, and a wrong reconstruction
  pins the wrong graph while staying green. **This does not reach `test_placement.rs` or
  `test_graph_input.rs`**: both drive `assign_lanes` / `layout` from hand-written
  `PlacementInput` literals by design, where the literal is the unit's input rather than a
  stand-in for a repository, and is the only way to state an input `capture()` cannot produce
  — the missing-parent and cycle contracts among them
- `just graph-fidelity` is the only thing standing behind "a rule input is what the repository
  produces", and **nothing runs it for you**: the check is `#[ignore]`d and sits in neither
  `just check` nor CI. Run it in the same change as any edit to a shape in `graph_shapes.rs`,
  to any shape builder in `test_graph_capture.rs` — `shapes()` and the two local ones — to
  `TestContext::builder` in `tests/common/builder.rs`, whose pinned clock builds eight of the
  captured inputs, to `capture` in `graph.rs`, or to the dirtiness definition in `status.rs` — a
  rule input freezes `worktree_dirty` as a bool
  (`graph_input.rs`, `CapturedGraph`), so a narrowed predicate leaves the stash-dirtiness tests
  green on data the repository no longer produces — and after any `just graph-capture`. A drift
  it reports is a suspected defect, never a stale artifact
- Two kinds of test in `test_graph.rs` stay repository-built. **(a) Binding** — a test whose
  subject is git2 itself: the five `graph_and_dirty_counts_agree_when_*` — they read the live
  `status::worktree_dirty`, which a capture freezes, and are what still catches a narrowed
  `DIRTY_BITS` (measured 2026-08-11: dropping `STAGED_BITS` failed
  `graph_and_dirty_counts_agree_when_only_staged` *and*
  `stash_branches_right_when_only_staged` before the dirtiness migration, and only the first
  after it — still caught, with the redundancy gone);
  `walk_commits_on_bare_repo_does_not_error`, the two `unreadable_stash_*`, and
  `tagged_stash_is_not_duplicated`; plus, measured 2026-08-11, the only two tests in the four
  suites `just rust` runs (`test_graph.rs`, `test_placement.rs`, `test_graph_input.rs`,
  `test_graph_goldens.rs`) that fail when the revwalk's `TOPOLOGICAL | TIME` loses `TIME` —
  `two_backdated_stashes_on_one_parent` and `dirtiness_relayouts_unrelated_branches`. A
  capture freezes walk order, so migrating either deletes that coverage rather than moving it;
  re-measure that pair before migrating anything under it, and record the date here and in
  `topic_layout_clean_then_dirty`'s doc comment in `test_graph.rs`, which states the same
  count. The sweep
  cannot stand in for them: its row 7 (`docs/commit-graph-mutation-ledger.md` §"Row 7",
  `scripts/graph-mutation-sweep.py`) mutates `TOPOLOGICAL | TIME` to `TOPOLOGICAL ^ TIME`,
  which is the same value — the flags are distinct bits — so it is an equivalent mutant, and
  nothing in the sweep drops `TIME`. **(b) Not yet migrated, and free to migrate** —
  `detached_head_marks_first_parent_chain`, and every test under the "HEAD lane follows linear
  continuations" heading that still builds its repository in the body rather than reading a
  capture through `rule_inputs`. The set only shrinks: a new test rebuilds a repository under
  (a) or not at all
- Pin every commit timestamp in a graph shape, spaced, never same-second. `TestContext::builder`
  pins its own clock (`FIXTURE_BASE_SECS`, day-spaced); a raw-git2 shape must call
  `graph_shapes::sig_at` with spaced values rather than declare a local signature helper.
  `git2::Signature::now` is disqualified outright: two builds give different OIDs, so the shape
  cannot be captured at all, and same-second commits sort arbitrarily under
  `TOPOLOGICAL | TIME`. `graph_shapes.rs`'s module doc and the "HEAD lane follows linear
  continuations" comment in `test_graph.rs` are this rule's mirrors
- Changing `placement.rs`, `graph.rs` or `graph_input.rs` re-opens the mutation sweep. `scripts/graph-mutation-sweep.py`
  carries one exact-string anchor per measured mutation into `placement.rs`, `graph.rs` and
  `graph_input.rs`, and `just graph-sweep-check` fails inside `just check` the moment one stops
  matching exactly once. That failure is the alarm working, not a broken script: a measured site
  was reworded, re-indented, deleted or moved, so the verdict
  `docs/commit-graph-mutation-ledger.md` records for it no longer describes the code. Re-anchor
  it, narrowing the anchor if it now matches twice rather than zero times. **Commit the pipeline
  change before re-running** — the sweep refuses to start while `placement.rs`, `graph.rs` or
  `graph_input.rs` is dirty, because a stale mutation left in a source would compound into every
  later cycle. Then re-measure at least the rows you touched with
  `just graph-sweep --only 11,12`, and splice those rows into the ledger's table in place — that
  table is otherwise `just graph-sweep`'s stdout pasted unedited, so a partial splice is the one
  edit it accepts, and a full run supersedes it. When a measured site is genuinely gone, its
  anchor goes too — only with the user's direction, and only in the same change that moves its
  row out of the table into the ledger's §"Deleted anchors", naming the commit that removed the
  site. Never drop the row without recording it there: the sweep cannot report a site it no
  longer carries, so that section is the verdict's only surviving record. Never delete an anchor
  to silence the alarm, and never
  edit a pipeline source to kill a mutant. The alarm and the measurement are different things
  and only the alarm is in `just check`; the full sweep is 26-32 minutes and stays on demand,
  which `justfile`'s `graph-sweep` comment restates. (Added 2026-08-12: milestone 4's
  behaviour-preserving extraction moved every measured site while every golden stayed green,
  which is the failure this anchor set exists to catch)
- Tests: `just rust` (Rust — builds every graph suite: `src-tauri/tests/test_graph.rs` owns
  the named-rule assertions — over `tests/rule-inputs/`, plus the repository-built set the
  "Two kinds of test" bullet enumerates — and pins the accepted dirtiness churn, `test_placement.rs`
  the pure lane algorithm, `test_graph_input.rs` page hydration, `test_graph_goldens.rs` the
  committed fixture corpus; plain `cargo test --lib` runs none of them, and `just` runs them
  the way CI does), `just front` (TypeScript)

## Reference

- `docs/architecture/commit-graph.md` — read before changing lane assignment, edge
  emission, or node rendering. Covers the pipeline stages, the per-commit phases, the file
  map, and the golden corpus (capture, red-golden discipline, `just graph-accept`)
- `docs/research/gitamine-graph-algorithm.md` — read only when reworking the placement algorithm
  itself. A comparison against gitamine's "straight branches", not a spec of current
  behaviour; its stash sections carry staleness notes. The docs sweep above still covers this
  file on every pipeline change

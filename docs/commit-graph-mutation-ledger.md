# Commit graph mutation ledger

> **Incomplete.** Milestone 6 prepends the ledger header and the generated verdict table above
> the first section below. The three sections here are prose. No script generates them, and
> `just graph-sweep` never rewrites them.

The sweep script reports one of three verdicts: `SURVIVES`, `killed`, or `UNVIABLE`. It cannot
report "equivalent". A survivor is closed only by a fixture, a named-rule test, or a written
construction proof. Never by editing `placement.rs` or `graph.rs`. Every proof below names what
forces the mutant and the original to agree on **every** input. A corpus sweep that finds no
counterexample is not a proof, and this project has recorded two such arguments that were wrong.

Row numbers key to Appendix A of the milestone-5 grill document, which
`scripts/graph-mutation-sweep.py` carries as its 37 anchors.

## Construction proofs

Seventeen of the 37 measured mutants survive the suite and cannot be killed by any input. The
other twenty end killed. No row is left open.

### Rows 13, 14, 15, 16, 22 and 23 — the three resize guards are dead

These six mutate `active_lanes.resize(x + 1, None)` into `resize(x - 1, …)` or `resize(x * 1, …)`
at three sites: `placement.rs` `:275` (the inline branch), `:291` (post phase 1), and `:405` (the
unclaimed-parent branch). Each site sits inside a guard of the form `if x >= active_lanes.len()`.
All three guards are permanently false, so all three bodies are unreachable. Three lemmas
establish that.

**Lemma 1. `active_lanes.len()` never decreases.** Only two kinds of operation change its length:
the `push` at `:221`, and five `resize` calls at `:60`, `:72`, `:275`, `:291` and `:405`. Every
resize is `resize(x + 1, None)` under a guard proving `x >= active_lanes.len()`. So the new length
`x + 1` always exceeds the old one. The file contains no `truncate`, `pop`, `clear`, `drain`, or
reassignment of the vector.

**Lemma 2. `find_free_column_near` returns an index strictly inside `active_lanes`.** It has five
return sites. `:61` returns `target` right after `resize(target + 1, …)`. `:64` returns `target`
under `active_lanes[target].is_none()`, which would panic if `target` were out of range. `:73`
returns `right` right after `resize(right + 1, …)`. `:76` returns `right` under the same kind of
index. `:82` returns `left`, which is smaller than `target`, and the code reaches `:79` only when
`right < active_lanes.len()` held at `:71`.

**Lemma 3. Every value stored in `pending_parents` indexes `active_lanes` validly.** There are
four insert sites. `:225` and `:228` insert column 0 after the `push` at `:221`, so the length is
at least 1. `:408` inserts `col`, which `:290` to `:292` has already brought into range. `:429`
inserts a column from `find_free_column_near`, and `:428` indexes `active_lanes` at that column
immediately. Lemma 1 keeps every such value valid for the rest of the walk.

**Site `:291`, rows 15 and 16.** The value `col` comes from one of three places. From
`pending_parents` at `:246`, which lemmas 1 and 3 bound. From the `can_inline` branch at `:273`,
which also reads `pending_parents`. From `find_free_column_near` at `:281`, which lemma 2 bounds.
All three are smaller than the length, so the guard at `:290` never fires.

**Site `:405`, rows 22 and 23.** After `:290` to `:292`, `col` is smaller than the length. Between
`:292` and `:404` the code only iterates `active_lanes` at `:314` and assigns to existing slots at
`:351` and `:356`. Neither changes the length. So the guard at `:404` never fires.

**Site `:275`, rows 13 and 14.** This site needs its own argument, because `can_inline`'s last
clause at `:269` to `:270` explicitly admits `pcol >= active_lanes.len()`. That disjunct exists to
short-circuit before the `active_lanes[pcol]` index on the same line. It is a defensive bound
check, not a reachable state. The value `c` at `:273` is a `pending_parents` value, which lemma 3
bounds, so the guard at `:274` never fires either.

**Falsifier, run and silent.** The three resize bodies were replaced with `panic!`, and `:269`'s
first disjunct with `assert!(pcol < active_lanes.len())`. All 80 tests across the four graph
suites stayed green. That result refutes nothing and proves nothing on its own. The lemmas above
carry the verdict.

### Row 7 — `Sort::TOPOLOGICAL | Sort::TIME` and `^` are the same value

`git2::Sort::TOPOLOGICAL` is bit 1 and `git2::Sort::TIME` is bit 2. Measured directly against
git2 0.21. The two flags are disjoint, so `|` and `^` both yield `Sort { bits: 3 }`. No revwalk
can distinguish them.

### Row 10 — `is_merge`'s `&&` and `||` agree wherever the value is read

`is_merge` is written at `placement.rs:243` and read exactly once, at `:437`. That read sits in
the `else` arm of `if idx == 0`, so it runs only when `idx >= 1`. Reaching `idx >= 1` needs
`parents.len() >= 2`. For a stash, `:361` to `:365` truncates `parents` to one element, so a stash
never reaches it. For a non-stash, `parents` is the full list, so `commit_parents.len() >= 2`
holds. Both conjuncts are therefore true wherever `is_merge` is read, and `&&` and `||` agree.
`graph_input.rs` recomputes the flag that the goldens print, independently of this value.

### Rows 30 to 35 — the non-merge fork ladder is unreachable

These six mutate the `} else if parent_col < col {` and `} else if parent_col > col {` arms at
`:445` and `:447`. Both sit in the `else` half of `if is_merge` at `:437`. Row 10's argument shows
that `idx >= 1` implies `is_merge`, so that `else` half never executes. No input reaches any of
the six. Deleting the ladder outright is a separate decision, recorded in the milestone status
file and scheduled after milestone 6.

### Row 19 — `other_col < col` and `other_col <= col` agree

The fork-out ladder at `:324` sits inside the loop guarded by `other_col != col` at `:315`. The
two operators can differ only when `other_col == col`, which the guard excludes.

### Row 36 — `parents.is_empty() && !col_reoccupied` and `|| !col_reoccupied` agree

`col_reoccupied` starts `false` at `:368`. It is set `true` at `:385`, `:391` and `:409`, and
those three are the three branches of the `idx == 0` arm. That arm runs whenever `parents` is not
empty. So `parents.is_empty()` holds exactly when `!col_reoccupied` holds. Where `A` is equivalent
to `!B`, the expressions `A && !B` and `A || !B` agree.

### Row 37 — the root cleanup's removal is unobservable

Row 36's equivalence makes the mutated guard `parents.is_empty() && col_reoccupied` read as
`A && !A`, which is permanently false. So the mutant is exactly "`lane_colors.remove(&col)` at
`:467` never runs". Every read of `lane_colors` takes the form `get(&k).unwrap_or(&d)`. Mutant and
original can differ only where a retained key is read before something rewrites it.

Consider a column that the root cleanup frees. Reallocating that column takes one of three paths.
`find_free_column_near` at `:281` writes `lane_colors` at `:283` before any read. The
secondary-parent path at `:427` writes it at `:431`. A `pending_parents` column is always paired
with an `active_lanes` occupancy at `:408` or `:429`, so no live reservation at a freed column
survives the root that freed it.

One path writes no colour: `can_inline` at `:273`. It requires a column that is reserved and free
at once. The unpaired-insert rule in `.claude/rules/commit-graph.md` confines that state to column
0. At column 0 the retained value is `0`, from `:223` or `:297`, and every default for column 0 is
also `0`. So the two agree there as well.

**Falsifier, run and silent.** `placement.rs` was instrumented with a shadow map of what the root
cleanup removed, plus a checked read at all seven read sites. The check panics if a root-freed
colour is ever readable and differs from the default. All 81 tests stayed green.

### `head_lane_extension`'s cycle guard — unreachable, and conditionally so

This site is not one of the 37. It is a mutation site the extraction introduced, at
`placement.rs:161` to `:164`. Grill decision A called it a real gap needing a test. That is wrong,
and the probe below is what settles it.

The second arm of `head_lane_extension` walks upward over `first_parent_children`. An edge from
`c` to `c'` in that map means `first_parent(c') == c`. First-parent is a function, so a revisited
node forces the cycle back through `head_tip` itself. Any such cycle is a first-parent cycle that
`head_chain` descends, under an identical `steps > input.parents.len()` bound. `head_chain` runs
at `:213`, before `head_lane_extension` at `:217`. So `head_chain` panics first, every time.

**Probe.** `steps += 1;` was changed to `steps *= 1;` at `:161`, which disables the guard. Two
shapes ran unmutated and mutated, with identical results. A `head_tip` whose own first parent is
itself panicked at `placement.rs:120:13`, which is `head_chain`'s guard and not this one. A
first-parent cycle above a root `head_tip` terminated normally, because the cycle is unreachable
from `head_tip`. All 80 tests stayed green under the mutation, and nothing hung.

**Carry this caveat with the proof.** The equivalence depends on two facts that no test pins. It
depends on `head_chain` being called at `:213` before `head_lane_extension` at `:217`. It also
depends on `head_chain` keeping its own guard. Reordering those two calls revives the gap
silently.

**Do not close this with a `#[should_panic]` test.** All three cycle guards raise the identical
message, and `head_chain`'s fires first. Such a test passes under the mutation. It is false
coverage of exactly the kind the AC-7 audit exists to catch.

## AC-7 rule-to-test map

Every behavioural binding rule in `.claude/rules/commit-graph.md` is listed here with the named
test that asserts it, the mutation that probed the test, and the decision to keep it. A mapping
alone cannot detect a test that states a rule and pins nothing. Each row below was probed.

Every Rust probe ran with `--no-fail-fast` across all four graph suites. Without that flag, cargo
stops after the first failing binary, and a later suite's failure reads as a pass.

| Binding rule | Named test | Probing mutation | Outcome | Decision |
|---|---|---|---|---|
| Stash square, WIP circle, merge circle | four cases under `the node shape ladder`, `CommitGraph.render.test.ts` | render the stash branch as `<circle>` instead of `<rect>` in `CommitGraph.svelte` | `paints a stash as a dashed hollow square` red, plus 27 render goldens. The other three cases stayed green | keep |
| `can_inline`'s `!worktree_dirty` clause | `stash_branches_right_when_worktree_dirty`, `…_when_only_untracked`, `…_when_only_staged` | delete `&& !input.worktree_dirty` at `placement.rs:264` | all three red, plus seven others | keep all three |
| `can_inline`'s `head_lane_ext.is_empty()` clause | `stash_branches_right_when_the_head_lane_extends` | delete `&& head_lane_ext.is_empty()` at `:265` | red, plus the two golden tests | keep |
| `head_lane_extension` filters stashes, revwalk arm | `a_stash_never_extends_the_head_lane`, `stash_inline_on_head_tip` | delete `.filter(\|o\| !input.stashes.contains(o))` at `:149` | both red, plus eleven others | keep both |
| `head_lane_extension` filters stashes, tracked-upstream arm | `a_stash_on_the_tracked_upstream_path_blocks_the_head_lane_extension` | delete `&& !path.iter().any(\|o\| input.stashes.contains(o))` at `:141` | red, `left: (0, 0) right: (1, 1)` | keep, added by milestone 5 |
| Dirty path asserts colour as well as column | `dirtiness_relayouts_unrelated_branches`, `dirtiness_recolors_branches_below_the_stash_parent` | `next_color += 1` to `+= 2` at `:283` to `:284` | exactly those two red, plus three golden tests | keep both |
| Every unpaired `pending_parents.insert` | `a_stash_below_the_head_tip_branches_out_of_the_head_lane` | Appendix A row 11, delete `!` from `can_inline` clause 4 | row 11 flipped from `SURVIVES` to `killed` | keep, added by milestone 5 |

### Two findings this audit produced

**The tracked-upstream filter was uncovered.** Deleting it at `placement.rs:141` left all 76 tests
green. The reason is narrow. A non-stash commit's first parent is never a stash, and no captured
input puts a stash on an upstream's first-parent path. `PlacementInput` takes `tracked_upstream`
directly, so a literal expresses the shape that the corpus does not contain.

**The rule file overstates its own coverage.** `.claude/rules/commit-graph.md` says that
`head_lane_extension` filters the stash set out of both candidates, and that
`stash_inline_on_head_tip` "is what catches it". Measured, `stash_inline_on_head_tip` catches the
revwalk arm only. Nothing caught the tracked-upstream arm until milestone 5 added the test above.
Milestone 6 owns the correction to that passage.

**One test reads as coverage and is not.**
`stash_branches_right_when_head_chain_occupies_lane` is advertised in
`docs/architecture/commit-graph.md` as the mid-chain-stash test. Appendix A row 11 survived the
whole suite twice, so that test does not pin `can_inline` clause 4. The proposed mechanism, still
unverified, is that its setup leaves the worktree dirty, which short-circuits an earlier clause.

## Extraction-introduced sites

Milestone 4 moved the placement algorithm out of `graph.rs` into `placement.rs`, `graph_input.rs`
and a slimmer `graph.rs`. Appendix A's 37 anchors are re-derived against that layout and measured.
The sites the extraction **introduced** have no such baseline, and this section enumerates them.

**Method.** `cargo mutants --list` enumerates all three files today, at 111, 15 and 13 mutants for
a total of 139. It builds nothing and writes nothing. Each site's source line was then compared
against `git show 0112f0a:src-tauri/src/git/graph.rs`. 83 of the 139 lines carry over verbatim.
The remaining 56 were read by hand, which separates genuinely new logic from carried logic that
the extraction reworded. `input.worktree_dirty`, `input.head_tip`, `input.stashes` and
`commit_parents.len()` are rewordings, not new sites.

**41 sites are genuinely new.** That is more than the 33 a subtraction of 106 from 139 suggests.
The subtraction assumes nothing was deleted, and the extraction did delete the git2-specific code
that the old `walk_commits` carried.

| Group | Count | Where | Risk read |
|---|---|---|---|
| `head_chain`'s cycle guard | 5 | `placement.rs:118` to `:119` | Pinned by `a_cycle_below_the_head_tip_is_fatal`. The relational mutants shift the bound by one and may still be unpinned |
| `head_lane_extension`'s cycle guard | 5 | `placement.rs:161` to `:162` | Proved unreachable above. Equivalent, and conditionally so |
| `first_parent_path_to`'s cycle guard | 5 | `placement.rs:189` to `:190` | Pinned by `a_cycle_above_the_tracked_upstream_is_fatal`, with the same relational caveat |
| `parent_list`'s malformed-input panic | 2 | `placement.rs:93` | Pinned by `a_walk_member_the_parent_map_does_not_describe_is_fatal` |
| `head_chain`'s whole-function return | 2 | `placement.rs:103` | Returning an empty set drops the column-0 pre-reservation, which many goldens would catch |
| `assign_lanes`'s whole-function return | 1 | `placement.rs:202` | Returning a default layout blanks every golden |
| `graph.rs::parent_map` | 5 | `graph.rs:27`, `:37` | **The sharpest gap.** See below |
| `graph.rs::capture`'s whole-function return | 1 | `graph.rs:53` | Same reachability caveat as `parent_map` |
| `graph_input.rs`, whole file | 15 | row hydration and paging | Deferred by ruling, not by oversight. Milestone 6 task 0 measures all 15 |

**`test_graph.rs` is the only suite that reaches `capture`.** All 49 `walk_commits` calls live
there. `test_graph_goldens.rs` reads committed inputs and calls `graph_input::layout` directly, so
it never runs the git2 half of the pipeline. Every mutant in `graph.rs`, including Appendix A row
7, is therefore measurable only while `test_graph.rs` stays in the sweep's command. Dropping that
suite would record all 13 as false survivors.

//! Lane assignment for the commit graph, as a pure function over plain data.
//!
//! The algorithm needs no repository: it reads a revwalk order, a parent map and a stash
//! set, and returns a column, a colour and edges per commit. `graph.rs` gathers those
//! values from git2; a test can write them as a literal.

use std::collections::HashMap;
use std::collections::HashSet;

use git2::Oid;

use crate::git::types::{EdgeType, GraphEdge};

/// Lane slot: (occupant OID, dashed).
/// The dashed flag is set by the commit that creates/takes over the lane:
/// stash commits set true (their connection to parent is dashed),
/// non-stash commits set false.
type LaneSlot = Option<(Oid, bool)>;

/// Everything lane assignment reads. `parents` carries full, unfiltered parent lists and is
/// total over every oid the algorithm looks up: `oids` plus the first-parent chains above
/// `head_tip` and `tracked_upstream`.
#[derive(Debug, Clone)]
pub struct PlacementInput {
    pub oids: Vec<Oid>,
    pub parents: HashMap<Oid, Vec<Oid>>,
    pub stashes: HashSet<Oid>,
    pub head_tip: Option<Oid>,
    pub tracked_upstream: Option<Oid>,
    pub worktree_dirty: bool,
}

#[derive(Debug, Clone)]
pub struct Placement {
    pub column: usize,
    pub color_index: usize,
    pub edges: Vec<GraphEdge>,
    pub is_branch_tip: bool,
    pub is_stash: bool,
    /// The commit that claimed this lane, which every row below inherits until the lane
    /// ends. A column is claimed once, by a tip, and freed for reuse afterwards, so this
    /// identifies the line of history a row belongs to where the column alone cannot:
    /// two unrelated branches can hold one column at different rows.
    ///
    /// An OID rather than a ref, because the algorithm reads no refs at all. `graph_input`
    /// resolves it against the ref map, which is where ref labels live.
    pub lane_claim: Option<Oid>,
}

#[derive(Debug, Clone)]
pub struct Layout {
    pub placements: HashMap<Oid, Placement>,
    pub head_chain: HashSet<Oid>,
    pub max_columns: usize,
}

/// Find a free column nearest to `target`, spiraling outward (±1, ±2, …).
/// Inspired by gitamine's `insertCommit` proximity search — keeps branches
/// compact by placing new lanes near related commits instead of at the first
/// globally-available slot.
/// `min_col` prevents placement below a minimum column index. Column 0 belongs to the HEAD
/// lane, which `head_lane_extension` may widen past HEAD's own ancestry; anything that lane
/// does not claim is placed from column 1 up.
fn find_free_column_near(active_lanes: &mut Vec<LaneSlot>, target: usize, min_col: usize) -> usize {
    // Try target column first
    if target >= min_col {
        if target >= active_lanes.len() {
            active_lanes.resize(target + 1, None);
            return target;
        }
        if active_lanes[target].is_none() {
            return target;
        }
    }
    // Spiral outward: +1, -1, +2, -2, ...
    for delta in 1usize.. {
        // Try right (target + delta)
        let right = target + delta;
        if right >= active_lanes.len() {
            active_lanes.resize(right + 1, None);
            return right;
        }
        if active_lanes[right].is_none() {
            return right;
        }
        // Try left (target - delta), if within bounds and above min_col
        if delta <= target {
            let left = target - delta;
            if left >= min_col && active_lanes[left].is_none() {
                return left;
            }
        }
    }
    unreachable!("spiral search always terminates by extending active_lanes")
}

/// The parent list recorded for `oid`. An oid the walk lists with no entry here is a
/// malformed input, not a repository state, so it fails loudly rather than laying out as a
/// root.
fn parent_list(parents: &HashMap<Oid, Vec<Oid>>, oid: Oid) -> &[Oid] {
    match parents.get(&oid) {
        Some(list) => list,
        None => panic!("placement: no parent list for {oid}"),
    }
}

/// HEAD's own first-parent ancestry, newest first. The descent stops at a commit the map
/// does not describe, keeping the oid it stopped on — a shallow boundary and a root both
/// end the walk that way, and both belong to the chain.
fn head_chain(input: &PlacementInput) -> HashSet<Oid> {
    let mut chain: HashSet<Oid> = HashSet::new();

    let Some(head_tip) = input.head_tip else {
        return chain;
    };

    let mut current = head_tip;
    let mut steps = 0usize;
    loop {
        chain.insert(current);

        let Some(&next) = input.parents.get(&current).and_then(|ps| ps.first()) else {
            return chain;
        };

        steps += 1;
        if steps > input.parents.len() {
            panic!("placement: cycle in parent map at {current}");
        }
        current = next;
    }
}

/// The commits sitting directly above `head_tip` on the same first-parent line, newest
/// first, plus whether that chain is HEAD's tracked upstream.
///
/// The HEAD lane owns these as well as HEAD's ancestors, so a branch that is merely behind
/// renders as the straight line the DAG actually is. Several chains can continue `head_tip`
/// and only one holds the lane, in this order: the working tree while it is dirty, then the
/// tracked upstream, then whichever continuation the revwalk ordered first. The working tree
/// has no commits to place — the frontend draws it as the WIP row above `head_tip` — so when
/// it wins there is no extension at all and every real continuation forks right.
fn head_lane_extension(input: &PlacementInput) -> (Vec<Oid>, bool) {
    if input.worktree_dirty {
        return (Vec::new(), false);
    }

    let Some(head_tip) = input.head_tip else {
        return (Vec::new(), false);
    };

    if let Some(upstream) = input.tracked_upstream
        && let Some(path) = first_parent_path_to(&input.parents, upstream, head_tip)
        && !path.is_empty()
        && !path.iter().any(|o| input.stashes.contains(o))
    {
        return (path, true);
    }

    // A stash hangs off its parent by first parent too, and it is not a continuation of that
    // branch — it has its own placement rules and must never take the lane.
    let mut first_parent_children: HashMap<Oid, Vec<Oid>> = HashMap::new();
    for &oid in input.oids.iter().filter(|o| !input.stashes.contains(o)) {
        if let Some(&parent) = input.parents.get(&oid).and_then(|ps| ps.first()) {
            first_parent_children.entry(parent).or_default().push(oid);
        }
    }

    let mut path = Vec::new();
    let mut current = head_tip;
    let mut steps = 0usize;
    while let Some(children) = first_parent_children.get(&current) {
        let Some(&next) = children.first() else { break };

        steps += 1;
        if steps > input.parents.len() {
            panic!("placement: cycle in parent map at {current}");
        }
        path.push(next);
        current = next;
    }
    path.reverse();
    (path, false)
}

/// The first-parent commits between `from` and `target`, newest first, or `None` when
/// `from` does not reach `target` by first parent at all.
fn first_parent_path_to(
    parents: &HashMap<Oid, Vec<Oid>>,
    from: Oid,
    target: Oid,
) -> Option<Vec<Oid>> {
    let mut path = Vec::new();
    let mut current = from;
    let mut steps = 0usize;
    loop {
        if current == target {
            return Some(path);
        }

        let &next = parents.get(&current)?.first()?;

        steps += 1;
        if steps > parents.len() {
            panic!("placement: cycle in parent map at {current}");
        }
        path.push(current);
        current = next;
    }
}

/// Open a lane at `col`: take the next colour and record what claimed it.
///
/// A lane's colour and its claim are one event seen twice — a new line of history starting
/// at this column — so they are taken together. Assigning a colour without moving the claim
/// leaves a reused column drawn in the new branch's colour under the old branch's name.
///
/// `claim` is `None` for a stash, which takes a lane without naming one: it is a state
/// rather than a line of history. Opening with no claim still clears the column's previous
/// one — a stash reusing a column a branch just freed must not leave that branch's claim for
/// the commit below the stash to inherit.
fn open_lane(
    lane_colors: &mut HashMap<usize, usize>,
    lane_claims: &mut HashMap<usize, Oid>,
    next_color: &mut usize,
    col: usize,
    claim: Option<Oid>,
) {
    lane_colors.insert(col, *next_color);
    *next_color += 1;

    match claim {
        Some(oid) => {
            lane_claims.insert(col, oid);
        }
        None => {
            lane_claims.remove(&col);
        }
    }
}

pub fn assign_lanes(input: &PlacementInput) -> Layout {
    // active_lanes[col] = Some((oid, dashed)) → col is tracking that oid's chain
    // The dashed flag is set by the commit that creates/takes over the lane.
    // pending_parents[oid] = col → a child already reserved this column for oid
    let mut active_lanes: Vec<LaneSlot> = Vec::new();
    let mut pending_parents: HashMap<Oid, usize> = HashMap::new();
    let mut placements: HashMap<Oid, Placement> = HashMap::new();

    // max_columns: high-water mark of active_lanes.len() (Fix 3: ALGO-03)
    let mut max_columns: usize = 0;

    // Branch color counter (Fix 4): deterministic per-branch color assignment
    let mut next_color: usize = 1; // 0 reserved for HEAD's own chain
    let mut lane_colors: HashMap<usize, usize> = HashMap::new();
    // lane_claims[col] = the commit that opened the lane col currently holds. Every row below
    // inherits it until the lane ends. Written wherever a lane opens, which is wherever
    // `lane_colors` takes a new colour, so a column released by one branch and taken by
    // another names the branch that holds it now rather than the one that freed it.
    let mut lane_claims: HashMap<usize, Oid> = HashMap::new();

    let head_chain = head_chain(input);

    // Commits above HEAD's tip on the same first-parent line. While the worktree is clean they
    // share the HEAD lane, so a branch that is only behind renders straight instead of forking
    // away from itself; a dirty one keeps lane 0 for the WIP row and there is no extension.
    let (head_lane_ext, ext_is_upstream) = head_lane_extension(input);

    // Pre-reserve column 0 for ALL head_chain members via pending_parents.
    if !head_chain.is_empty() {
        active_lanes.push(None);
        max_columns = max_columns.max(active_lanes.len());
        lane_colors.insert(0, 0); // HEAD chain always color 0
        for &hc_oid in &head_chain {
            pending_parents.insert(hc_oid, 0);
        }
        for &ext_oid in &head_lane_ext {
            pending_parents.insert(ext_oid, 0);
        }
        // Only the tracked upstream is the same line of work as HEAD, so only it keeps HEAD's
        // colour. Any other continuation holds the lane under a colour of its own, which the
        // HEAD tip switches back below.
        if !head_lane_ext.is_empty() && !ext_is_upstream {
            lane_colors.insert(0, next_color);
            next_color += 1;
        }
    }

    for &oid in &input.oids {
        let commit_parents = parent_list(&input.parents, oid);
        let is_stash = input.stashes.contains(&oid);
        // Stash commits have 2-3 parents (base, index, untracked) but are NOT merges
        let is_merge = !is_stash && commit_parents.len() >= 2;

        // Phase 1: Find this commit's column (ACTIVATE)
        let col = if let Some(&c) = pending_parents.get(&oid) {
            pending_parents.remove(&oid);
            c
        } else {
            // New chain (regular branch tip OR stash).
            let min_col = if !head_chain.is_empty() { 1 } else { 0 };
            let parent_oid = commit_parents.first().copied();
            let parent_col = parent_oid.and_then(|pid| pending_parents.get(&pid).copied());

            // Inline stash placement: if the stash's parent column is free and
            // no intermediate commits will occupy it, place inline (same column
            // as parent) with a straight dashed line — like GitKraken.
            // An extending HEAD lane admits an inline only at its topmost row: below the
            // top, the unpulled chain still owns column 0 across the rows between the
            // stash and its parent. That admitted parent is off the head chain and not the
            // HEAD tip, so the !head_chain arm is what admits it — see
            // .claude/rules/commit-graph.md before narrowing any clause. The worktree must
            // be clean: a dirty one puts the WIP row here.
            // `head_lane_extension` returns its path newest first on both arms, which is
            // what makes `first()` the topmost row.
            let ext_tip = head_lane_ext.first().copied();
            let can_inline = is_stash
                && !input.worktree_dirty
                && (head_lane_ext.is_empty() || ext_tip == parent_oid)
                && parent_col.is_some()
                && parent_oid
                    .is_some_and(|p| !head_chain.contains(&p) || input.head_tip == Some(p))
                && parent_col
                    .is_some_and(|pcol| pcol >= active_lanes.len() || active_lanes[pcol].is_none());

            if can_inline {
                let c = parent_col.unwrap();
                if c >= active_lanes.len() {
                    active_lanes.resize(c + 1, None);
                }
                c
            } else {
                // Normal placement: find free column near parent's column.
                let target = parent_col.unwrap_or(0).max(min_col);
                let c = find_free_column_near(&mut active_lanes, target, min_col);
                open_lane(
                    &mut lane_colors,
                    &mut lane_claims,
                    &mut next_color,
                    c,
                    (!is_stash).then_some(oid),
                );
                c
            }
        };

        // Ensure active_lanes is large enough for this column
        if col >= active_lanes.len() {
            active_lanes.resize(col + 1, None);
        }
        max_columns = max_columns.max(active_lanes.len());

        // The extension's colour and claim end here: from the HEAD tip down, lane 0 is HEAD's
        // own. An extension above the tip pre-claims column 0 for itself (the `or_insert`
        // below), so without this reset the tip would inherit the extension's claim instead of
        // naming its own ref — the one case where a live claim must be overwritten.
        if input.head_tip == Some(oid) {
            lane_colors.insert(0, 0);
            lane_claims.insert(0, oid);
        }

        // Rows below a lane's opener inherit its claim rather than re-claiming, which is what
        // `or_insert` says. A tip opening a lane has already claimed the column above, so it
        // does not reach this; nothing here overwrites a live claim.
        //
        // This covers column 0, which is pre-reserved for the head chain before the walk
        // starts and so is never seen being taken: the first row to land there is HEAD's own
        // tip, or the topmost row of the extension continuing it.
        //
        // A stash claims nothing. It names a state rather than a line of history, and a clean
        // worktree inlines it at the top of the lane it hangs off, where it would otherwise
        // claim that whole lane and rename every commit on the branch below it.
        if !is_stash {
            lane_claims.entry(col).or_insert(oid);
        }

        // Branch tip: no child has set up this lane (active_lanes[col] is None),
        // or this is a root commit (no parents) — root commits always terminate the lane downward.
        let is_root_commit = commit_parents.is_empty();
        let is_branch_tip =
            is_root_commit || col >= active_lanes.len() || active_lanes[col].is_none();

        // Get this commit's color_index from lane_colors.
        let commit_color = *lane_colors.get(&col).unwrap_or(&0);
        let commit_lane_claim = lane_claims.get(&col).copied();

        // Phase 2: Emit pass-through edges for all OTHER active lanes (PASSTHROUGH)
        // Also detect fork-in lanes: lanes held by a child that forked from this commit.
        // For those, emit a fork-out edge from this commit's column to the branch column.
        let mut edges: Vec<GraphEdge> = Vec::new();
        let mut fork_in_cols: Vec<usize> = Vec::new();
        for (other_col, slot) in active_lanes.iter().enumerate() {
            if other_col != col
                && let Some(&(occupant, lane_dashed)) = slot.as_ref()
            {
                let is_dashed = lane_dashed;
                if occupant == oid {
                    // Fork-in: a child kept this lane alive pointing to us.
                    // Emit fork-out edge from our column to the branch column.
                    fork_in_cols.push(other_col);
                    let edge_color = *lane_colors.get(&other_col).unwrap_or(&other_col);
                    let edge_type = if other_col < col {
                        EdgeType::ForkLeft
                    } else {
                        EdgeType::ForkRight
                    };
                    edges.push(GraphEdge {
                        from_column: col,
                        to_column: other_col,
                        edge_type,
                        color_index: edge_color,
                        dashed: is_dashed,
                    });
                } else {
                    // Normal pass-through
                    let edge_color = *lane_colors.get(&other_col).unwrap_or(&other_col);
                    edges.push(GraphEdge {
                        from_column: other_col,
                        to_column: other_col,
                        edge_type: EdgeType::Straight,
                        color_index: edge_color,
                        dashed: is_dashed,
                    });
                }
            }
        }
        // Clean up fork-in lanes (branch terminated at this commit)
        for &fc in &fork_in_cols {
            active_lanes[fc] = None;
            lane_colors.remove(&fc);
        }

        // Phase 3: Consume this commit's slot (TERMINATE current occupant)
        active_lanes[col] = None;

        // Assign columns to parents and emit crossing edges
        // For stash commits, only track the first parent (base commit).
        // Parents 1+ are internal stash state (index, untracked) not in the graph.
        let parents: Vec<Oid> = if is_stash {
            commit_parents.first().copied().into_iter().collect()
        } else {
            commit_parents.to_vec()
        };

        // Track whether the current column is re-occupied by a parent
        let mut col_reoccupied = false;

        for (idx, &parent_oid) in parents.iter().enumerate() {
            if idx == 0 {
                // First parent: continue at current column (if not already reserved elsewhere)
                if let Some(&existing_col) = pending_parents.get(&parent_oid) {
                    if existing_col == col {
                        // Same column — re-occupy to maintain lane.
                        let edge_color = *lane_colors.get(&existing_col).unwrap_or(&existing_col);
                        edges.push(GraphEdge {
                            from_column: col,
                            to_column: col,
                            edge_type: EdgeType::Straight,
                            color_index: edge_color,
                            dashed: is_stash,
                        });
                        active_lanes[col] = Some((parent_oid, is_stash));
                        col_reoccupied = true;
                    } else {
                        // Different column — keep lane alive so the PARENT emits the fork-out edge.
                        // This creates pass-through rails at this column on intermediate rows,
                        // giving the branch its own visible lane.
                        active_lanes[col] = Some((parent_oid, is_stash));
                        col_reoccupied = true;
                        let edge_color = *lane_colors.get(&col).unwrap_or(&col);
                        edges.push(GraphEdge {
                            from_column: col,
                            to_column: col,
                            edge_type: EdgeType::Straight,
                            color_index: edge_color,
                            dashed: is_stash,
                        });
                    }
                } else {
                    // Parent not yet claimed — claim at current column (lane continues).
                    // This applies to both regular commits and stashes with reachable parents.
                    if col >= active_lanes.len() {
                        active_lanes.resize(col + 1, None);
                    }
                    active_lanes[col] = Some((parent_oid, is_stash));
                    pending_parents.insert(parent_oid, col);
                    col_reoccupied = true;
                    let edge_color = *lane_colors.get(&col).unwrap_or(&col);
                    edges.push(GraphEdge {
                        from_column: col,
                        to_column: col,
                        edge_type: EdgeType::Straight,
                        color_index: edge_color,
                        dashed: is_stash,
                    });
                }
            } else {
                // Secondary parents: find or assign a column
                let parent_col = if let Some(&c) = pending_parents.get(&parent_oid) {
                    c
                } else {
                    // Find a free column near the merge commit's column
                    let min_col = if !head_chain.is_empty() { 1 } else { 0 };
                    let target = col.max(min_col);
                    let c = find_free_column_near(&mut active_lanes, target, min_col);
                    active_lanes[c] = Some((parent_oid, false));
                    pending_parents.insert(parent_oid, c);
                    open_lane(
                        &mut lane_colors,
                        &mut lane_claims,
                        &mut next_color,
                        c,
                        Some(parent_oid),
                    );
                    max_columns = max_columns.max(active_lanes.len());
                    c
                };

                let edge_type = if is_merge {
                    if parent_col < col {
                        EdgeType::MergeLeft
                    } else if parent_col > col {
                        EdgeType::MergeRight
                    } else {
                        EdgeType::Straight
                    }
                } else if parent_col < col {
                    EdgeType::ForkLeft
                } else if parent_col > col {
                    EdgeType::ForkRight
                } else {
                    EdgeType::Straight
                };

                // Merge edges use the source (merged-in) branch color
                let edge_color = *lane_colors.get(&parent_col).unwrap_or(&parent_col);
                edges.push(GraphEdge {
                    from_column: col,
                    to_column: parent_col,
                    edge_type,
                    color_index: edge_color,
                    dashed: false,
                });
            }
        }

        // Lane lifecycle — if no parents (root commit), ensure lane is freed
        if parents.is_empty() && !col_reoccupied {
            lane_colors.remove(&col);
        }

        max_columns = max_columns.max(active_lanes.len());
        placements.insert(
            oid,
            Placement {
                column: col,
                color_index: commit_color,
                edges,
                is_branch_tip,
                is_stash,
                lane_claim: commit_lane_claim,
            },
        );
    }

    Layout {
        placements,
        head_chain,
        max_columns,
    }
}

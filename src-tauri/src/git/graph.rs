use crate::error::TrunkError;
use crate::git::repository;
use crate::git::status;
use crate::git::types::{EdgeType, GraphCommit, GraphEdge, GraphResult};
use std::collections::HashMap;
use std::collections::HashSet;

/// Find a free column nearest to `target`, spiraling outward (±1, ±2, …).
/// Inspired by gitamine's `insertCommit` proximity search — keeps branches
/// compact by placing new lanes near related commits instead of at the first
/// globally-available slot.
/// `min_col` prevents placement below a minimum column index. Column 0 belongs to the HEAD
/// lane, which `head_lane_extension` may widen past HEAD's own ancestry; anything that lane
/// does not claim is placed from column 1 up.
/// Lane slot: (occupant OID, dashed).
/// The dashed flag is set by the commit that creates/takes over the lane:
/// stash commits set true (their connection to parent is dashed),
/// non-stash commits set false.
type LaneSlot = Option<(git2::Oid, bool)>;

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

/// The commits sitting directly above `head_tip` on the same first-parent line, newest
/// first, plus whether that chain is HEAD's tracked upstream.
///
/// The HEAD lane owns these as well as HEAD's ancestors, so a branch that is merely behind
/// renders as the straight line the DAG actually is. When several chains continue `head_tip`
/// only one can hold the lane: the tracked upstream takes it outright, and otherwise the
/// revwalk's own order breaks the tie.
fn head_lane_extension(
    repo: &git2::Repository,
    head_tip: git2::Oid,
    oids: &[git2::Oid],
    stash_oids: &HashSet<git2::Oid>,
) -> (Vec<git2::Oid>, bool) {
    if let Some(upstream) = tracked_upstream_oid(repo)
        && let Some(path) = first_parent_path_to(repo, upstream, head_tip)
        && !path.is_empty()
        && !path.iter().any(|o| stash_oids.contains(o))
    {
        return (path, true);
    }

    // A stash hangs off its parent by first parent too, and it is not a continuation of that
    // branch — it has its own placement rules and must never take the lane.
    let mut first_parent_children: HashMap<git2::Oid, Vec<git2::Oid>> = HashMap::new();
    for &oid in oids.iter().filter(|o| !stash_oids.contains(o)) {
        if let Ok(commit) = repo.find_commit(oid)
            && let Ok(parent) = commit.parent_id(0)
        {
            first_parent_children.entry(parent).or_default().push(oid);
        }
    }

    let mut path = Vec::new();
    let mut current = head_tip;
    while let Some(children) = first_parent_children.get(&current) {
        let Some(&next) = children.first() else { break };
        path.push(next);
        current = next;
    }
    path.reverse();
    (path, false)
}

fn tracked_upstream_oid(repo: &git2::Repository) -> Option<git2::Oid> {
    let head = repo.head().ok()?;
    if !head.is_branch() {
        return None;
    }
    let branch = git2::Branch::wrap(head);
    branch.upstream().ok()?.get().target()
}

/// The first-parent commits between `from` and `target`, newest first, or `None` when
/// `from` does not reach `target` by first parent at all.
fn first_parent_path_to(
    repo: &git2::Repository,
    from: git2::Oid,
    target: git2::Oid,
) -> Option<Vec<git2::Oid>> {
    let mut path = Vec::new();
    let mut current = from;
    loop {
        if current == target {
            return Some(path);
        }
        let commit = repo.find_commit(current).ok()?;
        path.push(current);
        current = commit.parent_id(0).ok()?;
    }
}

pub fn walk_commits(
    repo: &mut git2::Repository,
    offset: usize,
    limit: usize,
) -> Result<GraphResult, TrunkError> {
    // Step 0: Worktree state, read once — the frontend draws a WIP row in column 0
    // whenever this is true, so inline stash placement has to yield the lane.
    let worktree_dirty = status::worktree_dirty(repo);

    // Step 1: Build ref map (needs &mut repo for stash_foreach)
    let ref_map = repository::build_ref_map(repo);

    // Step 1b: Collect stash OIDs (stash_foreach needs &mut repo)
    let mut stash_oids: Vec<git2::Oid> = Vec::new();
    let _ = repo.stash_foreach(|_idx, _name, oid| {
        stash_oids.push(*oid);
        true
    });
    let stash_oid_set: HashSet<git2::Oid> = stash_oids.iter().copied().collect();

    // A stash only joins the walk once every object the walk will reach through it reads
    // back. Skipping an unreadable one costs that stash its row; letting it through costs
    // the whole repo its graph, because the walk fails as a unit.
    //
    // Its parents 1.. are the index tree, and the untracked tree when it was stashed with
    // INCLUDE_UNTRACKED. Pushing the stash makes them reachable, so without this set they
    // enter the walk as rows of their own.
    let mut walkable_stashes: Vec<git2::Oid> = Vec::new();
    let mut stash_internals: HashSet<git2::Oid> = HashSet::new();
    for &s_oid in &stash_oids {
        let Ok(commit) = repo.find_commit(s_oid) else {
            continue;
        };

        let parents: Vec<git2::Oid> = commit.parent_ids().collect();
        if parents.iter().any(|&p| repo.find_commit(p).is_err()) {
            continue;
        }

        stash_internals.extend(parents.iter().skip(1));
        walkable_stashes.push(s_oid);
    }

    // Step 2: Collect all OIDs via revwalk. Stashes ride the same walk as the refs, so
    // TOPOLOGICAL sorting places each one above its parent whatever its committer time says.
    let mut revwalk = repo.revwalk()?;
    revwalk.push_glob("refs/heads")?;
    revwalk.push_glob("refs/remotes")?;
    revwalk.push_glob("refs/tags")?;
    for &s_oid in &walkable_stashes {
        revwalk.push(s_oid)?;
    }
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    let mut oids: Vec<git2::Oid> = revwalk.collect::<Result<Vec<_>, _>>()?;
    oids.retain(|oid| !stash_internals.contains(oid));

    // Step 3: Compute page slice
    let start = offset.min(oids.len());
    let end = (offset + limit).min(oids.len());
    let page_oids = oids[start..end].to_vec();

    // Step 4: Lane assignment — single pass over ALL oids for lane continuity
    // active_lanes[col] = Some((oid, dashed)) → col is tracking that oid's chain
    // The dashed flag is set by the commit that creates/takes over the lane.
    // pending_parents[oid] = col → a child already reserved this column for oid
    let mut active_lanes: Vec<LaneSlot> = Vec::new();
    let mut pending_parents: HashMap<git2::Oid, usize> = HashMap::new();
    // per_oid_data stores (column, edges, color_index, is_branch_tip, is_stash) for each processed commit
    let mut per_oid_data: HashMap<git2::Oid, (usize, Vec<GraphEdge>, usize, bool, bool)> =
        HashMap::new();

    // max_columns: high-water mark of active_lanes.len() (Fix 3: ALGO-03)
    let mut max_columns: usize = 0;

    // Branch color counter (Fix 4): deterministic per-branch color assignment
    let mut next_color: usize = 1; // 0 reserved for HEAD's own chain
    let mut lane_colors: HashMap<usize, usize> = HashMap::new();

    // Pre-compute HEAD's first-parent chain and tip OID
    let mut head_chain: HashSet<git2::Oid> = HashSet::new();
    let mut head_tip: Option<git2::Oid> = None;
    if let Ok(head_ref) = repo.head()
        && let Some(oid) = head_ref.target()
    {
        head_tip = Some(oid);
        let mut current = Some(oid);
        while let Some(c_oid) = current {
            head_chain.insert(c_oid);
            current = repo
                .find_commit(c_oid)
                .ok()
                .and_then(|c| c.parent_id(0).ok());
        }
    }

    // Commits above HEAD's tip on the same first-parent line. They share the HEAD lane, so a
    // branch that is only behind renders straight instead of forking away from itself.
    let (head_lane_ext, ext_is_upstream) = match head_tip {
        Some(tip) => head_lane_extension(repo, tip, &oids, &stash_oid_set),
        None => (Vec::new(), false),
    };

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

    for &oid in &oids {
        let commit = repo.find_commit(oid)?;
        let is_stash = stash_oid_set.contains(&oid);
        // Stash commits have 2-3 parents (base, index, untracked) but are NOT merges
        let is_merge = !is_stash && commit.parent_count() >= 2;

        // Phase 1: Find this commit's column (ACTIVATE)
        let col = if let Some(&c) = pending_parents.get(&oid) {
            pending_parents.remove(&oid);
            c
        } else {
            // New chain (regular branch tip OR stash).
            let min_col = if !head_chain.is_empty() { 1 } else { 0 };
            let parent_col = commit
                .parent_id(0)
                .ok()
                .and_then(|pid| pending_parents.get(&pid).copied());
            let parent_oid = commit.parent_id(0).ok();

            // Inline stash placement: if the stash's parent column is free and
            // no intermediate commits will occupy it, place inline (same column
            // as parent) with a straight dashed line — like GitKraken.
            // Only column 0 is ever reserved-and-free, so the !head_chain arm cannot
            // fire on its own — see .claude/rules/commit-graph.md before narrowing any
            // clause. The worktree must be clean: a dirty one puts the WIP row here.
            // An extending HEAD lane rules inlining out entirely: the unpulled chain already
            // owns column 0 across the rows between the stash and its parent.
            let can_inline = is_stash
                && !worktree_dirty
                && head_lane_ext.is_empty()
                && parent_col.is_some()
                && parent_oid.is_some_and(|p| !head_chain.contains(&p) || head_tip == Some(p))
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
                // New branch gets a new color
                lane_colors.insert(c, next_color);
                next_color += 1;
                c
            }
        };

        // Ensure active_lanes is large enough for this column
        if col >= active_lanes.len() {
            active_lanes.resize(col + 1, None);
        }
        max_columns = max_columns.max(active_lanes.len());

        // The extension's colour ends here: from the HEAD tip down, lane 0 is HEAD's own.
        if head_tip == Some(oid) {
            lane_colors.insert(0, 0);
        }

        // Branch tip: no child has set up this lane (active_lanes[col] is None),
        // or this is a root commit (no parents) — root commits always terminate the lane downward.
        let is_root_commit = commit.parent_count() == 0;
        let is_branch_tip =
            is_root_commit || col >= active_lanes.len() || active_lanes[col].is_none();

        // Get this commit's color_index from lane_colors.
        let commit_color = *lane_colors.get(&col).unwrap_or(&0);

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
        let parents: Vec<git2::Oid> = if is_stash {
            commit.parent_id(0).ok().into_iter().collect()
        } else {
            commit.parent_ids().collect()
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
                    // New secondary parent lane gets a new color
                    lane_colors.insert(c, next_color);
                    next_color += 1;
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
        per_oid_data.insert(oid, (col, edges, commit_color, is_branch_tip, is_stash));
    }

    // Step 5: Build output for page_oids only
    let mut result = Vec::with_capacity(page_oids.len());
    for oid in page_oids {
        let commit = repo.find_commit(oid)?;
        let (column, edges, color_index, is_branch_tip, is_stash) = per_oid_data
            .remove(&oid)
            .unwrap_or((0, vec![], 0, false, false));
        let mut refs = ref_map.get(&oid).cloned().unwrap_or_default();
        for r in &mut refs {
            r.color_index = color_index;
        }
        let is_head = refs.iter().any(|r| r.is_head);
        let is_merge = !is_stash && commit.parent_count() >= 2;
        // For stash commits, only expose the first parent (base commit)
        let parent_oids: Vec<String> = if is_stash {
            commit
                .parent_id(0)
                .ok()
                .map(|o| o.to_string())
                .into_iter()
                .collect()
        } else {
            commit.parent_ids().map(|o| o.to_string()).collect()
        };
        let author = commit.author();
        let short_oid = &oid.to_string()[..7];

        result.push(GraphCommit {
            oid: oid.to_string(),
            short_oid: short_oid.to_owned(),
            summary: commit.summary().ok().flatten().unwrap_or("").to_owned(),
            body: commit.body().ok().flatten().map(|s| s.to_owned()),
            author_name: author.name().unwrap_or("").to_owned(),
            author_email: author.email().unwrap_or("").to_owned(),
            author_timestamp: author.when().seconds(),
            parent_oids,
            column,
            color_index,
            edges,
            refs,
            is_head,
            is_merge,
            is_branch_tip,
            is_stash,
            in_head_chain: head_chain.contains(&oid),
        });
    }

    Ok(GraphResult {
        commits: result,
        max_columns,
    })
}

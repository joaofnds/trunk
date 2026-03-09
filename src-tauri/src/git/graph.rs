use std::collections::{HashMap, HashSet};
use crate::error::TrunkError;
use crate::git::types::{EdgeType, GraphCommit, GraphEdge, GraphResult};
use crate::git::repository;

pub fn walk_commits(
    repo: &mut git2::Repository,
    offset: usize,
    limit: usize,
) -> Result<GraphResult, TrunkError> {
    // Step 1: Build ref map (needs &mut repo for stash_foreach)
    let ref_map = repository::build_ref_map(repo);

    // Step 2: Collect all OIDs via revwalk
    let mut revwalk = repo.revwalk()?;
    revwalk.push_glob("refs/heads")?;
    revwalk.push_glob("refs/remotes")?;
    revwalk.push_glob("refs/tags")?;
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    let oids: Vec<git2::Oid> = revwalk.collect::<Result<Vec<_>, _>>()?;

    // Step 3: Compute page slice
    let start = offset.min(oids.len());
    let end = (offset + limit).min(oids.len());
    let page_oids = oids[start..end].to_vec();

    // Step 4: Lane assignment — single pass over ALL oids for lane continuity
    // active_lanes[col] = Some(oid) → col is tracking that oid's chain
    // pending_parents[oid] = col → a child already reserved this column for oid
    let mut active_lanes: Vec<Option<git2::Oid>> = Vec::new();
    let mut pending_parents: HashMap<git2::Oid, usize> = HashMap::new();
    // per_oid_data stores (column, edges, color_index) for each processed commit
    let mut per_oid_data: HashMap<git2::Oid, (usize, Vec<GraphEdge>, usize)> = HashMap::new();

    // max_columns: high-water mark of active_lanes.len() (Fix 3: ALGO-03)
    let mut max_columns: usize = 0;

    // Branch color counter (Fix 4): deterministic per-branch color assignment
    let mut next_color: usize = 1; // 0 reserved for HEAD chain
    let mut lane_colors: HashMap<usize, usize> = HashMap::new();

    // Pre-compute HEAD's first-parent chain
    let mut head_chain: HashSet<git2::Oid> = HashSet::new();
    if let Ok(head_ref) = repo.head() {
        if let Some(oid) = head_ref.target() {
            let mut current = Some(oid);
            while let Some(c_oid) = current {
                head_chain.insert(c_oid);
                current = repo.find_commit(c_oid).ok().and_then(|c| c.parent_id(0).ok());
            }
        }
    }

    // Pre-reserve column 0 for ALL head_chain members via pending_parents.
    if !head_chain.is_empty() {
        active_lanes.push(None);
        max_columns = max_columns.max(active_lanes.len());
        lane_colors.insert(0, 0); // HEAD chain always color 0
        for &hc_oid in &head_chain {
            pending_parents.insert(hc_oid, 0);
        }
    }

    for &oid in &oids {
        let commit = repo.find_commit(oid)?;
        let is_merge = commit.parent_count() >= 2;

        // Phase 1: Find this commit's column (ACTIVATE)
        let col = if let Some(&c) = pending_parents.get(&oid) {
            pending_parents.remove(&oid);
            c
        } else {
            // New chain — skip column 0 to keep it reserved for HEAD.
            let start_col = if !head_chain.is_empty() { 1 } else { 0 };
            let c = if let Some(i) = active_lanes.iter().skip(start_col).position(|s| s.is_none()) {
                i + start_col
            } else {
                active_lanes.push(None);
                active_lanes.len() - 1
            };
            // New branch gets a new color
            lane_colors.insert(c, next_color);
            next_color += 1;
            c
        };

        // Ensure active_lanes is large enough for this column
        if col >= active_lanes.len() {
            active_lanes.resize(col + 1, None);
        }
        max_columns = max_columns.max(active_lanes.len());

        // Get this commit's color_index from lane_colors
        let commit_color = *lane_colors.get(&col).unwrap_or(&0);

        // Phase 2: Emit pass-through edges for all OTHER active lanes (PASSTHROUGH)
        let mut edges: Vec<GraphEdge> = Vec::new();
        for (other_col, slot) in active_lanes.iter().enumerate() {
            if other_col != col {
                if slot.is_some() {
                    let edge_color = *lane_colors.get(&other_col).unwrap_or(&other_col);
                    edges.push(GraphEdge {
                        from_column: other_col,
                        to_column: other_col,
                        edge_type: EdgeType::Straight,
                        color_index: edge_color,
                    });
                }
            }
        }

        // Phase 3: Consume this commit's slot (TERMINATE current occupant)
        active_lanes[col] = None;

        // Assign columns to parents and emit crossing edges
        let parents: Vec<git2::Oid> = commit.parent_ids().collect();

        // Track whether the current column is re-occupied by a parent
        let mut col_reoccupied = false;

        for (idx, &parent_oid) in parents.iter().enumerate() {
            if idx == 0 {
                // First parent: continue at current column (if not already reserved elsewhere)
                if let Some(&existing_col) = pending_parents.get(&parent_oid) {
                    // Parent already claimed at another column
                    let edge_type = if existing_col == col {
                        EdgeType::Straight
                    } else if existing_col < col {
                        EdgeType::ForkLeft
                    } else {
                        EdgeType::ForkRight
                    };
                    let edge_color = *lane_colors.get(&existing_col).unwrap_or(&existing_col);
                    edges.push(GraphEdge {
                        from_column: col,
                        to_column: existing_col,
                        edge_type,
                        color_index: edge_color,
                    });
                    if existing_col == col {
                        // Same column — re-occupy to maintain lane
                        active_lanes[col] = Some(parent_oid);
                        col_reoccupied = true;
                    }
                    // Fix 1 (ALGO-01): If different column, col stays None (lane terminates).
                    // The color for this column is removed since the lane ends here.
                    if existing_col != col {
                        lane_colors.remove(&col);
                    }
                } else {
                    // Parent not yet claimed — claim at current column (lane continues)
                    if col >= active_lanes.len() {
                        active_lanes.resize(col + 1, None);
                    }
                    active_lanes[col] = Some(parent_oid);
                    pending_parents.insert(parent_oid, col);
                    col_reoccupied = true;
                    let edge_color = *lane_colors.get(&col).unwrap_or(&col);
                    edges.push(GraphEdge {
                        from_column: col,
                        to_column: col,
                        edge_type: EdgeType::Straight,
                        color_index: edge_color,
                    });
                }
            } else {
                // Secondary parents: find or assign a column
                let parent_col = if let Some(&c) = pending_parents.get(&parent_oid) {
                    c
                } else {
                    // Fix 2 (ALGO-02): Skip column 0 for secondary parents
                    let start_col = if !head_chain.is_empty() { 1 } else { 0 };
                    let c = if let Some(i) = active_lanes.iter().skip(start_col).position(|s| s.is_none()) {
                        i + start_col
                    } else {
                        active_lanes.push(None);
                        active_lanes.len() - 1
                    };
                    if c >= active_lanes.len() {
                        active_lanes.resize(c + 1, None);
                    }
                    active_lanes[c] = Some(parent_oid);
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
                });
            }
        }

        // Fix 5: Lane lifecycle — if no parents (root commit), ensure lane is freed
        if parents.is_empty() && !col_reoccupied {
            lane_colors.remove(&col);
        }

        max_columns = max_columns.max(active_lanes.len());
        per_oid_data.insert(oid, (col, edges, commit_color));
    }

    // Step 5: Build output for page_oids only
    let mut result = Vec::with_capacity(page_oids.len());
    for oid in page_oids {
        let commit = repo.find_commit(oid)?;
        let (column, edges, color_index) = per_oid_data.remove(&oid).unwrap_or((0, vec![], 0));
        let refs = ref_map.get(&oid).cloned().unwrap_or_default();
        let is_head = refs.iter().any(|r| r.is_head);
        let is_merge = commit.parent_count() >= 2;
        let parent_oids: Vec<String> = commit.parent_ids().map(|o| o.to_string()).collect();
        let author = commit.author();
        let short_oid = &oid.to_string()[..7];

        result.push(GraphCommit {
            oid: oid.to_string(),
            short_oid: short_oid.to_owned(),
            summary: commit.summary().unwrap_or("").to_owned(),
            body: commit.body().map(|s| s.to_owned()),
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
        });
    }

    Ok(GraphResult { commits: result, max_columns })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::repository::tests::{make_large_test_repo, make_test_repo};
    use crate::git::types::EdgeType;

    #[test]
    fn linear_topology() {
        // Build a fresh linear 3-commit repo (no merge)
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);
        repo.set_head("refs/heads/main").unwrap();
        let sig = git2::Signature::now("T", "t@t.com").unwrap();
        let mut parent_oid: Option<git2::Oid> = None;
        for i in 0..3 {
            let fname = format!("f{}.txt", i);
            std::fs::write(dir.path().join(&fname), &fname).unwrap();
            let mut idx = repo.index().unwrap();
            idx.add_path(std::path::Path::new(&fname)).unwrap();
            idx.write().unwrap();
            let tree_oid = idx.write_tree().unwrap();
            let tree = repo.find_tree(tree_oid).unwrap();
            let parents: Vec<git2::Commit> =
                parent_oid.map(|o| repo.find_commit(o).unwrap()).into_iter().collect();
            let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
            let oid = repo
                .commit(Some("refs/heads/main"), &sig, &sig, &format!("C{}", i), &tree, &parent_refs)
                .unwrap();
            parent_oid = Some(oid);
        }

        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap().commits;
        assert_eq!(commits.len(), 3);
        for c in &commits {
            assert_eq!(c.column, 0, "expected all commits at column 0");
            for e in &c.edges {
                assert!(
                    !matches!(
                        e.edge_type,
                        EdgeType::ForkLeft | EdgeType::ForkRight | EdgeType::MergeLeft | EdgeType::MergeRight
                    ),
                    "unexpected non-straight edge in linear topology"
                );
            }
        }

        // Every non-root commit must have a Straight edge at its own column
        for c in &commits[..commits.len()-1] {
            let has_own_straight = c.edges.iter().any(|e| {
                matches!(e.edge_type, EdgeType::Straight)
                    && e.from_column == c.column
                    && e.to_column == c.column
            });
            assert!(has_own_straight, "commit {} missing first-parent Straight edge", c.short_oid);
        }
        // Root commit should NOT have a self-straight edge
        let root = commits.last().unwrap();
        let root_has_self_straight = root.edges.iter().any(|e| {
            matches!(e.edge_type, EdgeType::Straight) && e.from_column == root.column && e.to_column == root.column
        });
        assert!(!root_has_self_straight, "root commit should not have self-straight edge");
    }

    #[test]
    fn merge_commit_edges() {
        let dir = make_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap().commits;
        let merge = commits.iter().find(|c| c.is_merge).expect("no merge commit found");
        let has_merge_edge = merge.edges.iter().any(|e| {
            matches!(e.edge_type, EdgeType::MergeLeft | EdgeType::MergeRight)
        });
        assert!(has_merge_edge, "merge commit has no MergeLeft/MergeRight edge");
    }

    #[test]
    fn is_merge_flag() {
        let dir = make_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap().commits;
        let merge_count = commits.iter().filter(|c| c.is_merge).count();
        let non_merge_count = commits.iter().filter(|c| !c.is_merge).count();
        assert_eq!(merge_count, 1, "expected exactly 1 merge commit");
        assert_eq!(non_merge_count, 2, "expected 2 non-merge commits");
    }

    #[test]
    fn walk_first_batch() {
        let dir = make_large_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let commits = walk_commits(&mut repo, 0, 200).unwrap().commits;
        assert_eq!(commits.len(), 200);
    }

    #[test]
    fn walk_second_batch() {
        let dir = make_large_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let first = walk_commits(&mut repo, 0, 200).unwrap().commits;
        let second = walk_commits(&mut repo, 200, 200).unwrap().commits;
        assert!(!second.is_empty(), "second batch should not be empty");
        assert!(second.len() <= 200);
        assert_ne!(
            first[0].oid, second[0].oid,
            "first OID of batch 1 and batch 2 should differ"
        );
    }

    #[test]
    fn merge_has_first_parent_straight() {
        let dir = make_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap().commits;
        let merge = commits.iter().find(|c| c.is_merge).expect("no merge commit");
        let has_straight = merge.edges.iter().any(|e| {
            matches!(e.edge_type, EdgeType::Straight) && e.from_column == merge.column
        });
        assert!(has_straight, "merge commit missing first-parent Straight edge");
    }

    #[test]
    fn branch_fork_topology() {
        // Create repo: main has C0->C1->C2, topic diverges from C1 with B0
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);
        let sig = git2::Signature::now("T", "t@t.com").unwrap();

        // C0 (root)
        std::fs::write(dir.path().join("f0.txt"), "f0").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("f0.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let c0 = repo.commit(Some("refs/heads/main"), &sig, &sig, "C0", &tree, &[]).unwrap();

        // C1 (child of C0, on main)
        std::fs::write(dir.path().join("f1.txt"), "f1").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("f1.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let c0_commit = repo.find_commit(c0).unwrap();
        let c1 = repo.commit(Some("refs/heads/main"), &sig, &sig, "C1", &tree, &[&c0_commit]).unwrap();

        // C2 (child of C1, on main — HEAD)
        std::fs::write(dir.path().join("f2.txt"), "f2").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("f2.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let c1_commit = repo.find_commit(c1).unwrap();
        let _c2 = repo.commit(Some("refs/heads/main"), &sig, &sig, "C2", &tree, &[&c1_commit]).unwrap();
        repo.set_head("refs/heads/main").unwrap();

        // B0 (child of C1, on topic — unmerged branch)
        std::fs::write(dir.path().join("b0.txt"), "b0").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("b0.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let _b0 = repo.commit(Some("refs/heads/topic"), &sig, &sig, "B0", &tree, &[&c1_commit]).unwrap();

        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap().commits;

        // Find commits by summary
        let c2 = commits.iter().find(|c| c.summary == "C2").expect("C2 not found");
        let c1 = commits.iter().find(|c| c.summary == "C1").expect("C1 not found");
        let c0 = commits.iter().find(|c| c.summary == "C0").expect("C0 not found");
        let b0 = commits.iter().find(|c| c.summary == "B0").expect("B0 not found");

        // HEAD chain (C2, C1, C0) must all be at column 0
        assert_eq!(c2.column, 0, "C2 (HEAD) should be at column 0");
        assert_eq!(c1.column, 0, "C1 should be at column 0");
        assert_eq!(c0.column, 0, "C0 should be at column 0");

        // Topic branch tip must NOT be at column 0
        assert!(b0.column > 0, "B0 (topic branch) should be at column > 0, got {}", b0.column);

        // B0 must have a fork edge toward column 0 (connecting to parent C1)
        let has_fork_to_main = b0.edges.iter().any(|e| {
            matches!(e.edge_type, EdgeType::ForkLeft) && e.to_column == 0
        });
        assert!(has_fork_to_main, "B0 should have ForkLeft edge toward column 0, edges: {:?}", b0.edges);

        // Main chain commits should NOT have ForkLeft/ForkRight edges originating from their own column
        for main_commit in [c2, c1, c0] {
            let has_own_fork = main_commit.edges.iter().any(|e| {
                matches!(e.edge_type, EdgeType::ForkLeft | EdgeType::ForkRight)
                    && e.from_column == main_commit.column
            });
            assert!(!has_own_fork, "main commit {} should not have fork edges from its own column", main_commit.summary);
        }
    }

    // ---- 9 new tests for lane algorithm hardening ----

    /// Helper: create a repo with root -> C1 on main, root -> F1 on feature, merge M
    fn make_merge_repo() -> (tempfile::TempDir, git2::Oid, git2::Oid, git2::Oid, git2::Oid) {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);
        let sig = git2::Signature::now("T", "t@t.com").unwrap();

        // C0 (root)
        std::fs::write(dir.path().join("f0.txt"), "f0").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("f0.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let c0 = repo.commit(Some("refs/heads/main"), &sig, &sig, "C0", &tree, &[]).unwrap();

        // C1 (main, child of C0)
        std::fs::write(dir.path().join("f1.txt"), "f1").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("f1.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let c0_commit = repo.find_commit(c0).unwrap();
        let c1 = repo.commit(Some("refs/heads/main"), &sig, &sig, "C1", &tree, &[&c0_commit]).unwrap();

        // F1 (feature, child of C0)
        std::fs::write(dir.path().join("feat.txt"), "feat").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("feat.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let f1 = repo.commit(Some("refs/heads/feature"), &sig, &sig, "F1", &tree, &[&c0_commit]).unwrap();

        // M (merge on main: parents C1 + F1)
        std::fs::write(dir.path().join("merge.txt"), "merge").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("merge.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let c1_commit = repo.find_commit(c1).unwrap();
        let f1_commit = repo.find_commit(f1).unwrap();
        let m = repo.commit(Some("refs/heads/main"), &sig, &sig, "M", &tree, &[&c1_commit, &f1_commit]).unwrap();
        repo.set_head("refs/heads/main").unwrap();

        (dir, c0, c1, f1, m)
    }

    #[test]
    fn no_ghost_lanes_after_merge() {
        let (dir, _c0, _c1, _f1, _m) = make_merge_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
        let commits = &result.commits;

        // Find commits by summary
        let _merge = commits.iter().find(|c| c.summary == "M").expect("M not found");
        let f1 = commits.iter().find(|c| c.summary == "F1").expect("F1 not found");
        let feature_col = f1.column;

        // C0 is the root, processed after ALL other commits.
        // After merge M consumes F1's branch, and F1 is processed (freeing its column),
        // C0 must NOT have a pass-through Straight edge at the feature's former column.
        // This is the definitive ghost lane check: column stays active after the branch
        // that occupied it has been fully consumed.
        let c0 = commits.iter().find(|c| c.summary == "C0").expect("C0 not found");
        let ghost_c0 = c0.edges.iter().any(|e| {
            e.from_column == feature_col
                && e.to_column == feature_col
                && matches!(e.edge_type, EdgeType::Straight)
        });
        assert!(
            !ghost_c0,
            "ghost lane detected at column {} on commit C0 (after merge and branch consumed), edges: {:?}",
            feature_col, c0.edges
        );

        // Verify that the feature column was actually used (not at column 0)
        assert!(
            feature_col > 0,
            "feature branch F1 should be at column > 0, got {}",
            feature_col
        );
    }

    #[test]
    fn no_ghost_lanes_criss_cross() {
        // Create: root, branch-a commit (from root), branch-b commit (from root),
        // merge-ab (merges b into a on main)
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);
        let sig = git2::Signature::now("T", "t@t.com").unwrap();

        // Root
        std::fs::write(dir.path().join("root.txt"), "root").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("root.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let root = repo.commit(Some("refs/heads/main"), &sig, &sig, "Root", &tree, &[]).unwrap();
        let root_commit = repo.find_commit(root).unwrap();

        // A1 on main (child of root)
        std::fs::write(dir.path().join("a1.txt"), "a1").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("a1.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let a1 = repo.commit(Some("refs/heads/main"), &sig, &sig, "A1", &tree, &[&root_commit]).unwrap();
        let a1_commit = repo.find_commit(a1).unwrap();

        // B1 on branch-b (child of root)
        std::fs::write(dir.path().join("b1.txt"), "b1").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("b1.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let b1 = repo.commit(Some("refs/heads/branch-b"), &sig, &sig, "B1", &tree, &[&root_commit]).unwrap();
        let b1_commit = repo.find_commit(b1).unwrap();

        // Merge-AB on main (merges B1 into A1)
        std::fs::write(dir.path().join("merge_ab.txt"), "merge_ab").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("merge_ab.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let _merge_ab = repo.commit(Some("refs/heads/main"), &sig, &sig, "Merge-AB", &tree, &[&a1_commit, &b1_commit]).unwrap();
        repo.set_head("refs/heads/main").unwrap();

        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
        let commits = &result.commits;

        let b1_found = commits.iter().find(|c| c.summary == "B1").expect("B1 not found");
        let b1_col = b1_found.column;

        // After the merge, Root should have no ghost lane at b1's column
        let root_found = commits.iter().find(|c| c.summary == "Root").expect("Root not found");
        let ghost = root_found.edges.iter().any(|e| {
            e.from_column == b1_col
                && e.to_column == b1_col
                && matches!(e.edge_type, EdgeType::Straight)
        });
        assert!(
            !ghost,
            "ghost lane detected at column {} on Root after criss-cross merge, edges: {:?}",
            b1_col, root_found.edges
        );
    }

    #[test]
    fn octopus_merge_compact() {
        // Create: root, 3 branch commits from root, octopus merge on main
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);
        let sig = git2::Signature::now("T", "t@t.com").unwrap();

        // Root
        std::fs::write(dir.path().join("root.txt"), "root").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("root.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let root = repo.commit(Some("refs/heads/main"), &sig, &sig, "Root", &tree, &[]).unwrap();
        let root_commit = repo.find_commit(root).unwrap();

        // Main-1 (child of root, on main -- so octopus first parent is not root directly)
        std::fs::write(dir.path().join("main1.txt"), "main1").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("main1.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let main1 = repo.commit(Some("refs/heads/main"), &sig, &sig, "Main-1", &tree, &[&root_commit]).unwrap();
        let main1_commit = repo.find_commit(main1).unwrap();

        // branch-a (child of root)
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("a.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let ba = repo.commit(Some("refs/heads/branch-a"), &sig, &sig, "BA", &tree, &[&root_commit]).unwrap();
        let ba_commit = repo.find_commit(ba).unwrap();

        // branch-b (child of root)
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("b.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let bb = repo.commit(Some("refs/heads/branch-b"), &sig, &sig, "BB", &tree, &[&root_commit]).unwrap();
        let bb_commit = repo.find_commit(bb).unwrap();

        // branch-c (child of root)
        std::fs::write(dir.path().join("c.txt"), "c").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("c.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let bc = repo.commit(Some("refs/heads/branch-c"), &sig, &sig, "BC", &tree, &[&root_commit]).unwrap();
        let bc_commit = repo.find_commit(bc).unwrap();

        // Octopus merge on main: parents = Main-1, BA, BB, BC
        std::fs::write(dir.path().join("octopus.txt"), "octopus").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("octopus.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let _octopus = repo.commit(
            Some("refs/heads/main"), &sig, &sig, "Octopus",
            &tree, &[&main1_commit, &ba_commit, &bb_commit, &bc_commit],
        ).unwrap();
        repo.set_head("refs/heads/main").unwrap();

        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();

        // max_columns should be at most parent_count + 1 (main + 3 branches + possibly 1 for main-1's continuation)
        assert!(
            result.max_columns <= 5,
            "octopus merge max_columns {} exceeds 5 (main + 4 parents max)",
            result.max_columns
        );
    }

    #[test]
    fn octopus_no_column_zero_theft() {
        // Same octopus repo as above
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);
        let sig = git2::Signature::now("T", "t@t.com").unwrap();

        // Root
        std::fs::write(dir.path().join("root.txt"), "root").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("root.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let root = repo.commit(Some("refs/heads/main"), &sig, &sig, "Root", &tree, &[]).unwrap();
        let root_commit = repo.find_commit(root).unwrap();

        // Main-1
        std::fs::write(dir.path().join("main1.txt"), "main1").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("main1.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let main1 = repo.commit(Some("refs/heads/main"), &sig, &sig, "Main-1", &tree, &[&root_commit]).unwrap();
        let main1_commit = repo.find_commit(main1).unwrap();

        // branch-a
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("a.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let ba = repo.commit(Some("refs/heads/branch-a"), &sig, &sig, "BA", &tree, &[&root_commit]).unwrap();
        let ba_commit = repo.find_commit(ba).unwrap();

        // branch-b
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("b.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let bb = repo.commit(Some("refs/heads/branch-b"), &sig, &sig, "BB", &tree, &[&root_commit]).unwrap();
        let bb_commit = repo.find_commit(bb).unwrap();

        // Octopus merge on main: parents = Main-1, BA, BB
        std::fs::write(dir.path().join("octopus.txt"), "octopus").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("octopus.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let _octopus = repo.commit(
            Some("refs/heads/main"), &sig, &sig, "Octopus",
            &tree, &[&main1_commit, &ba_commit, &bb_commit],
        ).unwrap();
        repo.set_head("refs/heads/main").unwrap();

        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
        let commits = &result.commits;

        // Find the octopus merge commit
        let octopus = commits.iter().find(|c| c.summary == "Octopus").expect("Octopus not found");

        // No secondary parent should have column 0
        // Secondary parents are BA, BB (indices 1, 2 in parent_oids)
        for parent_oid_str in octopus.parent_oids.iter().skip(1) {
            let parent = commits.iter().find(|c| &c.oid == parent_oid_str);
            if let Some(p) = parent {
                assert_ne!(
                    p.column, 0,
                    "secondary parent {} at column 0 (column 0 theft)",
                    p.summary
                );
            }
        }
    }

    #[test]
    fn consistent_max_columns() {
        let dir = make_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();

        assert!(result.max_columns > 0, "max_columns should be > 0");
        for commit in &result.commits {
            assert!(
                commit.column < result.max_columns,
                "commit {} at column {} >= max_columns {}",
                commit.short_oid, commit.column, result.max_columns
            );
        }
    }

    #[test]
    fn max_columns_pagination() {
        let dir = make_large_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();

        let full = walk_commits(&mut repo, 0, usize::MAX).unwrap();
        let page1 = walk_commits(&mut repo, 0, 100).unwrap();
        let page2 = walk_commits(&mut repo, 100, 100).unwrap();

        assert_eq!(
            full.max_columns, page1.max_columns,
            "max_columns differs: full={} vs page1={}",
            full.max_columns, page1.max_columns
        );
        assert_eq!(
            full.max_columns, page2.max_columns,
            "max_columns differs: full={} vs page2={}",
            full.max_columns, page2.max_columns
        );
    }

    #[test]
    fn freed_column_reuse() {
        // Create: root -> main-1 -> merge-a (merges branch-a) -> main-2 -> branch-b from main-2
        // branch-a should use some column > 0, then after merge-a frees it,
        // branch-b should reuse that same column.
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);
        let sig = git2::Signature::now("T", "t@t.com").unwrap();

        // Root
        std::fs::write(dir.path().join("root.txt"), "root").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("root.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let root = repo.commit(Some("refs/heads/main"), &sig, &sig, "Root", &tree, &[]).unwrap();
        let root_commit = repo.find_commit(root).unwrap();

        // Main-1 (child of root)
        std::fs::write(dir.path().join("main1.txt"), "main1").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("main1.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let main1 = repo.commit(Some("refs/heads/main"), &sig, &sig, "Main-1", &tree, &[&root_commit]).unwrap();
        let main1_commit = repo.find_commit(main1).unwrap();

        // Branch-A (child of root)
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("a.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let ba = repo.commit(Some("refs/heads/branch-a"), &sig, &sig, "BranchA", &tree, &[&root_commit]).unwrap();
        let ba_commit = repo.find_commit(ba).unwrap();

        // Merge-A (merges branch-a into main, first parent = main1)
        std::fs::write(dir.path().join("merge_a.txt"), "merge_a").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("merge_a.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let merge_a = repo.commit(Some("refs/heads/main"), &sig, &sig, "Merge-A", &tree, &[&main1_commit, &ba_commit]).unwrap();
        let merge_a_commit = repo.find_commit(merge_a).unwrap();

        // Main-2 (child of merge-a)
        std::fs::write(dir.path().join("main2.txt"), "main2").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("main2.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let main2 = repo.commit(Some("refs/heads/main"), &sig, &sig, "Main-2", &tree, &[&merge_a_commit]).unwrap();
        let main2_commit = repo.find_commit(main2).unwrap();

        // Branch-B (child of main-2, on a separate branch)
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("b.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let _bb = repo.commit(Some("refs/heads/branch-b"), &sig, &sig, "BranchB", &tree, &[&main2_commit]).unwrap();
        repo.set_head("refs/heads/main").unwrap();

        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
        let commits = &result.commits;

        let branch_a = commits.iter().find(|c| c.summary == "BranchA").expect("BranchA not found");
        let branch_b = commits.iter().find(|c| c.summary == "BranchB").expect("BranchB not found");

        assert!(branch_a.column > 0, "BranchA should be at column > 0");
        assert!(branch_b.column > 0, "BranchB should be at column > 0");
        assert_eq!(
            branch_a.column, branch_b.column,
            "BranchB (col {}) should reuse BranchA's freed column (col {})",
            branch_b.column, branch_a.column
        );
    }

    #[test]
    fn color_index_deterministic() {
        let dir = make_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let result1 = walk_commits(&mut repo, 0, usize::MAX).unwrap();
        let result2 = walk_commits(&mut repo, 0, usize::MAX).unwrap();

        assert_eq!(result1.commits.len(), result2.commits.len());
        for (c1, c2) in result1.commits.iter().zip(result2.commits.iter()) {
            assert_eq!(
                c1.color_index, c2.color_index,
                "color_index mismatch for commit {}: {} vs {}",
                c1.short_oid, c1.color_index, c2.color_index
            );
            // Also check edge color_index consistency
            assert_eq!(c1.edges.len(), c2.edges.len());
            for (e1, e2) in c1.edges.iter().zip(c2.edges.iter()) {
                assert_eq!(
                    e1.color_index, e2.color_index,
                    "edge color_index mismatch on commit {}: {} vs {}",
                    c1.short_oid, e1.color_index, e2.color_index
                );
            }
        }
    }

    #[test]
    fn color_index_head_zero() {
        let dir = make_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
        let commits = &result.commits;

        // HEAD commit must have color_index == 0
        let head = commits.iter().find(|c| c.is_head).expect("no HEAD commit");
        assert_eq!(
            head.color_index, 0,
            "HEAD commit should have color_index 0, got {}",
            head.color_index
        );

        // All commits at column 0 (HEAD's first-parent chain) should have color_index 0
        for c in commits.iter().filter(|c| c.column == 0) {
            assert_eq!(
                c.color_index, 0,
                "HEAD chain commit {} (col 0) should have color_index 0, got {}",
                c.short_oid, c.color_index
            );
        }
    }
}

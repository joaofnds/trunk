use std::collections::{HashMap, HashSet};
use crate::error::TrunkError;
use crate::git::types::{EdgeType, GraphCommit, GraphEdge};
use crate::git::repository;

pub fn walk_commits(
    repo: &mut git2::Repository,
    offset: usize,
    limit: usize,
) -> Result<Vec<GraphCommit>, TrunkError> {
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
    let mut per_oid_data: HashMap<git2::Oid, (usize, Vec<GraphEdge>)> = HashMap::new();

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
    // This ensures that when a non-HEAD branch tip (e.g. B0) processes its
    // parent (e.g. C1) and finds C1 already in pending_parents at col 0,
    // it emits ForkLeft(branch_col -> 0) — the correct fork direction.
    // Without this, B0 would reserve C1 at B0's column, stealing it from HEAD.
    if !head_chain.is_empty() {
        // Ensure active_lanes has at least col 0
        active_lanes.push(None);
        for &hc_oid in &head_chain {
            pending_parents.insert(hc_oid, 0);
        }
    }

    for &oid in &oids {
        let commit = repo.find_commit(oid)?;
        let is_merge = commit.parent_count() >= 2;

        // Find this commit's column
        let col = if let Some(&c) = pending_parents.get(&oid) {
            pending_parents.remove(&oid);
            c
        } else {
            // New chain — never a head_chain member (those are pre-populated in
            // pending_parents). Skip column 0 to keep it reserved for HEAD.
            let start_col = if !head_chain.is_empty() { 1 } else { 0 };
            if let Some(i) = active_lanes.iter().skip(start_col).position(|s| s.is_none()) {
                i + start_col
            } else {
                active_lanes.push(None);
                active_lanes.len() - 1
            }
        };

        // Emit Straight edges for other active lanes passing through this row
        let mut edges: Vec<GraphEdge> = Vec::new();
        for (other_col, slot) in active_lanes.iter().enumerate() {
            if other_col != col {
                if let Some(_) = slot {
                    edges.push(GraphEdge {
                        from_column: other_col,
                        to_column: other_col,
                        edge_type: EdgeType::Straight,
                        color_index: other_col,
                    });
                }
            }
        }

        // Consume this commit's slot
        if col < active_lanes.len() {
            active_lanes[col] = None;
        }

        // Assign columns to parents and emit crossing edges
        let parents: Vec<git2::Oid> = commit.parent_ids().collect();
        for (idx, &parent_oid) in parents.iter().enumerate() {
            if idx == 0 {
                // First parent: continue at current column (if not already reserved elsewhere)
                if let Some(&existing_col) = pending_parents.get(&parent_oid) {
                    // Parent already claimed — emit edge from col to existing column
                    let edge_type = if existing_col == col {
                        EdgeType::Straight
                    } else if existing_col < col {
                        EdgeType::ForkLeft
                    } else {
                        EdgeType::ForkRight
                    };
                    edges.push(GraphEdge {
                        from_column: col,
                        to_column: existing_col,
                        edge_type,
                        color_index: existing_col,
                    });
                    // If same column, re-occupy to maintain lane for pass-through edges
                    if existing_col == col {
                        if col < active_lanes.len() {
                            active_lanes[col] = Some(parent_oid);
                        }
                    }
                    // If different column, current col stays None (lane terminates here)
                } else {
                    if col >= active_lanes.len() {
                        active_lanes.resize(col + 1, None);
                    }
                    active_lanes[col] = Some(parent_oid);
                    pending_parents.insert(parent_oid, col);
                    // Emit Straight edge for first-parent continuation
                    edges.push(GraphEdge {
                        from_column: col,
                        to_column: col,
                        edge_type: EdgeType::Straight,
                        color_index: col,
                    });
                }
            } else {
                // Secondary parents: find or assign a column
                let parent_col = if let Some(&c) = pending_parents.get(&parent_oid) {
                    c
                } else {
                    let c = if let Some(i) = active_lanes.iter().position(|s| s.is_none()) {
                        i
                    } else {
                        active_lanes.push(None);
                        active_lanes.len() - 1
                    };
                    if c >= active_lanes.len() {
                        active_lanes.resize(c + 1, None);
                    }
                    active_lanes[c] = Some(parent_oid);
                    pending_parents.insert(parent_oid, c);
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

                edges.push(GraphEdge {
                    from_column: col,
                    to_column: parent_col,
                    edge_type,
                    color_index: parent_col,
                });
            }
        }

        per_oid_data.insert(oid, (col, edges));
    }

    // Step 5: Build output for page_oids only
    let mut result = Vec::with_capacity(page_oids.len());
    for oid in page_oids {
        let commit = repo.find_commit(oid)?;
        let (column, edges) = per_oid_data.remove(&oid).unwrap_or((0, vec![]));
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
            edges,
            refs,
            is_head,
            is_merge,
        });
    }

    Ok(result)
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
        let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap();
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
        let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap();
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
        let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap();
        let merge_count = commits.iter().filter(|c| c.is_merge).count();
        let non_merge_count = commits.iter().filter(|c| !c.is_merge).count();
        assert_eq!(merge_count, 1, "expected exactly 1 merge commit");
        assert_eq!(non_merge_count, 2, "expected 2 non-merge commits");
    }

    #[test]
    fn walk_first_batch() {
        let dir = make_large_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let commits = walk_commits(&mut repo, 0, 200).unwrap();
        assert_eq!(commits.len(), 200);
    }

    #[test]
    fn walk_second_batch() {
        let dir = make_large_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let first = walk_commits(&mut repo, 0, 200).unwrap();
        let second = walk_commits(&mut repo, 200, 200).unwrap();
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
        let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap();
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
        let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap();

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
}

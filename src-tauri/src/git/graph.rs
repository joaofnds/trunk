use std::collections::HashMap;
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

    for &oid in &oids {
        let commit = repo.find_commit(oid)?;
        let is_merge = commit.parent_count() >= 2;

        // Find this commit's column
        let col = if let Some(&c) = pending_parents.get(&oid) {
            pending_parents.remove(&oid);
            c
        } else {
            // New chain: find first free lane or create one
            if let Some(i) = active_lanes.iter().position(|s| s.is_none()) {
                i
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
                    // Parent already claimed by another child — emit edge from col to existing column
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
                    // current column (col) slot stays None (freed).
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
}

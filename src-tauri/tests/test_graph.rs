mod common;

use common::context::TestContext;
use trunk_lib::git::graph::walk_commits;
use trunk_lib::git::types::EdgeType;

/// Helper: create a merge test repo (main + feature branch + merge commit).
/// Returns a TestContext.
fn make_merge_test_ctx() -> TestContext {
    TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("feature.txt", "feature work")
        .with_commit("Feature commit")
        .checkout("main")
        .merge("feature")
        .build()
}

/// Helper: create a repo with 300 linear commits.
fn make_large_test_ctx() -> TestContext {
    let mut builder = TestContext::builder();
    for i in 0..300 {
        builder.with_file(&format!("file{}.txt", i), &format!("content {}", i));
        builder.with_commit(&format!("Commit {}", i));
    }
    builder.build()
}

/// Helper: create repo with root -> C1 on main, root -> F1 on feature, merge M.
fn make_merge_repo_ctx() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);
        let sig = git2::Signature::now("T", "t@t.com").unwrap();

        let c0 = raw_commit_in(&repo, &sig, "refs/heads/main", "C0", "f0.txt", "f0", &[]);
        let c0_commit = repo.find_commit(c0).unwrap();
        let c1 = raw_commit_in(
            &repo,
            &sig,
            "refs/heads/main",
            "C1",
            "f1.txt",
            "f1",
            &[&c0_commit],
        );
        let f1 = raw_commit_in(
            &repo,
            &sig,
            "refs/heads/feature",
            "F1",
            "feat.txt",
            "feat",
            &[&c0_commit],
        );

        // M (merge on main: parents C1 + F1)
        let c1_commit = repo.find_commit(c1).unwrap();
        let f1_commit = repo.find_commit(f1).unwrap();
        raw_commit_in(
            &repo,
            &sig,
            "refs/heads/main",
            "M",
            "merge.txt",
            "merge",
            &[&c1_commit, &f1_commit],
        );
        repo.set_head("refs/heads/main").unwrap();
    }

    let path = dir.path().display().to_string();
    let mut state_map = std::collections::HashMap::new();
    state_map.insert(path.clone(), dir.path().to_path_buf());
    common::context::TestContext::from_parts(dir, path, state_map)
}

/// Helper: create a commit in a repo, dropping borrows promptly.
fn raw_commit_in(
    repo: &git2::Repository,
    sig: &git2::Signature,
    refname: &str,
    msg: &str,
    file: &str,
    content: &str,
    parents: &[&git2::Commit],
) -> git2::Oid {
    let dir = repo.workdir().unwrap();
    std::fs::write(dir.join(file), content).unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_path(std::path::Path::new(file)).unwrap();
    idx.write().unwrap();
    let tree_oid = idx.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();

    repo.commit(Some(refname), sig, sig, msg, &tree, parents)
        .unwrap()
}

/// Helper: create a commit in a raw repo. Returns the new commit OID.
fn raw_commit(
    repo: &git2::Repository,
    sig: &git2::Signature,
    refname: &str,
    msg: &str,
    file: &str,
    content: &str,
    parents: &[&git2::Commit],
) -> git2::Oid {
    let dir = repo.workdir().unwrap();
    std::fs::write(dir.join(file), content).unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_path(std::path::Path::new(file)).unwrap();
    idx.write().unwrap();
    let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
    repo.commit(Some(refname), sig, sig, msg, &tree, parents)
        .unwrap()
}

// ============================================================
// Tests
// ============================================================

#[test]
fn linear_topology() {
    let ctx = TestContext::builder()
        .with_file("f0.txt", "f0")
        .with_commit("C0")
        .with_file("f1.txt", "f1")
        .with_commit("C1")
        .with_file("f2.txt", "f2")
        .with_commit("C2")
        .build();

    let mut repo = ctx.repo();
    let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap().commits;
    assert_eq!(commits.len(), 3);
    for c in &commits {
        assert_eq!(c.column, 0, "expected all commits at column 0");
        for e in &c.edges {
            assert!(
                !matches!(
                    e.edge_type,
                    EdgeType::ForkLeft
                        | EdgeType::ForkRight
                        | EdgeType::MergeLeft
                        | EdgeType::MergeRight
                ),
                "unexpected non-straight edge in linear topology"
            );
        }
    }

    // Every non-root commit must have a Straight edge at its own column
    for c in &commits[..commits.len() - 1] {
        let has_own_straight = c.edges.iter().any(|e| {
            matches!(e.edge_type, EdgeType::Straight)
                && e.from_column == c.column
                && e.to_column == c.column
        });
        assert!(
            has_own_straight,
            "commit {} missing first-parent Straight edge",
            c.short_oid
        );
    }
    // Root commit should NOT have a self-straight edge
    let root = commits.last().unwrap();
    let root_has_self_straight = root.edges.iter().any(|e| {
        matches!(e.edge_type, EdgeType::Straight)
            && e.from_column == root.column
            && e.to_column == root.column
    });
    assert!(
        !root_has_self_straight,
        "root commit should not have self-straight edge"
    );
}

#[test]
fn merge_commit_edges() {
    let ctx = make_merge_test_ctx();
    let mut repo = ctx.repo();
    let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap().commits;
    let merge = commits
        .iter()
        .find(|c| c.is_merge)
        .expect("no merge commit found");
    let has_merge_edge = merge
        .edges
        .iter()
        .any(|e| matches!(e.edge_type, EdgeType::MergeLeft | EdgeType::MergeRight));
    assert!(
        has_merge_edge,
        "merge commit has no MergeLeft/MergeRight edge"
    );
}

#[test]
fn is_merge_flag() {
    let ctx = make_merge_test_ctx();
    let mut repo = ctx.repo();
    let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap().commits;
    let merge_count = commits.iter().filter(|c| c.is_merge).count();
    let non_merge_count = commits.iter().filter(|c| !c.is_merge).count();
    assert_eq!(merge_count, 1, "expected exactly 1 merge commit");
    assert_eq!(non_merge_count, 2, "expected 2 non-merge commits");
}

#[test]
fn walk_first_batch() {
    let ctx = make_large_test_ctx();
    let mut repo = ctx.repo();
    let commits = walk_commits(&mut repo, 0, 200).unwrap().commits;
    assert_eq!(commits.len(), 200);
}

#[test]
fn walk_second_batch() {
    let ctx = make_large_test_ctx();
    let mut repo = ctx.repo();
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
    let ctx = make_merge_test_ctx();
    let mut repo = ctx.repo();
    let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap().commits;
    let merge = commits
        .iter()
        .find(|c| c.is_merge)
        .expect("no merge commit");
    let has_straight = merge
        .edges
        .iter()
        .any(|e| matches!(e.edge_type, EdgeType::Straight) && e.from_column == merge.column);
    assert!(
        has_straight,
        "merge commit missing first-parent Straight edge"
    );
}

#[test]
fn branch_fork_topology() {
    // main has C0->C1->C2, topic diverges from C1 with B0
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "T").unwrap();
    cfg.set_str("user.email", "t@t.com").unwrap();
    drop(cfg);
    let sig = git2::Signature::now("T", "t@t.com").unwrap();

    let c0 = raw_commit(&repo, &sig, "refs/heads/main", "C0", "f0.txt", "f0", &[]);
    let c0c = repo.find_commit(c0).unwrap();
    let c1 = raw_commit(
        &repo,
        &sig,
        "refs/heads/main",
        "C1",
        "f1.txt",
        "f1",
        &[&c0c],
    );
    let c1c = repo.find_commit(c1).unwrap();
    let _c2 = raw_commit(
        &repo,
        &sig,
        "refs/heads/main",
        "C2",
        "f2.txt",
        "f2",
        &[&c1c],
    );
    repo.set_head("refs/heads/main").unwrap();
    let _b0 = raw_commit(
        &repo,
        &sig,
        "refs/heads/topic",
        "B0",
        "b0.txt",
        "b0",
        &[&c1c],
    );

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap().commits;

    let c2 = commits
        .iter()
        .find(|c| c.summary == "C2")
        .expect("C2 not found");
    let c1f = commits
        .iter()
        .find(|c| c.summary == "C1")
        .expect("C1 not found");
    let c0f = commits
        .iter()
        .find(|c| c.summary == "C0")
        .expect("C0 not found");
    let b0 = commits
        .iter()
        .find(|c| c.summary == "B0")
        .expect("B0 not found");

    assert_eq!(c2.column, 0, "C2 (HEAD) should be at column 0");
    assert_eq!(c1f.column, 0, "C1 should be at column 0");
    assert_eq!(c0f.column, 0, "C0 should be at column 0");
    assert!(
        b0.column > 0,
        "B0 (topic branch) should be at column > 0, got {}",
        b0.column
    );

    let b0_has_straight = b0.edges.iter().any(|e| {
        matches!(e.edge_type, EdgeType::Straight)
            && e.from_column == b0.column
            && e.to_column == b0.column
    });
    assert!(
        b0_has_straight,
        "B0 should have Straight edge at its own column, edges: {:?}",
        b0.edges
    );

    let b0_has_fork = b0
        .edges
        .iter()
        .any(|e| matches!(e.edge_type, EdgeType::ForkLeft | EdgeType::ForkRight));
    assert!(
        !b0_has_fork,
        "B0 should not have fork edges, edges: {:?}",
        b0.edges
    );

    let c1_has_fork_out = c1f.edges.iter().any(|e| {
        matches!(e.edge_type, EdgeType::ForkRight)
            && e.from_column == c1f.column
            && e.to_column == b0.column
    });
    assert!(
        c1_has_fork_out,
        "C1 should have ForkRight edge toward B0's column {}, edges: {:?}",
        b0.column, c1f.edges
    );
}

#[test]
fn no_ghost_lanes_after_merge() {
    let ctx = make_merge_repo_ctx();
    let mut repo = ctx.repo();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let f1 = commits
        .iter()
        .find(|c| c.summary == "F1")
        .expect("F1 not found");
    let feature_col = f1.column;

    let c0 = commits
        .iter()
        .find(|c| c.summary == "C0")
        .expect("C0 not found");
    let ghost_c0 = c0.edges.iter().any(|e| {
        e.from_column == feature_col
            && e.to_column == feature_col
            && matches!(e.edge_type, EdgeType::Straight)
    });
    assert!(
        !ghost_c0,
        "ghost lane detected at column {} on commit C0, edges: {:?}",
        feature_col, c0.edges
    );
    assert!(
        feature_col > 0,
        "feature branch F1 should be at column > 0, got {}",
        feature_col
    );
}

#[test]
fn no_ghost_lanes_criss_cross() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "T").unwrap();
    cfg.set_str("user.email", "t@t.com").unwrap();
    drop(cfg);
    let sig = git2::Signature::now("T", "t@t.com").unwrap();

    let root = raw_commit(
        &repo,
        &sig,
        "refs/heads/main",
        "Root",
        "root.txt",
        "root",
        &[],
    );
    let root_c = repo.find_commit(root).unwrap();
    let a1 = raw_commit(
        &repo,
        &sig,
        "refs/heads/main",
        "A1",
        "a1.txt",
        "a1",
        &[&root_c],
    );
    let a1_c = repo.find_commit(a1).unwrap();
    let b1 = raw_commit(
        &repo,
        &sig,
        "refs/heads/branch-b",
        "B1",
        "b1.txt",
        "b1",
        &[&root_c],
    );
    let b1_c = repo.find_commit(b1).unwrap();

    // Merge-AB on main
    std::fs::write(dir.path().join("merge_ab.txt"), "merge_ab").unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_path(std::path::Path::new("merge_ab.txt")).unwrap();
    idx.write().unwrap();
    let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
    repo.commit(
        Some("refs/heads/main"),
        &sig,
        &sig,
        "Merge-AB",
        &tree,
        &[&a1_c, &b1_c],
    )
    .unwrap();
    repo.set_head("refs/heads/main").unwrap();

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let b1_found = commits
        .iter()
        .find(|c| c.summary == "B1")
        .expect("B1 not found");
    let b1_col = b1_found.column;

    let root_found = commits
        .iter()
        .find(|c| c.summary == "Root")
        .expect("Root not found");
    let ghost = root_found.edges.iter().any(|e| {
        e.from_column == b1_col
            && e.to_column == b1_col
            && matches!(e.edge_type, EdgeType::Straight)
    });
    assert!(
        !ghost,
        "ghost lane detected at column {} on Root, edges: {:?}",
        b1_col, root_found.edges
    );
}

#[test]
fn octopus_merge_compact() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "T").unwrap();
    cfg.set_str("user.email", "t@t.com").unwrap();
    drop(cfg);
    let sig = git2::Signature::now("T", "t@t.com").unwrap();

    let root = raw_commit(
        &repo,
        &sig,
        "refs/heads/main",
        "Root",
        "root.txt",
        "root",
        &[],
    );
    let root_c = repo.find_commit(root).unwrap();
    let main1 = raw_commit(
        &repo,
        &sig,
        "refs/heads/main",
        "Main-1",
        "main1.txt",
        "main1",
        &[&root_c],
    );
    let main1_c = repo.find_commit(main1).unwrap();
    let ba = raw_commit(
        &repo,
        &sig,
        "refs/heads/branch-a",
        "BA",
        "a.txt",
        "a",
        &[&root_c],
    );
    let ba_c = repo.find_commit(ba).unwrap();
    let bb = raw_commit(
        &repo,
        &sig,
        "refs/heads/branch-b",
        "BB",
        "b.txt",
        "b",
        &[&root_c],
    );
    let bb_c = repo.find_commit(bb).unwrap();
    let bc = raw_commit(
        &repo,
        &sig,
        "refs/heads/branch-c",
        "BC",
        "c.txt",
        "c",
        &[&root_c],
    );
    let bc_c = repo.find_commit(bc).unwrap();

    // Octopus merge
    std::fs::write(dir.path().join("octopus.txt"), "octopus").unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_path(std::path::Path::new("octopus.txt")).unwrap();
    idx.write().unwrap();
    let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
    repo.commit(
        Some("refs/heads/main"),
        &sig,
        &sig,
        "Octopus",
        &tree,
        &[&main1_c, &ba_c, &bb_c, &bc_c],
    )
    .unwrap();
    repo.set_head("refs/heads/main").unwrap();

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    assert!(
        result.max_columns <= 5,
        "octopus merge max_columns {} exceeds 5",
        result.max_columns
    );
}

#[test]
fn octopus_no_column_zero_theft() {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "T").unwrap();
    cfg.set_str("user.email", "t@t.com").unwrap();
    drop(cfg);
    let sig = git2::Signature::now("T", "t@t.com").unwrap();

    let root = raw_commit(
        &repo,
        &sig,
        "refs/heads/main",
        "Root",
        "root.txt",
        "root",
        &[],
    );
    let root_c = repo.find_commit(root).unwrap();
    let main1 = raw_commit(
        &repo,
        &sig,
        "refs/heads/main",
        "Main-1",
        "main1.txt",
        "main1",
        &[&root_c],
    );
    let main1_c = repo.find_commit(main1).unwrap();
    let ba = raw_commit(
        &repo,
        &sig,
        "refs/heads/branch-a",
        "BA",
        "a.txt",
        "a",
        &[&root_c],
    );
    let ba_c = repo.find_commit(ba).unwrap();
    let bb = raw_commit(
        &repo,
        &sig,
        "refs/heads/branch-b",
        "BB",
        "b.txt",
        "b",
        &[&root_c],
    );
    let bb_c = repo.find_commit(bb).unwrap();

    // Octopus merge (3 parents)
    std::fs::write(dir.path().join("octopus.txt"), "octopus").unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_path(std::path::Path::new("octopus.txt")).unwrap();
    idx.write().unwrap();
    let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
    repo.commit(
        Some("refs/heads/main"),
        &sig,
        &sig,
        "Octopus",
        &tree,
        &[&main1_c, &ba_c, &bb_c],
    )
    .unwrap();
    repo.set_head("refs/heads/main").unwrap();

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let octopus = commits
        .iter()
        .find(|c| c.summary == "Octopus")
        .expect("Octopus not found");
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
    let ctx = make_merge_test_ctx();
    let mut repo = ctx.repo();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();

    assert!(result.max_columns > 0, "max_columns should be > 0");
    for commit in &result.commits {
        assert!(
            commit.column < result.max_columns,
            "commit {} at column {} >= max_columns {}",
            commit.short_oid,
            commit.column,
            result.max_columns
        );
    }
}

#[test]
fn max_columns_pagination() {
    let ctx = make_large_test_ctx();
    let mut repo = ctx.repo();

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
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "T").unwrap();
    cfg.set_str("user.email", "t@t.com").unwrap();
    drop(cfg);
    let sig = git2::Signature::now("T", "t@t.com").unwrap();

    let root = raw_commit(
        &repo,
        &sig,
        "refs/heads/main",
        "Root",
        "root.txt",
        "root",
        &[],
    );
    let root_c = repo.find_commit(root).unwrap();
    let main1 = raw_commit(
        &repo,
        &sig,
        "refs/heads/main",
        "Main-1",
        "main1.txt",
        "main1",
        &[&root_c],
    );
    let main1_c = repo.find_commit(main1).unwrap();
    let ba = raw_commit(
        &repo,
        &sig,
        "refs/heads/branch-a",
        "BranchA",
        "a.txt",
        "a",
        &[&root_c],
    );
    let ba_c = repo.find_commit(ba).unwrap();

    // Merge-A
    std::fs::write(dir.path().join("merge_a.txt"), "merge_a").unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_path(std::path::Path::new("merge_a.txt")).unwrap();
    idx.write().unwrap();
    let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
    let merge_a = repo
        .commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            "Merge-A",
            &tree,
            &[&main1_c, &ba_c],
        )
        .unwrap();
    let merge_a_c = repo.find_commit(merge_a).unwrap();

    let main2 = raw_commit(
        &repo,
        &sig,
        "refs/heads/main",
        "Main-2",
        "main2.txt",
        "main2",
        &[&merge_a_c],
    );
    let main2_c = repo.find_commit(main2).unwrap();
    let _bb = raw_commit(
        &repo,
        &sig,
        "refs/heads/branch-b",
        "BranchB",
        "b.txt",
        "b",
        &[&main2_c],
    );
    repo.set_head("refs/heads/main").unwrap();

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let branch_a = commits
        .iter()
        .find(|c| c.summary == "BranchA")
        .expect("BranchA not found");
    let branch_b = commits
        .iter()
        .find(|c| c.summary == "BranchB")
        .expect("BranchB not found");

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
    let ctx = make_merge_test_ctx();
    let mut repo = ctx.repo();
    let result1 = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let result2 = walk_commits(&mut repo, 0, usize::MAX).unwrap();

    assert_eq!(result1.commits.len(), result2.commits.len());
    for (c1, c2) in result1.commits.iter().zip(result2.commits.iter()) {
        assert_eq!(
            c1.color_index, c2.color_index,
            "color_index mismatch for commit {}: {} vs {}",
            c1.short_oid, c1.color_index, c2.color_index
        );
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
    let ctx = make_merge_test_ctx();
    let mut repo = ctx.repo();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let head = commits.iter().find(|c| c.is_head).expect("no HEAD commit");
    assert_eq!(
        head.color_index, 0,
        "HEAD commit should have color_index 0, got {}",
        head.color_index
    );

    for c in commits.iter().filter(|c| c.column == 0) {
        assert_eq!(
            c.color_index, 0,
            "HEAD chain commit {} (col 0) should have color_index 0, got {}",
            c.short_oid, c.color_index
        );
    }
}

#[test]
fn ref_label_color_index() {
    let ctx = make_merge_test_ctx();
    let mut repo = ctx.repo();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();

    for commit in &result.commits {
        for r in &commit.refs {
            assert_eq!(
                r.color_index, commit.color_index,
                "ref '{}' color_index {} does not match commit {} color_index {}",
                r.short_name, r.color_index, commit.short_oid, commit.color_index
            );
        }
    }

    let commits_with_refs = result.commits.iter().filter(|c| !c.refs.is_empty()).count();
    assert!(
        commits_with_refs > 0,
        "expected at least one commit with refs"
    );
}

#[test]
fn ref_label_no_refs_no_panic() {
    let ctx = make_merge_test_ctx();
    let mut repo = ctx.repo();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();

    let no_refs = result.commits.iter().find(|c| c.refs.is_empty());
    assert!(
        no_refs.is_some(),
        "expected at least one commit without refs in test repo"
    );
    let c = no_refs.unwrap();
    assert!(
        c.refs.is_empty(),
        "refs should be empty vec, not None/panic"
    );
}

#[test]
fn stash_inline_on_head_tip() {
    let ctx = TestContext::builder()
        .with_file("f0.txt", "f0")
        .with_commit("C0")
        .with_file("f1.txt", "f1")
        .with_commit("C1")
        .with_file("f2.txt", "f2")
        .with_commit("C2")
        .with_stash(Some("test stash"))
        .build();

    let mut repo = ctx.repo();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let c2 = commits
        .iter()
        .find(|c| c.summary == "C2")
        .expect("C2 not found");
    assert_eq!(c2.column, 0, "C2 should be at column 0");

    let stash = commits
        .iter()
        .find(|c| c.is_stash)
        .expect("no stash commit found");

    assert_eq!(
        stash.column, c2.column,
        "stash should be inline at parent's column {}, got {}",
        c2.column, stash.column
    );
    assert!(stash.is_branch_tip, "stash should be a branch tip");
    assert!(stash.is_stash, "stash should have is_stash=true");
    assert!(!stash.is_merge, "stash should NOT be a merge");
    assert_eq!(
        stash.parent_oids.len(),
        1,
        "stash should have exactly 1 parent_oid"
    );
    assert_eq!(
        stash.color_index, c2.color_index,
        "inline stash should inherit parent's color {}, got {}",
        c2.color_index, stash.color_index
    );

    let stash_straight = stash.edges.iter().find(|e| {
        matches!(e.edge_type, EdgeType::Straight)
            && e.from_column == stash.column
            && e.to_column == stash.column
    });
    assert!(
        stash_straight.is_some(),
        "stash should have Straight edge at its column, edges: {:?}",
        stash.edges
    );
    assert!(
        stash_straight.unwrap().dashed,
        "inline stash Straight edge should be dashed, edges: {:?}",
        stash.edges
    );

    let c2_fork = c2
        .edges
        .iter()
        .find(|e| matches!(e.edge_type, EdgeType::ForkRight));
    assert!(
        c2_fork.is_none(),
        "C2 should NOT have ForkRight for inline stash, edges: {:?}",
        c2.edges
    );

    let c2_own_straight = c2.edges.iter().find(|e| {
        matches!(e.edge_type, EdgeType::Straight)
            && e.from_column == c2.column
            && e.to_column == c2.column
    });
    assert!(
        c2_own_straight.is_some() && !c2_own_straight.unwrap().dashed,
        "C2's own Straight should not be dashed, edges: {:?}",
        c2.edges
    );

    let c1 = commits
        .iter()
        .find(|c| c.summary == "C1")
        .expect("C1 not found");
    for e in &c1.edges {
        assert_eq!(
            e.from_column, 0,
            "C1 should only have edges at column 0, found edge at column {}, edges: {:?}",
            e.from_column, c1.edges
        );
    }
}

#[test]
fn multiple_stashes_on_same_parent() {
    // Use raw git2 to create exactly C0 -> C1 with 2 stashes on C1 (HEAD).
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);
        let sig = git2::Signature::now("T", "t@t.com").unwrap();

        let c0 = raw_commit(&repo, &sig, "refs/heads/main", "C0", "f0.txt", "f0", &[]);
        let c0c = repo.find_commit(c0).unwrap();
        let _c1 = raw_commit(
            &repo,
            &sig,
            "refs/heads/main",
            "C1",
            "f1.txt",
            "f1",
            &[&c0c],
        );
        repo.set_head("refs/heads/main").unwrap();
    }

    // First stash
    let mut repo = git2::Repository::open(dir.path()).unwrap();
    std::fs::write(dir.path().join("s1.txt"), "stash1").unwrap();
    {
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("s1.txt")).unwrap();
        idx.write().unwrap();
    }
    let sig2 = git2::Signature::now("T", "t@t.com").unwrap();
    repo.stash_save(&sig2, "stash-1", None).unwrap();

    // Second stash
    std::fs::write(dir.path().join("s2.txt"), "stash2").unwrap();
    {
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("s2.txt")).unwrap();
        idx.write().unwrap();
    }
    let sig3 = git2::Signature::now("T", "t@t.com").unwrap();
    repo.stash_save(&sig3, "stash-2", None).unwrap();

    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let stashes: Vec<_> = commits.iter().filter(|c| c.is_stash).collect();
    assert_eq!(
        stashes.len(),
        2,
        "expected 2 stash commits, got {}",
        stashes.len()
    );

    let c1 = commits
        .iter()
        .find(|c| c.summary == "C1")
        .expect("C1 not found");

    for s in &stashes {
        assert!(s.is_branch_tip, "stash should be branch tip");
    }

    let inline_count = stashes.iter().filter(|s| s.column == c1.column).count();
    let branched_count = stashes.iter().filter(|s| s.column > c1.column).count();
    assert_eq!(
        inline_count,
        1,
        "exactly 1 stash should be inline at parent col {}, stash cols: {:?}",
        c1.column,
        stashes.iter().map(|s| s.column).collect::<Vec<_>>()
    );
    assert_eq!(
        branched_count,
        1,
        "exactly 1 stash should branch right, stash cols: {:?}",
        stashes.iter().map(|s| s.column).collect::<Vec<_>>()
    );

    let fork_count = c1
        .edges
        .iter()
        .filter(|e| matches!(e.edge_type, EdgeType::ForkRight))
        .count();
    assert_eq!(
        fork_count, 1,
        "C1 should have 1 ForkRight edge (branched stash only), edges: {:?}",
        c1.edges
    );

    let dashed_forks: Vec<_> = c1
        .edges
        .iter()
        .filter(|e| matches!(e.edge_type, EdgeType::ForkRight) && e.dashed)
        .collect();
    assert_eq!(
        dashed_forks.len(),
        1,
        "ForkRight edge should be dashed, edges: {:?}",
        c1.edges
    );
}

#[test]
fn stash_branches_right_when_head_chain_occupies_lane() {
    // Stash on a MID-CHAIN HEAD commit (C1) where C2 occupies column 0 between stash and C1.
    let dir = tempfile::tempdir().unwrap();

    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);
        let sig = git2::Signature::now("T", "t@t.com").unwrap();

        let c0 = raw_commit(&repo, &sig, "refs/heads/main", "C0", "f0.txt", "f0", &[]);
        let c0c = repo.find_commit(c0).unwrap();
        let c1 = raw_commit(
            &repo,
            &sig,
            "refs/heads/main",
            "C1",
            "f1.txt",
            "f1",
            &[&c0c],
        );
        let c1c = repo.find_commit(c1).unwrap();
        let _c2 = raw_commit(
            &repo,
            &sig,
            "refs/heads/main",
            "C2",
            "f2.txt",
            "f2",
            &[&c1c],
        );
        repo.set_head("refs/heads/main").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();

        // Detach HEAD at C1 to create a stash whose parent is C1 (mid-chain)
        repo.set_head_detached(c1).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
    }

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    std::fs::write(dir.path().join("dirty.txt"), "dirty").unwrap();
    {
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("dirty.txt")).unwrap();
        idx.write().unwrap();
    }
    let sig2 = git2::Signature::now("T", "t@t.com").unwrap();
    let stash_oid = repo.stash_save(&sig2, "test stash on C1", None).unwrap();
    repo.set_head("refs/heads/main").unwrap();

    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let c1 = commits
        .iter()
        .find(|c| c.summary == "C1")
        .expect("C1 not found");
    let stash = commits
        .iter()
        .find(|c| c.oid == stash_oid.to_string())
        .expect("stash not found");

    assert!(
        stash.column > c1.column,
        "stash on mid-chain parent should branch right (col > {}), got col {}",
        c1.column,
        stash.column
    );

    let fork_count = c1
        .edges
        .iter()
        .filter(|e| matches!(e.edge_type, EdgeType::ForkRight))
        .count();
    assert_eq!(
        fork_count, 1,
        "C1 should have 1 ForkRight edge, edges: {:?}",
        c1.edges
    );
}

#[test]
fn stash_inline_with_topic_branch() {
    // Stash on HEAD tip with a topic branch from C0 at another column.
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);
        let sig = git2::Signature::now("T", "t@t.com").unwrap();

        let c0 = raw_commit(&repo, &sig, "refs/heads/main", "C0", "f0.txt", "f0", &[]);
        let c0c = repo.find_commit(c0).unwrap();
        let _c1 = raw_commit(
            &repo,
            &sig,
            "refs/heads/main",
            "C1",
            "f1.txt",
            "f1",
            &[&c0c],
        );
        repo.set_head("refs/heads/main").unwrap();
        let _topic = raw_commit(
            &repo,
            &sig,
            "refs/heads/topic",
            "Topic",
            "topic.txt",
            "topic",
            &[&c0c],
        );
    }

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    std::fs::write(dir.path().join("dirty.txt"), "dirty").unwrap();
    {
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("dirty.txt")).unwrap();
        idx.write().unwrap();
    }
    let sig2 = git2::Signature::now("T", "t@t.com").unwrap();
    repo.stash_save(&sig2, "test stash", None).unwrap();

    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let c1 = commits
        .iter()
        .find(|c| c.summary == "C1")
        .expect("C1 not found");
    let stash = commits.iter().find(|c| c.is_stash).expect("no stash found");

    assert_eq!(
        stash.column, c1.column,
        "stash should be inline at parent's column {}, got col {}",
        c1.column, stash.column
    );

    let c1_fork = c1
        .edges
        .iter()
        .find(|e| matches!(e.edge_type, EdgeType::ForkRight));
    assert!(
        c1_fork.is_none(),
        "C1 should NOT have ForkRight for inline stash, edges: {:?}",
        c1.edges
    );
}

/// C0 -> C1 -> C2 -> "Add stash marker" (HEAD tip) with one stash on the marker.
/// `with_stash` reverts the worktree, so the fixture arrives clean. The committed `.gitignore`
/// is what lets a test distinguish `dirty_status_options()` from `statuses(None)`.
fn stash_on_head_tip_ctx() -> TestContext {
    TestContext::builder()
        .with_file(".gitignore", "ignored.txt\n")
        .with_commit("Add ignore rules")
        .with_file("f0.txt", "f0")
        .with_commit("C0")
        .with_file("f1.txt", "f1")
        .with_commit("C1")
        .with_file("f2.txt", "f2")
        .with_commit("C2")
        .with_stash(Some("test stash"))
        .build()
}

fn stash_and_parent(commits: &[trunk_lib::git::types::GraphCommit]) -> (usize, usize) {
    let stash_idx = commits
        .iter()
        .position(|c| c.is_stash)
        .expect("no stash commit found");
    let parent_oid = &commits[stash_idx].parent_oids[0];
    let parent_idx = commits
        .iter()
        .position(|c| &c.oid == parent_oid)
        .expect("stash parent not found");
    (stash_idx, parent_idx)
}

#[test]
fn stash_branches_right_when_worktree_dirty() {
    let ctx = stash_on_head_tip_ctx();
    std::fs::write(ctx.repo_path().join("f2.txt"), "modified").unwrap();

    let mut repo = ctx.repo();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();

    let (stash_idx, parent_idx) = stash_and_parent(&result.commits);
    let stash = &result.commits[stash_idx];
    let parent = &result.commits[parent_idx];
    assert_eq!(
        stash.column, 1,
        "dirty worktree should push the stash off the WIP column, got col {}",
        stash.column
    );
    assert_ne!(
        stash.color_index, 0,
        "branching stash should take its own color, edges: {:?}",
        stash.edges
    );
    let stash_straight = stash.edges.iter().find(|e| {
        matches!(e.edge_type, EdgeType::Straight) && e.from_column == 1 && e.to_column == 1
    });
    assert!(
        stash_straight.is_some_and(|e| e.dashed),
        "stash should have a dashed Straight at column 1, edges: {:?}",
        stash.edges
    );
    let parent_fork = parent.edges.iter().find(|e| {
        matches!(e.edge_type, EdgeType::ForkRight) && e.from_column == 0 && e.to_column == 1
    });
    assert!(
        parent_fork.is_some_and(|e| e.dashed),
        "stash parent should emit a dashed ForkRight 0->1, edges: {:?}",
        parent.edges
    );
}

#[test]
fn stash_branches_right_when_only_untracked() {
    let ctx = stash_on_head_tip_ctx();
    std::fs::write(ctx.repo_path().join("untracked.txt"), "u").unwrap();

    let mut repo = ctx.repo();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();

    let (stash_idx, _) = stash_and_parent(&result.commits);
    assert_eq!(
        result.commits[stash_idx].column, 1,
        "an untracked file alone is dirty; status options must include untracked"
    );
}

#[test]
fn stash_branches_right_when_only_staged() {
    let ctx = stash_on_head_tip_ctx();
    std::fs::write(ctx.repo_path().join("staged.txt"), "s").unwrap();

    let mut repo = ctx.repo();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("staged.txt")).unwrap();
    index.write().unwrap();
    drop(index);

    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();

    let (stash_idx, _) = stash_and_parent(&result.commits);
    assert_eq!(
        result.commits[stash_idx].column, 1,
        "a staged-only change is dirty; the mask must include the INDEX_* bits"
    );
}

/// Invariant 1: `walk_commits` and `get_dirty_counts_inner` must never disagree about whether
/// the worktree is dirty — drift between them reproduces the stash/WIP collision intermittently.
/// `walk_commits`'s reading is invisible in `GraphResult`, so the stash's column is the only
/// observable that stands in for it.
fn assert_readings_agree(dirty_the_tree: impl Fn(&TestContext)) {
    use trunk_lib::commands::staging::get_dirty_counts_inner;

    let ctx = stash_on_head_tip_ctx();
    dirty_the_tree(&ctx);

    let counts = get_dirty_counts_inner(ctx.path(), ctx.state_map()).unwrap();
    let mut repo = ctx.repo();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();

    let (stash_idx, _) = stash_and_parent(&result.commits);
    let counts_say_dirty = counts.staged + counts.unstaged + counts.conflicted > 0;
    let graph_says_dirty = result.commits[stash_idx].column == 1;
    assert_eq!(
        counts_say_dirty, graph_says_dirty,
        "get_dirty_counts dirty={counts_say_dirty}, graph dirty={graph_says_dirty}"
    );
}

#[test]
fn graph_and_dirty_counts_agree_when_clean() {
    assert_readings_agree(|_| {});
}

#[test]
fn graph_and_dirty_counts_agree_when_only_ignored() {
    assert_readings_agree(|ctx| {
        std::fs::write(ctx.repo_path().join("ignored.txt"), "i").unwrap();
    });
}

#[test]
fn graph_and_dirty_counts_agree_when_only_untracked() {
    assert_readings_agree(|ctx| {
        std::fs::write(ctx.repo_path().join("untracked.txt"), "u").unwrap();
    });
}

#[test]
fn graph_and_dirty_counts_agree_when_only_staged() {
    assert_readings_agree(|ctx| {
        std::fs::write(ctx.repo_path().join("staged.txt"), "s").unwrap();
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("staged.txt")).unwrap();
        index.write().unwrap();
    });
}

#[test]
fn graph_and_dirty_counts_agree_when_only_unstaged() {
    assert_readings_agree(|ctx| {
        std::fs::write(ctx.repo_path().join("f2.txt"), "modified").unwrap();
    });
}

/// `open_repo` walks bare repositories too — `validate_and_open` only remaps the error, so
/// `workdir()` is not always `Some`. `repo.statuses()` refuses to run against one, and the
/// walk must survive that rather than propagate it.
#[test]
fn walk_commits_on_bare_repo_does_not_error() {
    let dir = tempfile::tempdir().unwrap();
    let mut repo = git2::Repository::init_bare(dir.path()).unwrap();

    let result = walk_commits(&mut repo, 0, usize::MAX);

    assert!(result.is_ok(), "bare repo walk failed: {:?}", result.err());
}

/// `C0 -> C1` on main with `C0 -> T1` on topic, plus one stash on the main tip. Timestamps are
/// spaced so the `TOPOLOGICAL | TIME` sort is deterministic; `t1_secs` places T1 above or below
/// C1, which is what decides how far D6's churn reaches. The tree is left clean.
fn topic_and_stash_repo(t1_secs: i64) -> tempfile::TempDir {
    let sig_at =
        |secs: i64| git2::Signature::new("T", "t@t.com", &git2::Time::new(secs, 0)).unwrap();
    let dir = tempfile::tempdir().unwrap();
    {
        let mut repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);

        {
            let c0 = raw_commit(
                &repo,
                &sig_at(1000),
                "refs/heads/main",
                "C0",
                "f0.txt",
                "f0",
                &[],
            );
            let c0c = repo.find_commit(c0).unwrap();
            raw_commit(
                &repo,
                &sig_at(t1_secs),
                "refs/heads/topic",
                "T1",
                "topic.txt",
                "topic",
                &[&c0c],
            );
            raw_commit(
                &repo,
                &sig_at(2000),
                "refs/heads/main",
                "C1",
                "f1.txt",
                "f1",
                &[&c0c],
            );
        }
        repo.set_head("refs/heads/main").unwrap();

        std::fs::write(dir.path().join("f1.txt"), "to be stashed").unwrap();
        repo.stash_save(&sig_at(4000), "test stash", None).unwrap();
    }
    dir
}

/// (max_columns, T1's column, T1's color) clean, then with the worktree dirtied.
fn topic_layout_clean_then_dirty(
    dir: &tempfile::TempDir,
) -> ((usize, usize, usize), (usize, usize, usize)) {
    let mut repo = git2::Repository::open(dir.path()).unwrap();
    let read = |result: &trunk_lib::git::types::GraphResult| {
        let t1 = result
            .commits
            .iter()
            .find(|c| c.summary == "T1")
            .expect("T1 not found");
        (result.max_columns, t1.column, t1.color_index)
    };

    let clean = read(&walk_commits(&mut repo, 0, usize::MAX).unwrap());
    std::fs::write(dir.path().join("f1.txt"), "dirty").unwrap();
    let dirty = read(&walk_commits(&mut repo, 0, usize::MAX).unwrap());
    (clean, dirty)
}

/// The `!worktree_dirty` clause in `.claude/rules/commit-graph.md`: a branching stash
/// consumes a lane and a colour that an inline stash does not, and stashes are placed before
/// branch tips. A branch tip sorting between the stash and the stash's parent finds that lane
/// still held, so it shifts a column right and a colour along. Accepted trade, pinned here so
/// it cannot change unnoticed.
#[test]
fn dirtiness_relayouts_unrelated_branches() {
    let dir = topic_and_stash_repo(3000);

    let (clean, dirty) = topic_layout_clean_then_dirty(&dir);

    assert_eq!(clean, (2, 1, 1), "clean: (max_columns, T1 col, T1 color)");
    assert_eq!(dirty, (3, 2, 2), "dirty: (max_columns, T1 col, T1 color)");
}

/// The other half of D6, and the bound on it: a branch tip sorting *below* the stash's parent
/// finds the stash's lane already released, so it keeps its column and only the colour moves.
#[test]
fn dirtiness_recolors_branches_below_the_stash_parent() {
    let dir = topic_and_stash_repo(1500);

    let (clean, dirty) = topic_layout_clean_then_dirty(&dir);

    assert_eq!(clean, (2, 1, 1), "clean: (max_columns, T1 col, T1 color)");
    assert_eq!(dirty, (2, 1, 2), "dirty: (max_columns, T1 col, T1 color)");
}

#[test]
fn stash_stays_inline_when_worktree_clean() {
    let ctx = stash_on_head_tip_ctx();

    let mut repo = ctx.repo();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();

    let (stash_idx, parent_idx) = stash_and_parent(&result.commits);
    let stash = &result.commits[stash_idx];
    let parent = &result.commits[parent_idx];
    assert_eq!(
        stash.column, 0,
        "clean worktree should keep the stash inline"
    );
    assert_eq!(
        stash.color_index, 0,
        "inline stash should inherit the HEAD lane's color"
    );
    assert!(
        !parent
            .edges
            .iter()
            .any(|e| matches!(e.edge_type, EdgeType::ForkRight)),
        "inline stash's parent should emit no ForkRight, edges: {:?}",
        parent.edges
    );
}

#[test]
fn detached_head_marks_first_parent_chain() {
    // Mid-rebase shape: HEAD detached at a1 (parent r2), reachable from no ref.
    // Remote chain base -> r1 -> r2 (refs/remotes/origin/main + tag), local
    // main base -> m1 -> m2 -> m3 with newer timestamps so it sorts on top.
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
        drop(cfg);
        let sig_at =
            |secs: i64| git2::Signature::new("T", "t@t.com", &git2::Time::new(secs, 0)).unwrap();

        let remote_ref = "refs/remotes/origin/main";
        let base = raw_commit(&repo, &sig_at(1000), remote_ref, "base", "b.txt", "b", &[]);
        let base_c = repo.find_commit(base).unwrap();
        let r1 = raw_commit(
            &repo,
            &sig_at(2000),
            remote_ref,
            "r1",
            "r1.txt",
            "r1",
            &[&base_c],
        );
        let r1_c = repo.find_commit(r1).unwrap();
        let r2 = raw_commit(
            &repo,
            &sig_at(3000),
            remote_ref,
            "r2",
            "r2.txt",
            "r2",
            &[&r1_c],
        );
        let r2_c = repo.find_commit(r2).unwrap();
        repo.tag_lightweight("v1", r2_c.as_object(), false).unwrap();

        let m1 = raw_commit(
            &repo,
            &sig_at(4000),
            "refs/heads/main",
            "m1",
            "m1.txt",
            "m1",
            &[&base_c],
        );
        let m1_c = repo.find_commit(m1).unwrap();
        let m2 = raw_commit(
            &repo,
            &sig_at(5000),
            "refs/heads/main",
            "m2",
            "m2.txt",
            "m2",
            &[&m1_c],
        );
        let m2_c = repo.find_commit(m2).unwrap();
        let _m3 = raw_commit(
            &repo,
            &sig_at(6000),
            "refs/heads/main",
            "m3",
            "m3.txt",
            "m3",
            &[&m2_c],
        );

        // a1: applied rebase commit on r2, reachable only from detached HEAD
        std::fs::write(dir.path().join("a1.txt"), "a1").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("a1.txt")).unwrap();
        idx.write().unwrap();
        let tree_oid = idx.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = sig_at(7000);
        let a1 = repo
            .commit(None, &sig, &sig, "a1", &tree, &[&r2_c])
            .unwrap();
        repo.set_head_detached(a1).unwrap();
    }

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    assert!(
        commits.iter().all(|c| !c.is_head),
        "detached HEAD: no row should be is_head"
    );
    assert!(
        !commits.iter().any(|c| c.summary == "a1"),
        "detached-only commit a1 should have no row"
    );

    for summary in ["r2", "r1", "base"] {
        let c = commits.iter().find(|c| c.summary == summary).unwrap();
        assert!(c.in_head_chain, "{summary} should be in_head_chain");
    }
    for summary in ["m1", "m2", "m3"] {
        let c = commits.iter().find(|c| c.summary == summary).unwrap();
        assert!(!c.in_head_chain, "{summary} should NOT be in_head_chain");
    }

    let first_chain = commits
        .iter()
        .find(|c| c.in_head_chain)
        .expect("a head-chain row should exist");
    assert_eq!(
        first_chain.summary, "r2",
        "first in_head_chain row should be the chain tip r2"
    );
}

fn sig_at(secs: i64) -> git2::Signature<'static> {
    git2::Signature::new("T", "t@t.com", &git2::Time::new(secs, 0)).unwrap()
}

/// `Add notes` -> `Add app` on main, with a stash on the tip whose committer time predates
/// both. Mirrors QA fixture 15. The tree is left clean, so the stash is inline-eligible.
fn backdated_stash_repo() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let mut repo = git2::Repository::init(dir.path()).unwrap();
    {
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
    }
    {
        let notes = raw_commit(
            &repo,
            &sig_at(1_700_000_000),
            "refs/heads/main",
            "Add notes",
            "notes.txt",
            "notes v1",
            &[],
        );
        let notes_c = repo.find_commit(notes).unwrap();
        raw_commit(
            &repo,
            &sig_at(1_700_086_400),
            "refs/heads/main",
            "Add app",
            "app.txt",
            "app v1",
            &[&notes_c],
        );
    }
    repo.set_head("refs/heads/main").unwrap();

    std::fs::write(dir.path().join("notes.txt"), "notes v2 — stashed").unwrap();
    repo.stash_save(&sig_at(1_699_913_600), "backdated", None)
        .unwrap();

    dir
}

fn row_of(commits: &[trunk_lib::git::types::GraphCommit], summary: &str) -> usize {
    commits
        .iter()
        .position(|c| c.summary == summary)
        .unwrap_or_else(|| panic!("{summary} not found in {:?}", summaries(commits)))
}

fn summaries(commits: &[trunk_lib::git::types::GraphCommit]) -> Vec<&str> {
    commits.iter().map(|c| c.summary.as_str()).collect()
}

#[test]
fn backdated_stash_sorts_above_its_parent() {
    let dir = backdated_stash_repo();
    let mut repo = git2::Repository::open(dir.path()).unwrap();

    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let stash_row = commits
        .iter()
        .position(|c| c.is_stash)
        .expect("no stash row emitted");
    let parent_row = row_of(commits, "Add app");
    assert!(
        stash_row < parent_row,
        "stash must sort above its parent, got stash={stash_row} parent={parent_row} in {:?}",
        summaries(commits)
    );
    assert_eq!(
        commits[stash_row].column, commits[parent_row].column,
        "a clean worktree should place the stash inline at its parent's column"
    );
    assert_eq!(result.max_columns, 1, "inline stash needs no second column");
    assert!(
        !commits[parent_row].is_branch_tip,
        "the stash re-occupies the lane, so its parent is no longer a branch tip"
    );
    assert_no_stash_internals(commits);
}

fn assert_no_stash_internals(commits: &[trunk_lib::git::types::GraphCommit]) {
    for c in commits {
        assert!(
            !c.summary.starts_with("index on ") && !c.summary.starts_with("untracked files on "),
            "stash internals leaked into the walk: {:?}",
            summaries(commits)
        );
    }
}

/// The backdated shape with a lightweight tag on the stash commit, so the stash is reachable
/// from `refs/tags` as well as from `refs/stash`.
fn tagged_stash_repo() -> tempfile::TempDir {
    let dir = backdated_stash_repo();
    {
        let repo = git2::Repository::open(dir.path()).unwrap();
        let stash_oid = repo.refname_to_id("refs/stash").unwrap();
        let stash_obj = repo.find_object(stash_oid, None).unwrap();
        repo.tag_lightweight("keep", &stash_obj, false).unwrap();
    }
    dir
}

/// A ref pointing at a stash used to push it into the walk a second time, and the duplicate
/// row lost its `is_stash` flag to `per_oid_data.remove`, recomputing itself as a merge.
#[test]
fn tagged_stash_is_not_duplicated() {
    let dir = tagged_stash_repo();
    let mut repo = git2::Repository::open(dir.path()).unwrap();
    let stash_oid = repo.refname_to_id("refs/stash").unwrap();

    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let stash_rows: Vec<_> = commits
        .iter()
        .filter(|c| c.oid == stash_oid.to_string())
        .collect();
    assert_eq!(
        stash_rows.len(),
        1,
        "a tagged stash must occupy exactly one row, got {:?}",
        summaries(commits)
    );
    assert!(
        stash_rows[0].is_stash,
        "the surviving row must be the stash"
    );
    assert!(
        !stash_rows[0].is_merge,
        "a stash's extra parents are internal state, not a merge"
    );
    assert_eq!(
        result.max_columns,
        1,
        "one clean lane, got {:?}",
        summaries(commits)
    );
    assert_no_stash_internals(commits);
}

/// Stash B taken while HEAD is detached on stash A, so `B^ == A`. B is timestamped *before*
/// A: under a time-ordered merge the newer parent sorts above its child, which is the
/// inversion the topological walk has to rule out.
///
/// The detach is load-bearing. It puts A in the head chain, so A's column is reserved before
/// B is placed.
fn stash_on_stash_repo() -> (tempfile::TempDir, git2::Oid, git2::Oid) {
    let dir = tempfile::tempdir().unwrap();
    let mut repo = git2::Repository::init(dir.path()).unwrap();
    {
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
    }
    {
        let notes = raw_commit(
            &repo,
            &sig_at(1_700_000_000),
            "refs/heads/main",
            "Add notes",
            "notes.txt",
            "notes v1",
            &[],
        );
        let notes_c = repo.find_commit(notes).unwrap();
        raw_commit(
            &repo,
            &sig_at(1_700_086_400),
            "refs/heads/main",
            "Add app",
            "app.txt",
            "app v1",
            &[&notes_c],
        );
    }
    repo.set_head("refs/heads/main").unwrap();

    std::fs::write(dir.path().join("notes.txt"), "notes v2 — stash A").unwrap();
    let a = repo
        .stash_save(&sig_at(1_700_259_200), "stash A", None)
        .unwrap();

    {
        let a_obj = repo.find_object(a, None).unwrap();
        let mut checkout = git2::build::CheckoutBuilder::new();
        repo.checkout_tree(&a_obj, Some(checkout.force())).unwrap();
        repo.set_head_detached(a).unwrap();
    }

    std::fs::write(dir.path().join("notes.txt"), "notes v3 — stash B").unwrap();
    let b = repo
        .stash_save(&sig_at(1_700_172_800), "stash B", None)
        .unwrap();

    assert_eq!(
        repo.find_commit(b).unwrap().parent_id(0).unwrap(),
        a,
        "fixture is wrong: B's first parent must be stash A"
    );
    (dir, a, b)
}

fn row_of_oid(commits: &[trunk_lib::git::types::GraphCommit], oid: git2::Oid) -> usize {
    commits
        .iter()
        .position(|c| c.oid == oid.to_string())
        .unwrap_or_else(|| panic!("{oid} not found in {:?}", summaries(commits)))
}

#[test]
fn stash_on_stash_chain_orders_child_first() {
    let (dir, a, b) = stash_on_stash_repo();
    let mut repo = git2::Repository::open(dir.path()).unwrap();

    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let b_row = row_of_oid(commits, b);
    let a_row = row_of_oid(commits, a);
    let base_row = row_of(commits, "Add app");
    assert!(
        b_row < a_row && a_row < base_row,
        "expected B above A above the base commit, got B={b_row} A={a_row} base={base_row} in {:?}",
        summaries(commits)
    );
    assert!(commits[b_row].is_stash, "B must be flagged as a stash");
    assert!(commits[a_row].is_stash, "A must be flagged as a stash");
    assert_no_stash_internals(commits);
}

/// Two stashes on the same parent, both timestamped before it. Returns the newer and the
/// older stash OID.
fn two_backdated_stashes_repo() -> (tempfile::TempDir, git2::Oid, git2::Oid) {
    let dir = tempfile::tempdir().unwrap();
    let mut repo = git2::Repository::init(dir.path()).unwrap();
    {
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
    }
    {
        let notes = raw_commit(
            &repo,
            &sig_at(1_700_000_000),
            "refs/heads/main",
            "Add notes",
            "notes.txt",
            "notes v1",
            &[],
        );
        let notes_c = repo.find_commit(notes).unwrap();
        raw_commit(
            &repo,
            &sig_at(1_700_086_400),
            "refs/heads/main",
            "Add app",
            "app.txt",
            "app v1",
            &[&notes_c],
        );
    }
    repo.set_head("refs/heads/main").unwrap();

    std::fs::write(dir.path().join("notes.txt"), "notes v2 — stashed").unwrap();
    let older = repo
        .stash_save(&sig_at(1_699_827_200), "older backdated", None)
        .unwrap();

    std::fs::write(dir.path().join("app.txt"), "app v2 — stashed").unwrap();
    let newer = repo
        .stash_save(&sig_at(1_699_913_600), "newer backdated", None)
        .unwrap();

    (dir, newer, older)
}

/// The shape QA fixture 07 already documents for two ordinary stashes: the first one placed
/// takes the parent's lane, the second finds it held and branches one column right. Being
/// backdated changes nothing about it.
#[test]
fn two_backdated_stashes_on_one_parent() {
    let (dir, newer, older) = two_backdated_stashes_repo();
    let mut repo = git2::Repository::open(dir.path()).unwrap();

    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let newer_row = row_of_oid(commits, newer);
    let older_row = row_of_oid(commits, older);
    let parent_row = row_of(commits, "Add app");
    assert!(
        newer_row < parent_row && older_row < parent_row,
        "both stashes must sort above their parent, got newer={newer_row} older={older_row} parent={parent_row}"
    );
    assert_eq!(
        commits[newer_row].column, commits[parent_row].column,
        "the newer stash takes its parent's lane"
    );
    assert_eq!(
        commits[older_row].column,
        commits[parent_row].column + 1,
        "the older stash finds that lane held and branches one column right"
    );
    assert_no_stash_internals(commits);
}

/// QA fixture 12's shape: the stash's parent is dropped from every ref by `reset --hard`, so
/// the only thing still pointing at it is the stash itself.
fn orphan_stash_repo() -> (tempfile::TempDir, git2::Oid) {
    let dir = tempfile::tempdir().unwrap();
    let mut repo = git2::Repository::init(dir.path()).unwrap();
    {
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "T").unwrap();
        cfg.set_str("user.email", "t@t.com").unwrap();
    }
    let notes = {
        let notes = raw_commit(
            &repo,
            &sig_at(1_700_000_000),
            "refs/heads/main",
            "Add notes",
            "notes.txt",
            "notes v1",
            &[],
        );
        let notes_c = repo.find_commit(notes).unwrap();
        raw_commit(
            &repo,
            &sig_at(1_700_086_400),
            "refs/heads/main",
            "Add app",
            "app.txt",
            "app v1",
            &[&notes_c],
        );
        notes
    };
    repo.set_head("refs/heads/main").unwrap();

    std::fs::write(dir.path().join("notes.txt"), "notes v2 — stashed").unwrap();
    let stash = repo
        .stash_save(&sig_at(1_700_864_000), "half-finished notes", None)
        .unwrap();

    {
        let notes_obj = repo.find_object(notes, None).unwrap();
        repo.reset(&notes_obj, git2::ResetType::Hard, None).unwrap();
    }

    (dir, stash)
}

/// D6: pushing the stash into the walk makes its parent reachable again, so the row comes
/// back and the dashed connector has something to land on. The cost is that `reset --hard`
/// no longer visually removes a commit a stash still holds — dropping the stash does.
#[test]
fn orphan_stash_shows_its_parent() {
    let (dir, stash) = orphan_stash_repo();
    let mut repo = git2::Repository::open(dir.path()).unwrap();

    let result = walk_commits(&mut repo, 0, usize::MAX).unwrap();
    let commits = &result.commits;

    let stash_row = row_of_oid(commits, stash);
    let parent_row = row_of(commits, "Add app");
    assert!(
        stash_row < parent_row,
        "the stash must sort above the parent it holds, got stash={stash_row} parent={parent_row}"
    );

    let stash_col = commits[stash_row].column;
    assert!(
        commits[stash_row].edges.iter().any(|e| {
            matches!(e.edge_type, EdgeType::Straight)
                && e.from_column == stash_col
                && e.to_column == stash_col
                && e.dashed
        }),
        "the stash must emit a dashed connector at its own column, edges: {:?}",
        commits[stash_row].edges
    );
}

/// Every shape whose ordering the timestamp merge could invert. D4's invariants are asserted
/// over these and not over plain linear history, which could never violate them — that is why
/// the first version of the invariant passed while the walk was broken.
fn stash_shapes() -> Vec<(&'static str, tempfile::TempDir)> {
    vec![
        ("backdated stash", backdated_stash_repo()),
        ("tagged stash", tagged_stash_repo()),
        ("stash on stash", stash_on_stash_repo().0),
        ("two backdated stashes", two_backdated_stashes_repo().0),
        ("orphan stash", orphan_stash_repo().0),
    ]
}

#[test]
fn first_parent_never_sorts_above_its_child() {
    for (shape, dir) in stash_shapes() {
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap().commits;

        let row_by_oid: std::collections::HashMap<&str, usize> = commits
            .iter()
            .enumerate()
            .map(|(row, c)| (c.oid.as_str(), row))
            .collect();

        for (row, c) in commits.iter().enumerate() {
            let Some(parent) = c.parent_oids.first() else {
                continue;
            };
            let Some(&parent_row) = row_by_oid.get(parent.as_str()) else {
                continue;
            };
            assert!(
                parent_row > row,
                "{shape}: {} sits at row {row} but its first parent is at row {parent_row}, in {:?}",
                c.short_oid,
                summaries(&commits)
            );
        }
    }
}

#[test]
fn no_oid_appears_twice() {
    for (shape, dir) in stash_shapes() {
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let commits = walk_commits(&mut repo, 0, usize::MAX).unwrap().commits;

        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for c in &commits {
            assert!(
                seen.insert(c.oid.as_str()),
                "{shape}: {} appears twice, in {:?}",
                c.short_oid,
                summaries(&commits)
            );
        }
    }
}

fn delete_loose_object(repo_path: &std::path::Path, oid: git2::Oid) {
    let hex = oid.to_string();
    let path = repo_path
        .join(".git/objects")
        .join(&hex[..2])
        .join(&hex[2..]);
    std::fs::remove_file(&path).unwrap_or_else(|e| panic!("removing {}: {e}", path.display()));
}

/// R3: pushing stashes into the walk newly exposes their objects to it. A corrupt or
/// manually-pruned object store must cost the graph that one stash, not every row in the repo.
#[test]
fn unreadable_stash_commit_is_skipped() {
    let dir = backdated_stash_repo();
    let stash_oid = git2::Repository::open(dir.path())
        .unwrap()
        .refname_to_id("refs/stash")
        .unwrap();
    delete_loose_object(dir.path(), stash_oid);

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    let result = walk_commits(&mut repo, 0, usize::MAX);

    let commits = result
        .expect("an unreadable stash commit must not blank the graph")
        .commits;
    for summary in ["Add app", "Add notes"] {
        assert!(
            commits.iter().any(|c| c.summary == summary),
            "{summary} should still render, got {:?}",
            summaries(&commits)
        );
    }
}

/// The same failure one level down, and the one `revwalk.push` cannot catch: the stash commit
/// itself reads fine, so the push succeeds and the walk only fails when it reaches the
/// index-tree commit.
#[test]
fn unreadable_stash_index_commit_is_skipped() {
    let dir = backdated_stash_repo();
    let index_oid = {
        let repo = git2::Repository::open(dir.path()).unwrap();
        let stash_oid = repo.refname_to_id("refs/stash").unwrap();
        repo.find_commit(stash_oid).unwrap().parent_id(1).unwrap()
    };
    delete_loose_object(dir.path(), index_oid);

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    let result = walk_commits(&mut repo, 0, usize::MAX);

    let commits = result
        .expect("an unreadable stash index commit must not blank the graph")
        .commits;
    for summary in ["Add app", "Add notes"] {
        assert!(
            commits.iter().any(|c| c.summary == summary),
            "{summary} should still render, got {:?}",
            summaries(&commits)
        );
    }
}

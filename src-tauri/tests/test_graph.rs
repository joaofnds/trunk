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

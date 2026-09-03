mod common;

use common::context::TestContext;
use common::graph_shapes::{
    backdated_stash_repo, behind_upstream_repo, checkout_main, context_at, identity, raw_commit,
    sig_at, stash_on_tip_with_ignore_repo, tagged_stash_repo, topic_and_stash_repo,
    track_origin_main, two_backdated_stashes_repo,
};
use common::rule_inputs;
use trunk_lib::git::graph::snapshot;
use trunk_lib::git::graph_input::RefVisibility;
use trunk_lib::git::types::EdgeType;

// ============================================================
// Tests
// ============================================================

#[test]
fn linear_topology() {
    let commits = rule_inputs::commits("linear-topology");

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
fn walk_first_batch() {
    let commits = rule_inputs::walk("linear-300-commits", 0, 200).commits;

    assert_eq!(commits.len(), 200);
}

#[test]
fn walk_second_batch() {
    let first = rule_inputs::walk("linear-300-commits", 0, 200).commits;
    let second = rule_inputs::walk("linear-300-commits", 200, 200).commits;

    assert!(!second.is_empty(), "second batch should not be empty");
    assert!(second.len() <= 200);
    assert_ne!(
        first[0].oid, second[0].oid,
        "first OID of batch 1 and batch 2 should differ"
    );
}

#[test]
fn merge_commit_edges() {
    let commits = rule_inputs::commits("merge-feature");

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
    let commits = rule_inputs::commits("merge-feature");

    let merge_count = commits.iter().filter(|c| c.is_merge).count();
    let non_merge_count = commits.iter().filter(|c| !c.is_merge).count();
    assert_eq!(merge_count, 1, "expected exactly 1 merge commit");
    assert_eq!(non_merge_count, 2, "expected 2 non-merge commits");
}

#[test]
fn merge_has_first_parent_straight() {
    let commits = rule_inputs::commits("merge-feature");

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
fn no_ghost_lanes_after_merge() {
    let commits = rule_inputs::commits("merge-two-parents");

    let feature_col = row(&commits, "F1").column;
    let c0 = row(&commits, "C0");
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
        "feature branch F1 should be at column > 0, got {feature_col}"
    );
}

#[test]
fn no_ghost_lanes_criss_cross() {
    let commits = rule_inputs::commits("criss-cross-merge");

    let b1_col = row(&commits, "B1").column;
    let root_found = row(&commits, "Root");
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
    let result = rule_inputs::walk("octopus-three-branches", 0, usize::MAX);

    assert!(
        result.max_columns <= 5,
        "octopus merge max_columns {} exceeds 5",
        result.max_columns
    );
}

#[test]
fn octopus_no_column_zero_theft() {
    let commits = rule_inputs::commits("octopus-two-branches");

    let octopus = row(&commits, "Octopus");
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
    let result = rule_inputs::walk("merge-feature", 0, usize::MAX);

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
fn color_index_deterministic() {
    let result1 = rule_inputs::walk("merge-feature", 0, usize::MAX);
    let result2 = rule_inputs::walk("merge-feature", 0, usize::MAX);

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
    let commits = rule_inputs::commits("merge-feature");

    let head = commits.iter().find(|c| c.is_head).expect("no HEAD commit");
    assert_eq!(
        head.color_index, 0,
        "HEAD commit should have color_index 0, got {}",
        head.color_index
    );

    for c in commits.iter().filter(|c| c.column == 0 && c.in_head_chain) {
        assert_eq!(
            c.color_index, 0,
            "HEAD chain commit {} (col 0) should have color_index 0, got {}",
            c.short_oid, c.color_index
        );
    }
}

#[test]
fn branch_fork_topology() {
    let commits = rule_inputs::commits("branch-fork");

    let c2 = row(&commits, "C2");
    let c1f = row(&commits, "C1");
    let c0f = row(&commits, "C0");
    let b0 = row(&commits, "B0");

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
fn max_columns_pagination() {
    let full = rule_inputs::walk("linear-300-commits", 0, usize::MAX);
    let page1 = rule_inputs::walk("linear-300-commits", 0, 100);
    let page2 = rule_inputs::walk("linear-300-commits", 100, 100);

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
    let commits = rule_inputs::commits("freed-column-reuse");

    let branch_a = row(&commits, "BranchA");
    let branch_b = row(&commits, "BranchB");

    assert!(branch_a.column > 0, "BranchA should be at column > 0");
    assert!(branch_b.column > 0, "BranchB should be at column > 0");
    assert_eq!(
        branch_a.column, branch_b.column,
        "BranchB (col {}) should reuse BranchA's freed column (col {})",
        branch_b.column, branch_a.column
    );
}

#[test]
fn head_lane_carries_two_colors_above_a_non_upstream_continuation() {
    let commits = rule_inputs::commits("non-upstream-continuation");

    let lane_zero: Vec<usize> = commits
        .iter()
        .filter(|c| c.column == 0)
        .map(|c| c.color_index)
        .collect();
    assert_eq!(lane_zero.len(), 3, "all three rows share lane 0");
    assert_ne!(
        row(&commits, "later1").color_index,
        row(&commits, "base2").color_index,
        "lane 0 carries two colors: a non-upstream continuation does not inherit HEAD's"
    );
    assert_eq!(
        row(&commits, "base2").color_index,
        0,
        "HEAD's own chain keeps color 0"
    );
}

#[test]
fn ref_label_color_index() {
    let commits = rule_inputs::commits("merge-feature");

    for commit in &commits {
        for r in &commit.refs {
            assert_eq!(
                r.color_index, commit.color_index,
                "ref '{}' color_index {} does not match commit {} color_index {}",
                r.short_name, r.color_index, commit.short_oid, commit.color_index
            );
        }
    }

    let commits_with_refs = commits.iter().filter(|c| !c.refs.is_empty()).count();
    assert!(
        commits_with_refs > 0,
        "expected at least one commit with refs"
    );
}

#[test]
fn ref_label_no_refs_no_panic() {
    let commits = rule_inputs::commits("merge-feature");

    let no_refs = commits.iter().find(|c| c.refs.is_empty());
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
    let commits = rule_inputs::commits("stash-on-head-tip");

    let c2 = row(&commits, "C2");
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

    let c1 = row(&commits, "C1");
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
    let commits = rule_inputs::commits("two-stashes-one-parent");

    let stashes: Vec<_> = commits.iter().filter(|c| c.is_stash).collect();
    assert_eq!(
        stashes.len(),
        2,
        "expected 2 stash commits, got {}",
        stashes.len()
    );

    let c1 = row(&commits, "C1");

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
    let commits = rule_inputs::commits("stash-on-mid-chain");

    let c1 = row(&commits, "C1");
    let stash = commits
        .iter()
        .find(|c| c.is_stash)
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
    let commits = rule_inputs::commits("stash-with-topic-branch");

    let c1 = row(&commits, "C1");
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
    let commits = rule_inputs::commits("stash-tip-dirty-tracked");

    let (stash_idx, parent_idx) = stash_and_parent(&commits);
    let stash = &commits[stash_idx];
    let parent = &commits[parent_idx];
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
    let commits = rule_inputs::commits("stash-tip-untracked");

    let (stash_idx, _) = stash_and_parent(&commits);
    assert_eq!(
        commits[stash_idx].column, 1,
        "an untracked file alone is dirty; status options must include untracked"
    );
}

#[test]
fn stash_branches_right_when_only_staged() {
    let commits = rule_inputs::commits("stash-tip-staged");

    let (stash_idx, _) = stash_and_parent(&commits);
    assert_eq!(
        commits[stash_idx].column, 1,
        "a staged-only change is dirty; the mask must include the INDEX_* bits"
    );
}

/// Invariant 1: `graph::snapshot` and `get_dirty_counts_inner` must never disagree about whether
/// the worktree is dirty — drift between them reproduces the stash/WIP collision intermittently.
/// the walk's reading is invisible in `GraphResult`, so the stash's column is the only
/// observable that stands in for it.
fn assert_readings_agree(dirty_the_tree: impl Fn(&TestContext)) {
    use trunk_lib::commands::staging::get_dirty_counts_inner;

    let ctx = stash_on_tip_with_ignore_repo();
    dirty_the_tree(&ctx);

    let counts = get_dirty_counts_inner(ctx.path(), ctx.state_map()).unwrap();
    let mut repo = ctx.repo();
    let result = snapshot(&mut repo, &RefVisibility::default())
        .map(|s| s.layout)
        .unwrap();

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
fn snapshot_on_bare_repo_does_not_error() {
    let dir = tempfile::tempdir().unwrap();
    let mut repo = git2::Repository::init_bare(dir.path()).unwrap();

    let result = snapshot(&mut repo, &RefVisibility::default()).map(|s| s.layout);

    assert!(result.is_ok(), "bare repo walk failed: {:?}", result.err());
}

/// (max_columns, T1's column, T1's color) for one captured topic-and-stash shape.
fn topic_layout(name: &str) -> (usize, usize, usize) {
    let result = rule_inputs::walk(name, 0, usize::MAX);
    let t1 = result
        .commits
        .iter()
        .find(|c| c.summary == "T1")
        .expect("T1 not found");

    (result.max_columns, t1.column, t1.color_index)
}

/// (max_columns, T1's column, T1's color) clean, then with the worktree dirtied. Built from a
/// repository rather than a capture: this pair is one of the two tests that still pin the
/// revwalk's `TOPOLOGICAL | TIME` sort, which a committed capture would freeze (count
/// re-measured 2026-08-11; `.claude/rules/commit-graph.md` states the same one).
fn topic_layout_clean_then_dirty(
    ctx: &TestContext,
) -> ((usize, usize, usize), (usize, usize, usize)) {
    let mut repo = ctx.repo();
    let read = |result: &trunk_lib::git::types::GraphResult| {
        let t1 = result
            .commits
            .iter()
            .find(|c| c.summary == "T1")
            .expect("T1 not found");
        (result.max_columns, t1.column, t1.color_index)
    };

    let clean = read(
        &snapshot(&mut repo, &RefVisibility::default())
            .map(|s| s.layout)
            .unwrap(),
    );
    std::fs::write(ctx.repo_path().join("f1.txt"), "dirty").unwrap();
    let dirty = read(
        &snapshot(&mut repo, &RefVisibility::default())
            .map(|s| s.layout)
            .unwrap(),
    );
    (clean, dirty)
}

/// The `!worktree_dirty` clause in `.claude/rules/commit-graph.md`: a branching stash
/// consumes a lane and a colour that an inline stash does not, and stashes are placed before
/// branch tips. A branch tip sorting between the stash and the stash's parent finds that lane
/// still held, so it shifts a column right and a colour along. Accepted trade, pinned here so
/// it cannot change unnoticed.
#[test]
fn dirtiness_relayouts_unrelated_branches() {
    let ctx = topic_and_stash_repo(3000);

    let (clean, dirty) = topic_layout_clean_then_dirty(&ctx);

    assert_eq!(clean, (2, 1, 1), "clean: (max_columns, T1 col, T1 color)");
    assert_eq!(dirty, (3, 2, 2), "dirty: (max_columns, T1 col, T1 color)");
}

/// The other half of D6, and the bound on it: a branch tip sorting *below* the stash's parent
/// finds the stash's lane already released, so it keeps its column and only the colour moves.
#[test]
fn dirtiness_recolors_branches_below_the_stash_parent() {
    let clean = topic_layout("topic-below-clean");
    let dirty = topic_layout("topic-below-dirty");

    assert_eq!(clean, (2, 1, 1), "clean: (max_columns, T1 col, T1 color)");
    assert_eq!(dirty, (2, 1, 2), "dirty: (max_columns, T1 col, T1 color)");
}

#[test]
fn stash_stays_inline_when_worktree_clean() {
    let commits = rule_inputs::commits("stash-tip-clean");

    let (stash_idx, parent_idx) = stash_and_parent(&commits);
    let stash = &commits[stash_idx];
    let parent = &commits[parent_idx];
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

    let ctx = context_at(dir);
    let mut repo = ctx.repo();
    let result = snapshot(&mut repo, &RefVisibility::default())
        .map(|s| s.layout)
        .unwrap();
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
    let result = rule_inputs::walk("backdated-stash", 0, usize::MAX);
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

/// A ref pointing at a stash used to push it into the walk a second time, and the duplicate
/// row lost its `is_stash` flag to `per_oid_data.remove`, recomputing itself as a merge.
#[test]
fn tagged_stash_is_not_duplicated() {
    let ctx = tagged_stash_repo();
    let mut repo = ctx.repo();
    let stash_oid = repo.refname_to_id("refs/stash").unwrap();

    let result = snapshot(&mut repo, &RefVisibility::default())
        .map(|s| s.layout)
        .unwrap();
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

#[test]
fn stash_on_stash_chain_orders_child_first() {
    let commits = rule_inputs::commits("stash-on-stash");

    let b_row = row_of(&commits, "On (no branch): stash B");
    let a_row = row_of(&commits, "On main: stash A");
    let base_row = row_of(&commits, "Add app");
    assert!(
        b_row < a_row && a_row < base_row,
        "expected B above A above the base commit, got B={b_row} A={a_row} base={base_row} in {:?}",
        summaries(&commits)
    );
    assert!(commits[b_row].is_stash, "B must be flagged as a stash");
    assert!(commits[a_row].is_stash, "A must be flagged as a stash");
    assert_no_stash_internals(&commits);
}

/// The shape QA fixture 07 already documents for two ordinary stashes: the first one placed
/// takes the parent's lane, the second finds it held and branches one column right. Being
/// backdated changes nothing about it.
#[test]
fn two_backdated_stashes_on_one_parent() {
    let ctx = two_backdated_stashes_repo();
    let mut repo = ctx.repo();

    let result = snapshot(&mut repo, &RefVisibility::default())
        .map(|s| s.layout)
        .unwrap();
    let commits = &result.commits;

    let newer_row = row_of(commits, "On main: newer backdated");
    let older_row = row_of(commits, "On main: older backdated");
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

/// D6: pushing the stash into the walk makes its parent reachable again, so the row comes
/// back and the dashed connector has something to land on. The cost is that `reset --hard`
/// no longer visually removes a commit a stash still holds — dropping the stash does.
#[test]
fn orphan_stash_shows_its_parent() {
    let commits = rule_inputs::commits("orphan-stash");

    let stash_row = commits
        .iter()
        .position(|c| c.is_stash)
        .expect("no stash row emitted");
    let parent_row = row_of(&commits, "Add app");
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

/// Every captured shape whose ordering the timestamp merge could invert. D4's invariants are
/// asserted over these and not over plain linear history, which could never violate them —
/// that is why the first version of the invariant passed while the walk was broken.
const STASH_SHAPES: [&str; 5] = [
    "backdated-stash",
    "tagged-stash",
    "stash-on-stash",
    "two-backdated-stashes",
    "orphan-stash",
];

#[test]
fn first_parent_never_sorts_above_its_child() {
    for shape in STASH_SHAPES {
        let commits = rule_inputs::commits(shape);

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
    for shape in STASH_SHAPES {
        let commits = rule_inputs::commits(shape);

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
    let ctx = backdated_stash_repo();
    let stash_oid = ctx.repo().refname_to_id("refs/stash").unwrap();
    delete_loose_object(ctx.repo_path(), stash_oid);

    let mut repo = ctx.repo();
    let result = snapshot(&mut repo, &RefVisibility::default()).map(|s| s.layout);

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
    let ctx = backdated_stash_repo();
    let index_oid = {
        let repo = ctx.repo();
        let stash_oid = repo.refname_to_id("refs/stash").unwrap();
        repo.find_commit(stash_oid).unwrap().parent_id(1).unwrap()
    };
    delete_loose_object(ctx.repo_path(), index_oid);

    let mut repo = ctx.repo();
    let result = snapshot(&mut repo, &RefVisibility::default()).map(|s| s.layout);

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

// --- HEAD lane follows linear continuations -------------------------------
//
// Every repo below uses one file, so checking `main` out at the end leaves a
// clean worktree, and spaces commit timestamps a second apart: same-second
// commits sort arbitrarily under TOPOLOGICAL | TIME and can render a
// coincidentally-correct layout.

fn row<'a>(
    commits: &'a [trunk_lib::git::types::GraphCommit],
    summary: &str,
) -> &'a trunk_lib::git::types::GraphCommit {
    commits
        .iter()
        .find(|c| c.summary == summary)
        .unwrap_or_else(|| panic!("no row {summary} in {:?}", summaries(commits)))
}

fn walk(ctx: &TestContext) -> Vec<trunk_lib::git::types::GraphCommit> {
    let mut repo = ctx.repo();
    snapshot(&mut repo, &RefVisibility::default())
        .map(|s| s.layout)
        .unwrap()
        .commits
}

fn has_fork_right(c: &trunk_lib::git::types::GraphCommit) -> bool {
    c.edges
        .iter()
        .any(|e| matches!(e.edge_type, EdgeType::ForkRight))
}

#[test]
fn upstream_chain_shares_the_head_lane() {
    let ctx = behind_upstream_repo();

    let commits = walk(&ctx);

    for summary in ["up5", "up4", "up3", "base2", "base1"] {
        assert_eq!(
            row(&commits, summary).column,
            0,
            "{summary} belongs in the HEAD lane"
        );
    }
}

#[test]
fn upstream_chain_keeps_the_head_color() {
    let ctx = behind_upstream_repo();

    let commits = walk(&ctx);

    let head_color = row(&commits, "base2").color_index;
    for summary in ["up5", "up4", "up3"] {
        assert_eq!(
            row(&commits, summary).color_index,
            head_color,
            "{summary} is on main's tracked upstream, so it keeps main's color"
        );
    }
}

#[test]
fn head_tip_emits_no_fork_into_its_upstream() {
    let ctx = behind_upstream_repo();

    let commits = walk(&ctx);

    assert!(
        !has_fork_right(row(&commits, "base2")),
        "the DAG is linear here, so no fork belongs at the head tip: {:?}",
        row(&commits, "base2").edges
    );
    for summary in ["up5", "up4", "up3"] {
        let c = row(&commits, summary);
        assert!(
            c.edges.iter().any(|e| e.from_column == 0
                && e.to_column == 0
                && matches!(e.edge_type, EdgeType::Straight)),
            "{summary} needs a straight edge in lane 0, got {:?}",
            c.edges
        );
    }
}

#[test]
fn local_descendant_shares_the_lane_in_its_own_color() {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);
        let b1 = raw_commit(
            &repo,
            &sig_at(1000),
            "refs/heads/main",
            "base1",
            "f.txt",
            "1",
            &[],
        );
        let b1_c = repo.find_commit(b1).unwrap();
        let b2 = raw_commit(
            &repo,
            &sig_at(2000),
            "refs/heads/main",
            "base2",
            "f.txt",
            "2",
            &[&b1_c],
        );
        let b2_c = repo.find_commit(b2).unwrap();
        let n1 = raw_commit(
            &repo,
            &sig_at(3000),
            "refs/heads/new",
            "new1",
            "f.txt",
            "3",
            &[&b2_c],
        );
        let n1_c = repo.find_commit(n1).unwrap();
        raw_commit(
            &repo,
            &sig_at(4000),
            "refs/heads/new",
            "new2",
            "f.txt",
            "4",
            &[&n1_c],
        );
        checkout_main(&repo);
    }

    let commits = walk(&context_at(dir));

    for summary in ["new2", "new1", "base2", "base1"] {
        assert_eq!(
            row(&commits, summary).column,
            0,
            "{summary} shares the lane"
        );
    }
    assert_ne!(
        row(&commits, "new1").color_index,
        row(&commits, "base2").color_index,
        "`new` is not main's tracked upstream, so it takes its own color"
    );
    assert!(!has_fork_right(row(&commits, "base2")));
}

#[test]
fn upstream_outranks_a_topic_branch_for_the_head_lane() {
    let ctx = behind_upstream_repo();
    {
        let repo = ctx.repo();
        let b2_c = repo
            .find_reference("refs/heads/main")
            .unwrap()
            .peel_to_commit()
            .unwrap();
        let t1 = raw_commit(
            &repo,
            &sig_at(6000),
            "refs/heads/topic",
            "topic1",
            "t.txt",
            "t1",
            &[&b2_c],
        );
        let t1_c = repo.find_commit(t1).unwrap();
        raw_commit(
            &repo,
            &sig_at(7000),
            "refs/heads/topic",
            "topic2",
            "t.txt",
            "t2",
            &[&t1_c],
        );
        checkout_main(&repo);
        std::fs::remove_file(ctx.repo_path().join("t.txt")).ok();
    }

    let commits = walk(&ctx);

    for summary in ["up5", "up4", "up3"] {
        assert_eq!(
            row(&commits, summary).column,
            0,
            "the tracked upstream outranks a newer topic branch"
        );
    }
    for summary in ["topic2", "topic1"] {
        assert_ne!(row(&commits, summary).column, 0, "{summary} branches right");
    }
    assert!(
        has_fork_right(row(&commits, "base2")),
        "topic forks off the head tip"
    );
}

#[test]
fn diverged_branch_keeps_the_head_lane_and_still_forks() {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);
        track_origin_main(&repo);
        let b1 = raw_commit(
            &repo,
            &sig_at(1000),
            "refs/heads/main",
            "base1",
            "f.txt",
            "1",
            &[],
        );
        let b1_c = repo.find_commit(b1).unwrap();
        let b2 = raw_commit(
            &repo,
            &sig_at(2000),
            "refs/heads/main",
            "base2",
            "f.txt",
            "2",
            &[&b1_c],
        );
        let b2_c = repo.find_commit(b2).unwrap();
        let u3 = raw_commit(
            &repo,
            &sig_at(3000),
            "refs/remotes/origin/main",
            "up3",
            "f.txt",
            "3",
            &[&b2_c],
        );
        let u3_c = repo.find_commit(u3).unwrap();
        raw_commit(
            &repo,
            &sig_at(4000),
            "refs/remotes/origin/main",
            "up4",
            "f.txt",
            "4",
            &[&u3_c],
        );
        let l5 = raw_commit(
            &repo,
            &sig_at(5000),
            "refs/heads/main",
            "local5",
            "f.txt",
            "5",
            &[&b2_c],
        );
        let l5_c = repo.find_commit(l5).unwrap();
        raw_commit(
            &repo,
            &sig_at(6000),
            "refs/heads/main",
            "local6",
            "f.txt",
            "6",
            &[&l5_c],
        );
        checkout_main(&repo);
    }

    let commits = walk(&context_at(dir));

    assert_eq!(
        row(&commits, "local6").column,
        0,
        "HEAD keeps the leftmost lane"
    );
    assert_eq!(row(&commits, "local5").column, 0);
    assert_ne!(row(&commits, "up4").column, 0, "a diverged upstream forks");
    assert!(
        has_fork_right(row(&commits, "base2")),
        "the DAG really forks here"
    );
}

#[test]
fn stash_branches_right_when_the_head_lane_extends() {
    let commits = rule_inputs::commits("stash-under-extended-head-lane");

    let stash = commits.iter().find(|c| c.is_stash).expect("no stash row");
    assert_ne!(
        stash.column, 0,
        "the unpulled chain owns lane 0, so the stash branches right"
    );
    for summary in ["up5", "up4", "up3"] {
        assert_eq!(row(&commits, summary).column, 0);
    }
}

#[test]
fn a_stash_on_the_upstream_extension_tip_inlines_end_to_end() {
    let commits = rule_inputs::commits("stash-on-upstream-extension-tip");

    let stash = commits.iter().find(|c| c.is_stash).expect("no stash row");
    assert_eq!(
        (stash.column, stash.color_index),
        (0, 0),
        "the stash joins the lane its parent, the extension tip, already holds"
    );
    assert!(
        !has_fork_right(row(&commits, "up5")),
        "nothing branches out of the extension tip"
    );
}

/// (column, colour) for one row — the pair the rule file's dirty-path bullet demands.
fn place(commits: &[trunk_lib::git::types::GraphCommit], summary: &str) -> (usize, usize) {
    let c = row(commits, summary);

    (c.column, c.color_index)
}

/// The working tree outranks the tracked upstream for the HEAD lane. While it is dirty the
/// unpulled chain places like any other branch, so nothing sits between the WIP row and
/// HEAD's tip.
#[test]
fn a_dirty_worktree_outranks_the_upstream_for_the_head_lane() {
    let clean = rule_inputs::commits("behind-upstream");
    let dirty = rule_inputs::commits("behind-upstream-dirty");

    for summary in ["up5", "up4", "up3"] {
        assert_eq!(
            place(&clean, summary),
            (0, 0),
            "clean: {summary} shares the HEAD lane in HEAD's colour"
        );
    }
    assert_eq!(
        place(&clean, "base2"),
        (0, 0),
        "clean: the head tip owns lane 0"
    );

    let (ext_col, ext_color) = place(&dirty, "up5");
    assert!(
        ext_col >= 1,
        "dirty: the working tree owns lane 0, so the unpulled chain forks right, got column {ext_col}"
    );
    assert!(
        ext_color >= 1,
        "dirty: an outranked upstream loses HEAD's colour, got colour {ext_color}"
    );
    for summary in ["up4", "up3"] {
        assert_eq!(
            place(&dirty, summary),
            (ext_col, ext_color),
            "dirty: {summary} stays on the chain up5 opened"
        );
    }
    assert_eq!(
        place(&dirty, "base2"),
        (0, 0),
        "dirty: the head tip keeps lane 0 and HEAD's colour"
    );
}

/// The same for the revwalk tie-break arm: with no tracked upstream a local continuation holds
/// the lane while the worktree is clean, and forks right the moment the working tree wants it.
#[test]
fn a_dirty_worktree_outranks_the_tiebreak_continuation_for_the_head_lane() {
    let clean = rule_inputs::commits("non-upstream-continuation");
    let dirty = rule_inputs::commits("non-upstream-continuation-dirty");

    let (clean_col, clean_color) = place(&clean, "later1");
    assert_eq!(clean_col, 0, "clean: the continuation holds the HEAD lane");
    assert!(
        clean_color >= 1,
        "clean: a continuation that is not the tracked upstream holds it under its own colour, got colour {clean_color}"
    );
    assert_eq!(
        place(&clean, "base2"),
        (0, 0),
        "clean: the head tip owns lane 0"
    );

    let (dirty_col, dirty_color) = place(&dirty, "later1");
    assert!(
        dirty_col >= 1,
        "dirty: the working tree owns lane 0, so the continuation forks right, got column {dirty_col}"
    );
    assert!(
        dirty_color >= 1,
        "dirty: the continuation keeps a colour of its own, got colour {dirty_color}"
    );
    assert_eq!(
        place(&dirty, "base2"),
        (0, 0),
        "dirty: the head tip keeps lane 0 and HEAD's colour"
    );
}

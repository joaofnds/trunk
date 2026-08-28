//! Rebuild every repository a migrated placement test was captured from, capture it through
//! the production path, and compare against the committed input.
//!
//! A migrated test reads `tests/rule-inputs/<shape>.json` and never calls `capture()`, so
//! without this check the claim "the committed data is what the repository produces" would be
//! true only on the day it was captured. Ignored by default: rebuilding the repositories is
//! the cost the migration removes from the fast loop. `just graph-fidelity` runs it.

mod common;

use std::path::Path;

use common::context::TestContext;
use common::graph_shapes;
use common::rule_inputs;
use trunk_lib::commands::staging::get_dirty_counts_inner;
use trunk_lib::git::graph::capture;
use trunk_lib::git::graph_input::{CapturedGraph, FixtureInput};

/// Set by `just graph-capture`, never by an ordinary test recipe. An input that rewrites
/// itself as a side effect of running the suite pins nothing.
const UPDATE_VAR: &str = "TRUNK_CAPTURE_GRAPH_INPUTS";

const DRIFT_HINT: &str = "A captured input that no longer matches a fresh capture is a \
suspected defect, not a stale artifact. The tests reading it are pinned against data the \
repository no longer produces. Investigate first; re-capture with `just graph-capture` only \
once you know why it moved, and only at the user's explicit direction.";

/// A captured input's name, and the repository it is captured from.
type Shape = (&'static str, fn() -> TestContext);

/// Every repository shape a migrated placement test reads. Each builder is the one the
/// original repository-building test used, moved rather than rewritten — a rewritten shape is
/// a re-derivation of the repository, which is exactly what capturing exists to avoid.
fn shapes() -> Vec<Shape> {
    vec![
        ("linear-topology", linear_topology_repo),
        ("linear-300-commits", linear_300_commits_repo),
        ("backdated-stash", graph_shapes::backdated_stash_repo),
        ("branch-fork", graph_shapes::branch_fork_repo),
        ("criss-cross-merge", graph_shapes::criss_cross_merge_repo),
        ("freed-column-reuse", graph_shapes::freed_column_reuse_repo),
        ("merge-feature", graph_shapes::merge_feature_repo),
        ("orphan-stash", graph_shapes::orphan_stash_repo),
        ("stash-on-head-tip", graph_shapes::stash_on_head_tip_repo),
        (
            "stash-tip-clean",
            graph_shapes::stash_on_tip_with_ignore_repo,
        ),
        (
            "stash-tip-dirty-tracked",
            graph_shapes::stash_on_tip_dirty_tracked_repo,
        ),
        ("stash-tip-staged", graph_shapes::stash_on_tip_staged_repo),
        (
            "stash-tip-untracked",
            graph_shapes::stash_on_tip_untracked_repo,
        ),
        ("topic-below-clean", graph_shapes::topic_below_clean_repo),
        ("topic-below-dirty", graph_shapes::topic_below_dirty_repo),
        ("stash-on-mid-chain", graph_shapes::stash_on_mid_chain_repo),
        (
            "stash-under-extended-head-lane",
            graph_shapes::stash_under_extended_head_lane_repo,
        ),
        (
            "stash-with-topic-branch",
            graph_shapes::stash_with_topic_branch_repo,
        ),
        (
            "two-stashes-one-parent",
            graph_shapes::two_stashes_one_parent_repo,
        ),
        ("stash-on-stash", graph_shapes::stash_on_stash_repo),
        ("tagged-stash", graph_shapes::tagged_stash_repo),
        (
            "two-backdated-stashes",
            graph_shapes::two_backdated_stashes_repo,
        ),
        ("merge-two-parents", graph_shapes::merge_two_parents_repo),
        (
            "octopus-three-branches",
            graph_shapes::octopus_three_branches_repo,
        ),
        (
            "octopus-two-branches",
            graph_shapes::octopus_two_branches_repo,
        ),
        (
            "non-upstream-continuation",
            graph_shapes::non_upstream_continuation_repo,
        ),
        (
            "non-upstream-continuation-dirty",
            graph_shapes::non_upstream_continuation_dirty_repo,
        ),
        ("behind-upstream", graph_shapes::behind_upstream_repo),
        (
            "behind-upstream-dirty",
            graph_shapes::behind_upstream_dirty_repo,
        ),
    ]
}

fn linear_topology_repo() -> TestContext {
    TestContext::builder()
        .with_file("f0.txt", "f0")
        .with_commit("C0")
        .with_file("f1.txt", "f1")
        .with_commit("C1")
        .with_file("f2.txt", "f2")
        .with_commit("C2")
        .build()
}

fn linear_300_commits_repo() -> TestContext {
    let mut builder = TestContext::builder();
    for i in 0..300 {
        builder.with_file(&format!("file{}.txt", i), &format!("content {}", i));
        builder.with_commit(&format!("Commit {}", i));
    }
    builder.build()
}

fn update_requested() -> bool {
    std::env::var_os(UPDATE_VAR).is_some()
}

/// Everything `walk_commits` reads from `ctx`, rendered as the committed file. The wip count
/// is the one `RepoView.svelte` passes alongside the layout.
fn render(ctx: &TestContext) -> String {
    let counts = get_dirty_counts_inner(ctx.path(), ctx.state_map()).expect("count dirty files");
    let mut repo = ctx.repo();

    let input = FixtureInput {
        wip_count: counts.staged + counts.unstaged + counts.conflicted,
        capture: CapturedGraph::from_source(&capture(&mut repo).expect("capture repository")),
    };

    let mut json = serde_json::to_string_pretty(&input).expect("serialize fixture input");
    json.push('\n');
    json
}

fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().expect("input has a parent")).expect("create inputs dir");
    std::fs::write(path, contents).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

fn input_drift() -> Vec<String> {
    let mut drifted = Vec::new();

    for (name, build) in shapes() {
        let rendered = render(&build());
        let committed = rule_inputs::path(name);

        if update_requested() {
            write(&committed, &rendered);
            continue;
        }
        match std::fs::read_to_string(&committed) {
            Ok(found) if found == rendered => {}
            Ok(_) => drifted.push(format!("{name}: changed")),
            Err(_) => drifted.push(format!("{name}: nothing captured")),
        }
    }

    drifted
}

#[test]
#[ignore = "rebuilds every fixture repository; `just graph-fidelity` runs it"]
fn every_committed_input_matches_a_fresh_capture() {
    let drifted = input_drift();

    assert!(
        drifted.is_empty(),
        "{} captured input(s) no longer match a fresh capture:\n  {}\n\n{DRIFT_HINT}",
        drifted.len(),
        drifted.join("\n  "),
    );
}

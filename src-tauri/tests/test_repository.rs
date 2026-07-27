mod common;

use common::context::TestContext;
use trunk_lib::git::repository::{build_ref_map, has_unmerged_paths};
use trunk_lib::git::types::RefType;

#[test]
fn ref_map_head() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("feature.txt", "feature work")
        .with_commit("Feature commit")
        .checkout("main")
        .merge("feature")
        .build();

    let mut repo = ctx.repo();
    let map = build_ref_map(&mut repo);
    assert!(
        map.values().flatten().any(|r| r.is_head),
        "expected at least one ref with is_head == true"
    );
}

#[test]
fn ref_map_stash() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("feature.txt", "feature work")
        .with_commit("Feature commit")
        .checkout("main")
        .merge("feature")
        .with_stash(Some("test stash"))
        .build();

    let mut repo = ctx.repo();
    let map = build_ref_map(&mut repo);
    assert!(
        map.values()
            .flatten()
            .any(|r| matches!(r.ref_type, RefType::Stash)),
        "expected at least one RefLabel with ref_type == Stash"
    );
}

#[test]
fn detects_unmerged_paths_in_a_conflicted_worktree() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    assert!(has_unmerged_paths(&ctx.repo()).unwrap());
}

#[test]
fn reports_no_unmerged_paths_in_a_clean_worktree() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .build();

    assert!(!has_unmerged_paths(&ctx.repo()).unwrap());
}

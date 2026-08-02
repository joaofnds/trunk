//! Integration tests: Multi-step git workflow sequences
//! Per D-04, these compose existing Phase 53 drivers into realistic user flows.
//! Individual commands are already unit-tested; these verify correct composition.

mod common;
use common::context::TestContext;
use trunk_lib::commands::operation_state::MergeBeginResult;
use trunk_lib::git::types::OperationType;

// -- Workflow tests --

#[test]
fn workflow_edit_stage_commit_cycle() {
    let ctx = TestContext::builder()
        .with_file("README.md", "initial content")
        .with_commit("Initial commit")
        .build();

    // Edit the file
    std::fs::write(ctx.repo_path().join("README.md"), "updated content").unwrap();

    // Verify file appears in unstaged
    let status = ctx.get_status().unwrap();
    assert!(
        status.unstaged.iter().any(|f| f.path == "README.md"),
        "README.md should appear in unstaged after edit"
    );

    // Stage the file
    ctx.stage_file("README.md").unwrap();
    ctx.assert_file_staged("README.md");

    // Commit
    ctx.create_commit("Update readme", None).unwrap();
    ctx.assert_status_clean();
    ctx.assert_head_message("Update readme");
    ctx.assert_commit_count(2);
}

#[test]
fn workflow_branch_commit_merge() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Create and checkout feature branch
    ctx.create_branch("feature", None).unwrap();
    ctx.checkout_branch("feature").unwrap();
    ctx.assert_head_at("feature");

    // Write new file, stage, commit on feature
    std::fs::write(ctx.repo_path().join("feature.txt"), "feature work").unwrap();
    ctx.stage_file("feature.txt").unwrap();
    ctx.create_commit("Add feature file", None).unwrap();

    // Switch back to main and add a commit so branches diverge (forces real merge)
    ctx.checkout_branch("main").unwrap();
    std::fs::write(ctx.repo_path().join("main.txt"), "main work").unwrap();
    ctx.stage_file("main.txt").unwrap();
    ctx.create_commit("Add main file", None).unwrap();

    // Two-step merge: begin stages the clean non-ff merge, continue commits it.
    let message = match ctx.merge_branch_begin("feature").unwrap() {
        MergeBeginResult::Ready { message, .. } => message,
        other => panic!("expected Ready for a clean non-ff merge, got {:?}", other),
    };
    ctx.merge_continue(Some(&message)).unwrap();

    // Verify: feature file exists on main
    ctx.assert_file_content("feature.txt", "feature work");
    ctx.assert_head_at("main");
    // initial + main commit + feature commit + merge commit = 4
    ctx.assert_commit_count(4);
}

#[test]
fn workflow_stash_save_checkout_pop() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "original content")
        .with_commit("Initial commit")
        .with_branch("feature")
        .build();

    // Modify tracked file
    std::fs::write(ctx.repo_path().join("README.md"), "modified content").unwrap();

    // Stash the changes
    ctx.stash_save("work in progress").unwrap();
    ctx.assert_status_clean();

    // Switch to feature and back
    ctx.checkout_branch("feature").unwrap();
    ctx.assert_head_at("feature");
    ctx.checkout_branch("main").unwrap();
    ctx.assert_head_at("main");

    // Pop the stash
    ctx.stash_pop(&ctx.top_stash_oid()).unwrap();

    // Verify: file has modified content and stash list is empty
    ctx.assert_file_content("README.md", "modified content");
    let stashes = ctx.list_stashes().unwrap();
    assert!(stashes.is_empty(), "stash list should be empty after pop");
}

#[test]
fn workflow_cherry_pick_from_branch() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .build();

    // Checkout feature, create new file, commit
    ctx.checkout_branch("feature").unwrap();
    std::fs::write(ctx.repo_path().join("cherry.txt"), "cherry content").unwrap();
    ctx.stage_file("cherry.txt").unwrap();
    ctx.create_commit("Add cherry file", None).unwrap();

    // Get the feature commit OID
    let oid = ctx.resolve_ref("feature").unwrap();

    // Switch back to main
    ctx.checkout_branch("main").unwrap();
    ctx.assert_head_at("main");

    // Cherry-pick the feature commit
    let result = ctx.cherry_pick(&oid);
    assert!(
        result.is_ok(),
        "cherry_pick should succeed: {:?}",
        result.err()
    );

    // Verify: cherry-picked file exists on main
    ctx.assert_file_content("cherry.txt", "cherry content");
    ctx.assert_head_at("main");
    // initial + cherry-picked = 2 (no merge commit)
    ctx.assert_commit_count(2);
}

#[test]
fn workflow_tag_and_branch_management() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_branch("temp")
        .build();

    // Get HEAD oid for tagging
    let oid = ctx.resolve_ref("main").unwrap();

    // Create tag
    ctx.create_tag(&oid, "v1.0", "Release v1.0").unwrap();
    ctx.assert_tag_exists("v1.0");

    // Delete branch
    ctx.delete_branch("temp").unwrap();
    ctx.assert_branch_not_exists("temp");

    // Verify refs
    let refs = ctx.list_refs().unwrap();
    assert!(
        refs.tags.iter().any(|t| t.short_name == "v1.0"),
        "tags should contain v1.0"
    );
    assert!(
        !refs.local.iter().any(|b| b.name == "temp"),
        "branches should not contain temp"
    );

    // Delete tag and verify
    ctx.delete_tag("v1.0").unwrap();
    let refs = ctx.list_refs().unwrap();
    assert!(
        !refs.tags.iter().any(|t| t.short_name == "v1.0"),
        "tags should not contain v1.0 after deletion"
    );
}

#[test]
fn workflow_undo_redo_commit() {
    let ctx = TestContext::builder()
        .with_file("README.md", "first")
        .with_commit("First")
        .with_file("README.md", "second")
        .with_commit("Second")
        .build();

    // Verify undo is available
    assert!(
        ctx.check_undo_available().unwrap(),
        "undo should be available with 2 commits"
    );

    // Undo the last commit
    let undo_result = ctx.undo_commit().unwrap();
    ctx.assert_head_message("First");
    assert_eq!(undo_result.subject, "Second");

    // Redo the undone commit
    ctx.redo_commit(&undo_result.subject, undo_result.body.as_deref())
        .unwrap();
    ctx.assert_head_message("Second");
}

#[test]
fn workflow_diff_staging_cycle() {
    let ctx = TestContext::builder()
        .with_file("code.txt", "line1\nline2\n")
        .with_commit("Initial commit")
        .build();

    // Modify the file
    std::fs::write(ctx.repo_path().join("code.txt"), "line1\nline2\nline3\n").unwrap();

    // Check unstaged diff has the addition
    let unstaged_diff = ctx.diff_unstaged("code.txt").unwrap();
    assert_eq!(unstaged_diff.len(), 1, "should have 1 file diff");
    assert!(
        !unstaged_diff[0].hunks.is_empty(),
        "should have at least 1 hunk"
    );

    // Stage the file
    ctx.stage_file("code.txt").unwrap();

    // Staged diff should show the same change
    let staged_diff = ctx.diff_staged("code.txt").unwrap();
    assert_eq!(staged_diff.len(), 1, "should have 1 staged file diff");
    assert!(
        !staged_diff[0].hunks.is_empty(),
        "staged diff should have at least 1 hunk"
    );

    // Unstaged diff should be empty now
    let unstaged_after = ctx.diff_unstaged("code.txt").unwrap();
    assert!(
        unstaged_after.is_empty() || unstaged_after[0].hunks.is_empty(),
        "unstaged diff should be empty after staging"
    );

    // Unstage the file
    ctx.unstage_file("code.txt").unwrap();

    // Unstaged diff should be back
    let unstaged_restored = ctx.diff_unstaged("code.txt").unwrap();
    assert_eq!(
        unstaged_restored.len(),
        1,
        "should have 1 file diff after unstaging"
    );
    assert!(
        !unstaged_restored[0].hunks.is_empty(),
        "unstaged diff should have hunks after unstaging"
    );
}

#[test]
fn workflow_search_commit_history() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "init")
        .with_commit("Initial setup")
        .with_file("feature.txt", "feature")
        .with_commit("Add feature X")
        .with_file("bugfix.txt", "fix")
        .with_commit("Fix bug in Y")
        .build();

    // Populate the cache before searching
    ctx.populate_cache();

    // Search for "feature"
    let results = ctx.search_commits("feature").unwrap();
    assert_eq!(results.len(), 1, "should find 1 commit matching 'feature'");

    // Search for "bug"
    let results = ctx.search_commits("bug").unwrap();
    assert_eq!(results.len(), 1, "should find 1 commit matching 'bug'");

    // Search for author "Test User" (all commits should match)
    let results = ctx.search_commits("Test User").unwrap();
    assert_eq!(
        results.len(),
        3,
        "should find 3 commits matching author 'Test User'"
    );
}

// -- State transition tests --

#[test]
fn state_transition_merge_conflict_resolve_commit() {
    // Use with_conflict builder to set up the conflicted merge state directly.
    let ctx = TestContext::builder()
        .with_file("shared.txt", "original content")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("shared.txt", "feature change")
        .with_commit("Feature change")
        .checkout("main")
        .with_file("shared.txt", "main change")
        .with_commit("Main change")
        .with_conflict("feature")
        .build();

    // Write MERGE_MSG manually (libgit2 merge does not create it; git CLI does)
    let repo = ctx.repo();
    std::fs::write(repo.path().join("MERGE_MSG"), "Merge branch 'feature'\n").unwrap();
    drop(repo);

    // State: Merge in progress
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::Merge),
        "expected Merge, got {:?}",
        info.op_type
    );

    // Resolve the conflict
    std::fs::write(ctx.repo_path().join("shared.txt"), "resolved content").unwrap();
    ctx.stage_file("shared.txt").unwrap();

    // Continue the merge
    ctx.merge_continue(Some("Merge commit")).unwrap();

    // State: back to None
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::None),
        "expected None after merge continue, got {:?}",
        info.op_type
    );
    ctx.assert_status_clean();
}

#[test]
fn state_transition_merge_conflict_abort() {
    let ctx = TestContext::builder()
        .with_file("shared.txt", "original content")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("shared.txt", "feature change")
        .with_commit("Feature change")
        .checkout("main")
        .with_file("shared.txt", "main change")
        .with_commit("Main change")
        .with_conflict("feature")
        .build();

    // State: Merge in progress
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::Merge),
        "expected Merge, got {:?}",
        info.op_type
    );

    // Abort the merge
    ctx.merge_abort().unwrap();

    // State: back to None
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::None),
        "expected None after merge abort, got {:?}",
        info.op_type
    );

    // HEAD is still at main, working tree reflects main's content
    ctx.assert_head_at("main");
    ctx.assert_file_content("shared.txt", "main change");
}

#[test]
fn state_transition_rebase_conflict_skip() {
    // Build divergent fixture with feature checked out for rebase
    let ctx = TestContext::builder()
        .with_file("shared.txt", "original content")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("shared.txt", "feature change")
        .with_commit("Feature change")
        .checkout("main")
        .with_file("shared.txt", "main change")
        .with_commit("Main change")
        .checkout("feature")
        .build();

    // Initial state: no operation
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::None),
        "expected None, got {:?}",
        info.op_type
    );

    // Rebase feature onto main -> conflicts
    let result = ctx.rebase_branch("main");
    assert!(
        result.is_ok(),
        "rebase_branch should return Ok even on conflict"
    );

    // State: Rebase in progress
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::Rebase),
        "expected Rebase, got {:?}",
        info.op_type
    );

    // Skip the conflicting commit
    ctx.rebase_skip().unwrap();

    // State: back to None (rebase complete after skip)
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::None),
        "expected None after rebase skip, got {:?}",
        info.op_type
    );
}

#[test]
fn state_transition_rebase_conflict_abort() {
    let ctx = TestContext::builder()
        .with_file("shared.txt", "original content")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("shared.txt", "feature change")
        .with_commit("Feature change")
        .checkout("main")
        .with_file("shared.txt", "main change")
        .with_commit("Main change")
        .checkout("feature")
        .build();

    // Rebase feature onto main -> conflicts
    ctx.rebase_branch("main").unwrap();

    // State: Rebase in progress
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::Rebase),
        "expected Rebase, got {:?}",
        info.op_type
    );

    // Abort the rebase
    ctx.rebase_abort().unwrap();

    // State: back to None
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::None),
        "expected None after rebase abort, got {:?}",
        info.op_type
    );
}

#[test]
fn state_transition_cherry_pick_conflict() {
    let ctx = TestContext::builder()
        .with_file("shared.txt", "original content")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("shared.txt", "feature change")
        .with_commit("Feature change")
        .checkout("main")
        .with_file("shared.txt", "main change")
        .with_commit("Main change")
        .build();

    // Get the feature commit OID (the one that modifies shared.txt)
    let oid = ctx.resolve_ref("feature").unwrap();

    // Cherry-pick the conflicting commit onto main
    let result = ctx.cherry_pick(&oid);
    // Cherry-pick with conflict may return error or Ok depending on implementation
    // The key is checking the operation state
    let _ = result;

    // State: CherryPick in progress
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::CherryPick),
        "expected CherryPick, got {:?}",
        info.op_type
    );
}

#[test]
fn state_transition_fast_forward_merge() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .build();

    // Add commits only on feature (main stays behind)
    ctx.checkout_branch("feature").unwrap();
    std::fs::write(ctx.repo_path().join("feature.txt"), "feature work").unwrap();
    ctx.stage_file("feature.txt").unwrap();
    ctx.create_commit("Feature commit", None).unwrap();

    // Switch back to main
    ctx.checkout_branch("main").unwrap();

    // State before merge: None
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::None),
        "expected None before ff merge, got {:?}",
        info.op_type
    );

    // Fast-forward merge (no divergence) -> FastForwarded, no editor.
    let result = ctx.merge_branch_begin("feature").unwrap();
    assert!(
        matches!(result, MergeBeginResult::FastForwarded { .. }),
        "expected FastForwarded, got {:?}",
        result
    );

    // State after merge: still None (no merge state for ff)
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::None),
        "expected None after ff merge, got {:?}",
        info.op_type
    );

    // Verify main has the feature commits
    ctx.assert_file_content("feature.txt", "feature work");
    ctx.assert_commit_count(2);
}

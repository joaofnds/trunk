mod common;

use common::context::TestContext;

/// Build a context with two commits for checkout/cherry-pick/revert/reset tests.
/// Returns (ctx, first_oid, second_oid).
fn build_two_commit_ctx() -> (TestContext, String, String) {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_file("second.txt", "world")
        .with_commit("Second commit")
        .build();

    let repo = ctx.repo();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let second_oid = head.id().to_string();
    let first_oid = head.parent(0).unwrap().id().to_string();

    (ctx, first_oid, second_oid)
}

// --- checkout_commit tests ---

#[test]
fn checkout_commit_detaches_head() {
    let (ctx, first_oid, _second_oid) = build_two_commit_ctx();

    let result = ctx.checkout_commit(&first_oid);
    assert!(
        result.is_ok(),
        "checkout_commit should succeed on clean workdir"
    );

    let repo = ctx.repo();
    assert!(repo.head_detached().unwrap(), "HEAD should be detached");
    assert_eq!(
        repo.head().unwrap().target().unwrap().to_string(),
        first_oid,
        "HEAD should point to the first commit"
    );
}

#[test]
fn checkout_commit_dirty_workdir_fails() {
    let (ctx, first_oid, _second_oid) = build_two_commit_ctx();

    // Make workdir dirty
    std::fs::write(ctx.repo_path().join("file.txt"), "modified").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
    }

    let result = ctx.checkout_commit(&first_oid);
    assert!(
        result.is_err(),
        "checkout_commit should fail on dirty workdir"
    );
    assert_eq!(result.unwrap_err().code, "dirty_workdir");
}

// --- create_tag tests ---

#[test]
fn create_tag_annotated() {
    let (ctx, _first_oid, second_oid) = build_two_commit_ctx();

    let result = ctx.create_tag(&second_oid, "v1.0.0", "Release 1.0");
    assert!(result.is_ok(), "create_tag should succeed");

    ctx.assert_tag_exists("v1.0.0");
}

#[test]
fn create_tag_empty_message_uses_name() {
    let (ctx, _first_oid, second_oid) = build_two_commit_ctx();

    let result = ctx.create_tag(&second_oid, "v2.0.0", "");
    assert!(
        result.is_ok(),
        "create_tag with empty message should succeed"
    );

    let repo = ctx.repo();
    let tag_ref = repo.find_reference("refs/tags/v2.0.0").unwrap();
    let tag_obj = tag_ref.peel_to_tag().unwrap();
    assert_eq!(tag_obj.message().unwrap().unwrap(), "v2.0.0");
}

#[test]
fn create_tag_duplicate_fails() {
    let (ctx, _first_oid, second_oid) = build_two_commit_ctx();

    ctx.create_tag(&second_oid, "v1.0.0", "first").unwrap();
    let result = ctx.create_tag(&second_oid, "v1.0.0", "second");
    assert!(result.is_err(), "duplicate tag should fail");
    assert_eq!(result.unwrap_err().code, "git_error");
}

// --- delete_tag tests ---

#[test]
fn delete_tag_removes_ref() {
    let (ctx, _first_oid, second_oid) = build_two_commit_ctx();

    ctx.create_tag(&second_oid, "v-del", "to delete").unwrap();
    ctx.assert_tag_exists("v-del");

    let result = ctx.delete_tag("v-del");
    assert!(
        result.is_ok(),
        "delete_tag should succeed: {:?}",
        result.err()
    );

    let repo = ctx.repo();
    assert!(
        repo.find_reference("refs/tags/v-del").is_err(),
        "tag v-del should no longer exist"
    );
}

// --- cherry_pick tests ---

#[test]
fn cherry_pick_applies_commit() {
    let (ctx, _first_oid, second_oid) = build_two_commit_ctx();

    // Create a branch from the first commit, then cherry-pick the second
    {
        let repo = ctx.repo();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let parent = head.parent(0).unwrap();
        repo.branch("pick-branch", &parent, false).unwrap();
        repo.set_head("refs/heads/pick-branch").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
            .unwrap();
    }

    let result = ctx.cherry_pick(&second_oid);
    assert!(
        result.is_ok(),
        "cherry_pick should succeed: {:?}",
        result.err()
    );
}

// --- undo_commit tests ---

#[test]
fn undo_commit_captures_message() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_file("second.txt", "content")
        .with_commit("Undo test subject\n\nUndo test body")
        .build();

    let result = ctx.undo_commit();
    assert!(
        result.is_ok(),
        "undo_commit should succeed: {:?}",
        result.err()
    );
    let undo = result.unwrap();
    assert_eq!(undo.subject, "Undo test subject");
    assert_eq!(undo.body, Some("Undo test body".to_owned()));

    // Verify HEAD moved back to initial commit
    ctx.assert_head_message("Initial commit");
}

#[test]
fn undo_initial_commit_fails() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .build();

    let result = ctx.undo_commit();
    assert!(result.is_err(), "undo on initial commit should fail");
    assert_eq!(result.unwrap_err().code, "nothing_to_undo");
}

#[test]
fn undo_merge_commit_fails() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("feature.txt", "feature change")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("main.txt", "main change")
        .with_commit("Main commit")
        .merge("feature")
        .build();

    let result = ctx.undo_commit();
    assert!(result.is_err(), "undo on merge commit should fail");
    assert_eq!(result.unwrap_err().code, "merge_commit");
}

// --- revert (two-step begin/continue/abort) tests ---

#[test]
fn revert_commit_begin_stages_removal_and_carries_default_message() {
    let (ctx, _first_oid, second_oid) = build_two_commit_ctx();

    let result = ctx.revert_commit_begin(&second_oid);
    let begin = result.expect("clean revert begin should succeed");

    // The default message git wrote to MERGE_MSG, including the full OID.
    let message = begin.message.expect("clean revert carries a message");
    assert!(
        message.starts_with("Revert \"Second commit\""),
        "got: {message:?}"
    );
    assert!(
        message.contains(&format!("This reverts commit {}.", second_oid)),
        "message must carry the full 40-char OID; got: {message:?}"
    );
    // begin stages the revert without committing: REVERT_HEAD set, file gone.
    assert!(
        ctx.repo_path().join(".git").join("REVERT_HEAD").exists(),
        "begin sets REVERT_HEAD (not committed yet)"
    );
    assert!(
        !ctx.repo_path().join("second.txt").exists(),
        "second.txt should be removed by the staged revert"
    );
}

#[test]
fn revert_continue_commits_and_clears_revert_head() {
    let (ctx, _first_oid, second_oid) = build_two_commit_ctx();
    ctx.revert_commit_begin(&second_oid)
        .expect("begin should succeed");

    ctx.revert_continue("Revert \"Second commit\"\n\nedited")
        .expect("continue should succeed");

    assert!(
        !ctx.repo_path().join(".git").join("REVERT_HEAD").exists(),
        "git commit -m clears REVERT_HEAD"
    );
    assert!(
        !ctx.repo_path().join("second.txt").exists(),
        "second.txt stays removed after the revert is committed"
    );
}

#[test]
fn revert_abort_restores_the_reverted_file() {
    let (ctx, _first_oid, second_oid) = build_two_commit_ctx();
    ctx.revert_commit_begin(&second_oid)
        .expect("begin should succeed");

    ctx.revert_abort().expect("abort should succeed");

    assert!(
        !ctx.repo_path().join(".git").join("REVERT_HEAD").exists(),
        "revert --abort clears REVERT_HEAD"
    );
    assert!(
        ctx.repo_path().join("second.txt").exists(),
        "revert --abort restores the staged removal"
    );
}

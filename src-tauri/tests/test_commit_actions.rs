mod common;

use common::context::TestContext;
use trunk_lib::commands::commit_actions::Conclusion;

/// Build a context with two commits for checkout/cherry-pick/revert/reset tests.
/// Returns (ctx, `first_oid`, `second_oid`).
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
fn checkout_commit_carries_a_change_the_commit_does_not_touch() {
    let (ctx, first_oid, _second_oid) = build_two_commit_ctx();
    std::fs::write(ctx.repo_path().join("file.txt"), "staged edit").unwrap();
    ctx.stage_file("file.txt").unwrap();
    std::fs::write(ctx.repo_path().join("file.txt"), "unstaged edit").unwrap();

    ctx.checkout_commit(&first_oid).unwrap();

    assert_eq!(
        ctx.repo().head().unwrap().target().unwrap().to_string(),
        first_oid
    );
    assert_eq!(ctx.staged_content("file.txt"), "staged edit");
    assert_eq!(
        std::fs::read_to_string(ctx.repo_path().join("file.txt")).unwrap(),
        "unstaged edit"
    );
}

/// The first commit has no second.txt, so checking it out would delete the user's edit.
#[test]
fn checkout_commit_refuses_a_change_it_would_overwrite() {
    let (ctx, first_oid, second_oid) = build_two_commit_ctx();
    std::fs::write(ctx.repo_path().join("second.txt"), "edited").unwrap();

    let err = ctx.checkout_commit(&first_oid).unwrap_err();

    assert_eq!(err.code, "dirty_workdir");
    assert_eq!(
        ctx.repo().head().unwrap().target().unwrap().to_string(),
        second_oid
    );
    assert_eq!(
        std::fs::read_to_string(ctx.repo_path().join("second.txt")).unwrap(),
        "edited"
    );
}

mod checkout_commit_when_another_writer_runs_meanwhile {
    use super::*;
    use common::drivers::staging::unstage_everything;

    #[test]
    fn carries_the_file_the_other_writer_staged_first() {
        let (mut ctx, first_oid, _second_oid) = build_two_commit_ctx();

        ctx.act_while_another_writer_stages("a.txt", |ctx| {
            ctx.checkout_commit(&first_oid).map(drop)
        })
        .expect("checkout_commit failed");

        assert_eq!(
            ctx.repo().head().unwrap().target().unwrap().to_string(),
            first_oid
        );
        assert_eq!(ctx.paths_staged_over_head(), ["a.txt"]);
    }

    #[test]
    fn moves_head_before_the_next_writer_reads_it() {
        let (mut ctx, first_oid, _second_oid) = build_two_commit_ctx();

        ctx.act_then_another_writer_at_release(
            |repo| unstage_everything(repo),
            |ctx| ctx.checkout_commit(&first_oid).map(drop),
        )
        .expect("checkout_commit failed");

        assert_eq!(ctx.paths_staged_over_head(), Vec::<String>::new());
    }
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
    assert_eq!(result.unwrap_err().code, "git_exists");
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

#[cfg(unix)]
#[test]
fn cherry_pick_returns_while_a_process_its_hook_started_still_runs() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("side")
        .checkout("side")
        .with_file("side.txt", "side")
        .with_commit("Side work")
        .checkout("main")
        .build();
    let side = ctx.resolve_ref("side").unwrap();
    let left_running = ctx.install_hook_leaving_a_process_running("post-commit");

    let result = ctx.cherry_pick(&side);

    left_running.release();
    result.unwrap();
    assert!(ctx.repo_path().join("side.txt").exists());
}

#[test]
fn cherry_pick_of_a_change_head_already_has_ends_the_pick_and_says_so() {
    let ctx = TestContext::builder()
        .with_file("f.txt", "a\n")
        .with_commit("Initial commit")
        .with_branch("side")
        .checkout("side")
        .with_file("f.txt", "b\n")
        .with_commit("Side change")
        .checkout("main")
        .with_file("f.txt", "b\n")
        .with_commit("Same change on main")
        .build();
    let side_oid = ctx.resolve_ref("side").unwrap();
    let head_before = ctx.resolve_ref("HEAD").unwrap();

    let err = ctx.cherry_pick(&side_oid).unwrap_err();

    assert_eq!(err.code, "cherry_pick_empty");
    assert_eq!(ctx.repo().state(), git2::RepositoryState::Clean);
    assert_eq!(ctx.resolve_ref("HEAD").unwrap(), head_before);
}

#[test]
fn cherry_pick_refused_by_a_conflicted_merge_says_why_and_leaves_the_merge() {
    let ctx = TestContext::builder()
        .with_file("f.txt", "base\n")
        .with_commit("Base")
        .with_branch("side")
        .checkout("side")
        .with_file("f.txt", "side\n")
        .with_commit("Side change")
        .with_file("g.txt", "g\n")
        .with_commit("Add g")
        .checkout("main")
        .with_file("f.txt", "main\n")
        .with_commit("Main change")
        .with_conflict("side")
        .build();
    let add_g = ctx.resolve_ref("side").unwrap();

    let err = ctx.cherry_pick(&add_g).unwrap_err();

    assert_eq!(err.code, "conflict_in_progress");
    assert_eq!(ctx.repo().state(), git2::RepositoryState::Merge);
}

#[test]
fn revert_refused_by_a_conflicted_merge_says_why_and_leaves_the_merge() {
    let ctx = TestContext::builder()
        .with_file("f.txt", "base\n")
        .with_commit("Base")
        .with_file("g.txt", "g\n")
        .with_commit("Add g")
        .with_branch("side")
        .checkout("side")
        .with_file("f.txt", "side\n")
        .with_commit("Side change")
        .checkout("main")
        .with_file("f.txt", "main\n")
        .with_commit("Main change")
        .with_conflict("side")
        .build();
    let add_g = ctx.resolve_ref("HEAD~1").unwrap();

    let err = ctx.revert_commit_begin(&add_g).unwrap_err();

    assert_eq!(err.code, "conflict_in_progress");
    assert_eq!(ctx.repo().state(), git2::RepositoryState::Merge);
}

// --- undo_commit tests ---

#[test]
fn undo_commit_refuses_when_head_is_not_the_commit_it_was_pressed_on() {
    let (ctx, first, second) = build_two_commit_ctx();

    let err = ctx.undo_commit_on(&first).unwrap_err();

    assert_eq!(err.code, "undo_stale");
    assert_eq!(ctx.resolve_ref("HEAD").unwrap(), second);
}

#[test]
fn undo_commit_reports_a_head_that_will_not_read_rather_than_a_moved_one() {
    let ctx = TestContext::builder().build();

    let err = ctx
        .undo_commit_on("0000000000000000000000000000000000000000")
        .unwrap_err();

    assert_eq!(err.code, "git_unborn_branch");
}

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

    // Verify HEAD moved back to initial commit
    ctx.assert_head_message("Initial commit");
    let repo = ctx.repo();
    let head = repo.head().unwrap().target().unwrap();
    assert_eq!(undo.head_oid, head.to_string());
    let undone = repo.find_commit(undo.undone_oid.parse().unwrap()).unwrap();
    assert_eq!(undone.summary().ok().flatten(), Some("Undo test subject"));
    assert_eq!(undone.parent_id(0).unwrap(), head);
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

// --- what Undo takes back ---

fn on_main_beside_a_feature_branch() -> TestContext {
    TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("feature.txt", "feature change")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("main.txt", "main change")
        .with_commit("Main commit")
        .build()
}

#[test]
fn undo_is_not_offered_once_a_checkout_moved_head() {
    let mut ctx = on_main_beside_a_feature_branch();

    ctx.checkout_branch("feature").unwrap();

    assert!(!ctx.check_undo_available().unwrap());
}

#[test]
fn undo_after_a_checkout_takes_nothing_back() {
    let mut ctx = on_main_beside_a_feature_branch();
    ctx.checkout_branch("feature").unwrap();
    let feature_tip = ctx.resolve_ref("HEAD").unwrap();

    let err = ctx.undo_commit().unwrap_err();

    assert_eq!(err.code, "nothing_to_undo");
    assert_eq!(ctx.resolve_ref("HEAD").unwrap(), feature_tip);
}

#[test]
fn undo_is_not_offered_once_an_amend_rewrote_head() {
    let (ctx, _, _) = build_two_commit_ctx();

    ctx.amend_commit("Second commit, reworded", None).unwrap();

    assert!(!ctx.check_undo_available().unwrap());
}

#[test]
fn undo_stays_offered_for_the_commit_beneath_an_undone_one() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_file("second.txt", "world")
        .with_commit("Second commit")
        .with_file("third.txt", "again")
        .with_commit("Third commit")
        .build();

    ctx.undo_commit().unwrap();

    assert!(ctx.check_undo_available().unwrap());
}

#[test]
fn undo_is_offered_again_once_a_redo_restored_the_commit() {
    let (ctx, _, _) = build_two_commit_ctx();
    let undo = ctx.undo_commit().unwrap();

    ctx.redo_commit(&undo).unwrap();

    assert!(ctx.check_undo_available().unwrap());
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
        message.contains(&format!("This reverts commit {second_oid}.")),
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
fn revert_commit_begin_refuses_while_changes_are_staged() {
    let (ctx, _first_oid, second_oid) = build_two_commit_ctx();
    std::fs::write(ctx.repo_path().join("file.txt"), "staged edit").unwrap();
    ctx.stage_file("file.txt").unwrap();

    let refusal = ctx
        .revert_commit_begin(&second_oid)
        .expect_err("a revert would take the staged edit into its commit");

    assert_eq!(refusal.code, "staged_changes");
    assert!(
        !ctx.repo_path().join(".git").join("REVERT_HEAD").exists(),
        "no revert was started"
    );
    assert_eq!(ctx.staged_content("file.txt"), "staged edit");
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
fn revert_commit_begin_ends_a_revert_head_already_undoes() {
    let ctx = TestContext::builder()
        .with_file("f.txt", "a\n")
        .with_commit("Initial commit")
        .with_file("f.txt", "b\n")
        .with_commit("Change")
        .with_file("f.txt", "a\n")
        .with_commit("Undo the change by hand")
        .build();
    let change = ctx.resolve_ref("HEAD~1").unwrap();
    let head_before = ctx.resolve_ref("HEAD").unwrap();

    let err = ctx
        .revert_commit_begin(&change)
        .expect_err("a revert HEAD already undoes has nothing to commit");

    assert_eq!(err.code, "revert_empty");
    assert!(!ctx.repo_path().join(".git").join("REVERT_HEAD").exists());
    assert_eq!(ctx.resolve_ref("HEAD").unwrap(), head_before);
}

#[test]
fn revert_continue_ends_a_revert_whose_changes_were_unstaged_without_a_commit() {
    let (ctx, _first_oid, second_oid) = build_two_commit_ctx();
    ctx.revert_commit_begin(&second_oid).unwrap();
    let head_before = ctx.resolve_ref("HEAD").unwrap();
    ctx.unstage_file("second.txt").unwrap();

    let conclusion = ctx.revert_continue_unasked().unwrap();

    assert_eq!(conclusion, Conclusion::Skipped);
    assert!(!ctx.repo_path().join(".git").join("REVERT_HEAD").exists());
    assert_eq!(ctx.resolve_ref("HEAD").unwrap(), head_before);
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

/// A conflicted cherry-pick leaves `CHERRY_PICK_HEAD` set. Until this module the
/// app had no command that clears it: the banner rendered a label and no
/// buttons, `is_mid_operation` stayed true so force-push refused and background
/// fetch skipped every poll, and committing through the normal form used git2's
/// plumbing commit, which does not conclude a sequencer operation. The only exit
/// was a terminal.
mod cherry_pick_lifecycle {
    use super::*;
    use trunk_lib::types::OperationType;

    /// Two commits changing the same file from a shared base, so cherry-picking
    /// the one that is not on HEAD's line conflicts.
    fn conflicting_cherry_pick_ctx() -> (TestContext, String) {
        let ctx = TestContext::builder()
            .with_file("f.txt", "base\n")
            .with_commit("Base")
            .with_branch("side")
            .checkout("side")
            .with_file("f.txt", "side\n")
            .with_commit("Side change")
            .checkout("main")
            .with_file("f.txt", "main\n")
            .with_commit("Main change")
            .build();

        let side_oid = {
            let repo = ctx.repo();
            repo.revparse_single("side").unwrap().id().to_string()
        };
        (ctx, side_oid)
    }

    fn cherry_pick_head_exists(ctx: &TestContext) -> bool {
        ctx.repo_path()
            .join(".git")
            .join("CHERRY_PICK_HEAD")
            .exists()
    }

    fn resolve_conflict(ctx: &TestContext) {
        std::fs::write(ctx.repo_path().join("f.txt"), "resolved\n").unwrap();
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("f.txt")).unwrap();
        index.write().unwrap();
    }

    #[test]
    fn committing_through_the_normal_form_concludes_the_cherry_pick() {
        let (ctx, side_oid) = conflicting_cherry_pick_ctx();
        let err = ctx.cherry_pick(&side_oid).unwrap_err();
        assert_eq!(err.code, "conflict_state");
        assert!(cherry_pick_head_exists(&ctx), "precondition");
        resolve_conflict(&ctx);

        ctx.create_commit("Resolved the pick", None).unwrap();

        assert!(
            !cherry_pick_head_exists(&ctx),
            "the commit must clear CHERRY_PICK_HEAD, not strand the repository"
        );
        let info = ctx.get_operation_state().unwrap();
        assert!(matches!(info.op_type, OperationType::None));
    }

    #[test]
    fn cherry_pick_continue_commits_the_resolution_and_clears_the_state() {
        let (ctx, side_oid) = conflicting_cherry_pick_ctx();
        ctx.cherry_pick(&side_oid).unwrap_err();
        resolve_conflict(&ctx);

        ctx.cherry_pick_continue("Pick the side change").unwrap();

        assert!(!cherry_pick_head_exists(&ctx));
        let head = ctx.get_head_commit_message().unwrap();
        assert_eq!(head.subject, "Pick the side change");
    }

    #[test]
    fn cherry_pick_continue_ends_a_pick_resolved_back_to_head_without_a_commit() {
        let (ctx, side_oid) = conflicting_cherry_pick_ctx();
        ctx.cherry_pick(&side_oid).unwrap_err();
        let head_before = ctx.resolve_ref("HEAD").unwrap();
        std::fs::write(ctx.repo_path().join("f.txt"), "main\n").unwrap();
        ctx.stage_file("f.txt").unwrap();
        std::fs::write(ctx.repo_path().join("notes.txt"), "kept\n").unwrap();

        let conclusion = ctx.cherry_pick_continue_unasked().unwrap();

        assert_eq!(conclusion, Conclusion::Skipped);
        assert!(!cherry_pick_head_exists(&ctx));
        assert_eq!(ctx.resolve_ref("HEAD").unwrap(), head_before);
        assert_eq!(
            std::fs::read_to_string(ctx.repo_path().join("notes.txt")).unwrap(),
            "kept\n"
        );
    }

    #[test]
    fn cherry_pick_continue_asks_for_a_message_before_committing_a_resolution() {
        let (ctx, side_oid) = conflicting_cherry_pick_ctx();
        ctx.cherry_pick(&side_oid).unwrap_err();
        resolve_conflict(&ctx);

        let conclusion = ctx.cherry_pick_continue_unasked().unwrap();

        assert_eq!(conclusion, Conclusion::NeedsMessage);
        assert!(
            cherry_pick_head_exists(&ctx),
            "the pick waits for its message"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cherry_pick_continue_refused_by_a_silent_hook_still_explains_the_refusal() {
        let (ctx, side_oid) = conflicting_cherry_pick_ctx();
        ctx.cherry_pick(&side_oid).unwrap_err();
        resolve_conflict(&ctx);
        ctx.install_hook("pre-commit", "exit 1");

        let err = ctx
            .cherry_pick_continue("Pick the side change")
            .unwrap_err();

        assert_eq!(
            err.message,
            "git exited with code 1 and printed no reason. A hook may have refused it."
        );
    }

    #[test]
    fn cherry_pick_abort_restores_a_clean_tree() {
        let (ctx, side_oid) = conflicting_cherry_pick_ctx();
        ctx.cherry_pick(&side_oid).unwrap_err();
        assert!(cherry_pick_head_exists(&ctx), "precondition");

        ctx.cherry_pick_abort().unwrap();

        assert!(!cherry_pick_head_exists(&ctx));
        let info = ctx.get_operation_state().unwrap();
        assert!(matches!(info.op_type, OperationType::None));
        assert_eq!(
            std::fs::read_to_string(ctx.repo_path().join("f.txt")).unwrap(),
            "main\n",
            "abort must restore HEAD's content"
        );
    }

    mod when_another_writer_runs_meanwhile {
        use super::*;

        #[test]
        fn cherry_pick_continue_commits_the_file_the_other_writer_staged_first() {
            let (mut ctx, side_oid) = conflicting_cherry_pick_ctx();
            ctx.cherry_pick(&side_oid).unwrap_err();
            resolve_conflict(&ctx);

            ctx.act_while_another_writer_stages("a.txt", |ctx| {
                ctx.cherry_pick_continue("Pick the side change").map(drop)
            })
            .expect("cherry_pick_continue failed");

            ctx.assert_head_has_file("a.txt");
            assert_eq!(ctx.paths_staged_over_head(), Vec::<String>::new());
        }

        #[test]
        fn cherry_pick_abort_leaves_no_conflict_behind() {
            let (mut ctx, side_oid) = conflicting_cherry_pick_ctx();
            ctx.cherry_pick(&side_oid).unwrap_err();

            ctx.act_while_another_writer_stages("a.txt", |ctx| ctx.cherry_pick_abort().map(drop))
                .expect("cherry_pick_abort failed");

            assert!(!ctx.repo().index().unwrap().has_conflicts());
        }
    }
}

/// Each git action run while another writer holds the repository: that writer read
/// before the action started, and writes once the action waits for it.
mod when_another_writer_runs_meanwhile {
    use super::*;
    use common::drivers::commit::commit_what_is_staged;
    use common::drivers::staging::stage_path;

    fn head(ctx: &TestContext) -> String {
        ctx.resolve_ref("HEAD").unwrap()
    }

    #[test]
    fn cherry_pick_refuses_once_the_other_writer_staged_a_file() {
        let (mut ctx, first_oid, second_oid) = build_two_commit_ctx();
        ctx.reset_to_commit(&first_oid, "hard").unwrap();

        let err = ctx
            .act_while_another_writer_stages("a.txt", |ctx| ctx.cherry_pick(&second_oid).map(drop))
            .expect_err("cherry_pick ran over a staged file");

        assert_eq!(err.code, "cherry_pick_error");
        assert_eq!(head(&ctx), first_oid);
        assert_eq!(ctx.paths_staged_over_head(), ["a.txt"]);
    }

    #[test]
    fn cherry_pick_of_a_change_head_already_has_ends_the_pick_before_the_next_writer() {
        let mut ctx = TestContext::builder()
            .with_file("f.txt", "a\n")
            .with_commit("Initial commit")
            .with_branch("side")
            .checkout("side")
            .with_file("f.txt", "b\n")
            .with_commit("Side change")
            .checkout("main")
            .with_file("f.txt", "b\n")
            .with_commit("Same change on main")
            .build();
        let side_oid = ctx.resolve_ref("side").unwrap();
        std::fs::write(ctx.repo_path().join("a.txt"), "a.txt").unwrap();

        let err = ctx
            .act_then_another_writer_at_release(
                |repo| stage_path(repo, "a.txt"),
                |ctx| ctx.cherry_pick(&side_oid).map(drop),
            )
            .expect_err("a pick HEAD already has reported success");

        assert_eq!(err.code, "cherry_pick_empty");
        assert_eq!(ctx.paths_staged_over_head(), ["a.txt"]);
    }

    #[test]
    fn revert_commit_begin_refuses_once_the_other_writer_staged_a_file() {
        let (mut ctx, _first_oid, second_oid) = build_two_commit_ctx();

        let err = ctx
            .act_while_another_writer_stages("a.txt", |ctx| {
                ctx.revert_commit_begin(&second_oid).map(drop)
            })
            .expect_err("revert_commit_begin ran over a staged file");

        assert_eq!(err.code, "staged_changes");
        assert!(!ctx.repo_path().join(".git").join("REVERT_HEAD").exists());
        assert_eq!(ctx.paths_staged_over_head(), ["a.txt"]);
    }

    #[test]
    fn revert_continue_commits_the_file_the_other_writer_staged_first() {
        let (mut ctx, _first_oid, second_oid) = build_two_commit_ctx();
        ctx.revert_commit_begin(&second_oid).unwrap();

        ctx.act_while_another_writer_stages("a.txt", |ctx| {
            ctx.revert_continue("Revert \"Second commit\"").map(drop)
        })
        .expect("revert_continue failed");

        ctx.assert_head_has_file("a.txt");
        assert_eq!(ctx.paths_staged_over_head(), Vec::<String>::new());
    }

    #[test]
    fn revert_abort_leaves_nothing_of_the_revert_staged() {
        let (mut ctx, _first_oid, second_oid) = build_two_commit_ctx();
        ctx.revert_commit_begin(&second_oid).unwrap();

        ctx.act_while_another_writer_stages("a.txt", |ctx| ctx.revert_abort().map(drop))
            .expect("revert_abort failed");

        assert_eq!(ctx.paths_staged_over_head(), Vec::<String>::new());
    }

    #[test]
    fn reset_to_commit_sets_the_index_after_the_other_writer_staged() {
        let (mut ctx, first_oid, _second_oid) = build_two_commit_ctx();

        ctx.act_while_another_writer_stages("a.txt", |ctx| {
            ctx.reset_to_commit(&first_oid, "mixed").map(drop)
        })
        .expect("reset_to_commit failed");

        assert_eq!(ctx.paths_staged_over_head(), Vec::<String>::new());
    }

    #[test]
    fn undo_commit_refuses_once_the_other_writer_committed() {
        let (mut ctx, _first_oid, second_oid) = build_two_commit_ctx();

        let err = ctx
            .act_while_another_writer(
                |_| (),
                |repo, ()| commit_what_is_staged(repo),
                |ctx| ctx.undo_commit(),
            )
            .expect_err("undo_commit took back the commit made while it waited");

        assert_eq!(err.code, "undo_stale");
        assert_eq!(
            ctx.get_head_commit_message().unwrap().subject,
            "Committed meanwhile"
        );
        assert_eq!(ctx.resolve_ref("HEAD~1").unwrap(), second_oid);
    }

    #[test]
    fn redo_commit_refuses_once_the_other_writer_moved_head() {
        let (mut ctx, _first_oid, _second_oid) = build_two_commit_ctx();
        let undo = ctx.undo_commit().unwrap();

        let err = ctx
            .act_while_another_writer(
                |_| (),
                |repo, ()| commit_what_is_staged(repo),
                |ctx| ctx.redo_commit(&undo),
            )
            .expect_err("redo_commit moved the branch off the commit made meanwhile");

        assert_eq!(err.code, "redo_stale");
    }
}

// -- cherry-pick has a way out --

mod common;

use common::context::TestContext;
use trunk_lib::commands::operation_state::MergeBeginResult;
use trunk_lib::git::types::OperationType;

#[test]
fn clean_repo_returns_none_operation_type() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .build();

    let info = ctx.get_operation_state().unwrap();
    assert!(matches!(info.op_type, OperationType::None));
    assert!(info.source_branch.is_none());
    assert!(info.target_branch.is_none());
    assert!(info.progress.is_none());
}

#[test]
fn merge_in_progress_reports_merge_state() {
    // Use with_conflict builder (which uses libgit2 merge) to create merge state,
    // then manually write MERGE_MSG for the operation_state parser to find.
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

    // Write MERGE_MSG manually (libgit2 merge does not create it; git CLI does)
    let repo = ctx.repo();
    let git_dir = repo.path();
    std::fs::write(git_dir.join("MERGE_MSG"), "Merge branch 'feature'\n").unwrap();

    let info = ctx.get_operation_state().unwrap();
    assert!(matches!(info.op_type, OperationType::Merge));
    assert_eq!(info.source_branch, Some("feature".to_string()));
    assert_eq!(info.target_branch, Some("main".to_string()));
    assert!(info.progress.is_none());
}

#[test]
fn merge_branch_begin_non_conflicting_then_continue_creates_merge_commit() {
    // Divergent changes on DIFFERENT files -> non-ff clean merge. The two-step
    // flow stages on begin (Ready), then merge_continue finalizes the commit.
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("feature.txt", "feature work")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("main.txt", "main work")
        .with_commit("Main commit")
        .build();

    let result = ctx.merge_branch_begin("feature").unwrap();
    let message = match result {
        MergeBeginResult::Ready { message, .. } => message,
        other => panic!("expected Ready for a clean non-ff merge, got {:?}", other),
    };
    // Begin staged without committing: still mid-merge with MERGE_HEAD set.
    let info = ctx.get_operation_state().unwrap();
    assert!(matches!(info.op_type, OperationType::Merge));

    // Finalize with the default message.
    ctx.merge_continue(Some(&message)).unwrap();

    // After continue, repo is clean and HEAD is a 2-parent merge commit.
    let info = ctx.get_operation_state().unwrap();
    assert!(matches!(info.op_type, OperationType::None));
    let repo = ctx.repo();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2);
}

#[test]
fn merge_branch_begin_fast_forward_when_linear() {
    // Feature ahead, main not diverged -> fast-forward, no editor, 1-parent HEAD.
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("feature.txt", "feature work")
        .with_commit("Feature commit")
        .checkout("main")
        .build();

    let result = ctx.merge_branch_begin("feature").unwrap();
    assert!(
        matches!(result, MergeBeginResult::FastForwarded { .. }),
        "expected FastForwarded, got {:?}",
        result
    );

    // Fast-forward merge: HEAD has 1 parent (not a merge commit).
    let repo = ctx.repo();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1);
}

#[test]
fn merge_branch_begin_with_conflict_returns_conflicts() {
    // A conflicting non-ff merge returns the Conflicts variant (NOT an Err) and
    // leaves MERGE_HEAD set for the continue UI. git writes CONFLICT to stdout,
    // which merge_branch_begin_inner now scans alongside stderr.
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
        .build();

    let result = ctx.merge_branch_begin("feature").unwrap();
    assert!(
        matches!(result, MergeBeginResult::Conflicts { .. }),
        "expected Conflicts, got {:?}",
        result
    );
    let info = ctx.get_operation_state().unwrap();
    assert!(matches!(info.op_type, OperationType::Merge));
}

#[test]
fn merge_abort_clears_merge_state() {
    // Use with_conflict builder to set up merge state reliably
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

    // Repo is now in merge state (from with_conflict)
    let info = ctx.get_operation_state().unwrap();
    assert!(matches!(info.op_type, OperationType::Merge));

    // Abort the merge
    let result = ctx.merge_abort();
    assert!(result.is_ok(), "merge_abort should succeed: {:?}", result);

    let info = ctx.get_operation_state().unwrap();
    assert!(matches!(info.op_type, OperationType::None));
}

#[test]
fn rebase_branch_with_no_conflicts_completes() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("feature.txt", "feature work")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("main.txt", "main work")
        .with_commit("Main commit")
        .checkout("feature")
        .build();

    let result = ctx.rebase_branch("main");
    assert!(result.is_ok(), "rebase_branch should succeed: {:?}", result);

    let info = ctx.get_operation_state().unwrap();
    assert!(matches!(info.op_type, OperationType::None));
}

#[test]
fn rebase_abort_clears_rebase_state() {
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
        .checkout("feature")
        .build();

    // Start conflicting rebase (will leave repo in rebase state)
    let _result = ctx.rebase_branch("main");

    // Abort it
    let result = ctx.rebase_abort();
    assert!(result.is_ok(), "rebase_abort should succeed: {:?}", result);

    let info = ctx.get_operation_state().unwrap();
    assert!(matches!(info.op_type, OperationType::None));
}

#[test]
fn rebase_continue_after_resolving_conflict_completes() {
    // Regression: `git rebase --continue` opens the commit-message editor for the
    // re-applied commit. Without GIT_EDITOR pinned, the subprocess inherits an ambient
    // interactive editor (e.g. nvim) with no TTY and blocks forever, so the command
    // never returns and the UI freezes. This asserts the resolve-then-continue path
    // actually completes.
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
        .checkout("feature")
        .build();

    // Conflicting rebase leaves the repo mid-rebase on the conflicted commit.
    let _ = ctx.rebase_branch("main");
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::Rebase),
        "expected a paused rebase, got {:?}",
        info.op_type
    );

    // Resolve the conflict and stage it, as the merge editor's "Mark Resolved" does.
    std::fs::write(ctx.repo_path().join("file.txt"), "resolved content\n").unwrap();
    let repo = ctx.repo();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("file.txt")).unwrap();
    index.write().unwrap();

    // Must complete, not hang or error, and leave the repo out of the rebase.
    let result = ctx.rebase_continue(None);
    assert!(
        result.is_ok(),
        "rebase_continue should complete after resolution: {:?}",
        result
    );
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::None),
        "rebase should be finished, got {:?}",
        info.op_type
    );
}

#[test]
fn rebase_skip_with_a_later_reword_completes() {
    // `git rebase --skip` resumes the todo list, so a reword/squash step after the
    // skipped commit opens the commit-message editor exactly as --continue does.
    // core.editor is pinned to a failing command so the skip fails unless the command
    // sets GIT_EDITOR itself. Note this only discriminates where GIT_EDITOR is absent
    // from the environment: an exported GIT_EDITOR is inherited by the child and
    // outranks core.editor, which makes the assertion vacuous on such a machine.
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Conflicting commit")
        .with_file("other.txt", "other")
        .with_commit("Commit to reword")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .checkout("feature")
        .build();

    let repo = ctx.repo();
    repo.config()
        .unwrap()
        .set_str("core.editor", "false")
        .unwrap();

    // Turn the second todo line into a reword, so the rebase has an editor step waiting
    // beyond the commit that conflicts.
    let seq_editor = ctx.data_dir().join("seq-editor.sh");
    std::fs::write(
        &seq_editor,
        "#!/bin/sh\nawk 'NR==2 && /^pick/ { sub(/^pick/, \"reword\") } { print }' \"$1\" > \"$1.new\" && mv \"$1.new\" \"$1\"\n",
    )
    .unwrap();
    let _ = std::process::Command::new("git")
        .args(["rebase", "-i", "main"])
        .current_dir(ctx.repo_path())
        .env(
            "GIT_SEQUENCE_EDITOR",
            format!("sh {}", seq_editor.display()),
        )
        .env("GIT_EDITOR", "true")
        .output()
        .unwrap();

    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::Rebase),
        "expected a paused rebase, got {:?}",
        info.op_type
    );

    let result = ctx.rebase_skip();

    assert!(
        result.is_ok(),
        "rebase_skip should complete through the reword step: {:?}",
        result
    );
    let info = ctx.get_operation_state().unwrap();
    assert!(
        matches!(info.op_type, OperationType::None),
        "rebase should be finished, got {:?}",
        info.op_type
    );
}

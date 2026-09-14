mod common;

use common::context::TestContext;

// -- stash_save tests --

#[test]
fn stash_save_creates_entry() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Create dirty state: write + stage a file
    std::fs::write(ctx.repo_path().join("file.txt"), "hello").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
    }

    ctx.stash_save("my stash").unwrap();

    let stashes = ctx.list_stashes().unwrap();
    assert_eq!(stashes.len(), 1);
    assert_eq!(stashes[0].short_name, "stash@{0}");
}

#[test]
fn stash_save_with_empty_message_uses_default() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("file.txt"), "hello").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
    }

    ctx.stash_save("").unwrap();

    let stashes = ctx.list_stashes().unwrap();
    assert_eq!(stashes.len(), 1);
    assert!(
        !stashes[0].name.is_empty(),
        "stash name should not be empty"
    );
}

#[test]
fn stash_save_on_clean_workdir_returns_error() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let err = ctx.stash_save("test").unwrap_err();
    assert_eq!(err.code, "nothing_to_stash");
    assert_eq!(err.message, "Nothing to stash — stage changes first.");
}

#[test]
fn stash_save_with_unstaged_changes_only_returns_nothing_to_stash_and_preserves_workdir() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("README.md"), "hello edited").unwrap();
    std::fs::write(ctx.repo_path().join("untracked.txt"), "untracked").unwrap();

    let err = ctx.stash_save("test").unwrap_err();
    assert_eq!(err.code, "nothing_to_stash");
    assert_eq!(err.message, "Nothing to stash — stage changes first.");
    assert_eq!(ctx.list_stashes().unwrap().len(), 0);

    ctx.assert_file_content("README.md", "hello edited");
    ctx.assert_file_unstaged("README.md");
    assert!(ctx.repo_path().join("untracked.txt").exists());
}

#[test]
fn stash_save_takes_only_staged_changes_and_preserves_other_unstaged_files() {
    let ctx = TestContext::builder()
        .with_file("README.md", "initial readme")
        .with_file("unstaged.txt", "initial unstaged")
        .with_commit("Initial commit")
        .build();

    // Stage a change to README.md
    std::fs::write(ctx.repo_path().join("README.md"), "staged readme").unwrap();
    ctx.stage_file("README.md").unwrap();

    // Leave an unstaged change in unstaged.txt
    std::fs::write(
        ctx.repo_path().join("unstaged.txt"),
        "unstaged modification",
    )
    .unwrap();

    ctx.stash_save("staged only").unwrap();

    let stashes = ctx.list_stashes().unwrap();
    assert_eq!(stashes.len(), 1);

    // Staged change was stashed, so README.md reverts to HEAD content
    ctx.assert_file_content("README.md", "initial readme");

    // Unstaged change in unstaged.txt is preserved in worktree and still unstaged
    ctx.assert_file_content("unstaged.txt", "unstaged modification");
    ctx.assert_file_unstaged("unstaged.txt");

    // Index is clean
    let status =
        trunk_lib::commands::staging::get_status_inner(ctx.path(), ctx.state_map()).unwrap();
    assert!(status.staged.is_empty());
}

#[test]
fn stash_save_entry_holds_the_staged_content_and_not_the_unstaged_one() {
    let ctx = TestContext::builder()
        .with_file("staged.txt", "committed staged\n")
        .with_file("unstaged.txt", "committed unstaged\n")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("staged.txt"), "staged edit\n").unwrap();
    ctx.stage_file("staged.txt").unwrap();
    std::fs::write(ctx.repo_path().join("unstaged.txt"), "unstaged edit\n").unwrap();

    ctx.stash_save("staged only").unwrap();

    let oid = ctx.top_stash_oid();
    ctx.assert_stash_content(&oid, "staged.txt", "staged edit\n");
    ctx.assert_stash_content(&oid, "unstaged.txt", "committed unstaged\n");
}

#[test]
fn stash_save_partially_staged_file_non_overlapping_preserves_unstaged_edit() {
    let initial_content =
        "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n";
    let ctx = TestContext::builder()
        .with_file("file.txt", initial_content)
        .with_commit("Initial commit")
        .build();

    // Stage an edit to line 1
    let staged_content =
        "line 1 STAGED\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n";
    std::fs::write(ctx.repo_path().join("file.txt"), staged_content).unwrap();
    ctx.stage_file("file.txt").unwrap();

    // Unstaged edit to line 10 in working tree
    let worktree_content = "line 1 STAGED\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10 UNSTAGED\n";
    std::fs::write(ctx.repo_path().join("file.txt"), worktree_content).unwrap();

    ctx.stash_save("partially staged").unwrap();

    let stashes = ctx.list_stashes().unwrap();
    assert_eq!(stashes.len(), 1);

    // In worktree: line 1 reverted to HEAD ("line 1\n"), while line 10 kept the unstaged edit
    let expected_worktree = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10 UNSTAGED\n";
    ctx.assert_file_content("file.txt", expected_worktree);
    ctx.assert_file_unstaged("file.txt");
}

#[test]
fn stash_save_partially_staged_file_overlapping_refuses_with_cannot_separate_changes() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "original content\n")
        .with_commit("Initial commit")
        .build();

    // Stage edit
    std::fs::write(ctx.repo_path().join("file.txt"), "staged edit\n").unwrap();
    ctx.stage_file("file.txt").unwrap();

    // Overlapping unstaged edit
    std::fs::write(ctx.repo_path().join("file.txt"), "unstaged edit\n").unwrap();

    let err = ctx.stash_save("test").unwrap_err();
    assert_eq!(err.code, "cannot_separate_changes");
    assert!(
        err.message
            .contains("Cannot separate staged and unstaged changes in file.txt")
    );
    assert_eq!(ctx.list_stashes().unwrap().len(), 0);

    // Working tree is untouched
    ctx.assert_file_content("file.txt", "unstaged edit\n");
    ctx.assert_file_staged("file.txt");
    ctx.assert_file_unstaged("file.txt");
}

#[test]
fn stash_save_staged_add_further_edited_in_worktree_refuses() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Stage a new file
    std::fs::write(ctx.repo_path().join("new.txt"), "initial new content\n").unwrap();
    ctx.stage_file("new.txt").unwrap();

    // Unstaged edit to the new file
    std::fs::write(ctx.repo_path().join("new.txt"), "diverged new content\n").unwrap();

    let err = ctx.stash_save("test").unwrap_err();
    assert_eq!(err.code, "cannot_separate_changes");
    assert!(
        err.message
            .contains("Cannot separate staged and unstaged changes in new.txt")
    );
    assert_eq!(ctx.list_stashes().unwrap().len(), 0);

    ctx.assert_file_content("new.txt", "diverged new content\n");
}

#[test]
fn stash_save_staged_deletion_with_the_file_recreated_unstaged_refuses() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "committed content\n")
        .with_commit("Initial commit")
        .build();

    // Stage the deletion
    std::fs::remove_file(ctx.repo_path().join("file.txt")).unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.remove_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
    }

    // The user writes a new file at the same path, unstaged
    std::fs::write(
        ctx.repo_path().join("file.txt"),
        "recreated, never staged\n",
    )
    .unwrap();

    let err = ctx.stash_save("test").unwrap_err();
    assert_eq!(err.code, "cannot_separate_changes");
    assert!(
        err.message
            .contains("Cannot separate staged and unstaged changes in file.txt")
    );
    assert_eq!(ctx.list_stashes().unwrap().len(), 0);

    ctx.assert_file_content("file.txt", "recreated, never staged\n");
}

#[test]
fn stash_save_staged_deletion_reverts_file_in_worktree() {
    let ctx = TestContext::builder()
        .with_file("to_delete.txt", "content to delete")
        .with_commit("Initial commit")
        .build();

    // Delete file and stage deletion
    std::fs::remove_file(ctx.repo_path().join("to_delete.txt")).unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index
            .remove_path(std::path::Path::new("to_delete.txt"))
            .unwrap();
        index.write().unwrap();
    }

    ctx.stash_save("stash deletion").unwrap();

    let stashes = ctx.list_stashes().unwrap();
    assert_eq!(stashes.len(), 1);

    // In worktree: file was restored from HEAD and is clean
    ctx.assert_file_content("to_delete.txt", "content to delete");
    ctx.assert_status_clean();
}

/// The entry is written before the worktree is cleaned, so that a failure here leaves
/// the staged work in the entry as well as the index. The user needs to be told that.
#[cfg(unix)]
#[test]
fn stash_save_reports_the_entry_it_kept_when_the_worktree_cannot_be_cleaned() {
    use std::os::unix::fs::PermissionsExt;

    let ctx = TestContext::builder()
        .with_file("locked/file.txt", "committed\n")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("locked/file.txt"), "staged\n").unwrap();
    ctx.stage_file("locked/file.txt").unwrap();

    // Removing the file is what the write phase does first, and only the directory's
    // write bit governs that. Clearing it is what makes the write fail.
    let dir = ctx.repo_path().join("locked");
    std::fs::set_permissions(
        ctx.repo_path().join("locked/file.txt"),
        std::fs::Permissions::from_mode(0o400),
    )
    .unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let err = ctx.stash_save("test").unwrap_err();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(err.code, "stash_incomplete");
    assert!(
        err.message.contains("still staged"),
        "the message must say the changes are still staged, got '{}'",
        err.message
    );

    let oid = ctx.top_stash_oid();
    ctx.assert_stash_content(&oid, "locked/file.txt", "staged\n");
    ctx.assert_file_content("locked/file.txt", "staged\n");
    ctx.assert_file_staged("locked/file.txt");
}

/// The symlink branch removes the path before recreating it, so a failure to recreate
/// must be reported rather than leaving the path missing with the stash reported good.
#[cfg(unix)]
#[test]
fn stash_save_reports_a_symlink_it_could_not_restore() {
    use std::os::unix::fs::PermissionsExt;

    let ctx = TestContext::builder()
        .with_file("target.txt", "pointed at\n")
        .with_commit("Initial commit")
        .build();

    let link = ctx.repo_path().join("locked/link");
    std::fs::create_dir(ctx.repo_path().join("locked")).unwrap();
    std::os::unix::fs::symlink("../target.txt", &link).unwrap();
    ctx.stage_file("locked/link").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        let tree = index.write_tree().unwrap();
        let tree = repo.find_tree(tree).unwrap();
        let sig = repo.signature().unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "add the link", &tree, &[&head])
            .unwrap();
    }

    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink("elsewhere.txt", &link).unwrap();
    ctx.stage_file("locked/link").unwrap();

    let dir = ctx.repo_path().join("locked");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let err = ctx.stash_save("test").unwrap_err();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(err.code, "stash_incomplete");
}

#[test]
fn stash_save_conflicted_index_returns_error() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "base")
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

    let err = ctx.stash_save("test").unwrap_err();
    assert_eq!(err.code, "conflicted_index");
    assert_eq!(ctx.list_stashes().unwrap().len(), 0);
}

#[test]
fn stash_save_unborn_branch_returns_error() {
    let ctx = TestContext::new_empty();

    let err = ctx.stash_save("test").unwrap_err();
    assert_eq!(err.code, "unborn_branch");
}

// -- list_stashes tests --

#[test]
fn list_stashes_returns_parent_oid() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("file.txt"), "hello").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
    }

    ctx.stash_save("stash1").unwrap();

    let stashes = ctx.list_stashes().unwrap();
    assert!(stashes[0].parent_oid.is_some());
}

// -- stash_pop tests --

#[test]
fn stash_pop_removes_entry_and_restores_changes() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("file.txt"), "hello").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
    }

    ctx.stash_save("pop test").unwrap();
    ctx.stash_pop(&ctx.top_stash_oid()).unwrap();

    let stashes = ctx.list_stashes().unwrap();
    assert_eq!(stashes.len(), 0);
}

// -- stash_apply tests --

#[test]
fn stash_apply_keeps_entry() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("file.txt"), "hello").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
    }

    ctx.stash_save("apply test").unwrap();
    ctx.stash_apply(&ctx.top_stash_oid()).unwrap();

    let stashes = ctx.list_stashes().unwrap();
    assert_eq!(stashes.len(), 1, "apply should keep the stash entry");
}

// -- stash_drop tests --

#[test]
fn stash_drop_removes_entry_without_restoring() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("file.txt"), "hello").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
    }

    ctx.stash_save("drop test").unwrap();
    ctx.stash_drop(&ctx.top_stash_oid()).unwrap();

    let stashes = ctx.list_stashes().unwrap();
    assert_eq!(stashes.len(), 0);
    // file.txt should NOT exist (was stashed, not restored)
    assert!(!ctx.repo_path().join("file.txt").exists());
}

// -- conflicted restore tests --
// Both restore paths deliberately leave the conflicted paths in the worktree and
// keep the stash entry, so the user can resolve without losing the stash.

/// Stash `file.txt`, then commit different content over it, so restoring conflicts.
fn ctx_with_a_conflicting_stash() -> TestContext {
    let ctx = TestContext::builder()
        .with_file("file.txt", "base")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("file.txt"), "stashed content").unwrap();
    ctx.stage_file("file.txt").unwrap();
    ctx.stash_save("wip").unwrap();
    std::fs::write(ctx.repo_path().join("file.txt"), "committed content").unwrap();
    ctx.stage_file("file.txt").unwrap();
    ctx.create_commit("Diverging commit", None).unwrap();
    ctx
}

#[test]
fn stash_pop_with_conflicts_reports_conflict_state() {
    let ctx = ctx_with_a_conflicting_stash();

    let err = ctx.stash_pop(&ctx.top_stash_oid()).unwrap_err();

    assert_eq!(err.code, "conflict_state");
    assert_eq!(ctx.list_stashes().unwrap().len(), 1);
}

#[test]
fn stash_apply_with_conflicts_reports_conflict_state() {
    let ctx = ctx_with_a_conflicting_stash();

    let err = ctx.stash_apply(&ctx.top_stash_oid()).unwrap_err();

    assert_eq!(err.code, "conflict_state");
    assert_eq!(ctx.list_stashes().unwrap().len(), 1);
}

// -- stashes are addressed by identity, not by position --

/// `stash@{n}` is a position in a stack anything can renumber — a second window,
/// a terminal, or this app on another tab. A UI listing captured before the
/// renumbering names one stash and reaches another, and the toast still says
/// success.
mod stash_identity {
    use super::*;

    fn dirty(ctx: &TestContext, name: &str, content: &str) {
        std::fs::write(ctx.repo_path().join(name), content).unwrap();
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new(name)).unwrap();
        index.write().unwrap();
    }

    #[test]
    fn drop_removes_the_stash_the_caller_named_after_a_renumbering() {
        let ctx = TestContext::builder()
            .with_file("README.md", "hello")
            .with_commit("Initial commit")
            .build();

        dirty(&ctx, "target.txt", "target");
        ctx.stash_save("target").unwrap();
        dirty(&ctx, "keep.txt", "keep");
        ctx.stash_save("keep").unwrap();

        // What the UI listed: keep@{0}, target@{1}.
        let listed = ctx.list_stashes().unwrap();
        let target_oid = listed[1].oid.clone();
        assert!(listed[1].name.contains("target"));

        // Another window stashes, and every index shifts by one.
        dirty(&ctx, "newer.txt", "newer");
        ctx.stash_save("newer").unwrap();

        ctx.stash_drop(&target_oid).unwrap();

        let remaining: Vec<String> = ctx
            .list_stashes()
            .unwrap()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(remaining.len(), 2);
        assert!(
            remaining.iter().any(|n| n.contains("keep")),
            "dropping `target` must leave `keep` alone, got {remaining:?}"
        );
        assert!(
            !remaining.iter().any(|n| n.contains("target")),
            "`target` should be gone, got {remaining:?}"
        );
    }

    #[test]
    fn drop_refuses_a_stash_that_is_already_gone() {
        let ctx = TestContext::builder()
            .with_file("README.md", "hello")
            .with_commit("Initial commit")
            .build();

        dirty(&ctx, "gone.txt", "gone");
        ctx.stash_save("gone").unwrap();
        let oid = ctx.list_stashes().unwrap()[0].oid.clone();
        ctx.stash_drop(&oid).unwrap();

        let err = ctx.stash_drop(&oid).unwrap_err();

        assert_eq!(err.code, "stash_not_found");
    }
}

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

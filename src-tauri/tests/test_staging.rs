mod common;

use common::builder::make_executable;
use common::context::TestContext;
use std::fmt::Write as _;
use trunk_lib::types::{DiffOrigin, DiffRequestOptions, FileStatusType};

// -- get_status tests --

#[test]
fn modified_file_shows_in_unstaged_status() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("README.md"), "modified content").unwrap();

    let status = ctx.get_status().expect("get_status failed");
    assert!(
        !status.unstaged.is_empty(),
        "expected unstaged to be non-empty"
    );
    assert!(status.staged.is_empty(), "expected staged to be empty");
}

#[test]
fn new_file_shows_as_new_in_unstaged() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("brand_new.txt"), "new content").unwrap();

    let status = ctx.get_status().expect("get_status failed");
    let has_new = status
        .unstaged
        .iter()
        .any(|f| matches!(f.status, FileStatusType::New));
    assert!(
        has_new,
        "expected at least one entry with status New in unstaged"
    );
}

#[test]
fn modified_tracked_file_shows_as_modified_in_unstaged() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("README.md"), "modified hello").unwrap();

    let status = ctx.get_status().expect("get_status failed");
    let has_modified = status
        .unstaged
        .iter()
        .any(|f| matches!(f.status, FileStatusType::Modified));
    assert!(
        has_modified,
        "expected at least one entry with status Modified in unstaged"
    );
}

// -- stage_file / unstage_file tests --

#[test]
fn stage_file_moves_to_staged() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("README.md"), "staged content").unwrap();
    ctx.stage_file("README.md").expect("stage_file failed");

    let status = ctx.get_status().expect("get_status failed");
    assert!(
        !status.staged.is_empty(),
        "expected staged to be non-empty after staging"
    );
    assert!(
        status.staged.iter().any(|f| f.path == "README.md"),
        "expected README.md in staged list"
    );
}

#[test]
fn stage_file_handles_deleted_file() {
    let ctx = TestContext::builder()
        .with_file("to_delete.txt", "content")
        .with_commit("Initial commit")
        .build();

    // Delete the file from the working directory
    std::fs::remove_file(ctx.repo_path().join("to_delete.txt")).unwrap();

    // Staging a deleted file should succeed (stages the deletion)
    ctx.stage_file("to_delete.txt")
        .expect("stage_file should handle deleted files");

    let status = ctx.get_status().expect("get_status failed");
    assert!(
        status.staged.iter().any(|f| f.path == "to_delete.txt"),
        "expected to_delete.txt in staged list (deletion staged)"
    );
    assert!(
        !status.unstaged.iter().any(|f| f.path == "to_delete.txt"),
        "expected to_delete.txt NOT in unstaged list after staging deletion"
    );
}

#[test]
fn unstage_file_moves_back_to_unstaged() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Modify and stage
    std::fs::write(
        ctx.repo_path().join("README.md"),
        "to be staged then unstaged",
    )
    .unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("README.md")).unwrap();
        index.write().unwrap();
    }

    ctx.unstage_file("README.md").expect("unstage_file failed");

    let status = ctx.get_status().expect("get_status failed");
    let readme_in_staged = status.staged.iter().any(|f| f.path == "README.md");
    assert!(
        !readme_in_staged,
        "expected README.md NOT in staged list after unstaging"
    );
}

#[test]
fn unstage_file_works_on_unborn_head() {
    let ctx = TestContext::new_empty();

    // Create a new file and stage it (no commits yet)
    std::fs::write(ctx.repo_path().join("new_file.txt"), "content").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index
            .add_path(std::path::Path::new("new_file.txt"))
            .unwrap();
        index.write().unwrap();
    }

    let result = ctx.unstage_file("new_file.txt");
    assert!(
        result.is_ok(),
        "expected Ok(()) for unstage on unborn HEAD, got: {result:?}"
    );
}

// -- stage_all / unstage_all tests --

#[test]
fn stage_all_stages_everything() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("README.md"), "modified for stage all").unwrap();
    std::fs::write(ctx.repo_path().join("new_for_all.txt"), "new content").unwrap();

    ctx.stage_all().expect("stage_all failed");

    let status = ctx.get_status().expect("get_status failed");
    assert!(
        status.staged.len() >= 2,
        "expected at least 2 entries in staged after stage_all, got {}",
        status.staged.len()
    );
    assert!(
        status.unstaged.is_empty(),
        "expected unstaged to be empty after stage_all"
    );
}

#[test]
fn unstage_all_clears_staged() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Modify and stage
    std::fs::write(
        ctx.repo_path().join("README.md"),
        "staged for unstage_all test",
    )
    .unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("README.md")).unwrap();
        index.write().unwrap();
    }

    ctx.unstage_all().expect("unstage_all failed");

    let status = ctx.get_status().expect("get_status failed");
    assert!(
        status.staged.is_empty(),
        "expected staged to be empty after unstage_all"
    );
}

// -- discard_file / discard_all tests --

#[test]
fn discard_file_reverts_tracked_modification() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let original = std::fs::read_to_string(ctx.repo_path().join("README.md")).unwrap();
    std::fs::write(
        ctx.repo_path().join("README.md"),
        "modified content for discard test",
    )
    .unwrap();

    ctx.discard_file("README.md").expect("discard_file failed");

    let after = std::fs::read_to_string(ctx.repo_path().join("README.md")).unwrap();
    assert_eq!(
        after, original,
        "expected README.md to revert to original content after discard"
    );
}

#[test]
fn discard_file_on_a_path_with_no_changes_reports_it_missing() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let err = ctx
        .discard_file("README.md")
        .expect_err("a path with nothing to discard is refused");

    assert_eq!(
        err.code, "file_not_found",
        "expected file_not_found error code"
    );
}

#[test]
fn discard_file_restores_the_staged_version_and_keeps_it_staged() {
    let ctx = TestContext::builder()
        .with_file("README.md", "committed\n")
        .with_commit("Initial commit")
        .build();
    std::fs::write(ctx.repo_path().join("README.md"), "staged\n").unwrap();
    ctx.stage_file("README.md").unwrap();
    std::fs::write(ctx.repo_path().join("README.md"), "staged\nunstaged\n").unwrap();

    ctx.discard_file("README.md").expect("discard_file failed");

    let after = std::fs::read_to_string(ctx.repo_path().join("README.md")).unwrap();
    assert_eq!(after, "staged\n");
    assert_eq!(ctx.staged_content("README.md"), "staged\n");
}

#[test]
fn discard_file_deletes_untracked_file() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("brand_new.txt"), "untracked content").unwrap();

    ctx.discard_file("brand_new.txt")
        .expect("discard_file failed");

    assert!(
        !ctx.repo_path().join("brand_new.txt").exists(),
        "expected brand_new.txt to be deleted after discard"
    );
}

#[test]
fn discard_file_deletes_untracked_file_in_subdirectory() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Use a neutral nested path: a developer's global gitignore (e.g.
    // ~/.config/git/ignore) may ignore well-known names like
    // .claude/settings.local.json, which would hide the fixture from git
    // status and make this test environment-dependent.
    let sub = ctx.repo_path().join("nested/dir");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(sub.join("untracked.txt"), "{}").unwrap();

    ctx.discard_file("nested/dir/untracked.txt")
        .expect("discard_file failed for nested untracked file");

    assert!(
        !sub.join("untracked.txt").exists(),
        "expected nested/dir/untracked.txt to be deleted after discard"
    );
}

#[test]
fn discard_files_throws_away_every_named_change_and_nothing_else() {
    let ctx = TestContext::builder()
        .with_file("dir/edited.txt", "committed\n")
        .with_file("dir/staged.txt", "committed\n")
        .with_file("dir/deleted.txt", "committed\n")
        .with_file("outside.txt", "committed\n")
        .with_commit("Initial commit")
        .build();
    std::fs::remove_file(ctx.repo_path().join("dir/deleted.txt")).unwrap();
    std::fs::write(ctx.repo_path().join("dir/edited.txt"), "edited\n").unwrap();
    std::fs::write(ctx.repo_path().join("dir/staged.txt"), "staged\n").unwrap();
    ctx.stage_file("dir/staged.txt").unwrap();
    std::fs::write(ctx.repo_path().join("dir/staged.txt"), "staged\nunstaged\n").unwrap();
    std::fs::write(ctx.repo_path().join("dir/new.txt"), "untracked\n").unwrap();
    std::fs::write(ctx.repo_path().join("outside.txt"), "edited\n").unwrap();

    ctx.discard_files(&[
        "dir/edited.txt",
        "dir/staged.txt",
        "dir/deleted.txt",
        "dir/new.txt",
    ])
    .expect("discard_files failed");

    let read = |path: &str| std::fs::read_to_string(ctx.repo_path().join(path)).unwrap();
    assert_eq!(read("dir/edited.txt"), "committed\n");
    assert_eq!(read("dir/staged.txt"), "staged\n");
    assert_eq!(ctx.staged_content("dir/staged.txt"), "staged\n");
    assert_eq!(read("dir/deleted.txt"), "committed\n");
    assert!(!ctx.repo_path().join("dir/new.txt").exists());
    assert_eq!(read("outside.txt"), "edited\n");
}

#[test]
fn discard_files_naming_only_untracked_files_restores_no_tracked_file() {
    let ctx = TestContext::builder()
        .with_file("edited.txt", "committed\n")
        .with_commit("Initial commit")
        .build();
    std::fs::write(ctx.repo_path().join("edited.txt"), "edited\n").unwrap();
    std::fs::write(ctx.repo_path().join("new.txt"), "untracked\n").unwrap();

    ctx.discard_files(&["new.txt"])
        .expect("discard_files failed");

    let edited = std::fs::read_to_string(ctx.repo_path().join("edited.txt")).unwrap();
    assert_eq!(edited, "edited\n");
    assert!(!ctx.repo_path().join("new.txt").exists());
}

#[test]
fn discard_files_touches_nothing_when_a_named_path_has_no_change() {
    let ctx = TestContext::builder()
        .with_file("edited.txt", "committed\n")
        .with_file("clean.txt", "committed\n")
        .with_commit("Initial commit")
        .build();
    std::fs::write(ctx.repo_path().join("edited.txt"), "edited\n").unwrap();
    std::fs::write(ctx.repo_path().join("new.txt"), "untracked\n").unwrap();

    let err = ctx
        .discard_files(&["edited.txt", "new.txt", "clean.txt"])
        .expect_err("a path with nothing to discard refuses the call");

    assert_eq!(err.code, "file_not_found");
    let edited = std::fs::read_to_string(ctx.repo_path().join("edited.txt")).unwrap();
    assert_eq!(edited, "edited\n");
    assert!(ctx.repo_path().join("new.txt").exists());
}

#[test]
fn discard_all_deletes_nested_untracked_file() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Neutral nested path — see discard_file_deletes_untracked_file_in_subdirectory
    // for why .claude/settings.local.json is unsafe as a fixture name.
    let sub = ctx.repo_path().join("nested/dir");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(sub.join("untracked.txt"), "{}").unwrap();

    ctx.discard_all().expect("discard_all failed");

    assert!(
        !sub.join("untracked.txt").exists(),
        "expected nested/dir/untracked.txt to be deleted after discard_all"
    );
}

#[test]
fn discard_all_reports_the_untracked_files_it_cannot_delete_and_deletes_the_rest() {
    use std::os::unix::fs::PermissionsExt as _;
    struct Unlock<'a>(&'a std::path::Path);
    impl Drop for Unlock<'_> {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(self.0, std::fs::Permissions::from_mode(0o755));
        }
    }
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    let locked = ctx.repo_path().join("locked");
    std::fs::create_dir(&locked).unwrap();
    std::fs::write(locked.join("kept-a.txt"), "kept").unwrap();
    std::fs::write(locked.join("kept-b.txt"), "kept").unwrap();
    // Sorts after locked/, so a discard that stopped at the first failure would leave it.
    let after_locked = ctx.repo_path().join("past-locked.txt");
    std::fs::write(&after_locked, "free").unwrap();
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();
    let unlock = Unlock(&locked);

    let result = ctx.discard_all();
    drop(unlock);

    let err = result.expect_err("discard_all reported files it left behind as discarded");
    assert_eq!(err.code, "io_error");
    assert!(
        err.message
            .starts_with("Failed to delete locked/kept-a.txt and 1 more:"),
        "{}",
        err.message
    );
    assert!(locked.join("kept-a.txt").exists());
    assert!(locked.join("kept-b.txt").exists());
    assert!(!after_locked.exists());
}

#[test]
fn discard_all_leaves_an_untracked_repository_nested_in_the_worktree() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    let nested = ctx.repo_path().join("nested");
    git2::Repository::init(&nested).unwrap();
    std::fs::write(nested.join("work.txt"), "its own work").unwrap();
    let loose = ctx.repo_path().join("loose.txt");
    std::fs::write(&loose, "loose").unwrap();

    ctx.discard_all()
        .expect("discard_all failed on a nested repository it should leave alone");

    assert!(nested.join(".git").exists());
    assert!(nested.join("work.txt").exists());
    assert!(!loose.exists());
}

#[test]
fn discard_all_restores_staged_versions_and_keeps_them_staged() {
    let ctx = TestContext::builder()
        .with_file("README.md", "committed\n")
        .with_commit("Initial commit")
        .build();
    std::fs::write(ctx.repo_path().join("README.md"), "staged\n").unwrap();
    ctx.stage_file("README.md").unwrap();
    std::fs::write(ctx.repo_path().join("README.md"), "staged\nunstaged\n").unwrap();

    ctx.discard_all().expect("discard_all failed");

    let after = std::fs::read_to_string(ctx.repo_path().join("README.md")).unwrap();
    assert_eq!(after, "staged\n");
    assert_eq!(ctx.staged_content("README.md"), "staged\n");
}

#[test]
fn discard_all_leaves_a_conflicted_file_as_it_is() {
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
    std::fs::write(ctx.repo_path().join("file.txt"), "half resolved").unwrap();

    ctx.discard_all().expect("discard_all failed");

    let conflicted = std::fs::read_to_string(ctx.repo_path().join("file.txt")).unwrap();
    assert_eq!(conflicted, "half resolved");
    assert!(ctx.repo().index().unwrap().has_conflicts());
}

/// Stage All acts on the unstaged list. A conflicted file sits in its own list, where
/// marking it resolved first checks it for conflict markers, so Stage All must not
/// mark it resolved behind that check.
#[test]
fn stage_all_leaves_a_conflicted_file_unresolved() {
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
    std::fs::write(ctx.repo_path().join("notes.txt"), "new").unwrap();

    ctx.stage_all().unwrap();

    let status = ctx.get_status().unwrap();
    let conflicted: Vec<_> = status.conflicted.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(conflicted, ["file.txt"]);
    assert_eq!(staged_rows(&ctx), ["notes.txt"]);
}

#[test]
fn discard_all_leaves_the_changes_made_after_the_user_confirmed() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "a")
        .with_file("b.txt", "b")
        .with_commit("Initial commit")
        .build();
    let root = ctx.repo_path();
    std::fs::write(root.join("a.txt"), "confirmed edit").unwrap();
    std::fs::write(root.join("new.txt"), "confirmed new file").unwrap();
    std::fs::write(root.join("b.txt"), "edit made after the question").unwrap();
    std::fs::write(root.join("late.txt"), "file made after the question").unwrap();

    ctx.discard_all_of(&["a.txt", "new.txt"])
        .expect("discard_all failed");

    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "a");
    assert!(!root.join("new.txt").exists());
    assert_eq!(
        std::fs::read_to_string(root.join("b.txt")).unwrap(),
        "edit made after the question"
    );
    assert!(root.join("late.txt").exists());
}

#[test]
fn discard_all_counts_a_confirmed_change_already_gone_as_discarded() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "a")
        .with_commit("Initial commit")
        .build();

    ctx.discard_all_of(&["a.txt", "gone.txt"])
        .expect("discard_all refused a change that was already gone");
}

#[test]
fn discard_all_reverts_all_changes() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let original = std::fs::read_to_string(ctx.repo_path().join("README.md")).unwrap();

    // Modify tracked file + create untracked file
    std::fs::write(
        ctx.repo_path().join("README.md"),
        "modified for discard_all",
    )
    .unwrap();
    std::fs::write(
        ctx.repo_path().join("brand_new.txt"),
        "untracked for discard_all",
    )
    .unwrap();

    ctx.discard_all().expect("discard_all failed");

    let after = std::fs::read_to_string(ctx.repo_path().join("README.md")).unwrap();
    assert_eq!(
        after, original,
        "expected README.md to revert after discard_all"
    );
    assert!(
        !ctx.repo_path().join("brand_new.txt").exists(),
        "expected brand_new.txt deleted after discard_all"
    );
}

#[test]
fn dirty_counts_includes_untracked() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("untracked_new.txt"), "brand new").unwrap();

    let status = ctx.get_status().expect("get_status failed");
    assert!(
        !status.unstaged.is_empty(),
        "expected unstaged non-empty for untracked file"
    );
}

// -- Multi-hunk fixture helper --

fn create_multi_hunk_file(ctx: &TestContext) {
    // Original content: 30 lines to ensure context separation between hunks
    let original = (1..=30)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(ctx.repo_path().join("multi.txt"), &original).unwrap();

    // Stage and commit the original
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("multi.txt")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = repo.signature().unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "Add multi.txt", &tree, &[&head])
            .unwrap();
    }

    // Modify lines near the top AND near the bottom (creates 2 hunks)
    let mut lines: Vec<String> = original
        .split('\n')
        .map(std::string::ToString::to_string)
        .collect();
    lines[1] = "MODIFIED line 2".to_string(); // Near top -> hunk 0
    lines[28] = "MODIFIED line 29".to_string(); // Near bottom -> hunk 1
    std::fs::write(ctx.repo_path().join("multi.txt"), lines.join("\n")).unwrap();
}

// -- stage_hunk tests --

#[test]
fn stage_hunk_stages_single_hunk() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_multi_hunk_file(&ctx);

    ctx.stage_hunk("multi.txt", 0).expect("stage_hunk failed");

    let staged = ctx.diff_staged("multi.txt").expect("diff_staged failed");
    assert_eq!(staged.len(), 1, "expected 1 file in staged diff");
    assert_eq!(staged[0].hunks.len(), 1, "expected 1 hunk in staged diff");

    let unstaged = ctx
        .diff_unstaged("multi.txt")
        .expect("diff_unstaged failed");
    assert_eq!(unstaged.len(), 1, "expected 1 file in unstaged diff");
    assert_eq!(
        unstaged[0].hunks.len(),
        1,
        "expected 1 hunk remaining in unstaged diff"
    );
}

#[test]
fn stage_hunk_works_on_untracked_file() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Create a brand-new untracked file in a subdirectory
    let subdir = ctx.repo_path().join("subdir");
    std::fs::create_dir_all(&subdir).unwrap();
    std::fs::write(subdir.join("new_file.txt"), "new content\n").unwrap();

    ctx.stage_hunk("subdir/new_file.txt", 0)
        .expect("stage_hunk should work on untracked files in subdirectories");

    let status = ctx.get_status().expect("get_status failed");
    assert!(
        status
            .staged
            .iter()
            .any(|f| f.path == "subdir/new_file.txt"),
        "expected subdir/new_file.txt in staged list"
    );
}

#[test]
fn stage_hunk_refuses_a_shown_hunk_the_file_no_longer_has() {
    let (ctx, mut edited) = two_rewrites();
    let shown = ctx.shown_unstaged_hunk("two.txt", 1);
    edited[24] = "line 25 rewritten again".to_string();
    std::fs::write(ctx.repo_path().join("two.txt"), joined(&edited)).unwrap();

    let err = ctx.stage_shown_hunk("two.txt", &shown).unwrap_err();

    assert_eq!(err.code, "stale_hunk");
    assert!(ctx.get_status().unwrap().staged.is_empty());
}

#[test]
fn stage_hunk_refuses_a_file_left_clean_since_its_diff_was_shown() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello\n")
        .with_commit("Initial commit")
        .build();
    std::fs::write(ctx.repo_path().join("README.md"), "changed\n").unwrap();
    let shown = ctx.shown_unstaged_hunk("README.md", 0);
    std::fs::write(ctx.repo_path().join("README.md"), "hello\n").unwrap();

    let err = ctx.stage_shown_hunk("README.md", &shown).unwrap_err();

    assert_eq!(err.code, "stale_hunk");
}

#[test]
fn stage_hunk_refuses_a_file_turned_binary_since_its_diff_was_shown() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello\n")
        .with_commit("Initial commit")
        .build();
    std::fs::write(ctx.repo_path().join("README.md"), "changed\n").unwrap();
    let shown = ctx.shown_unstaged_hunk("README.md", 0);
    std::fs::write(ctx.repo_path().join("README.md"), b"changed\0binary\n").unwrap();

    let err = ctx.stage_shown_hunk("README.md", &shown).unwrap_err();

    assert_eq!(err.code, "stale_hunk");
}

#[test]
fn stage_hunk_stages_a_file_the_terminal_marked_intent_to_add() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello\n")
        .with_commit("Initial commit")
        .build();
    std::fs::write(ctx.repo_path().join("new.txt"), "one\ntwo\n").unwrap();
    let marked = std::process::Command::new("git")
        .args(["add", "--intent-to-add", "new.txt"])
        .current_dir(ctx.repo_path())
        .status()
        .unwrap();
    assert!(marked.success());
    let shown = ctx.shown_unstaged_hunk("new.txt", 0);

    ctx.stage_shown_hunk("new.txt", &shown).unwrap();

    assert_eq!(ctx.staged_content("new.txt"), "one\ntwo\n");
}

// -- unstage_hunk tests --

#[test]
fn unstage_hunk_refuses_a_file_left_unstaged_since_its_diff_was_shown() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello\n")
        .with_commit("Initial commit")
        .build();
    std::fs::write(ctx.repo_path().join("README.md"), "changed\n").unwrap();
    ctx.stage_file("README.md").unwrap();
    let shown = ctx.shown_staged_hunk("README.md", 0);
    ctx.unstage_file("README.md").unwrap();

    let err = ctx.unstage_shown_hunk("README.md", &shown).unwrap_err();

    assert_eq!(err.code, "stale_hunk");
}

#[test]
fn unstage_hunk_unstages_single_hunk() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_multi_hunk_file(&ctx);

    // Stage entire file first
    ctx.stage_file("multi.txt").expect("stage_file failed");

    // Unstage hunk 0 only
    ctx.unstage_hunk("multi.txt", 0)
        .expect("unstage_hunk failed");

    let staged = ctx.diff_staged("multi.txt").expect("diff_staged failed");
    assert_eq!(staged.len(), 1, "expected 1 file in staged diff");
    assert_eq!(
        staged[0].hunks.len(),
        1,
        "expected 1 hunk remaining in staged diff"
    );

    let unstaged = ctx
        .diff_unstaged("multi.txt")
        .expect("diff_unstaged failed");
    assert_eq!(unstaged.len(), 1, "expected 1 file in unstaged diff");
    assert_eq!(
        unstaged[0].hunks.len(),
        1,
        "expected 1 hunk in unstaged diff"
    );
}

// -- discard_hunk tests --

#[test]
fn discard_hunk_discards_single_hunk() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_multi_hunk_file(&ctx);

    ctx.discard_hunk("multi.txt", 0)
        .expect("discard_hunk failed");

    let unstaged = ctx
        .diff_unstaged("multi.txt")
        .expect("diff_unstaged failed");
    assert_eq!(unstaged.len(), 1, "expected 1 file in unstaged diff");
    assert_eq!(
        unstaged[0].hunks.len(),
        1,
        "expected 1 hunk remaining after discard"
    );
}

#[test]
fn discard_hunk_refuses_a_file_left_clean_since_its_diff_was_shown() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello\n")
        .with_commit("Initial commit")
        .build();
    std::fs::write(ctx.repo_path().join("README.md"), "changed\n").unwrap();
    let shown = ctx.shown_unstaged_hunk("README.md", 0);
    std::fs::write(ctx.repo_path().join("README.md"), "hello\n").unwrap();

    let err = ctx.discard_shown_hunk("README.md", &shown).unwrap_err();

    assert_eq!(err.code, "stale_hunk");
}

// -- Line-level staging fixture helper --

fn create_add_delete_hunk_file(ctx: &TestContext) {
    let original = (1..=30)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(ctx.repo_path().join("multi.txt"), &original).unwrap();

    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("multi.txt")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = repo.signature().unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "Add multi.txt", &tree, &[&head])
            .unwrap();
    }

    // Replace line 2 and insert a new line, plus modify line 29
    let mut lines: Vec<String> = original
        .lines()
        .map(std::string::ToString::to_string)
        .collect();
    lines[1] = "MODIFIED line 2".to_string();
    lines.insert(2, "INSERTED line 2.5".to_string());
    lines[29] = "MODIFIED line 29".to_string();
    let modified = lines.join("\n") + "\n";
    std::fs::write(ctx.repo_path().join("multi.txt"), &modified).unwrap();
}

// -- stage_lines tests --

#[test]
fn stage_lines_stages_selected_add_lines() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_add_delete_hunk_file(&ctx);

    let unstaged = ctx
        .diff_unstaged("multi.txt")
        .expect("diff_unstaged failed");
    assert!(!unstaged.is_empty(), "expected unstaged diff");
    let hunk0 = &unstaged[0].hunks[0];

    // Find indices of add lines
    let add_indices: Vec<u32> = hunk0
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add))
        .map(|(i, _)| u32::try_from(i).unwrap_or(u32::MAX))
        .collect();
    assert!(
        !add_indices.is_empty(),
        "expected at least one add line in hunk 0"
    );

    ctx.stage_lines("multi.txt", 0, &add_indices)
        .expect("stage_lines failed");

    let staged = ctx.diff_staged("multi.txt").expect("diff_staged failed");
    assert!(
        !staged.is_empty(),
        "expected staged diff after staging add lines"
    );
    let staged_hunk0 = &staged[0].hunks[0];
    assert!(
        staged_hunk0
            .lines
            .iter()
            .any(|l| matches!(l.origin, DiffOrigin::Add)),
        "expected add lines in staged diff"
    );

    assert!(
        !staged_hunk0
            .lines
            .iter()
            .any(|l| matches!(l.origin, DiffOrigin::Delete)),
        "expected no delete lines in staged diff when only adds were staged"
    );
}

#[test]
fn stage_lines_stages_selected_delete_lines() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_add_delete_hunk_file(&ctx);

    let unstaged = ctx
        .diff_unstaged("multi.txt")
        .expect("diff_unstaged failed");
    let hunk0 = &unstaged[0].hunks[0];

    let del_indices: Vec<u32> = hunk0
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Delete))
        .map(|(i, _)| u32::try_from(i).unwrap_or(u32::MAX))
        .collect();
    assert!(
        !del_indices.is_empty(),
        "expected at least one delete line in hunk 0"
    );

    ctx.stage_lines("multi.txt", 0, &del_indices)
        .expect("stage_lines failed");

    let staged = ctx.diff_staged("multi.txt").expect("diff_staged failed");
    assert!(
        !staged.is_empty(),
        "expected staged diff after staging delete lines"
    );
    let staged_hunk0 = &staged[0].hunks[0];
    assert!(
        staged_hunk0
            .lines
            .iter()
            .any(|l| matches!(l.origin, DiffOrigin::Delete)),
        "expected delete lines in staged diff"
    );

    assert!(
        !staged_hunk0
            .lines
            .iter()
            .any(|l| matches!(l.origin, DiffOrigin::Add)),
        "expected no add lines in staged diff when only deletes were staged"
    );
}

#[test]
fn stage_lines_mixed_add_and_delete_selection() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_add_delete_hunk_file(&ctx);

    let unstaged = ctx
        .diff_unstaged("multi.txt")
        .expect("diff_unstaged failed");
    let hunk0 = &unstaged[0].hunks[0];

    let mixed_indices: Vec<u32> = hunk0
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add | DiffOrigin::Delete))
        .map(|(i, _)| u32::try_from(i).unwrap_or(u32::MAX))
        .collect();
    assert!(
        mixed_indices.len() >= 2,
        "expected at least 2 add/delete lines for mixed selection"
    );

    ctx.stage_lines("multi.txt", 0, &mixed_indices)
        .expect("stage_lines failed");

    let staged = ctx.diff_staged("multi.txt").expect("diff_staged failed");
    assert!(!staged.is_empty(), "expected staged diff");
    let staged_hunk0 = &staged[0].hunks[0];
    let has_adds = staged_hunk0
        .lines
        .iter()
        .any(|l| matches!(l.origin, DiffOrigin::Add));
    let has_dels = staged_hunk0
        .lines
        .iter()
        .any(|l| matches!(l.origin, DiffOrigin::Delete));
    assert!(
        has_adds,
        "expected add lines in staged diff for mixed selection"
    );
    assert!(
        has_dels,
        "expected delete lines in staged diff for mixed selection"
    );
}

#[test]
fn stage_lines_refuses_a_shown_hunk_the_file_no_longer_has() {
    let (ctx, mut edited) = two_rewrites();
    let shown = ctx.shown_unstaged_hunk("two.txt", 1);
    let lines = shown.changed_lines();
    edited[24] = "line 25 rewritten again".to_string();
    std::fs::write(ctx.repo_path().join("two.txt"), joined(&edited)).unwrap();

    let err = ctx
        .stage_shown_lines("two.txt", &shown, &lines)
        .unwrap_err();

    assert_eq!(err.code, "stale_hunk");
    assert!(ctx.get_status().unwrap().staged.is_empty());
}

#[test]
fn stage_lines_works_on_untracked_file() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Create an untracked file
    std::fs::write(
        ctx.repo_path().join("new_file.txt"),
        "line 1\nline 2\nline 3\n",
    )
    .unwrap();

    let unstaged = ctx
        .diff_unstaged("new_file.txt")
        .expect("diff_unstaged failed");
    assert!(
        !unstaged.is_empty(),
        "expected unstaged diff for untracked file"
    );

    let add_indices: Vec<u32> = unstaged[0].hunks[0]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add))
        .map(|(i, _)| u32::try_from(i).unwrap_or(u32::MAX))
        .collect();
    assert!(!add_indices.is_empty(), "expected add lines");

    // Stage only the first add line
    ctx.stage_lines("new_file.txt", 0, &[add_indices[0]])
        .expect("stage_lines should work on untracked files");

    let status = ctx.get_status().expect("get_status failed");
    assert!(
        status.staged.iter().any(|f| f.path == "new_file.txt"),
        "expected new_file.txt in staged list"
    );
}

// -- unstage_lines tests --

#[test]
fn unstage_lines_unstages_selected_lines() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_add_delete_hunk_file(&ctx);

    // Stage entire file first
    ctx.stage_file("multi.txt").expect("stage_file failed");

    let staged = ctx.diff_staged("multi.txt").expect("diff_staged failed");
    assert!(!staged.is_empty(), "expected staged diff");
    let hunk0 = &staged[0].hunks[0];

    let add_indices: Vec<u32> = hunk0
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add))
        .map(|(i, _)| u32::try_from(i).unwrap_or(u32::MAX))
        .collect();
    assert!(
        !add_indices.is_empty(),
        "expected add lines in staged hunk 0"
    );

    ctx.unstage_lines("multi.txt", 0, &add_indices)
        .expect("unstage_lines failed");

    let unstaged_after = ctx
        .diff_unstaged("multi.txt")
        .expect("diff_unstaged failed");
    assert!(
        !unstaged_after.is_empty(),
        "expected unstaged diff after unstaging lines"
    );
    let has_adds_unstaged = unstaged_after[0]
        .hunks
        .iter()
        .flat_map(|h| &h.lines)
        .any(|l| matches!(l.origin, DiffOrigin::Add));
    assert!(
        has_adds_unstaged,
        "expected add lines in unstaged diff after unstaging"
    );
}

// -- stage_files / unstage_files tests --

#[test]
fn stage_files_stages_multiple_modified_files() {
    let ctx = TestContext::builder()
        .with_file("dir/a.txt", "a")
        .with_file("dir/b.txt", "b")
        .with_file("dir/c.txt", "c")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("dir/a.txt"), "a modified").unwrap();
    std::fs::write(ctx.repo_path().join("dir/b.txt"), "b modified").unwrap();
    std::fs::write(ctx.repo_path().join("dir/c.txt"), "c modified").unwrap();

    ctx.stage_files(&["dir/a.txt", "dir/b.txt", "dir/c.txt"])
        .expect("stage_files failed");

    let status = ctx.get_status().expect("get_status failed");
    assert_eq!(status.staged.len(), 3, "expected 3 staged files");
    assert!(status.unstaged.is_empty(), "expected no unstaged files");
}

#[test]
fn stage_files_handles_mix_of_new_and_modified() {
    let ctx = TestContext::builder()
        .with_file("dir/existing.txt", "original")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("dir/existing.txt"), "modified").unwrap();
    std::fs::write(ctx.repo_path().join("dir/new_file.txt"), "brand new").unwrap();

    ctx.stage_files(&["dir/existing.txt", "dir/new_file.txt"])
        .expect("stage_files failed");

    let status = ctx.get_status().expect("get_status failed");
    assert_eq!(status.staged.len(), 2, "expected 2 staged files");
    assert!(
        status.staged.iter().any(|f| f.path == "dir/existing.txt"),
        "expected dir/existing.txt in staged"
    );
    assert!(
        status.staged.iter().any(|f| f.path == "dir/new_file.txt"),
        "expected dir/new_file.txt in staged"
    );
}

#[test]
fn stage_files_handles_deleted_file() {
    let ctx = TestContext::builder()
        .with_file("dir/to_delete.txt", "content")
        .with_file("dir/keep.txt", "keep")
        .with_commit("Initial commit")
        .build();

    std::fs::remove_file(ctx.repo_path().join("dir/to_delete.txt")).unwrap();
    std::fs::write(ctx.repo_path().join("dir/keep.txt"), "modified").unwrap();

    ctx.stage_files(&["dir/to_delete.txt", "dir/keep.txt"])
        .expect("stage_files failed");

    let status = ctx.get_status().expect("get_status failed");
    assert_eq!(status.staged.len(), 2, "expected 2 staged files");
    assert!(
        status
            .staged
            .iter()
            .any(|f| f.path == "dir/to_delete.txt" && matches!(f.status, FileStatusType::Deleted)),
        "expected dir/to_delete.txt staged as deleted"
    );
}

#[test]
fn stage_files_empty_vec_is_noop() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("README.md"), "modified").unwrap();

    ctx.stage_files(&[])
        .expect("stage_files with empty vec should succeed");

    let status = ctx.get_status().expect("get_status failed");
    assert!(
        status.staged.is_empty(),
        "expected no staged files after empty stage_files"
    );
}

#[test]
fn stage_files_resolves_every_conflicted_path_it_names() {
    let ctx = TestContext::builder()
        .with_file("edited.txt", "original")
        .with_file("removed.txt", "original")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("edited.txt", "feature change")
        .with_file("removed.txt", "feature change")
        .with_commit("Feature change")
        .checkout("main")
        .with_file("edited.txt", "main change")
        .with_file("removed.txt", "main change")
        .with_commit("Main change")
        .with_conflict("feature")
        .build();
    std::fs::write(ctx.repo_path().join("edited.txt"), "resolved").unwrap();
    std::fs::remove_file(ctx.repo_path().join("removed.txt")).unwrap();

    ctx.stage_files(&["edited.txt", "removed.txt"])
        .expect("stage_files failed");

    let status = ctx.get_status().expect("get_status failed");
    let staged: Vec<_> = status
        .staged
        .iter()
        .map(|file| format!("{} {:?}", file.path, file.status))
        .collect();
    assert!(status.conflicted.is_empty(), "{:?}", status.conflicted);
    assert_eq!(staged, ["edited.txt Modified", "removed.txt Deleted"]);
    assert_eq!(ctx.staged_content("edited.txt"), "resolved");
}

#[test]
fn unstage_files_unstages_multiple_files() {
    let ctx = TestContext::builder()
        .with_file("dir/a.txt", "a")
        .with_file("dir/b.txt", "b")
        .with_file("dir/c.txt", "c")
        .with_commit("Initial commit")
        .build();

    std::fs::write(ctx.repo_path().join("dir/a.txt"), "a modified").unwrap();
    std::fs::write(ctx.repo_path().join("dir/b.txt"), "b modified").unwrap();
    std::fs::write(ctx.repo_path().join("dir/c.txt"), "c modified").unwrap();

    // Stage all first
    ctx.stage_all().expect("stage_all failed");

    let status_before = ctx.get_status().expect("get_status failed");
    assert_eq!(
        status_before.staged.len(),
        3,
        "expected 3 staged files before unstage"
    );

    ctx.unstage_files(&["dir/a.txt", "dir/b.txt", "dir/c.txt"])
        .expect("unstage_files failed");

    let status = ctx.get_status().expect("get_status failed");
    assert!(
        status.staged.is_empty(),
        "expected no staged files after unstage_files"
    );
    assert_eq!(
        status.unstaged.len(),
        3,
        "expected 3 unstaged files after unstage_files"
    );
}

#[test]
fn unstage_files_on_unborn_head() {
    let ctx = TestContext::new_empty();

    // Create files and stage them (no commits yet)
    std::fs::write(ctx.repo_path().join("a.txt"), "a").unwrap();
    std::fs::write(ctx.repo_path().join("b.txt"), "b").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.add_path(std::path::Path::new("b.txt")).unwrap();
        index.write().unwrap();
    }

    ctx.unstage_files(&["a.txt", "b.txt"])
        .expect("unstage_files on unborn HEAD should succeed");

    let status = ctx.get_status().expect("get_status failed");
    assert!(
        !status.staged.iter().any(|f| f.path == "a.txt"),
        "expected a.txt not in staged"
    );
    assert!(
        !status.staged.iter().any(|f| f.path == "b.txt"),
        "expected b.txt not in staged"
    );
}

#[test]
fn unstage_files_empty_vec_is_noop() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Stage a file
    std::fs::write(ctx.repo_path().join("README.md"), "modified").unwrap();
    ctx.stage_file("README.md").expect("stage_file failed");

    ctx.unstage_files(&[])
        .expect("unstage_files with empty vec should succeed");

    let status = ctx.get_status().expect("get_status failed");
    assert!(
        !status.staged.is_empty(),
        "expected staged file to remain after empty unstage_files"
    );
}

// -- discard_lines tests --

#[test]
fn discard_lines_removes_selected_add_lines_from_file() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_add_delete_hunk_file(&ctx);

    let unstaged = ctx
        .diff_unstaged("multi.txt")
        .expect("diff_unstaged failed");
    let hunk0 = &unstaged[0].hunks[0];

    let add_info: Vec<(u32, String)> = hunk0
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add))
        .map(|(i, l)| (u32::try_from(i).unwrap_or(u32::MAX), l.content.clone()))
        .collect();
    assert!(!add_info.is_empty(), "expected add lines in hunk 0");
    let add_indices: Vec<u32> = add_info.iter().map(|(i, _)| *i).collect();
    let add_contents: Vec<String> = add_info.iter().map(|(_, c)| c.clone()).collect();

    ctx.discard_lines("multi.txt", 0, &add_indices)
        .expect("discard_lines failed");

    let file_content = std::fs::read_to_string(ctx.repo_path().join("multi.txt")).unwrap();
    let file_lines: Vec<&str> = file_content.lines().collect();
    for content in &add_contents {
        let trimmed = content.trim();
        assert!(
            !file_lines.contains(&trimmed),
            "expected discarded add line '{trimmed}' to be gone from file"
        );
    }
}

// -- get_dirty_counts per-status bucketing --

#[test]
fn dirty_counts_buckets_each_path_once() {
    use trunk_lib::commands::staging::get_dirty_counts_inner;

    let ctx = TestContext::builder()
        .with_file("mod.txt", "original")
        .with_file("del.txt", "to delete")
        .with_commit("Initial commit")
        .build();

    // new.txt: untracked → new bucket
    std::fs::write(ctx.repo_path().join("new.txt"), "fresh").unwrap();
    // del.txt: removed from working tree → deleted bucket
    std::fs::remove_file(ctx.repo_path().join("del.txt")).unwrap();
    // mod.txt: staged AND modified again. It is both INDEX_MODIFIED and
    // WT_MODIFIED, so union counting (staged + unstaged) double-counts it, but
    // the priority buckets must count it exactly once (modified).
    std::fs::write(ctx.repo_path().join("mod.txt"), "staged change").unwrap();
    ctx.stage_file("mod.txt").expect("stage_file failed");
    std::fs::write(ctx.repo_path().join("mod.txt"), "second change").unwrap();

    let c = get_dirty_counts_inner(ctx.path(), ctx.state_map()).expect("get_dirty_counts failed");

    assert_eq!(c.modified, 1, "mod.txt counted once in modified");
    assert_eq!(c.new, 1, "new.txt in new bucket");
    assert_eq!(c.deleted, 1, "del.txt in deleted bucket");
    assert_eq!(c.renamed, 0);
    assert_eq!(c.typechange, 0);
    assert_eq!(c.conflicted, 0);

    // Three distinct dirty paths; buckets sum to the distinct count even though
    // union counting (staged + unstaged) would over-count mod.txt.
    let bucket_sum = c.modified + c.new + c.deleted + c.renamed + c.typechange + c.conflicted;
    assert_eq!(bucket_sum, 3, "buckets sum to distinct dirty paths");
    assert_eq!(
        c.staged + c.unstaged,
        4,
        "union counting double-counts the staged+remodified path"
    );
}

#[test]
fn dirty_counts_conflicted_path_goes_to_conflicted_bucket() {
    use trunk_lib::commands::staging::get_dirty_counts_inner;

    let ctx = TestContext::builder()
        .with_file("file.txt", "original")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature version")
        .with_commit("Feature change")
        .checkout("main")
        .with_file("file.txt", "main version")
        .with_commit("Main change")
        .with_conflict("feature")
        .build();

    let c = get_dirty_counts_inner(ctx.path(), ctx.state_map()).expect("get_dirty_counts failed");

    assert!(c.conflicted >= 1, "conflicted file counted as conflicted");
    // Conflicted sits at the top of the priority chain, so the conflicted path
    // must not also land in the modified bucket.
    assert_eq!(
        c.modified, 0,
        "conflicted path excluded from modified bucket"
    );
}

/// The staging list pairs a staged rename into one entry, so the counts the graph's
/// uncommitted-changes row shows must too, or the two views of one tree disagree.
#[test]
fn dirty_counts_count_a_staged_rename_once_as_renamed() {
    use trunk_lib::commands::staging::get_dirty_counts_inner;

    let ctx = staged_rename_with_one_edit();

    let c = get_dirty_counts_inner(ctx.path(), ctx.state_map()).expect("get_dirty_counts failed");

    assert_eq!(
        (c.staged, c.renamed, c.new, c.deleted),
        (1, 1, 0, 0),
        "one staged rename is one staged, renamed file"
    );
}

// -- pathspec is a filename, not a glob --

/// libgit2 matches a pathspec with fnmatch unless told otherwise, so a filename
/// carrying `[`, `]`, `*` or `?` selects every file the pattern happens to match.
/// Every hunk and discard path then acts on whichever of them the diff lists first.
mod pathspec_is_literal {
    use super::*;
    use trunk_lib::commands::staging::discard_file_inner;

    const GLOB_NAME: &str = "foo[1].txt";
    const COLLIDING_NAME: &str = "foo1.txt";

    fn context_with_colliding_names() -> TestContext {
        let ctx = TestContext::builder()
            .with_file(GLOB_NAME, "one\ntwo\nthree\n")
            .with_file(COLLIDING_NAME, "one\ntwo\nthree\n")
            .with_commit("Initial commit")
            .build();

        std::fs::write(ctx.repo_path().join(GLOB_NAME), "one\nCHANGED\nthree\n").unwrap();
        std::fs::write(
            ctx.repo_path().join(COLLIDING_NAME),
            "one\nUNTOUCHED\nthree\n",
        )
        .unwrap();
        ctx
    }

    fn read(ctx: &TestContext, name: &str) -> String {
        std::fs::read_to_string(ctx.repo_path().join(name)).unwrap()
    }

    #[test]
    fn discard_hunk_leaves_a_glob_matched_sibling_alone() {
        let ctx = context_with_colliding_names();

        ctx.discard_hunk(GLOB_NAME, 0).unwrap();

        assert_eq!(
            read(&ctx, COLLIDING_NAME),
            "one\nUNTOUCHED\nthree\n",
            "discarding a hunk of {GLOB_NAME} must not touch {COLLIDING_NAME}"
        );
        assert_eq!(read(&ctx, GLOB_NAME), "one\ntwo\nthree\n");
    }

    #[test]
    fn discard_file_leaves_a_glob_matched_sibling_alone() {
        let ctx = context_with_colliding_names();

        discard_file_inner(ctx.path(), GLOB_NAME, ctx.state_map()).unwrap();

        assert_eq!(
            read(&ctx, COLLIDING_NAME),
            "one\nUNTOUCHED\nthree\n",
            "discarding {GLOB_NAME} must not touch {COLLIDING_NAME}"
        );
        assert_eq!(read(&ctx, GLOB_NAME), "one\ntwo\nthree\n");
    }
}

#[test]
fn conflicted_binary_file_is_reported_as_binary() {
    let ctx = TestContext::builder()
        .with_binary_file("image.png", b"\x89PNG\r\n\x1a\n\x00\x00\xff\xfeBASE")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_binary_file("image.png", b"\x89PNG\r\n\x1a\n\x00\x00\xff\xfeTHEM")
        .with_commit("Feature commit")
        .checkout("main")
        .with_binary_file("image.png", b"\x89PNG\r\n\x1a\n\x00\x00\xff\xfeOURS")
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    let status = ctx.get_status().expect("get_status failed");

    let entry = status
        .conflicted
        .iter()
        .find(|f| f.path == "image.png")
        .expect("image.png should be conflicted");
    assert!(
        entry.is_binary,
        "a conflicted PNG must not be reported as text"
    );
}

/// A tracked symlink whose target does not exist. `Path::exists()` follows the
/// link and reports false, which reads as "the file was deleted".
#[cfg(unix)]
fn dangling_symlink_ctx() -> TestContext {
    let ctx = TestContext::builder()
        .with_file("real.txt", "content")
        .with_commit("Initial commit")
        .build();

    let link = ctx.repo_path().join("link");
    std::os::unix::fs::symlink("real.txt", &link).unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("link")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "Add link", &tree, &[&parent])
            .unwrap();
    }

    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink("gone.txt", &link).unwrap();

    ctx
}

#[cfg(unix)]
#[test]
fn staging_a_symlink_that_now_dangles_keeps_it_in_the_index() {
    let ctx = dangling_symlink_ctx();

    ctx.stage_file("link").expect("stage_file failed");

    let repo = ctx.repo();
    let entry = repo
        .index()
        .unwrap()
        .get_path(std::path::Path::new("link"), 0)
        .expect("link must stay in the index");
    let target = repo.find_blob(entry.id).unwrap();
    assert_eq!(target.content(), b"gone.txt");
}

#[cfg(unix)]
#[test]
fn staging_many_keeps_a_symlink_that_now_dangles_in_the_index() {
    let ctx = dangling_symlink_ctx();

    ctx.stage_files(&["link"]).expect("stage_files failed");

    let index = ctx.repo().index().unwrap();
    assert!(
        index.get_path(std::path::Path::new("link"), 0).is_some(),
        "link must stay in the index"
    );
}

// -- staged renames (TRUNK-82) --

/// A rename staged in the index, with one line of the file also changed. The
/// staged view pairs the two sides into a single renamed entry carrying one
/// hunk, so every staging gesture must act on that same pairing: a diff rebuilt
/// without rename detection sees a whole-file add instead, and its hunk 0 is the
/// entire file rather than the line the user clicked (TRUNK-73's failure mode).
fn staged_rename_with_one_edit() -> TestContext {
    staged_rename_with_one_edit_beside("util.ts", "math-util.ts", &[])
}

/// The same staged rename between the two named paths, with each file in `beside`
/// committed next to the renamed one and left untouched.
fn staged_rename_with_one_edit_beside(
    old_path: &str,
    new_path: &str,
    beside: &[&str],
) -> TestContext {
    let original = (1..=20).fold(String::new(), |mut out, n| {
        let _ = writeln!(out, "export const value{n} = {n};");
        out
    });
    let edited = original.replace(
        "export const value7 = 7;",
        "export const value7 = 7 + offset;",
    );

    let mut builder = TestContext::builder();
    builder.with_file(old_path, &original);
    for path in beside {
        builder.with_file(path, "beside\n");
    }
    let ctx = builder
        .with_commit("add the files")
        .with_removed_file(old_path)
        .with_file(new_path, &edited)
        .build();

    let repo = ctx.repo();
    let mut index = repo.index().unwrap();
    index.remove_path(std::path::Path::new(old_path)).unwrap();
    index.add_path(std::path::Path::new(new_path)).unwrap();
    index.write().unwrap();

    ctx
}

/// The staging list's staged rows, each named by its path.
fn staged_rows(ctx: &TestContext) -> Vec<String> {
    ctx.get_status()
        .unwrap()
        .staged
        .into_iter()
        .map(|file| file.path)
        .collect()
}

fn staged_paths(ctx: &TestContext) -> Vec<String> {
    let repo = ctx.repo();
    let index = repo.index().unwrap();

    index
        .iter()
        .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
        .collect()
}

/// A staged rename is one delta: its hunks describe the edit, and reversing any
/// of them reverses the rename that carries them. git behaves the same way —
/// `git restore --staged` on the new path leaves `D old` and `?? new`. What must
/// not happen is the pre-fix outcome, where the index came back empty because
/// staging rebuilt the diff without rename detection and reversed a whole-file
/// add it invented.
#[test]
fn unstaging_a_hunk_of_a_staged_rename_reverts_the_rename_without_losing_the_file() {
    let ctx = staged_rename_with_one_edit();

    let view = ctx.diff_staged("math-util.ts").expect("diff_staged failed");
    assert_eq!(view.len(), 1, "the view pairs the rename into one entry");
    assert_eq!(view[0].hunks.len(), 1, "one edited line, so one hunk");

    ctx.unstage_hunk("math-util.ts", 0)
        .expect("unstage_hunk failed");

    assert_eq!(
        staged_paths(&ctx),
        vec!["util.ts".to_string()],
        "the index holds the pre-rename file, as after git restore --staged"
    );
    assert!(
        ctx.repo_path().join("math-util.ts").exists(),
        "the renamed file stays in the working tree"
    );
}

/// The reversed patch names each side's own path. A header repeating one path
/// on both sides is rejected by libgit2 outright ("mismatched new path names"),
/// which is what a rename hit before the fix: a legitimate gesture failed with
/// an internal parser message.
#[test]
fn unstaging_selected_lines_of_a_staged_rename_applies_without_a_patch_error() {
    let ctx = staged_rename_with_one_edit();

    let view = ctx.diff_staged("math-util.ts").expect("diff_staged failed");
    let added = view[0].hunks[0]
        .lines
        .iter()
        .position(|line| matches!(line.origin, DiffOrigin::Add))
        .expect("the hunk holds the added line");

    ctx.unstage_lines(
        "math-util.ts",
        0,
        &[u32::try_from(added).unwrap_or(u32::MAX)],
    )
    .expect("unstage_lines failed");

    let staged = staged_paths(&ctx);
    assert!(
        staged.contains(&"util.ts".to_string()),
        "the pre-rename file is back in the index, got {staged:?}"
    );
    assert!(
        ctx.repo_path().join("math-util.ts").exists(),
        "the renamed file stays in the working tree"
    );
}

/// Unstaging part of a rename's edit reverses the rename that carries it, as a hunk
/// does. A patch that names both paths without calling itself a rename stages the
/// old file again beside the new one, which the next commit would then carry.
#[test]
fn unstaging_selected_lines_of_a_staged_rename_leaves_one_file_staged() {
    let ctx = staged_rename_with_one_edit();
    let shown = ctx.shown_staged_hunk("math-util.ts", 0);
    let added = shown
        .lines
        .iter()
        .position(|line| matches!(line.origin, DiffOrigin::Add))
        .expect("the hunk holds the added line");

    ctx.unstage_shown_lines("math-util.ts", &shown, &[u32::try_from(added).unwrap()])
        .unwrap();

    assert_eq!(staged_paths(&ctx), vec!["util.ts".to_string()]);
}

/// The staging list shows a staged rename as one row, so unstaging that row puts the
/// whole rename back. Resetting only the new path left the old path's deletion staged,
/// and the row came back as a staged delete of the file the user had just unstaged.
#[test]
fn unstaging_a_staged_rename_unstages_both_of_its_paths() {
    let ctx = staged_rename_with_one_edit();

    ctx.unstage_file("math-util.ts").unwrap();

    assert_eq!(staged_rows(&ctx), Vec::<String>::new());
}

#[test]
fn unstaging_a_staged_rename_among_several_files_unstages_both_of_its_paths() {
    let ctx = staged_rename_with_one_edit();

    ctx.unstage_files(&["math-util.ts"]).unwrap();

    assert_eq!(staged_rows(&ctx), Vec::<String>::new());
}

#[test]
fn unstaging_everything_unstages_both_paths_of_a_staged_rename() {
    let ctx = staged_rename_with_one_edit();

    ctx.unstage_all().unwrap();

    assert_eq!(staged_rows(&ctx), Vec::<String>::new());
}

/// The staged file list is a separate libgit2 call from the staged diff
/// (`repo.statuses()` vs. `diff_tree_to_index`), with its own rename option.
/// Without it, `head_to_index()` never pairs the two sides, so the row this
/// list feeds shows as a plain add — the diff pane already read it as a
/// rename, but the file list next to it did not.
#[test]
fn staged_file_list_pairs_a_staged_rename() {
    let ctx = staged_rename_with_one_edit();

    let status = ctx.get_status().expect("get_status failed");

    assert_eq!(status.staged.len(), 1, "the rename is one entry, not two");
    assert_eq!(status.staged[0].path, "math-util.ts");
    assert_eq!(
        status.staged[0].old_path.as_deref(),
        Some("util.ts"),
        "the entry names the path it was renamed from"
    );
}

/// A staged rename with a further, unstaged edit on top: `head_to_index` pairs
/// util.ts -> math-util.ts, so `entry.path()` reads the old side for this entry
/// too, even though the unstaged row's own delta is `index_to_workdir`. The
/// unstaged row must still read the current path, not the pre-rename one.
#[test]
fn staged_rename_with_a_further_unstaged_edit_shows_the_current_path() {
    let ctx = staged_rename_with_one_edit();
    std::fs::write(
        ctx.repo_path().join("math-util.ts"),
        "export const value1 = 999;\n",
    )
    .unwrap();

    let status = ctx.get_status().expect("get_status failed");

    assert_eq!(status.unstaged.len(), 1);
    assert_eq!(
        status.unstaged[0].path, "math-util.ts",
        "unstaged row should show the current path, not the pre-rename one"
    );
}

// -- staging under the view's options (TRUNK-73) --

/// A file whose first change is whitespace-only, followed by two real edits.
///
/// The whitespace change is what makes the two diffs disagree: the view under
/// ignore-whitespace shows two hunks, while a diff built without the option
/// shows three, and wide context merges all three into one. An action that
/// rebuilt the diff without the view's options would act on a different hunk,
/// or find none and refuse.
fn whitespace_change_before_real_ones(ctx: &TestContext) -> String {
    let original = (1..=40)
        .map(|i| format!("line {i}"))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(ctx.repo_path().join("ws.txt"), &original).unwrap();

    let repo = ctx.repo();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("ws.txt")).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = repo.signature().unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "add ws.txt", &tree, &[&head])
        .unwrap();

    let mut lines: Vec<String> = original
        .trim_end_matches('\n')
        .split('\n')
        .map(std::string::ToString::to_string)
        .collect();
    lines[1] = "line 2   ".to_string();
    lines[20] = "REAL line 21".to_string();
    lines[38] = "REAL line 39".to_string();
    let modified = lines.join("\n") + "\n";
    std::fs::write(ctx.repo_path().join("ws.txt"), &modified).unwrap();

    modified
}

/// What `ws.txt` actually holds in the index, which is the only evidence that
/// says which lines a staging gesture really wrote.
fn staged_content(ctx: &TestContext, file_path: &str) -> String {
    let repo = ctx.repo();
    let entry = repo
        .index()
        .unwrap()
        .get_path(std::path::Path::new(file_path), 0)
        .expect("the file is in the index");
    String::from_utf8(repo.find_blob(entry.id).unwrap().content().to_vec()).unwrap()
}

fn ignore_whitespace() -> DiffRequestOptions {
    DiffRequestOptions {
        ignore_whitespace: true,
        ..DiffRequestOptions::default()
    }
}

#[test]
fn staging_a_hunk_under_ignore_whitespace_stages_the_lines_the_view_showed() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    whitespace_change_before_real_ones(&ctx);

    let view = ctx
        .diff_unstaged_with_options("ws.txt", &ignore_whitespace())
        .expect("diff_unstaged failed");
    assert_eq!(
        view[0].hunks.len(),
        2,
        "the view hides the whitespace-only change"
    );

    ctx.stage_hunk_with_options("ws.txt", 0, &ignore_whitespace())
        .expect("stage_hunk failed");

    let staged = staged_content(&ctx, "ws.txt");
    assert!(
        staged.contains("REAL line 21"),
        "the change the view showed as hunk 0 must be in the index, got:\n{staged}"
    );
    assert!(
        !staged.contains("line 2   "),
        "the whitespace-only change the view hid must not be in the index, got:\n{staged}"
    );
}

#[test]
fn staging_a_hunk_under_wide_context_stages_only_the_merged_hunk_shown() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    whitespace_change_before_real_ones(&ctx);

    // Wide context merges every change into one displayed hunk, so staging it
    // must stage all three, not the first of a three-hunk rebuild.
    let wide = DiffRequestOptions {
        context_lines: 20,
        ..DiffRequestOptions::default()
    };

    let view = ctx
        .diff_unstaged_with_options("ws.txt", &wide)
        .expect("diff_unstaged failed");
    assert_eq!(view[0].hunks.len(), 1, "wide context merges the changes");

    ctx.stage_hunk_with_options("ws.txt", 0, &wide)
        .expect("stage_hunk failed");

    let staged = staged_content(&ctx, "ws.txt");
    for expected in ["line 2   ", "REAL line 21", "REAL line 39"] {
        assert!(
            staged.contains(expected),
            "the merged hunk the view showed must be staged whole, missing {expected:?} in:\n{staged}"
        );
    }
}

#[test]
fn staging_lines_under_ignore_whitespace_stages_the_lines_the_view_showed() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    whitespace_change_before_real_ones(&ctx);

    let view = ctx
        .diff_unstaged_with_options("ws.txt", &ignore_whitespace())
        .expect("diff_unstaged failed");
    let hunk0 = &view[0].hunks[0];
    let adds: Vec<u32> = hunk0
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add))
        .map(|(i, _)| u32::try_from(i).unwrap_or(u32::MAX))
        .collect();

    ctx.stage_lines_with_options("ws.txt", 0, &adds, &ignore_whitespace())
        .expect("stage_lines failed");

    let staged = staged_content(&ctx, "ws.txt");
    assert!(
        staged.contains("REAL line 21"),
        "the line the view showed must be in the index, got:\n{staged}"
    );
    assert!(
        !staged.contains("line 2   "),
        "the whitespace-only change the view hid must not be in the index, got:\n{staged}"
    );
}

#[test]
fn unstaging_a_hunk_under_ignore_whitespace_unstages_the_lines_the_view_showed() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    whitespace_change_before_real_ones(&ctx);
    ctx.stage_file("ws.txt").expect("stage_file failed");

    let view = ctx
        .diff_staged_with_options("ws.txt", &ignore_whitespace())
        .expect("diff_staged failed");
    assert_eq!(
        view[0].hunks.len(),
        2,
        "the view hides the whitespace-only change"
    );

    ctx.unstage_hunk_with_options("ws.txt", 0, &ignore_whitespace())
        .expect("unstage_hunk failed");

    let staged = staged_content(&ctx, "ws.txt");
    assert!(
        !staged.contains("REAL line 21"),
        "the change the view showed as hunk 0 must be out of the index, got:\n{staged}"
    );
    assert!(
        staged.contains("line 2   "),
        "the whitespace-only change the view hid must stay staged, got:\n{staged}"
    );
}

#[test]
fn unstaging_a_hunk_under_wide_context_unstages_the_merged_hunk_shown() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    whitespace_change_before_real_ones(&ctx);
    ctx.stage_file("ws.txt").unwrap();

    ctx.unstage_hunk_with_options("ws.txt", 0, &wide_context())
        .unwrap();

    let staged = staged_content(&ctx, "ws.txt");
    for unstaged in ["line 2   ", "REAL line 21", "REAL line 39"] {
        assert!(!staged.contains(unstaged), "{unstaged:?} left the index");
    }
}

#[test]
fn discarding_a_hunk_under_wide_context_discards_the_merged_hunk_shown() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    whitespace_change_before_real_ones(&ctx);

    ctx.discard_hunk_with_options("ws.txt", 0, &wide_context())
        .unwrap();

    let on_disk = std::fs::read_to_string(ctx.repo_path().join("ws.txt")).unwrap();
    for discarded in ["line 2   ", "REAL line 21", "REAL line 39"] {
        assert!(!on_disk.contains(discarded), "{discarded:?} was discarded");
    }
}

fn wide_context() -> DiffRequestOptions {
    DiffRequestOptions {
        context_lines: 20,
        ..DiffRequestOptions::default()
    }
}

// -- no-newline-at-EOF marker tests --

/// A file whose last line has no trailing newline, changed on both its first
/// and its last line, so the hunk carries the marker on each side.
fn create_no_trailing_newline_file(ctx: &TestContext) {
    let path = ctx.repo_path().join("nonl.txt");
    std::fs::write(&path, "a\nb\nc\nd").unwrap();

    let repo = ctx.repo();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("nonl.txt")).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = repo.signature().unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "Add nonl.txt", &tree, &[&head])
        .unwrap();

    std::fs::write(&path, "A\nb\nc\nD").unwrap();
}

#[test]
fn stage_lines_stages_the_first_line_of_a_file_without_a_trailing_newline() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_no_trailing_newline_file(&ctx);

    let unstaged = ctx.diff_unstaged("nonl.txt").expect("diff_unstaged failed");
    let hunk0 = &unstaged[0].hunks[0];
    let first_change: Vec<u32> = hunk0
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add | DiffOrigin::Delete))
        .map(|(i, _)| u32::try_from(i).unwrap())
        .take(2)
        .collect();

    ctx.stage_lines("nonl.txt", 0, &first_change)
        .expect("stage_lines failed");

    assert_eq!(
        ctx.staged_content("nonl.txt"),
        "A\nb\nc\nd",
        "staging the first line's change leaves the last line at its old value, still unterminated"
    );
}

#[test]
fn stage_lines_stages_the_unterminated_last_line_of_a_file() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_no_trailing_newline_file(&ctx);

    let unstaged = ctx.diff_unstaged("nonl.txt").expect("diff_unstaged failed");
    let hunk0 = &unstaged[0].hunks[0];
    let last_change: Vec<u32> = hunk0
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add | DiffOrigin::Delete))
        .map(|(i, _)| u32::try_from(i).unwrap())
        .skip(2)
        .collect();

    ctx.stage_lines("nonl.txt", 0, &last_change)
        .expect("stage_lines failed");

    assert_eq!(
        ctx.staged_content("nonl.txt"),
        "a\nb\nc\nD",
        "staging the last line's change keeps it unterminated and leaves the first line alone"
    );
}

#[test]
fn stage_lines_stages_a_newly_added_trailing_newline() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_no_trailing_newline_file(&ctx);
    // The change now only terminates the last line, leaving its text alone.
    std::fs::write(ctx.repo_path().join("nonl.txt"), "a\nb\nc\nd\n").unwrap();

    let unstaged = ctx.diff_unstaged("nonl.txt").expect("diff_unstaged failed");
    let hunk0 = &unstaged[0].hunks[0];
    let changed: Vec<u32> = hunk0
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add | DiffOrigin::Delete))
        .map(|(i, _)| u32::try_from(i).unwrap())
        .collect();

    ctx.stage_lines("nonl.txt", 0, &changed)
        .expect("stage_lines failed");

    assert_eq!(
        ctx.staged_content("nonl.txt"),
        "a\nb\nc\nd\n",
        "staging the change that terminates the last line writes the newline"
    );
}

#[test]
fn discard_lines_discards_a_change_to_an_unterminated_last_line() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_no_trailing_newline_file(&ctx);

    let unstaged = ctx.diff_unstaged("nonl.txt").expect("diff_unstaged failed");
    let hunk0 = &unstaged[0].hunks[0];
    let last_change: Vec<u32> = hunk0
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add | DiffOrigin::Delete))
        .map(|(i, _)| u32::try_from(i).unwrap())
        .skip(2)
        .collect();

    ctx.discard_lines("nonl.txt", 0, &last_change)
        .expect("discard_lines failed");

    assert_eq!(
        std::fs::read_to_string(ctx.repo_path().join("nonl.txt")).unwrap(),
        "A\nb\nc\nd",
        "discarding the last line's change restores it, still unterminated"
    );
}

#[test]
fn unstage_lines_unstages_a_change_to_an_unterminated_last_line() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_no_trailing_newline_file(&ctx);
    ctx.stage_file("nonl.txt").expect("stage_file failed");

    let staged = ctx.diff_staged("nonl.txt").expect("diff_staged failed");
    let hunk0 = &staged[0].hunks[0];
    let last_change: Vec<u32> = hunk0
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add | DiffOrigin::Delete))
        .map(|(i, _)| u32::try_from(i).unwrap())
        .skip(2)
        .collect();

    ctx.unstage_lines("nonl.txt", 0, &last_change)
        .expect("unstage_lines failed");

    assert_eq!(
        ctx.staged_content("nonl.txt"),
        "A\nb\nc\nd",
        "unstaging the last line's change leaves it at its old value, still unterminated"
    );
}

// -- hunks shifted by an earlier change --

/// Thirty numbered lines, one per line, each terminated.
fn numbered_lines() -> Vec<String> {
    (1..=30).map(|n| format!("line {n}")).collect()
}

fn joined(lines: &[String]) -> String {
    lines.join("\n") + "\n"
}

/// The indices of a hunk's changed lines, additions and deletions both.
fn changed_lines(ctx_diff: &[trunk_lib::types::FileDiff], hunk: usize) -> Vec<u32> {
    ctx_diff[0].hunks[hunk]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add | DiffOrigin::Delete))
        .map(|(i, _)| u32::try_from(i).unwrap())
        .collect()
}

/// Commits thirty lines, then inserts a line after line 2 and rewrites line 20,
/// so the second hunk starts one line later on the new side than on the old.
fn shifted_by_an_insertion() -> (TestContext, Vec<String>, Vec<String>) {
    let original = numbered_lines();
    let ctx = TestContext::builder()
        .with_file("shift.txt", &joined(&original))
        .with_commit("Initial commit")
        .build();
    let mut edited = original.clone();
    edited[19] = "line 20 rewritten".to_string();
    edited.insert(2, "inserted".to_string());
    std::fs::write(ctx.repo_path().join("shift.txt"), joined(&edited)).unwrap();
    (ctx, original, edited)
}

#[test]
fn stage_lines_stages_a_hunk_an_earlier_insertion_moved_down() {
    let (ctx, original, _) = shifted_by_an_insertion();
    let unstaged = ctx
        .diff_unstaged("shift.txt")
        .expect("diff_unstaged failed");
    assert_eq!(unstaged[0].hunks.len(), 2, "the edit makes two hunks");

    ctx.stage_lines("shift.txt", 1, &changed_lines(&unstaged, 1))
        .expect("stage_lines failed");

    let mut expected = original;
    expected[19] = "line 20 rewritten".to_string();
    assert_eq!(ctx.staged_content("shift.txt"), joined(&expected));
}

#[test]
fn stage_lines_stages_a_hunk_an_earlier_deletion_moved_up() {
    let original = numbered_lines();
    let ctx = TestContext::builder()
        .with_file("shift.txt", &joined(&original))
        .with_commit("Initial commit")
        .build();
    let mut edited = original.clone();
    edited[19] = "line 20 rewritten".to_string();
    edited.remove(2);
    std::fs::write(ctx.repo_path().join("shift.txt"), joined(&edited)).unwrap();

    let unstaged = ctx
        .diff_unstaged("shift.txt")
        .expect("diff_unstaged failed");
    ctx.stage_lines("shift.txt", 1, &changed_lines(&unstaged, 1))
        .expect("stage_lines failed");

    let mut expected = original;
    expected[19] = "line 20 rewritten".to_string();
    assert_eq!(ctx.staged_content("shift.txt"), joined(&expected));
}

#[test]
fn unstage_lines_unstages_a_hunk_an_earlier_insertion_moved_down() {
    let (ctx, original, _) = shifted_by_an_insertion();
    ctx.stage_file("shift.txt").expect("stage_file failed");
    let staged = ctx.diff_staged("shift.txt").expect("diff_staged failed");

    ctx.unstage_lines("shift.txt", 1, &changed_lines(&staged, 1))
        .expect("unstage_lines failed");

    let mut expected = original;
    expected.insert(2, "inserted".to_string());
    assert_eq!(ctx.staged_content("shift.txt"), joined(&expected));
}

#[test]
fn discard_lines_discards_in_a_hunk_an_earlier_insertion_moved_down() {
    let (ctx, original, _) = shifted_by_an_insertion();
    let unstaged = ctx
        .diff_unstaged("shift.txt")
        .expect("diff_unstaged failed");

    ctx.discard_lines("shift.txt", 1, &changed_lines(&unstaged, 1))
        .expect("discard_lines failed");

    let mut expected = original;
    expected.insert(2, "inserted".to_string());
    assert_eq!(
        std::fs::read_to_string(ctx.repo_path().join("shift.txt")).unwrap(),
        joined(&expected)
    );
}

// -- a line added after an unterminated last line --

#[test]
fn stage_lines_keeps_a_line_added_after_an_unterminated_last_line_on_its_own_line() {
    let ctx = TestContext::builder()
        .with_file("tail.txt", "a\nb\n}")
        .with_commit("Initial commit")
        .build();
    std::fs::write(ctx.repo_path().join("tail.txt"), "a\nb\n}\nfunc tail()\n").unwrap();
    let unstaged = ctx.diff_unstaged("tail.txt").expect("diff_unstaged failed");
    let added_tail: Vec<u32> = unstaged[0].hunks[0]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add) && l.content.starts_with("func"))
        .map(|(i, _)| u32::try_from(i).unwrap())
        .collect();
    assert_eq!(added_tail.len(), 1);

    ctx.stage_lines("tail.txt", 0, &added_tail)
        .expect("stage_lines failed");

    assert_eq!(ctx.staged_content("tail.txt"), "a\nb\n}\nfunc tail()\n");
}

#[test]
fn stage_lines_of_the_terminated_copy_of_an_unterminated_last_line_adds_only_its_newline() {
    let ctx = TestContext::builder()
        .with_file("tail.txt", "a\nb\n}")
        .with_commit("Initial commit")
        .build();
    std::fs::write(ctx.repo_path().join("tail.txt"), "a\nb\n}\nfunc tail()\n").unwrap();
    let unstaged = ctx.diff_unstaged("tail.txt").expect("diff_unstaged failed");
    let terminated_brace: Vec<u32> = unstaged[0].hunks[0]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add) && l.content.starts_with('}'))
        .map(|(i, _)| u32::try_from(i).unwrap())
        .collect();
    assert_eq!(terminated_brace.len(), 1);

    ctx.stage_lines("tail.txt", 0, &terminated_brace)
        .expect("stage_lines failed");

    assert_eq!(ctx.staged_content("tail.txt"), "a\nb\n}\n");
}

#[test]
fn stage_lines_keeps_every_selected_addition_after_a_changed_unterminated_last_line() {
    let ctx = TestContext::builder()
        .with_file("tail.txt", "if (a) {\n\tb();\n}")
        .with_commit("Initial commit")
        .build();
    std::fs::write(
        ctx.repo_path().join("tail.txt"),
        "if (a) {\n\tb();\n} else {\n\tc();\n}\n",
    )
    .unwrap();
    let unstaged = ctx.diff_unstaged("tail.txt").expect("diff_unstaged failed");
    let additions: Vec<u32> = unstaged[0].hunks[0]
        .lines
        .iter()
        .enumerate()
        .filter(|(_, l)| matches!(l.origin, DiffOrigin::Add))
        .map(|(i, _)| u32::try_from(i).unwrap())
        .collect();
    assert_eq!(
        additions.len(),
        3,
        "the edit adds three lines after the old brace"
    );

    ctx.stage_lines("tail.txt", 0, &additions)
        .expect("stage_lines failed");

    assert_eq!(
        ctx.staged_content("tail.txt"),
        "if (a) {\n\tb();\n}\n} else {\n\tc();\n}\n"
    );
}

/// Commits thirty lines and rewrites lines 10 and 25, so the file shows two hunks
/// and the second one is the rewrite of line 25.
fn two_rewrites() -> (TestContext, Vec<String>) {
    let original = numbered_lines();
    let ctx = TestContext::builder()
        .with_file("two.txt", &joined(&original))
        .with_commit("Initial commit")
        .build();
    let mut edited = original;
    edited[9] = "line 10 rewritten".to_string();
    edited[24] = "line 25 rewritten".to_string();
    std::fs::write(ctx.repo_path().join("two.txt"), joined(&edited)).unwrap();
    (ctx, edited)
}

#[test]
fn discard_hunk_discards_the_shown_hunk_after_an_edit_above_it() {
    let (ctx, mut edited) = two_rewrites();
    let shown = ctx.shown_unstaged_hunk("two.txt", 1);
    edited[0] = "line 1 rewritten".to_string();
    std::fs::write(ctx.repo_path().join("two.txt"), joined(&edited)).unwrap();

    ctx.discard_shown_hunk("two.txt", &shown).unwrap();

    let mut expected = edited.clone();
    expected[24] = "line 25".to_string();
    assert_eq!(
        std::fs::read_to_string(ctx.repo_path().join("two.txt")).unwrap(),
        joined(&expected)
    );
}

#[test]
fn discard_hunk_refuses_a_shown_hunk_whose_lines_changed() {
    let (ctx, mut edited) = two_rewrites();
    let shown = ctx.shown_unstaged_hunk("two.txt", 1);
    edited[24] = "line 25 rewritten again".to_string();
    std::fs::write(ctx.repo_path().join("two.txt"), joined(&edited)).unwrap();

    let err = ctx.discard_shown_hunk("two.txt", &shown).unwrap_err();

    assert_eq!(err.code, "stale_hunk");
    assert_eq!(
        std::fs::read_to_string(ctx.repo_path().join("two.txt")).unwrap(),
        joined(&edited)
    );
}

#[test]
fn stage_hunk_stages_the_shown_hunk_after_an_insertion_above_it() {
    let (ctx, mut edited) = two_rewrites();
    let shown = ctx.shown_unstaged_hunk("two.txt", 1);
    edited.insert(0, "inserted".to_string());
    std::fs::write(ctx.repo_path().join("two.txt"), joined(&edited)).unwrap();

    ctx.stage_shown_hunk("two.txt", &shown).unwrap();

    let mut expected = numbered_lines();
    expected[24] = "line 25 rewritten".to_string();
    assert_eq!(ctx.staged_content("two.txt"), joined(&expected));
}

#[test]
fn unstage_hunk_unstages_the_shown_hunk_after_the_index_changed_above_it() {
    let (ctx, mut edited) = two_rewrites();
    ctx.stage_file("two.txt").unwrap();
    let shown = ctx.shown_staged_hunk("two.txt", 1);
    edited[0] = "line 1 rewritten".to_string();
    std::fs::write(ctx.repo_path().join("two.txt"), joined(&edited)).unwrap();
    ctx.stage_file("two.txt").unwrap();

    ctx.unstage_shown_hunk("two.txt", &shown).unwrap();

    let mut expected = edited.clone();
    expected[24] = "line 25".to_string();
    assert_eq!(ctx.staged_content("two.txt"), joined(&expected));
}

// -- patches git can read back exactly (TRUNK-458 review) --
//
// Every hunk and line action rebuilds a patch as text and has libgit2 parse it back.
// Whatever the text fails to say, a path's spelling, a byte, a mode, that a file is
// new or gone, the action loses.

fn committed(path: &str, content: &str) -> TestContext {
    TestContext::builder()
        .with_file("README.md", "hello\n")
        .with_file(path, content)
        .with_commit("add the files")
        .build()
}

fn committed_executable(path: &str, content: &str) -> TestContext {
    TestContext::builder()
        .with_file("README.md", "hello\n")
        .with_executable_file(path, content)
        .with_commit("add the files")
        .build()
}

fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;

    std::fs::metadata(path).unwrap().permissions().mode() & 0o111 != 0
}

#[test]
fn unstaging_a_hunk_of_a_rename_between_paths_with_spaces_restores_the_old_path() {
    let ctx = staged_rename_with_one_edit_beside("util file.ts", "math util.ts", &[]);

    ctx.unstage_hunk("math util.ts", 0).unwrap();

    assert_eq!(staged_paths(&ctx), vec!["util file.ts".to_string()]);
}

#[test]
fn unstaging_a_hunk_of_a_rename_to_a_quoted_name_leaves_other_files_staged() {
    let ctx = staged_rename_with_one_edit_beside("util.ts", "\"x\"", &["x"]);

    ctx.unstage_hunk("\"x\"", 0).unwrap();

    assert_eq!(
        staged_paths(&ctx),
        vec!["util.ts".to_string(), "x".to_string()]
    );
}

#[test]
fn staging_a_hunk_of_a_file_whose_name_holds_a_newline_stages_it() {
    let ctx = committed("two\nlines.txt", "one\n");
    std::fs::write(ctx.repo_path().join("two\nlines.txt"), "one\ntwo\n").unwrap();

    ctx.stage_hunk("two\nlines.txt", 0).unwrap();

    assert_eq!(ctx.staged_content("two\nlines.txt"), "one\ntwo\n");
}

#[test]
fn staging_a_hunk_keeps_bytes_that_are_not_utf8() {
    let ctx = committed("notes.txt", "one\n");
    std::fs::write(ctx.repo_path().join("notes.txt"), b"one\ncaf\xe9\n").unwrap();

    ctx.stage_hunk("notes.txt", 0).unwrap();

    assert_eq!(ctx.staged_bytes("notes.txt"), b"one\ncaf\xe9\n");
}

#[test]
fn discarding_a_hunk_restores_bytes_that_are_not_utf8() {
    let ctx = TestContext::builder()
        .with_binary_file("notes.txt", b"one\ncaf\xe9\n")
        .with_commit("add notes")
        .build();
    let file = ctx.repo_path().join("notes.txt");
    std::fs::write(&file, "one\n").unwrap();

    ctx.discard_hunk("notes.txt", 0).unwrap();

    assert_eq!(std::fs::read(&file).unwrap(), b"one\ncaf\xe9\n");
}

#[test]
fn staging_a_hunk_of_an_executable_keeps_it_executable() {
    let ctx = committed_executable("run.sh", "echo one\n");
    std::fs::write(ctx.repo_path().join("run.sh"), "echo one\necho two\n").unwrap();

    ctx.stage_hunk("run.sh", 0).unwrap();

    assert_eq!(ctx.staged_mode("run.sh"), 0o100_755);
}

#[test]
fn unstaging_a_hunk_of_an_executable_keeps_it_executable() {
    let ctx = committed_executable("run.sh", "echo one\n");
    std::fs::write(ctx.repo_path().join("run.sh"), "echo one\necho two\n").unwrap();
    ctx.stage_file("run.sh").unwrap();

    ctx.unstage_hunk("run.sh", 0).unwrap();

    assert_eq!(ctx.staged_mode("run.sh"), 0o100_755);
}

#[test]
fn discarding_a_hunk_of_an_executable_keeps_it_executable() {
    let ctx = committed_executable("run.sh", "echo one\n");
    let file = ctx.repo_path().join("run.sh");
    std::fs::write(&file, "echo one\necho two\n").unwrap();

    ctx.discard_hunk("run.sh", 0).unwrap();

    assert_eq!(std::fs::read_to_string(&file).unwrap(), "echo one\n");
    assert!(is_executable(&file), "the discard kept the executable bits");
}

#[test]
fn staging_a_hunk_of_an_untracked_executable_stages_it_executable() {
    let ctx = committed("README.md", "hello\n");
    let file = ctx.repo_path().join("run.sh");
    std::fs::write(&file, "echo one\n").unwrap();
    make_executable(&file);

    ctx.stage_hunk("run.sh", 0).unwrap();

    assert_eq!(ctx.staged_mode("run.sh"), 0o100_755);
}

#[test]
fn staging_the_hunk_of_a_deleted_file_stages_its_deletion() {
    let ctx = committed("gone.txt", "a\nb\n");
    std::fs::remove_file(ctx.repo_path().join("gone.txt")).unwrap();

    ctx.stage_hunk("gone.txt", 0).unwrap();

    assert_eq!(staged_paths(&ctx), vec!["README.md".to_string()]);
}

#[test]
fn staging_some_lines_of_a_deleted_file_stages_only_their_removal() {
    let ctx = committed("gone.txt", "a\nb\n");
    std::fs::remove_file(ctx.repo_path().join("gone.txt")).unwrap();

    ctx.stage_lines("gone.txt", 0, &[0]).unwrap();

    assert_eq!(ctx.staged_content("gone.txt"), "b\n");
}

#[test]
fn discarding_the_hunk_of_a_deleted_file_restores_it() {
    let ctx = committed("gone.txt", "a\nb\n");
    let file = ctx.repo_path().join("gone.txt");
    std::fs::remove_file(&file).unwrap();

    ctx.discard_hunk("gone.txt", 0).unwrap();

    assert_eq!(std::fs::read_to_string(&file).unwrap(), "a\nb\n");
}

#[test]
fn unstaging_the_hunk_of_a_staged_new_file_leaves_it_untracked() {
    let ctx = committed("README.md", "hello\n");
    let file = ctx.repo_path().join("new.txt");
    std::fs::write(&file, "a\nb\n").unwrap();
    ctx.stage_file("new.txt").unwrap();

    ctx.unstage_hunk("new.txt", 0).unwrap();

    assert_eq!(staged_paths(&ctx), vec!["README.md".to_string()]);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "a\nb\n");
}

#[test]
fn unstaging_some_lines_of_a_staged_new_file_keeps_the_rest_staged() {
    let ctx = committed("README.md", "hello\n");
    std::fs::write(ctx.repo_path().join("new.txt"), "a\nb\n").unwrap();
    ctx.stage_file("new.txt").unwrap();

    ctx.unstage_lines("new.txt", 0, &[0]).unwrap();

    assert_eq!(ctx.staged_content("new.txt"), "b\n");
}

#[test]
fn unstaging_the_hunk_of_a_staged_deletion_stages_the_file_again() {
    let ctx = committed("gone.txt", "a\nb\n");
    std::fs::remove_file(ctx.repo_path().join("gone.txt")).unwrap();
    ctx.stage_file("gone.txt").unwrap();

    ctx.unstage_hunk("gone.txt", 0).unwrap();

    assert_eq!(ctx.staged_content("gone.txt"), "a\nb\n");
}

#[test]
fn discarding_the_hunk_of_an_untracked_file_deletes_it() {
    let ctx = committed("README.md", "hello\n");
    let file = ctx.repo_path().join("scratch.txt");
    std::fs::write(&file, "a\nb\n").unwrap();

    ctx.discard_hunk("scratch.txt", 0).unwrap();

    assert!(!file.exists(), "the untracked file is gone");
}

/// A file holding the same edit, with the same context, in two places, as repeated
/// boilerplate does, so only where each hunk starts tells the two apart.
fn the_same_edit_twice() -> TestContext {
    let block = ["begin", "one", "two", "three", "four", "five", "end"];
    let mut lines: Vec<String> = (1..=40).map(|n| format!("line {n}")).collect();
    for start in [2, 27] {
        for (offset, text) in block.iter().enumerate() {
            lines[start + offset] = (*text).to_string();
        }
    }
    let ctx = committed("twice.txt", &(lines.join("\n") + "\n"));
    lines[5] = "edit".to_string();
    lines[30] = "edit".to_string();
    std::fs::write(ctx.repo_path().join("twice.txt"), lines.join("\n") + "\n").unwrap();

    ctx
}

#[test]
fn discard_hunk_discards_the_second_of_two_identical_hunks_when_shown_it() {
    let ctx = the_same_edit_twice();
    let shown = ctx.shown_unstaged_hunk("twice.txt", 1);

    ctx.discard_shown_hunk("twice.txt", &shown).unwrap();

    let on_disk = std::fs::read_to_string(ctx.repo_path().join("twice.txt")).unwrap();
    let edited: Vec<usize> = on_disk
        .lines()
        .enumerate()
        .filter(|(_, line)| *line == "edit")
        .map(|(index, _)| index)
        .collect();
    assert_eq!(edited, vec![5], "the first edit stays, the second is gone");
}

// -- one writer at a time --

mod when_another_writer_stages_meanwhile {
    use super::*;

    #[test]
    fn stage_file_keeps_the_other_writers_file() {
        let mut ctx = committed("README.md", "hello");
        std::fs::write(ctx.repo_path().join("b.txt"), "b").unwrap();

        ctx.act_while_another_writer_stages("a.txt", |ctx| ctx.stage_file("b.txt"))
            .expect("stage_file failed");

        assert_eq!(ctx.paths_staged_over_head(), ["a.txt", "b.txt"]);
    }

    #[test]
    fn stage_files_keeps_the_other_writers_file() {
        let mut ctx = committed("README.md", "hello");
        std::fs::write(ctx.repo_path().join("b.txt"), "b").unwrap();

        ctx.act_while_another_writer_stages("a.txt", |ctx| ctx.stage_files(&["b.txt"]))
            .expect("stage_files failed");

        assert_eq!(ctx.paths_staged_over_head(), ["a.txt", "b.txt"]);
    }

    #[test]
    fn unstage_file_keeps_the_other_writers_file() {
        let mut ctx = committed("README.md", "hello");
        std::fs::write(ctx.repo_path().join("b.txt"), "b").unwrap();
        ctx.stage_file("b.txt").unwrap();

        ctx.act_while_another_writer_stages("a.txt", |ctx| ctx.unstage_file("b.txt"))
            .expect("unstage_file failed");

        assert_eq!(ctx.paths_staged_over_head(), ["a.txt"]);
    }

    #[test]
    fn unstage_files_keeps_the_other_writers_file() {
        let mut ctx = committed("README.md", "hello");
        std::fs::write(ctx.repo_path().join("b.txt"), "b").unwrap();
        ctx.stage_file("b.txt").unwrap();

        ctx.act_while_another_writer_stages("a.txt", |ctx| ctx.unstage_files(&["b.txt"]))
            .expect("unstage_files failed");

        assert_eq!(ctx.paths_staged_over_head(), ["a.txt"]);
    }

    #[test]
    fn stage_hunk_keeps_the_other_writers_file() {
        let mut ctx = committed("README.md", "hello\n");
        std::fs::write(ctx.repo_path().join("README.md"), "changed\n").unwrap();

        ctx.act_while_another_writer_stages("a.txt", |ctx| ctx.stage_hunk("README.md", 0))
            .expect("stage_hunk failed");

        assert_eq!(ctx.staged_content("README.md"), "changed\n");
        assert_eq!(ctx.paths_staged_over_head(), ["README.md", "a.txt"]);
    }

    #[test]
    fn unstage_hunk_keeps_the_other_writers_file() {
        let mut ctx = committed("README.md", "hello\n");
        std::fs::write(ctx.repo_path().join("README.md"), "changed\n").unwrap();
        ctx.stage_file("README.md").unwrap();

        ctx.act_while_another_writer_stages("a.txt", |ctx| ctx.unstage_hunk("README.md", 0))
            .expect("unstage_hunk failed");

        assert_eq!(ctx.staged_content("README.md"), "hello\n");
        assert_eq!(ctx.paths_staged_over_head(), ["a.txt"]);
    }

    #[test]
    fn stage_all_keeps_its_own_change() {
        let mut ctx = committed("README.md", "hello");
        std::fs::write(ctx.repo_path().join("b.txt"), "b").unwrap();

        ctx.act_while_another_writer_stages("a.txt", |ctx| ctx.stage_all())
            .expect("stage_all failed");

        assert_eq!(ctx.paths_staged_over_head(), ["a.txt", "b.txt"]);
    }

    #[test]
    fn unstage_all_runs_after_it_and_leaves_nothing_staged() {
        let mut ctx = committed("README.md", "hello");
        std::fs::write(ctx.repo_path().join("b.txt"), "b").unwrap();
        ctx.stage_file("b.txt").unwrap();

        ctx.act_while_another_writer_stages("a.txt", |ctx| ctx.unstage_all())
            .expect("unstage_all failed");

        assert_eq!(ctx.paths_staged_over_head(), Vec::<String>::new());
    }

    #[test]
    fn discard_file_finds_nothing_left_once_the_other_writer_staged_the_same_file() {
        let mut ctx = committed("b.txt", "b");

        let err = ctx
            .act_while_another_writer_stages("b.txt", |ctx| ctx.discard_file("b.txt"))
            .expect_err("discard_file threw away the change the other writer staged");

        assert_eq!(err.code, "file_not_found");

        ctx.assert_file_content("b.txt", "b.txt");
        assert_eq!(ctx.staged_content("b.txt"), "b.txt");
    }

    #[test]
    fn discard_files_finds_nothing_left_once_the_other_writer_staged_the_same_file() {
        let mut ctx = committed("b.txt", "b");

        let err = ctx
            .act_while_another_writer_stages("b.txt", |ctx| ctx.discard_files(&["b.txt"]))
            .expect_err("discard_files threw away the change the other writer staged");

        assert_eq!(err.code, "file_not_found");

        ctx.assert_file_content("b.txt", "b.txt");
        assert_eq!(ctx.staged_content("b.txt"), "b.txt");
    }

    #[test]
    fn discard_all_runs_after_the_other_writer_staged_the_same_file() {
        let mut ctx = committed("b.txt", "b");

        ctx.act_while_another_writer_stages("b.txt", |ctx| ctx.discard_all())
            .expect("discard_all failed");

        ctx.assert_file_content("b.txt", "b.txt");
        assert_eq!(ctx.staged_content("b.txt"), "b.txt");
    }
}

mod when_another_writer_edits_the_file_meanwhile {
    use super::*;

    const COMMITTED: &str = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n";

    #[test]
    fn discard_hunk_keeps_the_other_writers_edit() {
        let mut ctx = TestContext::builder()
            .with_file("f.txt", COMMITTED)
            .with_commit("Initial commit")
            .build();
        let first_line_changed = COMMITTED.replacen("1\n", "one\n", 1);
        std::fs::write(ctx.repo_path().join("f.txt"), &first_line_changed).unwrap();
        let path = ctx.repo_path().join("f.txt");

        ctx.act_while_another_writer(
            |_| std::fs::read_to_string(&path).unwrap(),
            |_, read| std::fs::write(&path, read.replace("12\n", "twelve\n")).unwrap(),
            |ctx| ctx.discard_hunk("f.txt", 0),
        )
        .expect("discard_hunk failed");

        ctx.assert_file_content("f.txt", &COMMITTED.replace("12\n", "twelve\n"));
    }
}

#[test]
fn stage_hunk_reports_the_file_done_once_its_only_change_is_staged() {
    let ctx = TestContext::builder()
        .with_file("one.txt", &joined(&numbered_lines()))
        .with_commit("Initial commit")
        .build();
    let mut edited = numbered_lines();
    edited[9] = "line 10 rewritten".to_string();
    std::fs::write(ctx.repo_path().join("one.txt"), joined(&edited)).unwrap();

    let outcome = ctx.stage_hunk("one.txt", 0).unwrap();

    assert!(!outcome.file_still_changed);
}

#[test]
fn stage_hunk_reports_the_whitespace_change_the_view_hides() {
    let ctx = TestContext::builder()
        .with_file("ws.txt", &joined(&numbered_lines()))
        .with_commit("Initial commit")
        .build();
    let mut edited = numbered_lines();
    edited[9] = "line 10 rewritten".to_string();
    edited[24] = "line 25   ".to_string();
    std::fs::write(ctx.repo_path().join("ws.txt"), joined(&edited)).unwrap();
    let ignoring = DiffRequestOptions {
        ignore_whitespace: true,
        ..DiffRequestOptions::default()
    };

    let outcome = ctx.stage_hunk_with_options("ws.txt", 0, &ignoring).unwrap();

    assert!(outcome.file_still_changed);
}

#[test]
fn stage_hunk_reports_the_mode_change_its_hunk_leaves() {
    let ctx = TestContext::builder()
        .with_file("run.sh", &joined(&numbered_lines()))
        .with_commit("Initial commit")
        .build();
    let mut edited = numbered_lines();
    edited[9] = "line 10 rewritten".to_string();
    std::fs::write(ctx.repo_path().join("run.sh"), joined(&edited)).unwrap();
    make_executable(&ctx.repo_path().join("run.sh"));

    let outcome = ctx.stage_hunk("run.sh", 0).unwrap();

    assert!(outcome.file_still_changed);
}

#[test]
fn unstage_hunk_reports_the_file_done_once_its_only_change_is_unstaged() {
    let ctx = TestContext::builder()
        .with_file("one.txt", &joined(&numbered_lines()))
        .with_commit("Initial commit")
        .build();
    let mut edited = numbered_lines();
    edited[9] = "line 10 rewritten".to_string();
    std::fs::write(ctx.repo_path().join("one.txt"), joined(&edited)).unwrap();
    ctx.stage_file("one.txt").unwrap();

    let outcome = ctx.unstage_hunk("one.txt", 0).unwrap();

    assert!(!outcome.file_still_changed);
}

#[test]
fn unstage_hunk_reports_the_staged_mode_change_its_hunk_leaves() {
    let ctx = TestContext::builder()
        .with_file("run.sh", &joined(&numbered_lines()))
        .with_commit("Initial commit")
        .build();
    let mut edited = numbered_lines();
    edited[9] = "line 10 rewritten".to_string();
    std::fs::write(ctx.repo_path().join("run.sh"), joined(&edited)).unwrap();
    make_executable(&ctx.repo_path().join("run.sh"));
    ctx.stage_file("run.sh").unwrap();

    let outcome = ctx.unstage_hunk("run.sh", 0).unwrap();

    assert!(outcome.file_still_changed);
}

#[test]
fn discard_hunk_reports_the_whitespace_change_the_view_hides() {
    let ctx = TestContext::builder()
        .with_file("ws.txt", &joined(&numbered_lines()))
        .with_commit("Initial commit")
        .build();
    let mut edited = numbered_lines();
    edited[9] = "line 10 rewritten".to_string();
    edited[24] = "line 25   ".to_string();
    std::fs::write(ctx.repo_path().join("ws.txt"), joined(&edited)).unwrap();
    let ignoring = DiffRequestOptions {
        ignore_whitespace: true,
        ..DiffRequestOptions::default()
    };

    let outcome = ctx
        .discard_hunk_with_options("ws.txt", 0, &ignoring)
        .unwrap();

    assert!(outcome.file_still_changed);
}

#[test]
fn stage_lines_reports_the_lines_left_unstaged() {
    let (ctx, _) = two_rewrites();
    let diff = ctx.diff_unstaged("two.txt").unwrap();

    let outcome = ctx
        .stage_lines("two.txt", 0, &changed_lines(&diff, 0))
        .unwrap();

    assert!(outcome.file_still_changed);
}

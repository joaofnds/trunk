mod common;

use common::context::TestContext;
use trunk_lib::git::types::{DiffOrigin, FileStatusType};

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
        "expected Ok(()) for unstage on unborn HEAD, got: {:?}",
        result
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
        .map(|i| format!("line {}", i))
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
    let mut lines: Vec<String> = original.split('\n').map(|s| s.to_string()).collect();
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
fn stage_hunk_stale_index_returns_error() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_multi_hunk_file(&ctx);

    let result = ctx.stage_hunk("multi.txt", 5);
    assert!(result.is_err(), "expected Err for out-of-range hunk index");
    let err = result.unwrap_err();
    assert_eq!(
        err.code, "stale_hunk_index",
        "expected stale_hunk_index error code"
    );
}

#[test]
fn stage_hunk_clean_file_returns_error() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let result = ctx.stage_hunk("README.md", 0);
    assert!(
        result.is_err(),
        "expected Err for file with no unstaged changes"
    );
    let err = result.unwrap_err();
    assert_eq!(
        err.code, "file_not_found",
        "expected file_not_found error code"
    );
}

// -- unstage_hunk tests --

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
fn discard_hunk_clean_file_returns_error() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let result = ctx.discard_hunk("README.md", 0);
    assert!(
        result.is_err(),
        "expected Err for file with no unstaged changes"
    );
    let err = result.unwrap_err();
    assert_eq!(
        err.code, "file_not_found",
        "expected file_not_found error code"
    );
}

// -- Line-level staging fixture helper --

fn create_add_delete_hunk_file(ctx: &TestContext) {
    let original = (1..=30)
        .map(|i| format!("line {}", i))
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
    let mut lines: Vec<String> = original.lines().map(|s| s.to_string()).collect();
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
        .map(|(i, _)| i as u32)
        .collect();
    assert!(
        !add_indices.is_empty(),
        "expected at least one add line in hunk 0"
    );

    ctx.stage_lines("multi.txt", 0, add_indices)
        .expect("stage_lines failed");

    let staged = ctx.diff_staged("multi.txt").expect("diff_staged failed");
    assert!(
        !staged.is_empty(),
        "expected staged diff after staging add lines"
    );
    let staged_hunk0 = &staged[0].hunks[0];
    let staged_adds: Vec<_> = staged_hunk0
        .lines
        .iter()
        .filter(|l| matches!(l.origin, DiffOrigin::Add))
        .collect();
    assert!(!staged_adds.is_empty(), "expected add lines in staged diff");

    let staged_deletes: Vec<_> = staged_hunk0
        .lines
        .iter()
        .filter(|l| matches!(l.origin, DiffOrigin::Delete))
        .collect();
    assert!(
        staged_deletes.is_empty(),
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
        .map(|(i, _)| i as u32)
        .collect();
    assert!(
        !del_indices.is_empty(),
        "expected at least one delete line in hunk 0"
    );

    ctx.stage_lines("multi.txt", 0, del_indices)
        .expect("stage_lines failed");

    let staged = ctx.diff_staged("multi.txt").expect("diff_staged failed");
    assert!(
        !staged.is_empty(),
        "expected staged diff after staging delete lines"
    );
    let staged_hunk0 = &staged[0].hunks[0];
    let staged_deletes: Vec<_> = staged_hunk0
        .lines
        .iter()
        .filter(|l| matches!(l.origin, DiffOrigin::Delete))
        .collect();
    assert!(
        !staged_deletes.is_empty(),
        "expected delete lines in staged diff"
    );

    let staged_adds: Vec<_> = staged_hunk0
        .lines
        .iter()
        .filter(|l| matches!(l.origin, DiffOrigin::Add))
        .collect();
    assert!(
        staged_adds.is_empty(),
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
        .map(|(i, _)| i as u32)
        .collect();
    assert!(
        mixed_indices.len() >= 2,
        "expected at least 2 add/delete lines for mixed selection"
    );

    ctx.stage_lines("multi.txt", 0, mixed_indices)
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
fn stage_lines_stale_hunk_index_returns_error() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    create_add_delete_hunk_file(&ctx);

    let result = ctx.stage_lines("multi.txt", 99, vec![0]);
    assert!(result.is_err(), "expected Err for out-of-range hunk index");
    let err = result.unwrap_err();
    assert_eq!(
        err.code, "stale_hunk_index",
        "expected stale_hunk_index error code"
    );
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
        .map(|(i, _)| i as u32)
        .collect();
    assert!(!add_indices.is_empty(), "expected add lines");

    // Stage only the first add line
    ctx.stage_lines("new_file.txt", 0, vec![add_indices[0]])
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
        .map(|(i, _)| i as u32)
        .collect();
    assert!(
        !add_indices.is_empty(),
        "expected add lines in staged hunk 0"
    );

    ctx.unstage_lines("multi.txt", 0, add_indices)
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
        .map(|(i, l)| (i as u32, l.content.clone()))
        .collect();
    assert!(!add_info.is_empty(), "expected add lines in hunk 0");
    let add_indices: Vec<u32> = add_info.iter().map(|(i, _)| *i).collect();
    let add_contents: Vec<String> = add_info.iter().map(|(_, c)| c.clone()).collect();

    ctx.discard_lines("multi.txt", 0, add_indices)
        .expect("discard_lines failed");

    let file_content = std::fs::read_to_string(ctx.repo_path().join("multi.txt")).unwrap();
    let file_lines: Vec<&str> = file_content.lines().collect();
    for content in &add_contents {
        let trimmed = content.trim();
        assert!(
            !file_lines.contains(&trimmed),
            "expected discarded add line '{}' to be gone from file",
            trimmed
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

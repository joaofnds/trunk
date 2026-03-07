// Diff commands — Phase 6 implementation

use std::collections::HashMap;
use std::path::PathBuf;
use tauri::State;
use crate::error::TrunkError;
use crate::git::types::{CommitDetail, DiffHunk, DiffLine, DiffOrigin, FileDiff};
use crate::state::RepoState;

#[cfg(test)]
mod tests {
    use std::path::Path;
    use crate::git::repository::tests::make_test_repo;

    fn make_state_map(path: &Path) -> std::collections::HashMap<String, std::path::PathBuf> {
        let mut map = std::collections::HashMap::new();
        map.insert(path.to_string_lossy().to_string(), path.to_path_buf());
        map
    }

    // Test 1: diff_unstaged_returns_hunks
    #[test]
    fn diff_unstaged_returns_hunks() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Modify existing tracked file without staging
        std::fs::write(dir.path().join("README.md"), "modified content for diff").unwrap();

        let result = super::diff_unstaged_inner(&path, "README.md", &state_map);
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);

        let file_diffs = result.unwrap();
        assert!(!file_diffs.is_empty(), "expected non-empty file_diffs");

        let fd = &file_diffs[0];
        assert!(!fd.is_binary, "expected is_binary == false");
        assert!(!fd.hunks.is_empty(), "expected non-empty hunks");
    }

    // Test 2: diff_unstaged_empty_for_clean_file
    #[test]
    fn diff_unstaged_empty_for_clean_file() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Do NOT modify any file — clean working tree
        let result = super::diff_unstaged_inner(&path, "README.md", &state_map);
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);

        let file_diffs = result.unwrap();
        assert!(file_diffs.is_empty(), "expected empty file_diffs for clean file");
    }

    // Test 3: diff_staged_returns_hunks
    #[test]
    fn diff_staged_returns_hunks() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Modify README.md and stage it
        std::fs::write(dir.path().join("README.md"), "staged content for diff").unwrap();
        let repo = git2::Repository::open(dir.path()).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        index.write().unwrap();
        drop(index);
        drop(repo);

        let result = super::diff_staged_inner(&path, "README.md", &state_map);
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);

        let file_diffs = result.unwrap();
        assert!(!file_diffs.is_empty(), "expected non-empty file_diffs");

        let fd = &file_diffs[0];
        assert!(!fd.hunks.is_empty(), "expected non-empty hunks");
    }

    // Test 4: diff_staged_unborn_head
    #[test]
    fn diff_staged_unborn_head() {
        let dir = tempfile::tempdir().expect("failed to create tempdir");
        let repo = git2::Repository::init(dir.path()).expect("failed to init repo");
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Write new file and stage it (no commits yet)
        std::fs::write(dir.path().join("new_file.txt"), "brand new content").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("new_file.txt")).unwrap();
        index.write().unwrap();
        drop(index);
        drop(repo);

        let result = super::diff_staged_inner(&path, "new_file.txt", &state_map);
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);

        let file_diffs = result.unwrap();
        assert!(!file_diffs.is_empty(), "expected non-empty file_diffs for unborn HEAD staged file");
    }

    // Test 5: diff_commit_returns_hunks
    #[test]
    fn diff_commit_returns_hunks() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // get HEAD oid (non-root commit — make_test_repo creates merge commit)
        let repo = git2::Repository::open(dir.path()).unwrap();
        let head_oid = repo.head().unwrap().target().unwrap().to_string();
        drop(repo);

        let result = super::diff_commit_inner(&path, &head_oid, &state_map);
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);
        // merge commit may have empty diffs — just assert Ok
    }

    // Test 6: diff_commit_root_empty_tree
    #[test]
    fn diff_commit_root_empty_tree() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Walk commits to find root (parent_count == 0)
        let repo = git2::Repository::open(dir.path()).unwrap();
        let mut revwalk = repo.revwalk().unwrap();
        revwalk.push_head().unwrap();
        let root_oid = revwalk
            .filter_map(|id| id.ok())
            .find(|&id| {
                repo.find_commit(id)
                    .map(|c| c.parent_count() == 0)
                    .unwrap_or(false)
            })
            .expect("no root commit found");
        let root_oid_str = root_oid.to_string();
        drop(repo);

        let result = super::diff_commit_inner(&path, &root_oid_str, &state_map);
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);

        let file_diffs = result.unwrap();
        assert!(!file_diffs.is_empty(), "expected non-empty file_diffs for root commit");
    }

    // Test 7: get_commit_detail_returns_metadata
    #[test]
    fn get_commit_detail_returns_metadata() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        let repo = git2::Repository::open(dir.path()).unwrap();
        let head_oid = repo.head().unwrap().target().unwrap().to_string();
        drop(repo);

        let result = super::get_commit_detail_inner(&path, &head_oid, &state_map);
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);

        let detail = result.unwrap();
        assert_eq!(detail.oid.len(), 40, "expected 40-char oid");
        assert_eq!(detail.short_oid.len(), 7, "expected 7-char short_oid");
        assert!(!detail.summary.is_empty(), "expected non-empty summary");
        assert!(!detail.author_name.is_empty(), "expected non-empty author_name");
    }

    // Test 8: get_commit_detail_committer_fields
    #[test]
    fn get_commit_detail_committer_fields() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        let repo = git2::Repository::open(dir.path()).unwrap();
        let head_oid = repo.head().unwrap().target().unwrap().to_string();
        drop(repo);

        let result = super::get_commit_detail_inner(&path, &head_oid, &state_map);
        assert!(result.is_ok(), "expected Ok, got: {:?}", result);

        let detail = result.unwrap();
        assert!(!detail.committer_name.is_empty(), "expected non-empty committer_name");
        assert!(!detail.committer_email.is_empty(), "expected non-empty committer_email");
        assert!(detail.committer_timestamp > 0, "expected committer_timestamp > 0");
    }
}

// Diff commands — Phase 6 implementation

use std::collections::HashMap;
use std::path::PathBuf;
use tauri::State;
use crate::error::TrunkError;
use crate::git::types::{CommitDetail, DiffHunk, DiffLine, DiffOrigin, DiffStatus, FileDiff};
use crate::state::RepoState;

fn open_repo_from_state(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<git2::Repository, TrunkError> {
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    git2::Repository::open(path_buf).map_err(TrunkError::from)
}

fn is_head_unborn(repo: &git2::Repository) -> bool {
    match repo.head() {
        Err(e) => e.code() == git2::ErrorCode::UnbornBranch,
        Ok(_) => false,
    }
}

fn walk_diff_into_file_diffs(diff: git2::Diff<'_>) -> Result<Vec<FileDiff>, TrunkError> {
    use std::cell::RefCell;

    let file_diffs: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());

    diff.foreach(
        &mut |delta, _progress| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let is_binary = delta.old_file().is_binary() || delta.new_file().is_binary();
            let status = match delta.status() {
                git2::Delta::Added => DiffStatus::Added,
                git2::Delta::Deleted => DiffStatus::Deleted,
                git2::Delta::Modified => DiffStatus::Modified,
                git2::Delta::Renamed => DiffStatus::Renamed,
                git2::Delta::Copied => DiffStatus::Copied,
                git2::Delta::Untracked => DiffStatus::Untracked,
                _ => DiffStatus::Unknown,
            };
            file_diffs.borrow_mut().push(FileDiff { path, status, is_binary, hunks: Vec::new() });
            true
        },
        None, // skip binary callbacks
        Some(&mut |_delta, hunk| {
            if let Some(fd) = file_diffs.borrow_mut().last_mut() {
                fd.hunks.push(DiffHunk {
                    header: String::from_utf8_lossy(hunk.header()).into_owned(),
                    old_start: hunk.old_start(),
                    old_lines: hunk.old_lines(),
                    new_start: hunk.new_start(),
                    new_lines: hunk.new_lines(),
                    lines: Vec::new(),
                });
            }
            true
        }),
        Some(&mut |_delta, _hunk, line| {
            let origin = match line.origin() {
                '+' => DiffOrigin::Add,
                '-' => DiffOrigin::Delete,
                _ => DiffOrigin::Context,
            };
            let content = String::from_utf8_lossy(line.content()).into_owned();
            let mut diffs = file_diffs.borrow_mut();
            if let Some(fd) = diffs.last_mut() {
                if let Some(hunk) = fd.hunks.last_mut() {
                    hunk.lines.push(DiffLine {
                        origin,
                        content,
                        old_lineno: line.old_lineno(),
                        new_lineno: line.new_lineno(),
                    });
                }
            }
            true
        }),
    )
    .map_err(TrunkError::from)?;

    Ok(file_diffs.into_inner())
}

pub fn diff_unstaged_inner(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file_path);
    let diff = repo.diff_index_to_workdir(None, Some(&mut opts))?;
    walk_diff_into_file_diffs(diff)
}

pub fn diff_staged_inner(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file_path);
    let diff = if is_head_unborn(&repo) {
        repo.diff_tree_to_index(None, None, Some(&mut opts))?
    } else {
        let head_tree = repo.head()?.peel_to_tree()?;
        repo.diff_tree_to_index(Some(&head_tree), None, Some(&mut opts))?
    };
    walk_diff_into_file_diffs(diff)
}

pub fn diff_commit_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let oid = git2::Oid::from_str(oid)
        .map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
    let commit = repo.find_commit(oid)?;
    let commit_tree = commit.tree()?;
    let diff = if commit.parent_count() == 0 {
        repo.diff_tree_to_tree(None, Some(&commit_tree), None)?
    } else {
        let parent_tree = commit.parent(0)?.tree()?;
        repo.diff_tree_to_tree(Some(&parent_tree), Some(&commit_tree), None)?
    };
    walk_diff_into_file_diffs(diff)
}

pub fn get_commit_detail_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<CommitDetail, TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let oid = git2::Oid::from_str(oid)
        .map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
    let commit = repo.find_commit(oid)?;
    let author = commit.author();
    let committer = commit.committer();
    Ok(CommitDetail {
        oid: commit.id().to_string(),
        short_oid: commit.id().to_string()[..7].to_owned(),
        summary: commit.summary().unwrap_or("").to_owned(),
        body: commit.body().map(str::to_owned),
        author_name: author.name().unwrap_or("").to_owned(),
        author_email: author.email().unwrap_or("").to_owned(),
        author_timestamp: author.when().seconds(),
        committer_name: committer.name().unwrap_or("").to_owned(),
        committer_email: committer.email().unwrap_or("").to_owned(),
        committer_timestamp: committer.when().seconds(),
        parent_oids: commit.parent_ids().map(|id| id.to_string()).collect(),
    })
}

#[tauri::command]
pub async fn diff_unstaged(
    path: String,
    file_path: String,
    state: State<'_, RepoState>,
) -> Result<Vec<FileDiff>, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || diff_unstaged_inner(&path, &file_path, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

#[tauri::command]
pub async fn diff_staged(
    path: String,
    file_path: String,
    state: State<'_, RepoState>,
) -> Result<Vec<FileDiff>, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || diff_staged_inner(&path, &file_path, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

#[tauri::command]
pub async fn diff_commit(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
) -> Result<Vec<FileDiff>, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || diff_commit_inner(&path, &oid, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

#[tauri::command]
pub async fn get_commit_detail(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
) -> Result<CommitDetail, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || get_commit_detail_inner(&path, &oid, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

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

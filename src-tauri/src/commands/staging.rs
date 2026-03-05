use std::collections::HashMap;
use std::path::{Path, PathBuf};
use git2::{Status, StatusOptions};
use tauri::State;
use crate::error::TrunkError;
use crate::git::types::{FileStatus, FileStatusType, WorkingTreeStatus};
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

fn classify_index(s: Status) -> Option<FileStatusType> {
    if s.contains(Status::INDEX_NEW)        { return Some(FileStatusType::New); }
    if s.contains(Status::INDEX_MODIFIED)   { return Some(FileStatusType::Modified); }
    if s.contains(Status::INDEX_DELETED)    { return Some(FileStatusType::Deleted); }
    if s.contains(Status::INDEX_RENAMED)    { return Some(FileStatusType::Renamed); }
    if s.contains(Status::INDEX_TYPECHANGE) { return Some(FileStatusType::Typechange); }
    if s.contains(Status::CONFLICTED)       { return Some(FileStatusType::Conflicted); }
    None
}

fn classify_workdir(s: Status) -> Option<FileStatusType> {
    if s.contains(Status::WT_NEW)        { return Some(FileStatusType::New); }
    if s.contains(Status::WT_MODIFIED)   { return Some(FileStatusType::Modified); }
    if s.contains(Status::WT_DELETED)    { return Some(FileStatusType::Deleted); }
    if s.contains(Status::WT_RENAMED)    { return Some(FileStatusType::Renamed); }
    if s.contains(Status::WT_TYPECHANGE) { return Some(FileStatusType::Typechange); }
    None
}

pub fn get_status_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<WorkingTreeStatus, TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts))?;

    let mut unstaged: Vec<FileStatus> = Vec::new();
    let mut staged: Vec<FileStatus> = Vec::new();
    let mut conflicted: Vec<FileStatus> = Vec::new();

    for entry in statuses.iter() {
        let status = entry.status();
        let file_path = entry.path().unwrap_or("").to_owned();

        // Check for conflicts first
        if status.contains(Status::CONFLICTED) {
            conflicted.push(FileStatus {
                path: file_path.clone(),
                status: FileStatusType::Conflicted,
                is_binary: false,
            });
            continue;
        }

        // Index (staged) entries
        if let Some(status_type) = classify_index(status) {
            staged.push(FileStatus {
                path: file_path.clone(),
                status: status_type,
                is_binary: false,
            });
        }

        // Working directory (unstaged) entries — a file can appear in both
        if let Some(status_type) = classify_workdir(status) {
            unstaged.push(FileStatus {
                path: file_path,
                status: status_type,
                is_binary: false,
            });
        }
    }

    Ok(WorkingTreeStatus { unstaged, staged, conflicted })
}

pub fn stage_file_inner(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let mut index = repo.index()?;
    index.add_path(Path::new(file_path))?;
    index.write()?;
    Ok(())
}

fn is_head_unborn(repo: &git2::Repository) -> bool {
    match repo.head() {
        Err(e) => e.code() == git2::ErrorCode::UnbornBranch,
        Ok(_) => false,
    }
}

pub fn unstage_file_inner(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;

    if is_head_unborn(&repo) {
        // No commits yet — just remove from index
        let mut index = repo.index()?;
        index.remove_path(Path::new(file_path))?;
        index.write()?;
    } else {
        // Reset the file to HEAD state using reset_default
        let head_commit = repo.head()?.peel_to_commit()?;
        repo.reset_default(
            Some(head_commit.as_object()),
            std::iter::once(file_path),
        )?;
    }

    Ok(())
}

pub fn stage_all_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let mut index = repo.index()?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
    index.write()?;
    Ok(())
}

pub fn unstage_all_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;

    if is_head_unborn(&repo) {
        let mut index = repo.index()?;
        index.clear()?;
        index.write()?;
    } else {
        let head_commit = repo.head()?.peel_to_commit()?;
        // Collect all staged paths first
        let staged_paths: Vec<String> = get_status_inner(path, state_map)?
            .staged
            .into_iter()
            .map(|f| f.path)
            .collect();
        if !staged_paths.is_empty() {
            repo.reset_default(
                Some(head_commit.as_object()),
                staged_paths.iter().map(String::as_str),
            )?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_status(
    path: String,
    state: State<'_, RepoState>,
) -> Result<WorkingTreeStatus, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || get_status_inner(&path, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

#[tauri::command]
pub async fn stage_file(
    path: String,
    file_path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || stage_file_inner(&path, &file_path, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

#[tauri::command]
pub async fn unstage_file(
    path: String,
    file_path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || unstage_file_inner(&path, &file_path, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

#[tauri::command]
pub async fn stage_all(
    path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || stage_all_inner(&path, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

#[tauri::command]
pub async fn unstage_all(
    path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || unstage_all_inner(&path, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use crate::git::repository::tests::make_test_repo;
    use crate::git::types::FileStatusType;

    fn make_state_map(path: &Path) -> std::collections::HashMap<String, std::path::PathBuf> {
        let mut map = std::collections::HashMap::new();
        map.insert(path.to_string_lossy().to_string(), path.to_path_buf());
        map
    }

    // Test 1 — get_status_returns_unstaged
    #[test]
    fn get_status_returns_unstaged() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Modify existing tracked file without staging
        std::fs::write(dir.path().join("README.md"), "modified content").unwrap();

        let status = super::get_status_inner(&path, &state_map).expect("get_status_inner failed");

        assert!(!status.unstaged.is_empty(), "expected unstaged to be non-empty");
        assert!(status.staged.is_empty(), "expected staged to be empty");
    }

    // Test 2 — status_new_file
    #[test]
    fn status_new_file() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Write a brand new file (not previously tracked)
        std::fs::write(dir.path().join("brand_new.txt"), "new content").unwrap();

        let status = super::get_status_inner(&path, &state_map).expect("get_status_inner failed");

        let has_new = status.unstaged.iter().any(|f| matches!(f.status, FileStatusType::New));
        assert!(has_new, "expected at least one entry with status New in unstaged");
    }

    // Test 3 — status_modified_file
    #[test]
    fn status_modified_file() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Overwrite README.md (tracked file) without staging
        std::fs::write(dir.path().join("README.md"), "modified hello").unwrap();

        let status = super::get_status_inner(&path, &state_map).expect("get_status_inner failed");

        let has_modified = status.unstaged.iter().any(|f| matches!(f.status, FileStatusType::Modified));
        assert!(has_modified, "expected at least one entry with status Modified in unstaged");
    }

    // Test 4 — stage_file_moves_to_staged
    #[test]
    fn stage_file_moves_to_staged() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Modify README.md without staging
        std::fs::write(dir.path().join("README.md"), "staged content").unwrap();

        super::stage_file_inner(&path, "README.md", &state_map).expect("stage_file_inner failed");

        let status = super::get_status_inner(&path, &state_map).expect("get_status_inner failed");

        assert!(!status.staged.is_empty(), "expected staged to be non-empty after staging");
        let has_readme = status.staged.iter().any(|f| f.path == "README.md");
        assert!(has_readme, "expected README.md in staged list");
    }

    // Test 5 — unstage_file_moves_to_unstaged
    #[test]
    fn unstage_file_moves_to_unstaged() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Modify and stage README.md
        std::fs::write(dir.path().join("README.md"), "to be staged then unstaged").unwrap();
        let repo = git2::Repository::open(dir.path()).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        index.write().unwrap();
        drop(index);
        drop(repo);

        super::unstage_file_inner(&path, "README.md", &state_map).expect("unstage_file_inner failed");

        let status = super::get_status_inner(&path, &state_map).expect("get_status_inner failed");

        let readme_in_staged = status.staged.iter().any(|f| f.path == "README.md");
        assert!(!readme_in_staged, "expected README.md NOT in staged list after unstaging");
    }

    // Test 6 — unstage_on_unborn_head
    #[test]
    fn unstage_on_unborn_head() {
        let dir = tempfile::tempdir().expect("failed to create tempdir");
        let repo = git2::Repository::init(dir.path()).expect("failed to init repo");
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Create a new file and stage it (no commits yet)
        std::fs::write(dir.path().join("new_file.txt"), "content").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("new_file.txt")).unwrap();
        index.write().unwrap();
        drop(index);
        drop(repo);

        let result = super::unstage_file_inner(&path, "new_file.txt", &state_map);
        assert!(result.is_ok(), "expected Ok(()) for unstage on unborn HEAD, got: {:?}", result);
    }

    // Test 7 — stage_all_stages_everything
    #[test]
    fn stage_all_stages_everything() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Modify existing tracked file + write a new untracked file
        std::fs::write(dir.path().join("README.md"), "modified for stage all").unwrap();
        std::fs::write(dir.path().join("new_for_all.txt"), "new content").unwrap();

        super::stage_all_inner(&path, &state_map).expect("stage_all_inner failed");

        let status = super::get_status_inner(&path, &state_map).expect("get_status_inner failed");

        assert!(
            status.staged.len() >= 2,
            "expected at least 2 entries in staged after stage_all, got {}",
            status.staged.len()
        );
        assert!(status.unstaged.is_empty(), "expected unstaged to be empty after stage_all");
    }

    // Test 8 — unstage_all_clears_index
    #[test]
    fn unstage_all_clears_index() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Modify README.md and stage it manually
        std::fs::write(dir.path().join("README.md"), "staged for unstage_all test").unwrap();
        let repo = git2::Repository::open(dir.path()).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        index.write().unwrap();
        drop(index);
        drop(repo);

        super::unstage_all_inner(&path, &state_map).expect("unstage_all_inner failed");

        let status = super::get_status_inner(&path, &state_map).expect("get_status_inner failed");

        assert!(status.staged.is_empty(), "expected staged to be empty after unstage_all");
    }
}

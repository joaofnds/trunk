use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use crate::error::TrunkError;
use crate::git::{graph, types::GraphResult};
use crate::state::{CommitCache, RepoState};

fn open_repo(path: &str, state_map: &HashMap<String, PathBuf>) -> Result<git2::Repository, TrunkError> {
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    git2::Repository::open(path_buf).map_err(TrunkError::from)
}

fn is_dirty(repo: &git2::Repository) -> Result<bool, git2::Error> {
    use git2::{Status, StatusOptions};
    let mut opts = StatusOptions::new();
    opts.include_untracked(false).include_ignored(false);

    let dirty_flags = Status::INDEX_NEW
        | Status::INDEX_MODIFIED
        | Status::INDEX_DELETED
        | Status::INDEX_RENAMED
        | Status::INDEX_TYPECHANGE
        | Status::WT_MODIFIED
        | Status::WT_DELETED
        | Status::WT_RENAMED
        | Status::WT_TYPECHANGE;

    let statuses = repo.statuses(Some(&mut opts))?;
    Ok(statuses.iter().any(|s| s.status().intersects(dirty_flags)))
}

pub fn checkout_commit_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let repo = open_repo(path, state_map)?;

    if is_dirty(&repo)? {
        return Err(TrunkError::new(
            "dirty_workdir",
            "Working tree has uncommitted changes",
        ));
    }

    let obj = repo.revparse_single(oid)?;
    repo.checkout_tree(&obj, Some(&mut git2::build::CheckoutBuilder::new().safe()))?;
    repo.set_head_detached(obj.id())?;
    drop(obj);
    drop(repo);

    let path_buf = state_map.get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    let mut repo2 = git2::Repository::open(path_buf)?;
    graph::walk_commits(&mut repo2, 0, usize::MAX).map_err(TrunkError::from)
}

pub fn create_tag_inner(
    path: &str,
    oid: &str,
    tag_name: &str,
    message: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let repo = open_repo(path, state_map)?;
    let obj = repo.revparse_single(oid)?;
    let sig = repo.signature().map_err(TrunkError::from)?;
    let msg = if message.trim().is_empty() {
        tag_name.to_owned()
    } else {
        message.to_owned()
    };
    repo.tag(tag_name, &obj, &sig, &msg, false)?;
    drop(obj);
    drop(repo);

    let path_buf = state_map.get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    let mut repo2 = git2::Repository::open(path_buf)?;
    graph::walk_commits(&mut repo2, 0, usize::MAX).map_err(TrunkError::from)
}

pub fn cherry_pick_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let path_buf = state_map.get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;

    let output = std::process::Command::new("git")
        .args(["cherry-pick", oid])
        .current_dir(path_buf)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| TrunkError::new("cherry_pick_error", e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = if stderr.to_lowercase().contains("conflict") {
            "conflict_state"
        } else {
            "cherry_pick_error"
        };
        return Err(TrunkError::new(code, stderr.to_string()));
    }

    let mut repo = git2::Repository::open(path_buf)?;
    graph::walk_commits(&mut repo, 0, usize::MAX).map_err(TrunkError::from)
}

pub fn revert_commit_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let path_buf = state_map.get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;

    let output = std::process::Command::new("git")
        .args(["revert", oid, "--no-edit"])
        .current_dir(path_buf)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| TrunkError::new("revert_error", e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = if stderr.to_lowercase().contains("conflict") {
            "conflict_state"
        } else {
            "revert_error"
        };
        return Err(TrunkError::new(code, stderr.to_string()));
    }

    let mut repo = git2::Repository::open(path_buf)?;
    graph::walk_commits(&mut repo, 0, usize::MAX).map_err(TrunkError::from)
}

pub fn reset_to_commit_inner(
    path: &str,
    oid: &str,
    mode: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let path_buf = state_map.get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;

    let valid_modes = ["soft", "mixed", "hard"];
    if !valid_modes.contains(&mode) {
        return Err(TrunkError::new("invalid_mode", format!("Invalid reset mode: {}", mode)));
    }

    let output = std::process::Command::new("git")
        .args(["reset", &format!("--{}", mode), oid])
        .current_dir(path_buf)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| TrunkError::new("reset_error", e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(TrunkError::new("reset_error", stderr.to_string()));
    }

    let mut repo = git2::Repository::open(path_buf)?;
    graph::walk_commits(&mut repo, 0, usize::MAX).map_err(TrunkError::from)
}

#[tauri::command]
pub async fn reset_to_commit(
    path: String,
    oid: String,
    mode: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        reset_to_commit_inner(&path_clone, &oid, &mode, &state_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[tauri::command]
pub async fn checkout_commit(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        checkout_commit_inner(&path_clone, &oid, &state_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[tauri::command]
pub async fn create_tag(
    path: String,
    oid: String,
    tag_name: String,
    message: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        create_tag_inner(&path_clone, &oid, &tag_name, &message, &state_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[tauri::command]
pub async fn cherry_pick(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        cherry_pick_inner(&path_clone, &oid, &state_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[tauri::command]
pub async fn revert_commit(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        revert_commit_inner(&path_clone, &oid, &state_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_test_repo() -> (TempDir, HashMap<String, PathBuf>) {
        let dir = TempDir::new().unwrap();
        let path_str = dir.path().to_str().unwrap().to_owned();
        {
            let repo = git2::Repository::init(dir.path()).unwrap();
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Test").unwrap();
            config.set_str("user.email", "test@test.com").unwrap();
            drop(config);

            let sig = repo.signature().unwrap();
            fs::write(dir.path().join("file.txt"), "hello").unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("file.txt")).unwrap();
            index.write().unwrap();
            let tree_oid = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_oid).unwrap();
            repo.commit(Some("refs/heads/main"), &sig, &sig, "Initial commit", &tree, &[]).unwrap();
            drop(tree);

            // Point HEAD at main
            repo.set_head("refs/heads/main").unwrap();
            repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force())).unwrap();
        }
        let mut state_map = HashMap::new();
        state_map.insert(path_str.clone(), dir.path().to_owned());
        (dir, state_map)
    }

    /// Create a repo with two commits so we can checkout/cherry-pick/revert the first.
    fn make_test_repo_two_commits() -> (TempDir, HashMap<String, PathBuf>, String, String) {
        let (dir, state_map) = make_test_repo();
        let first_oid;
        let second_oid;
        {
            let repo = git2::Repository::open(dir.path()).unwrap();
            first_oid = repo.head().unwrap().target().unwrap().to_string();

            let sig = repo.signature().unwrap();
            fs::write(dir.path().join("second.txt"), "world").unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("second.txt")).unwrap();
            index.write().unwrap();
            let tree_oid = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_oid).unwrap();
            let parent = repo.find_commit(repo.head().unwrap().target().unwrap()).unwrap();
            let oid = repo.commit(Some("refs/heads/main"), &sig, &sig, "Second commit", &tree, &[&parent]).unwrap();
            second_oid = oid.to_string();
            drop(tree);
            drop(parent);

            repo.set_head("refs/heads/main").unwrap();
            repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force())).unwrap();
        }
        (dir, state_map, first_oid, second_oid)
    }

    // --- checkout_commit tests ---

    #[test]
    fn checkout_commit_detaches_head() {
        let (dir, state_map, first_oid, _second_oid) = make_test_repo_two_commits();
        let path = dir.path().to_str().unwrap();

        let result = checkout_commit_inner(path, &first_oid, &state_map);
        assert!(result.is_ok(), "checkout_commit should succeed on clean workdir");

        let repo = git2::Repository::open(dir.path()).unwrap();
        assert!(repo.head_detached().unwrap(), "HEAD should be detached");
        assert_eq!(
            repo.head().unwrap().target().unwrap().to_string(),
            first_oid,
            "HEAD should point to the first commit"
        );
    }

    #[test]
    fn checkout_commit_dirty_workdir_fails() {
        let (dir, state_map, first_oid, _second_oid) = make_test_repo_two_commits();
        let path = dir.path().to_str().unwrap();

        // Make workdir dirty
        fs::write(dir.path().join("file.txt"), "modified").unwrap();
        {
            let repo = git2::Repository::open(dir.path()).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("file.txt")).unwrap();
            index.write().unwrap();
        }

        let result = checkout_commit_inner(path, &first_oid, &state_map);
        assert!(result.is_err(), "checkout_commit should fail on dirty workdir");
        assert_eq!(result.unwrap_err().code, "dirty_workdir");
    }

    // --- create_tag tests ---

    #[test]
    fn create_tag_annotated() {
        let (dir, state_map, _first_oid, second_oid) = make_test_repo_two_commits();
        let path = dir.path().to_str().unwrap();

        let result = create_tag_inner(path, &second_oid, "v1.0.0", "Release 1.0", &state_map);
        assert!(result.is_ok(), "create_tag should succeed");

        let repo = git2::Repository::open(dir.path()).unwrap();
        let tag = repo.find_reference("refs/tags/v1.0.0");
        assert!(tag.is_ok(), "tag v1.0.0 should exist");
    }

    #[test]
    fn create_tag_empty_message_uses_name() {
        let (dir, state_map, _first_oid, second_oid) = make_test_repo_two_commits();
        let path = dir.path().to_str().unwrap();

        let result = create_tag_inner(path, &second_oid, "v2.0.0", "", &state_map);
        assert!(result.is_ok(), "create_tag with empty message should succeed");

        let repo = git2::Repository::open(dir.path()).unwrap();
        let tag_ref = repo.find_reference("refs/tags/v2.0.0").unwrap();
        // Peel to tag object to verify it's annotated
        let tag_obj = tag_ref.peel_to_tag().unwrap();
        assert_eq!(tag_obj.message().unwrap(), "v2.0.0");
    }

    #[test]
    fn create_tag_duplicate_fails() {
        let (dir, state_map, _first_oid, second_oid) = make_test_repo_two_commits();
        let path = dir.path().to_str().unwrap();

        create_tag_inner(path, &second_oid, "v1.0.0", "first", &state_map).unwrap();
        let result = create_tag_inner(path, &second_oid, "v1.0.0", "second", &state_map);
        assert!(result.is_err(), "duplicate tag should fail");
        assert_eq!(result.unwrap_err().code, "git_error");
    }

    // --- cherry_pick tests ---

    #[test]
    fn cherry_pick_succeeds() {
        let (dir, state_map, _first_oid, _second_oid) = make_test_repo_two_commits();
        let path = dir.path().to_str().unwrap();

        // Create a new branch from the first commit, then cherry-pick the second
        {
            let repo = git2::Repository::open(dir.path()).unwrap();
            let first = repo.head().unwrap().target().unwrap();
            let first_commit = repo.find_commit(first).unwrap();
            // Get actual first commit (parent of HEAD)
            let parent = first_commit.parent(0).unwrap();
            repo.branch("pick-branch", &parent, false).unwrap();
            repo.set_head("refs/heads/pick-branch").unwrap();
            repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force())).unwrap();
        }

        let result = cherry_pick_inner(path, &_second_oid, &state_map);
        assert!(result.is_ok(), "cherry_pick should succeed: {:?}", result.err());
    }

    // --- revert_commit tests ---

    #[test]
    fn revert_commit_succeeds() {
        let (dir, state_map, _first_oid, second_oid) = make_test_repo_two_commits();
        let path = dir.path().to_str().unwrap();

        let result = revert_commit_inner(path, &second_oid, &state_map);
        assert!(result.is_ok(), "revert should succeed: {:?}", result.err());

        // The reverted file should not exist
        assert!(!dir.path().join("second.txt").exists(), "second.txt should be removed by revert");
    }
}

use tauri::{AppHandle, State};
use crate::state::{CommitCache, RepoState};
use crate::git::{graph, repository};
use crate::error::TrunkError;
use crate::watcher::{self, WatcherState};

#[tauri::command]
pub async fn open_repo(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    watcher_state: State<'_, WatcherState>,
    app: AppHandle,
) -> Result<(), String> {
    let path_clone = path.clone();

    let commits = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<crate::git::types::GraphCommit>, TrunkError> {
        let path_buf = std::path::PathBuf::from(&path_clone);
        repository::validate_and_open(&path_buf)?;
        let mut repo = git2::Repository::open(&path_buf)?;
        graph::walk_commits(&mut repo, 0, usize::MAX)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    let path_buf = std::path::PathBuf::from(&path);
    state.0.lock().unwrap().insert(path.clone(), path_buf.clone());
    cache.0.lock().unwrap().insert(path.clone(), commits);
    watcher::start_watcher(path_buf, app, &watcher_state);

    Ok(())
}

#[tauri::command]
pub async fn close_repo(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    watcher_state: State<'_, WatcherState>,
) -> Result<(), String> {
    state.0.lock().unwrap().remove(&path);
    cache.0.lock().unwrap().remove(&path);
    watcher::stop_watcher(&path, &watcher_state);
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::git::repository::{tests::make_test_repo, validate_and_open};

    #[test]
    fn open_invalid_path() {
        let dir = tempfile::tempdir().unwrap();
        // dir is a real directory but NOT a git repo
        let result = validate_and_open(dir.path());
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().code, "not_a_git_repo");
    }

    #[test]
    fn open_valid_repo() {
        let dir = make_test_repo();
        let result = validate_and_open(dir.path());
        assert!(result.is_ok());
    }

    #[test]
    fn close_removes_state() {
        use std::collections::HashMap;
        use std::path::PathBuf;
        use std::sync::Mutex;

        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state = Mutex::new(HashMap::<String, PathBuf>::new());

        // Simulate open
        state.lock().unwrap().insert(path.clone(), dir.path().to_path_buf());
        assert!(state.lock().unwrap().contains_key(&path));

        // Simulate close
        state.lock().unwrap().remove(&path);
        assert!(!state.lock().unwrap().contains_key(&path));
    }
}

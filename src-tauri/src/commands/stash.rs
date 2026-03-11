use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use crate::error::TrunkError;
use crate::git::{graph, types::{GraphResult, StashEntry}};
use crate::state::{CommitCache, RepoState};

fn open_repo(path: &str, state_map: &HashMap<String, PathBuf>) -> Result<git2::Repository, TrunkError> {
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    git2::Repository::open(path_buf).map_err(TrunkError::from)
}

pub fn list_stashes_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<Vec<StashEntry>, TrunkError> {
    let mut repo = open_repo(path, state_map)?;
    let mut raw: Vec<(usize, String, git2::Oid)> = Vec::new();
    repo.stash_foreach(|idx, name, oid| {
        raw.push((idx, name.to_owned(), *oid));
        true
    })?;
    Ok(raw.into_iter().map(|(idx, name, stash_oid)| {
        let parent_oid = repo
            .find_commit(stash_oid)
            .ok()
            .and_then(|c| c.parent_id(0).ok())
            .map(|o| o.to_string());
        StashEntry {
            index: idx,
            short_name: format!("stash@{{{}}}", idx),
            name,
            parent_oid,
        }
    }).collect())
}

pub fn stash_save_inner(
    path: &str,
    message: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let mut repo = open_repo(path, state_map)?;
    let sig = repo.signature().map_err(TrunkError::from)?;
    let msg = if message.trim().is_empty() {
        let branch = repo.head().ok()
            .and_then(|h| h.shorthand().map(str::to_owned))
            .unwrap_or_else(|| "HEAD".to_owned());
        format!("WIP on {}", branch)
    } else {
        message.to_owned()
    };
    repo.stash_save(&sig, &msg, None).map_err(|e| {
        if e.message().contains("nothing to stash") {
            TrunkError::new("nothing_to_stash", "Nothing to stash — working tree is clean")
        } else {
            TrunkError::from(e)
        }
    })?;
    graph::walk_commits(&mut repo, 0, usize::MAX).map_err(TrunkError::from)
}

pub fn stash_pop_inner(
    path: &str,
    index: usize,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let mut repo = open_repo(path, state_map)?;
    repo.stash_pop(index, None).map_err(|e| {
        if e.message().contains("conflict") || e.message().contains("merge") {
            TrunkError::new("conflict_state", "Stash applied with conflicts — resolve conflicts before continuing. Note: stash was NOT removed.")
        } else {
            TrunkError::from(e)
        }
    })?;
    // Check for post-apply conflicts (git2 may return Ok even with conflicts)
    {
        let statuses = repo.statuses(None).map_err(TrunkError::from)?;
        let has_conflicts = statuses.iter().any(|s| s.status().contains(git2::Status::CONFLICTED));
        if has_conflicts {
            return Err(TrunkError::new("conflict_state", "Stash applied with conflicts — resolve conflicts before continuing. Note: stash was NOT removed."));
        }
    }
    graph::walk_commits(&mut repo, 0, usize::MAX).map_err(TrunkError::from)
}

pub fn stash_apply_inner(
    path: &str,
    index: usize,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let mut repo = open_repo(path, state_map)?;
    repo.stash_apply(index, None).map_err(|e| {
        if e.message().contains("conflict") || e.message().contains("merge") {
            TrunkError::new("conflict_state", "Stash applied with conflicts — resolve conflicts before continuing")
        } else {
            TrunkError::from(e)
        }
    })?;
    {
        let statuses = repo.statuses(None).map_err(TrunkError::from)?;
        let has_conflicts = statuses.iter().any(|s| s.status().contains(git2::Status::CONFLICTED));
        if has_conflicts {
            return Err(TrunkError::new("conflict_state", "Stash applied with conflicts — resolve conflicts before continuing"));
        }
    }
    graph::walk_commits(&mut repo, 0, usize::MAX).map_err(TrunkError::from)
}

pub fn stash_drop_inner(
    path: &str,
    index: usize,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let mut repo = open_repo(path, state_map)?;
    repo.stash_drop(index).map_err(TrunkError::from)?;
    graph::walk_commits(&mut repo, 0, usize::MAX).map_err(TrunkError::from)
}

#[tauri::command]
pub async fn list_stashes(
    path: String,
    state: State<'_, RepoState>,
) -> Result<Vec<StashEntry>, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || list_stashes_inner(&path, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

#[tauri::command]
pub async fn stash_save(
    path: String,
    message: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        stash_save_inner(&path_clone, &message, &state_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[tauri::command]
pub async fn stash_pop(
    path: String,
    index: usize,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        stash_pop_inner(&path_clone, index, &state_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[tauri::command]
pub async fn stash_apply(
    path: String,
    index: usize,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        stash_apply_inner(&path_clone, index, &state_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[tauri::command]
pub async fn stash_drop(
    path: String,
    index: usize,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        stash_drop_inner(&path_clone, index, &state_map)
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
            // configure identity
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Test").unwrap();
            config.set_str("user.email", "test@test.com").unwrap();
            drop(config);
            // initial commit (required for stash to work)
            let sig = repo.signature().unwrap();
            let tree_oid = repo.index().unwrap().write_tree().unwrap();
            let tree = repo.find_tree(tree_oid).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[]).unwrap();
            drop(tree);
            // make repo dirty (write + stage a file)
            fs::write(dir.path().join("file.txt"), "hello").unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("file.txt")).unwrap();
            index.write().unwrap();
        }
        let mut state_map = HashMap::new();
        state_map.insert(path_str.clone(), dir.path().to_owned());
        (dir, state_map)
    }

    #[test]
    fn stash_save_creates_entry() {
        let (dir, state_map) = make_test_repo();
        let path = dir.path().to_str().unwrap();
        stash_save_inner(path, "my stash", &state_map).unwrap();
        let stashes = list_stashes_inner(path, &state_map).unwrap();
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].short_name, "stash@{0}");
    }

    #[test]
    fn stash_save_default_message() {
        let (dir, state_map) = make_test_repo();
        let path = dir.path().to_str().unwrap();
        stash_save_inner(path, "", &state_map).unwrap();
        let stashes = list_stashes_inner(path, &state_map).unwrap();
        assert_eq!(stashes.len(), 1);
        // message should contain branch name (not empty)
        assert!(!stashes[0].name.is_empty());
    }

    #[test]
    fn stash_save_clean_workdir() {
        let dir = TempDir::new().unwrap();
        let path_str = dir.path().to_str().unwrap().to_owned();
        {
            let repo = git2::Repository::init(dir.path()).unwrap();
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Test").unwrap();
            config.set_str("user.email", "test@test.com").unwrap();
            drop(config);
            let sig = repo.signature().unwrap();
            let tree_oid = repo.index().unwrap().write_tree().unwrap();
            let tree = repo.find_tree(tree_oid).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[]).unwrap();
            drop(tree);
        }
        let mut state_map = HashMap::new();
        state_map.insert(path_str.clone(), dir.path().to_owned());
        let err = stash_save_inner(&path_str, "test", &state_map).unwrap_err();
        assert_eq!(err.code, "nothing_to_stash");
    }

    #[test]
    fn list_stashes_returns_parent_oid() {
        let (dir, state_map) = make_test_repo();
        let path = dir.path().to_str().unwrap();
        stash_save_inner(path, "stash1", &state_map).unwrap();
        let stashes = list_stashes_inner(path, &state_map).unwrap();
        assert!(stashes[0].parent_oid.is_some());
    }

    #[test]
    fn stash_pop_removes_entry() {
        let (dir, state_map) = make_test_repo();
        let path = dir.path().to_str().unwrap();
        stash_save_inner(path, "pop test", &state_map).unwrap();
        stash_pop_inner(path, 0, &state_map).unwrap();
        let stashes = list_stashes_inner(path, &state_map).unwrap();
        assert_eq!(stashes.len(), 0);
    }

    #[test]
    fn stash_apply_keeps_entry() {
        let (dir, state_map) = make_test_repo();
        let path = dir.path().to_str().unwrap();
        stash_save_inner(path, "apply test", &state_map).unwrap();
        stash_apply_inner(path, 0, &state_map).unwrap();
        let stashes = list_stashes_inner(path, &state_map).unwrap();
        assert_eq!(stashes.len(), 1, "apply should keep the stash entry");
    }

    #[test]
    fn stash_drop_removes_entry() {
        let (dir, state_map) = make_test_repo();
        let path = dir.path().to_str().unwrap();
        stash_save_inner(path, "drop test", &state_map).unwrap();
        stash_drop_inner(path, 0, &state_map).unwrap();
        let stashes = list_stashes_inner(path, &state_map).unwrap();
        assert_eq!(stashes.len(), 0);
        // workdir is unchanged — file.txt should NOT exist (was stashed, not restored)
        assert!(!dir.path().join("file.txt").exists());
    }
}

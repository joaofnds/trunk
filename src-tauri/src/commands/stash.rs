use crate::error::TrunkError;
use crate::git::{
    graph,
    types::{GraphResult, StashEntry},
};
use crate::state::{CommitCache, RepoState};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

pub fn list_stashes_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<Vec<StashEntry>, TrunkError> {
    let mut repo = crate::commands::open_repo_from_state(path, state_map)?;
    let mut raw: Vec<(usize, String, git2::Oid)> = Vec::new();
    repo.stash_foreach(|idx, name, oid| {
        raw.push((idx, name.to_owned(), *oid));
        true
    })?;
    Ok(raw
        .into_iter()
        .map(|(idx, name, stash_oid)| {
            let parent_oid = repo
                .find_commit(stash_oid)
                .ok()
                .and_then(|c| c.parent_id(0).ok())
                .map(|o| o.to_string());
            StashEntry {
                index: idx,
                short_name: format!("stash@{{{}}}", idx),
                name,
                oid: stash_oid.to_string(),
                parent_oid,
            }
        })
        .collect())
}

pub fn stash_save_inner(
    path: &str,
    message: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let mut repo = crate::commands::open_repo_from_state(path, state_map)?;
    let sig = repo.signature().map_err(TrunkError::from)?;
    let msg = if message.trim().is_empty() {
        let branch = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().ok().map(str::to_owned))
            .unwrap_or_else(|| "HEAD".to_owned());
        format!("WIP on {}", branch)
    } else {
        message.to_owned()
    };
    repo.stash_save(&sig, &msg, None).map_err(|e| {
        if e.message().contains("nothing to stash") {
            TrunkError::new(
                "nothing_to_stash",
                "Nothing to stash — working tree is clean",
            )
        } else {
            TrunkError::from(e)
        }
    })?;
    graph::walk_commits(&mut repo, 0, usize::MAX)
}

pub fn stash_pop_inner(
    path: &str,
    index: usize,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let mut repo = crate::commands::open_repo_from_state(path, state_map)?;
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
        let has_conflicts = statuses
            .iter()
            .any(|s| s.status().contains(git2::Status::CONFLICTED));
        if has_conflicts {
            return Err(TrunkError::new(
                "conflict_state",
                "Stash applied with conflicts — resolve conflicts before continuing. Note: stash was NOT removed.",
            ));
        }
    }
    graph::walk_commits(&mut repo, 0, usize::MAX)
}

pub fn stash_apply_inner(
    path: &str,
    index: usize,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let mut repo = crate::commands::open_repo_from_state(path, state_map)?;
    repo.stash_apply(index, None).map_err(|e| {
        if e.message().contains("conflict") || e.message().contains("merge") {
            TrunkError::new(
                "conflict_state",
                "Stash applied with conflicts — resolve conflicts before continuing",
            )
        } else {
            TrunkError::from(e)
        }
    })?;
    {
        let statuses = repo.statuses(None).map_err(TrunkError::from)?;
        let has_conflicts = statuses
            .iter()
            .any(|s| s.status().contains(git2::Status::CONFLICTED));
        if has_conflicts {
            return Err(TrunkError::new(
                "conflict_state",
                "Stash applied with conflicts — resolve conflicts before continuing",
            ));
        }
    }
    graph::walk_commits(&mut repo, 0, usize::MAX)
}

pub fn stash_drop_inner(
    path: &str,
    index: usize,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphResult, TrunkError> {
    let mut repo = crate::commands::open_repo_from_state(path, state_map)?;
    repo.stash_drop(index).map_err(TrunkError::from)?;
    graph::walk_commits(&mut repo, 0, usize::MAX)
}

#[tauri::command]
pub async fn list_stashes(
    path: String,
    state: State<'_, RepoState>,
) -> Result<Vec<StashEntry>, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || list_stashes_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
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
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

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
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

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
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

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
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

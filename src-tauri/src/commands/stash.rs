use crate::error::TrunkError;
use crate::git::graph_input::GraphSnapshot;
use crate::git::{graph, types::StashEntry};
use crate::state::{CommitCache, RepoState};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Runtime, State};

/// Kept apart: only pop can leave an entry behind, so only pop's message may say so.
const POP_CONFLICT_MESSAGE: &str = "Stash applied with conflicts — resolve conflicts before continuing. Note: stash was NOT removed.";
const APPLY_CONFLICT_MESSAGE: &str =
    "Stash applied with conflicts — resolve conflicts before continuing";

/// `stash@{n}` is a position in a stack anything can renumber — a second window,
/// a terminal, or this app on another tab. Resolving the caller's stash commit to
/// its current position at call time is what keeps an operation on the entry the
/// user picked; a stale position silently names a different one.
fn stash_index_of(repo: &mut git2::Repository, oid: &str) -> Result<usize, TrunkError> {
    let wanted = git2::Oid::from_str(oid)
        .map_err(|_| TrunkError::new("stash_not_found", format!("Not a stash id: {oid}")))?;

    let mut found = None;
    repo.stash_foreach(|idx, _, stash_oid| {
        if *stash_oid == wanted {
            found = Some(idx);
            return false;
        }
        true
    })?;

    found.ok_or_else(|| {
        TrunkError::new(
            "stash_not_found",
            "That stash is no longer in this repository — it was applied or dropped elsewhere.",
        )
    })
}

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
                short_name: format!("stash@{{{idx}}}"),
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
    visibility: &crate::git::graph_input::RefVisibility,
) -> Result<GraphSnapshot, TrunkError> {
    let mut repo = crate::commands::open_repo_from_state(path, state_map)?;
    let sig = repo.signature().map_err(TrunkError::from)?;
    let msg = if message.trim().is_empty() {
        let branch = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().ok().map(str::to_owned))
            .unwrap_or_else(|| "HEAD".to_owned());
        format!("WIP on {branch}")
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
    graph::snapshot(&mut repo, visibility)
}

pub fn stash_pop_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
    visibility: &crate::git::graph_input::RefVisibility,
) -> Result<GraphSnapshot, TrunkError> {
    let mut repo = crate::commands::open_repo_from_state(path, state_map)?;
    let index = stash_index_of(&mut repo, oid)?;
    // Apply and drop separately rather than `stash_pop`: git2's pop drops the entry even
    // when it applied with conflicts, leaving the user's stashed work nowhere once they
    // clear the conflict markers. Real `git stash pop` keeps it, and so does this.
    repo.stash_apply(index, None).map_err(|e| {
        if e.message().contains("conflict") || e.message().contains("merge") {
            TrunkError::new("conflict_state", POP_CONFLICT_MESSAGE)
        } else {
            TrunkError::from(e)
        }
    })?;
    if crate::git::repository::has_unmerged_paths(&repo)? {
        return Err(TrunkError::new("conflict_state", POP_CONFLICT_MESSAGE));
    }
    repo.stash_drop(index).map_err(TrunkError::from)?;
    graph::snapshot(&mut repo, visibility)
}

pub fn stash_apply_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
    visibility: &crate::git::graph_input::RefVisibility,
) -> Result<GraphSnapshot, TrunkError> {
    let mut repo = crate::commands::open_repo_from_state(path, state_map)?;
    let index = stash_index_of(&mut repo, oid)?;
    repo.stash_apply(index, None).map_err(|e| {
        if e.message().contains("conflict") || e.message().contains("merge") {
            TrunkError::new("conflict_state", APPLY_CONFLICT_MESSAGE)
        } else {
            TrunkError::from(e)
        }
    })?;
    if crate::git::repository::has_unmerged_paths(&repo)? {
        return Err(TrunkError::new("conflict_state", APPLY_CONFLICT_MESSAGE));
    }
    graph::snapshot(&mut repo, visibility)
}

pub fn stash_drop_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
    visibility: &crate::git::graph_input::RefVisibility,
) -> Result<GraphSnapshot, TrunkError> {
    let mut repo = crate::commands::open_repo_from_state(path, state_map)?;
    let index = stash_index_of(&mut repo, oid)?;
    repo.stash_drop(index).map_err(TrunkError::from)?;
    graph::snapshot(&mut repo, visibility)
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
pub async fn stash_save<R: Runtime>(
    path: String,
    message: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        stash_save_inner(&path_clone, &message, &state_map, &visibility)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[tauri::command]
pub async fn stash_pop<R: Runtime>(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        stash_pop_inner(&path_clone, &oid, &state_map, &visibility)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[tauri::command]
pub async fn stash_apply<R: Runtime>(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        stash_apply_inner(&path_clone, &oid, &state_map, &visibility)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[tauri::command]
pub async fn stash_drop<R: Runtime>(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        stash_drop_inner(&path_clone, &oid, &state_map, &visibility)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

use crate::error::TrunkError;
use crate::git::graph;
use crate::git::types::MergeSides;
use crate::state::{CommitCache, RepoState};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Runtime, State};

pub fn get_merge_sides_inner(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<MergeSides, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let index = repo.index()?;

    // Find the conflict entry for this file by iterating all conflicts
    let mut conflicts = index
        .conflicts()
        .map_err(|e| TrunkError::new("conflict_error", e.to_string()))?;

    let conflict = conflicts
        .find(|entry| {
            if let Ok(c) = entry {
                let entry_path = c
                    .our
                    .as_ref()
                    .or(c.their.as_ref())
                    .or(c.ancestor.as_ref())
                    .map(|e| String::from_utf8_lossy(&e.path).into_owned());
                entry_path.as_deref() == Some(file_path)
            } else {
                false
            }
        })
        .ok_or_else(|| {
            TrunkError::new(
                "not_conflicted",
                format!("File not in conflict: {}", file_path),
            )
        })?
        .map_err(|e| TrunkError::new("conflict_error", e.to_string()))?;

    // `from_utf8_lossy` would replace every invalid byte with U+FFFD and the save
    // path writes that text back over the file, with both original sides already
    // dropped from the index. Refusing here is what keeps the sides recoverable.
    let read_blob = |entry: &Option<git2::IndexEntry>| -> Result<String, TrunkError> {
        let Some(e) = entry else {
            return Ok(String::new());
        };
        let blob = repo.find_blob(e.id)?;
        String::from_utf8(blob.content().to_vec()).map_err(|_| {
            TrunkError::new(
                "binary_conflict",
                format!("{file_path} is binary — resolve it outside the merge editor."),
            )
        })
    };

    Ok(MergeSides {
        base: read_blob(&conflict.ancestor)?,
        ours: read_blob(&conflict.our)?,
        theirs: read_blob(&conflict.their)?,
    })
}

pub fn save_merge_result_inner(
    path: &str,
    file_path: &str,
    content: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let repo_path = repo
        .workdir()
        .ok_or_else(|| TrunkError::new("no_workdir", "Bare repository"))?;

    // Write merged content to disk
    let full_path = repo_path.join(file_path);
    std::fs::write(&full_path, content)
        .map_err(|e| TrunkError::new("write_error", e.to_string()))?;

    // Stage the file (clears conflict entry from index)
    let mut index = repo.index()?;
    index.add_path(std::path::Path::new(file_path))?;
    index.write()?;

    Ok(())
}

// --- Tauri command wrappers ---

#[tauri::command]
pub async fn get_merge_sides(
    path: String,
    file_path: String,
    state: State<'_, RepoState>,
) -> Result<MergeSides, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        get_merge_sides_inner(&path, &file_path, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn save_merge_result<R: Runtime>(
    path: String,
    file_path: String,
    content: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let state_map_clone = state_map.clone();
    tauri::async_runtime::spawn_blocking(move || {
        save_merge_result_inner(&path_clone, &file_path, &content, &state_map_clone)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    // Repopulate cache and emit repo-changed (same pattern as merge_continue)
    let path_for_cache = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        let path_buf = crate::commands::repo_path_from_state(&path_for_cache, &state_map)?;
        let mut repo = git2::Repository::open(path_buf)?;
        graph::walk_commits(&mut repo, 0, usize::MAX, &visibility)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

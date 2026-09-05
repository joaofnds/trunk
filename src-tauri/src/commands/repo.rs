use crate::error::TrunkError;
use crate::git::graph_input::GraphSnapshot;
use crate::git::{graph, repository};
use crate::state::{CommitCache, CommitStatsCache, RepoState, RunningOp, kill_process};
use crate::watcher::{self, WatcherState};
use tauri::{AppHandle, Runtime, State};

/// Open a repository, cache its first graph, and start watching it.
///
/// # Errors
///
/// Returns `spawn_error` as JSON when the blocking task cannot be joined, and
/// the git error as JSON when the path is not a repository this app can open.
///
/// # Panics
///
/// Panics when the commit-cache lock is poisoned.
#[tauri::command]
pub async fn open_repo<R: Runtime>(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    watcher_state: State<'_, WatcherState>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    // Nothing has pushed a visibility for a repo being opened, so this first graph shows
    // every ref. The frontend loads the stored set from prefs, pushes it, and refreshes.
    let visibility = ref_visibility.get(&path);
    let path_clone = path.clone();

    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<GraphSnapshot, TrunkError> {
            let path_buf = std::path::PathBuf::from(&path_clone);
            repository::validate_and_open(&path_buf)?;
            let mut repo = git2::Repository::open(&path_buf)?;
            graph::snapshot(&mut repo, &visibility)
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())?;

    let path_buf = std::path::PathBuf::from(&path);
    state.register(path.clone(), path_buf.clone());
    cache.0.lock().unwrap().insert(path.clone(), result);
    watcher::start_watcher(path_buf, app, &watcher_state);

    Ok(())
}

/// Forget a repository and stop watching it.
///
/// # Errors
///
/// Never returns an error. The `Result` is the shape every command shares.
///
/// # Panics
///
/// Panics when the commit-cache or stats lock is poisoned.
#[tauri::command]
pub async fn close_repo(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    stats: State<'_, CommitStatsCache>,
    watcher_state: State<'_, WatcherState>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
) -> Result<(), String> {
    state.forget(&path);
    cache.0.lock().unwrap().forget(&path);
    stats.0.lock().unwrap().remove(&path);
    ref_visibility.forget(&path);
    watcher::stop_watcher(&path, &watcher_state);
    Ok(())
}

/// Close a repository, killing any remote operation still running on it.
///
/// # Errors
///
/// Never returns an error. The `Result` is the shape every command shares.
///
/// # Panics
///
/// Panics when the running-operation, commit-cache or stats lock is poisoned.
#[tauri::command]
pub async fn force_close_repo(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    stats: State<'_, CommitStatsCache>,
    watcher_state: State<'_, WatcherState>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
) -> Result<(), String> {
    // Cancel running remote op first (D-03)
    {
        let mut guard = running.0.lock().unwrap();
        if let Some(pid) = guard.finish(&path) {
            kill_process(pid);
        }
    }
    // Then clean up all other state (same as close_repo)
    state.forget(&path);
    cache.0.lock().unwrap().forget(&path);
    stats.0.lock().unwrap().remove(&path);
    ref_visibility.forget(&path);
    watcher::stop_watcher(&path, &watcher_state);
    Ok(())
}

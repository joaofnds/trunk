use crate::state::{CommitCache, CommitStatsCache, RepoState, RunningOp};
use crate::watcher::{self, WatcherState};
use tauri::{AppHandle, Runtime, State};
use trunk_git::error::TrunkError;
use trunk_git::repository;

/// Open a repository, cache its first graph, and start watching it.
///
/// # Errors
///
/// Returns `spawn_error` as JSON when the blocking task cannot be joined, and
/// the git error as JSON when the path is not a repository this app can open.
/// Returns `watcher_unavailable` when filesystem watching cannot be registered.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
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
    cache.open_session(&path);
    let opening_session = cache.session_id(&path);
    let rebuild = crate::state::GraphRebuild::new(&cache, &ref_visibility);
    let path_clone = path.clone();
    rebuild
        .rebuild(
            path.clone(),
            move || -> Result<crate::state::GraphRead, TrunkError> {
                let path_buf = std::path::PathBuf::from(&path_clone);
                repository::validate_and_open(&path_buf)?;
                let mut repo = git2::Repository::open(&path_buf)?;
                crate::state::read_graph(&mut repo)
            },
        )
        .await
        .map_err(|e| e.to_json())?;

    let path_buf = std::path::PathBuf::from(&path);
    let mut repositories = state.0.lock().unwrap();
    if cache.session_id(&path) != opening_session {
        return Err(TrunkError::new("not_open", "Repository session was closed").to_json());
    }
    repositories.register(path.clone(), path_buf.clone());
    if let Err(error) = watcher::start_watcher(&path_buf, app, &watcher_state) {
        repositories.forget(&path);
        cache.forget(&path);
        return Err(error.to_json());
    }
    drop(repositories);

    Ok(())
}

/// Forget a repository, cancel its remote operation, and stop watching it.
///
/// # Errors
///
/// Never returns an error. The `Result` is the shape every command shares.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn close_repo(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    commit_stats: State<'_, CommitStatsCache>,
    watcher_state: State<'_, WatcherState>,
    running: State<'_, RunningOp>,
    background: State<'_, crate::background_fetch::BackgroundFetch>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
) -> Result<(), String> {
    let mut repositories = state.0.lock().unwrap();
    cache.forget(&path);
    repositories.forget(&path);
    let process = running.0.lock().unwrap().cancel(&path);
    if let Some(process) = process {
        process.stop();
    }
    background.forget(&path);
    commit_stats.0.lock().unwrap().forget(&path);
    ref_visibility.forget(&path);
    watcher::stop_watcher(&path, &watcher_state);
    drop(repositories);
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
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn force_close_repo(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    commit_stats: State<'_, CommitStatsCache>,
    watcher_state: State<'_, WatcherState>,
    running: State<'_, RunningOp>,
    background: State<'_, crate::background_fetch::BackgroundFetch>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
) -> Result<(), String> {
    close_repo(
        path,
        state,
        cache,
        commit_stats,
        watcher_state,
        running,
        background,
        ref_visibility,
    )
    .await
}

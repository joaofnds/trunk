use crate::state::{CommitCache, CommitStatsCache, RepoState, RunningOp};
use crate::watcher::{self, WatcherState};
use tauri::{AppHandle, Emitter, Runtime, State};
use trunk_git::error::TrunkError;
use trunk_git::repository;

/// Open a repository, cache its first graph, and start watching it. It returns
/// without waiting for the watch, which reports its own failure.
///
/// # Errors
///
/// Returns `spawn_error` as JSON when the blocking task cannot be joined, and
/// the git error as JSON when the path is not a repository this app can open.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn open_repo<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    // Nothing has pushed a visibility for a repo being opened, so this first graph shows
    // every ref. The frontend loads the stored set from prefs, pushes it, and refreshes.
    cache.open_session(&path);
    let opening_session = cache.session_id(&path);
    let rebuild = crate::state::GraphRebuild::new(activity.clone(), &cache, &ref_visibility);
    let path_buf = std::path::PathBuf::from(&path);
    // The repository is registered with the memo its first capture filled, so the next
    // capture reads only what changed.
    let entry = crate::state::OpenRepo::new(path_buf.clone());
    let opening = entry.clone();
    rebuild
        .rebuild(
            path.clone(),
            move || -> Result<crate::state::GraphRead, TrunkError> {
                repository::validate_and_open(opening.location())?;
                opening.read_graph()
            },
        )
        .await
        .map_err(|e| e.to_json())?;

    let mut repositories = state.0.lock().unwrap();
    if cache.session_id(&path) != opening_session {
        return Err(TrunkError::new("not_open", "Repository session was closed").to_json());
    }
    repositories.register(path.clone(), entry);
    let watching = watcher::watch_in_background(path_buf, app.clone());
    drop(repositories);

    if let Err(error) = watching {
        eprintln!("{path} is not watched: {error}");
        let _ = app.emit(
            watcher::WATCH_UNAVAILABLE,
            watcher::WatchUnavailable { repo: path },
        );
    }

    Ok(())
}

/// Forget a repository, cancel its background fetch, and stop watching it. A remote
/// operation the user started runs on to its end.
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
    _activity: crate::activity::Activity,
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
    let process = running.0.lock().unwrap().cancel_background(&path);
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
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    commit_stats: State<'_, CommitStatsCache>,
    watcher_state: State<'_, WatcherState>,
    running: State<'_, RunningOp>,
    background: State<'_, crate::background_fetch::BackgroundFetch>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
) -> Result<(), String> {
    let process = running.0.lock().unwrap().cancel(&path);
    if let Some(process) = process {
        process.stop();
    }
    close_repo(
        activity,
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

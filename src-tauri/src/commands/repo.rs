use crate::error::TrunkError;
use crate::git::review_store;
use crate::git::types::ReviewSession;
use crate::git::{graph, repository};
use crate::state::{
    kill_process, CommitCache, CommitStatsCache, RepoState, ReviewSessionsState, RunningOp,
};
use crate::watcher::{self, WatcherState};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Drop ONLY the in-memory session entry for `path` (canonical-keyed). The file
/// on disk is left untouched so resume works on reopen — only `end_review_session`
/// hard-deletes (D-13/D-14). Best-effort: if the path no longer canonicalizes
/// (repo dir gone), there is nothing to remove.
fn drop_in_memory_session(path: &str, sessions: &State<'_, ReviewSessionsState>) {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        sessions.0.lock().unwrap().remove(&canonical);
    }
}

/// Inverse of `drop_in_memory_session`: load a clean on-disk session for `path`
/// back into the in-memory map when a repo (re)opens, so an ongoing review's
/// comment counts are live the instant the repo is open instead of staying blank
/// until the review pane lazily resumes it. `close_repo` drops the entry but leaves
/// the file precisely "so resume works on reopen"; this is the reopen half that
/// closes that symmetry.
///
/// Uses the side-effect-free `peek_clean_session`, NOT `load_session` (which is a
/// recovery state machine: it quarantines corrupt files and re-saves migrations on
/// disk). Only a clean, current-schema session hydrates here; corrupt, newer-schema,
/// and migration-pending files are left byte-unchanged for the explicit resume path,
/// which alone surfaces the recovery/refusal toast (D-15/D-16). `or_insert` keeps
/// re-open idempotent — a live in-memory session is never clobbered by a disk reload.
fn hydrate_in_memory_session(
    data_dir: &Path,
    path: &str,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
) {
    let Ok(canonical) = std::fs::canonicalize(path) else {
        return;
    };
    if let Some(session) = review_store::peek_clean_session(data_dir, &canonical) {
        sessions.lock().unwrap().entry(canonical).or_insert(session);
    }
}

#[tauri::command]
pub async fn open_repo(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    watcher_state: State<'_, WatcherState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<(), String> {
    let path_clone = path.clone();

    let result = tauri::async_runtime::spawn_blocking(
        move || -> Result<crate::git::types::GraphResult, TrunkError> {
            let path_buf = std::path::PathBuf::from(&path_clone);
            repository::validate_and_open(&path_buf)?;
            let mut repo = git2::Repository::open(&path_buf)?;
            graph::walk_commits(&mut repo, 0, usize::MAX)
        },
    )
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    let path_buf = std::path::PathBuf::from(&path);
    state
        .0
        .lock()
        .unwrap()
        .insert(path.clone(), path_buf.clone());
    cache.0.lock().unwrap().insert(path.clone(), result);
    watcher::start_watcher(path_buf, app.clone(), &watcher_state);

    // Reopen half of the session lifecycle (see hydrate_in_memory_session): make an
    // ongoing review's state live the moment the repo is open. Swallow an
    // app_data_dir() failure deliberately — hydration is an enhancement, never a
    // reason to fail the repo open; the lazy resume path still recovers later.
    if let Ok(data_dir) = app.path().app_data_dir() {
        hydrate_in_memory_session(&data_dir, &path, &sessions.0);
    }

    Ok(())
}

#[tauri::command]
pub async fn close_repo(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    stats: State<'_, CommitStatsCache>,
    watcher_state: State<'_, WatcherState>,
    sessions: State<'_, ReviewSessionsState>,
) -> Result<(), String> {
    state.0.lock().unwrap().remove(&path);
    cache.0.lock().unwrap().remove(&path);
    stats.0.lock().unwrap().remove(&path);
    watcher::stop_watcher(&path, &watcher_state);
    drop_in_memory_session(&path, &sessions);
    Ok(())
}

#[tauri::command]
pub async fn force_close_repo(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    stats: State<'_, CommitStatsCache>,
    watcher_state: State<'_, WatcherState>,
    running: State<'_, RunningOp>,
    sessions: State<'_, ReviewSessionsState>,
) -> Result<(), String> {
    // Cancel running remote op first (D-03)
    {
        let mut guard = running.0.lock().unwrap();
        if let Some(pid) = guard.remove(&path) {
            kill_process(pid);
        }
    }
    // Then clean up all other state (same as close_repo)
    state.0.lock().unwrap().remove(&path);
    cache.0.lock().unwrap().remove(&path);
    stats.0.lock().unwrap().remove(&path);
    watcher::stop_watcher(&path, &watcher_state);
    drop_in_memory_session(&path, &sessions);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn empty_session() -> ReviewSession {
        ReviewSession {
            schema_version: 2,
            commits: vec![],
            comments: vec![],
            draft_comment: None,
            working_tree_snapshot: None,
            index_snapshot: None,
        }
    }

    #[test]
    fn hydrate_loads_a_saved_session_into_memory() {
        let data_dir = TempDir::new().unwrap();
        let repo_dir = TempDir::new().unwrap();
        let canonical = std::fs::canonicalize(repo_dir.path()).unwrap();
        review_store::save_session(data_dir.path(), &canonical, &empty_session()).unwrap();

        let sessions = Mutex::new(HashMap::new());
        hydrate_in_memory_session(
            data_dir.path(),
            repo_dir.path().to_str().unwrap(),
            &sessions,
        );

        assert!(sessions.lock().unwrap().contains_key(&canonical));
    }

    #[test]
    fn hydrate_is_a_noop_without_a_saved_session() {
        let data_dir = TempDir::new().unwrap();
        let repo_dir = TempDir::new().unwrap();

        let sessions = Mutex::new(HashMap::new());
        hydrate_in_memory_session(
            data_dir.path(),
            repo_dir.path().to_str().unwrap(),
            &sessions,
        );

        assert!(sessions.lock().unwrap().is_empty());
    }
}

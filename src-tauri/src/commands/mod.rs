use crate::error::TrunkError;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Open the git repository registered for `path` in the app's repo-state map.
/// Returns a `not_open` error if the path was never opened. Shared by every
/// command module so the open/error contract lives in exactly one place.
pub(crate) fn open_repo_from_state(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<git2::Repository, TrunkError> {
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    git2::Repository::open(path_buf).map_err(TrunkError::from)
}

/// Whether the worktree holds conflicted paths. A pull whose autostash restore
/// conflicts exits 0, leaves no rebase directory, and reads `repo.state() == Clean`,
/// so the unmerged paths are the only evidence the pull did not finish the job.
pub fn has_unmerged_paths(repo: &git2::Repository) -> Result<bool, TrunkError> {
    let statuses = repo.statuses(None).map_err(TrunkError::from)?;
    Ok(statuses
        .iter()
        .any(|s| s.status().contains(git2::Status::CONFLICTED)))
}

/// Resolve `app_data_dir`, JSON-stringifying the error like the other commands.
pub(crate) fn resolve_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| TrunkError::new("app_data_dir", e.to_string()).to_json())
}

pub mod branches;
pub mod commit;
pub mod commit_actions;
pub mod diff;
pub mod fs;
pub mod history;
pub mod interactive_rebase;
pub mod markdown;
pub mod merge_editor;
pub mod operation_state;
pub mod prefs;
pub mod remote;
pub mod repo;
pub mod review;
pub mod staging;
pub mod stash;

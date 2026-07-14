use crate::error::TrunkError;
use std::collections::HashMap;
use std::path::PathBuf;

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
pub mod remote;
pub mod repo;
pub mod review;
pub mod staging;
pub mod stash;

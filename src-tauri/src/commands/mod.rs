use crate::error::TrunkError;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The message reaches the user as a toast, so it names the repository rather than
/// spelling out where it lives on disk.
pub(crate) fn repo_path_from_state<'a>(
    path: &str,
    state_map: &'a HashMap<String, PathBuf>,
) -> Result<&'a PathBuf, TrunkError> {
    state_map.get(path).ok_or_else(|| {
        let name = std::path::Path::new(path)
            .file_name()
            .map_or(path, |n| n.to_str().unwrap_or(path));
        TrunkError::new("not_open", format!("Repository not open: {}", name))
    })
}

/// Open the git repository registered for `path` in the app's repo-state map.
pub(crate) fn open_repo_from_state(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<git2::Repository, TrunkError> {
    git2::Repository::open(repo_path_from_state(path, state_map)?).map_err(TrunkError::from)
}

/// Resolve `app_data_dir`, JSON-stringifying the error like the other commands.
pub(crate) fn resolve_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| TrunkError::new("app_data_dir", e.to_string()).to_json())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_miss_reports_not_open() {
        let err = repo_path_from_state("/Users/someone/code/my-repo", &HashMap::new()).unwrap_err();

        assert_eq!(err.code, "not_open");
    }

    #[test]
    fn a_miss_names_the_repository_without_its_path() {
        let err = repo_path_from_state("/Users/someone/code/my-repo", &HashMap::new()).unwrap_err();

        assert_eq!(err.message, "Repository not open: my-repo");
    }

    #[test]
    fn a_miss_falls_back_to_the_key_when_it_has_no_final_component() {
        let err = repo_path_from_state("/", &HashMap::new()).unwrap_err();

        assert_eq!(err.message, "Repository not open: /");
    }
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

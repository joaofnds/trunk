use crate::error::TrunkError;
use crate::git::repository;

/// Best-effort check that a recents-list entry is still a valid git repo.
///
/// Returns `Ok(true)` iff the path exists AND opens cleanly via `git2`.
/// Any failure (missing path, not a repo, permission denied) maps to `Ok(false)` —
/// callers only care about whether to keep the entry.
///
/// # Errors
///
/// Returns `spawn_error` as JSON when the blocking task cannot be joined.
#[tauri::command]
pub async fn validate_recent_path(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path_buf = std::path::PathBuf::from(&path);
        repository::validate_and_open(&path_buf).is_ok()
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())
}

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::TrunkError;
use crate::git::{graph, types::GraphResult};
use crate::state::{CommitCache, RepoState, RunningOp};

/// Classifies git stderr output into structured error codes.
pub fn classify_git_error(stderr: &str) -> TrunkError {
    let lower = stderr.to_lowercase();

    if lower.contains("authentication failed")
        || lower.contains("permission denied")
        || lower.contains("could not read from remote")
        || lower.contains("host key verification failed")
        || lower.contains("connection refused")
    {
        TrunkError::new("auth_failure", stderr)
    } else if lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("failed to push some refs")
    {
        TrunkError::new("non_fast_forward", stderr)
    } else if lower.contains("no upstream") || lower.contains("has no upstream branch") {
        TrunkError::new("no_upstream", stderr)
    } else {
        TrunkError::new("remote_error", stderr)
    }
}

/// Spawns a git subprocess with async stderr streaming and progress events.
///
/// Stores child PID in `running` for cancel support.
/// Emits `remote-progress` Tauri events per stderr line.
/// On failure, classifies the error using `classify_git_error`.
async fn run_git_remote(
    args: &[&str],
    cwd: &std::path::Path,
    app: &AppHandle,
    repo_path: &str,
    running: &Mutex<Option<u32>>,
) -> Result<(), TrunkError> {
    // Check mutual exclusion
    {
        let guard = running.lock().unwrap();
        if guard.is_some() {
            return Err(TrunkError::new(
                "op_in_progress",
                "Another remote operation is already running",
            ));
        }
    }

    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| TrunkError::new("remote_error", e.to_string()))?;

    // Store PID for cancel support
    if let Some(pid) = child.id() {
        let mut guard = running.lock().unwrap();
        *guard = Some(pid);
    }

    // Read stderr lines and emit progress events
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| TrunkError::new("remote_error", "Failed to capture stderr"))?;

    let mut reader = BufReader::new(stderr).lines();
    let mut collected_stderr = Vec::new();

    while let Ok(Some(line)) = reader.next_line().await {
        collected_stderr.push(line.clone());

        // Git progress uses \r for in-place updates; take the last segment
        let display = line
            .split('\r')
            .filter(|s| !s.trim().is_empty())
            .last()
            .unwrap_or("")
            .trim();

        if !display.is_empty() {
            let _ = app.emit(
                "remote-progress",
                serde_json::json!({"path": repo_path, "line": display}),
            );
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| TrunkError::new("remote_error", e.to_string()))?;

    // Clear RunningOp regardless of outcome
    {
        let mut guard = running.lock().unwrap();
        *guard = None;
    }

    if !status.success() {
        let full_stderr = collected_stderr.join("\n");
        return Err(classify_git_error(&full_stderr));
    }

    Ok(())
}

/// Rebuild the commit graph and update the cache after a successful remote operation.
async fn refresh_graph(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
    cache: &State<'_, CommitCache>,
    app: &AppHandle,
) -> Result<(), String> {
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| {
            serde_json::to_string(&TrunkError::new(
                "not_open",
                format!("Repository not open: {}", path),
            ))
            .unwrap()
        })?
        .clone();

    let path_owned = path.to_owned();
    let graph_result: GraphResult = tauri::async_runtime::spawn_blocking(move || {
        let mut repo = git2::Repository::open(&path_buf)
            .map_err(|e| TrunkError::new("git_error", e.to_string()))?;
        graph::walk_commits(&mut repo, 0, usize::MAX).map_err(TrunkError::from)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    cache.0.lock().unwrap().insert(path_owned.clone(), graph_result);
    let _ = app.emit("repo-changed", path_owned);
    Ok(())
}

#[tauri::command]
pub async fn git_fetch(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_buf = state_map
        .get(&path)
        .ok_or_else(|| {
            serde_json::to_string(&TrunkError::new(
                "not_open",
                format!("Repository not open: {}", path),
            ))
            .unwrap()
        })?
        .clone();

    run_git_remote(
        &["fetch", "--all", "--progress"],
        &path_buf,
        &app,
        &path,
        &running.0,
    )
    .await
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    refresh_graph(&path, &state_map, &cache, &app).await
}

#[tauri::command]
pub async fn git_pull(
    path: String,
    strategy: Option<String>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_buf = state_map
        .get(&path)
        .ok_or_else(|| {
            serde_json::to_string(&TrunkError::new(
                "not_open",
                format!("Repository not open: {}", path),
            ))
            .unwrap()
        })?
        .clone();

    let args: Vec<&str> = match strategy.as_deref() {
        Some("ff") => vec!["pull", "--ff", "--progress"],
        Some("ff-only") => vec!["pull", "--ff-only", "--progress"],
        Some("rebase") => vec!["pull", "--rebase", "--progress"],
        _ => vec!["pull", "--progress"],
    };

    run_git_remote(&args, &path_buf, &app, &path, &running.0)
        .await
        .map_err(|e| serde_json::to_string(&e).unwrap())?;

    refresh_graph(&path, &state_map, &cache, &app).await
}

#[tauri::command]
pub async fn git_push(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_buf = state_map
        .get(&path)
        .ok_or_else(|| {
            serde_json::to_string(&TrunkError::new(
                "not_open",
                format!("Repository not open: {}", path),
            ))
            .unwrap()
        })?
        .clone();

    run_git_remote(&["push", "--progress"], &path_buf, &app, &path, &running.0)
        .await
        .map_err(|e| serde_json::to_string(&e).unwrap())?;

    refresh_graph(&path, &state_map, &cache, &app).await
}

#[tauri::command]
pub async fn cancel_remote_op(
    running: State<'_, RunningOp>,
) -> Result<(), String> {
    let mut guard = running.0.lock().unwrap();
    if let Some(pid) = guard.take() {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- classify_git_error tests ---

    #[test]
    fn classify_auth_failure_password() {
        let err = classify_git_error("fatal: Authentication failed for 'https://github.com/user/repo.git'");
        assert_eq!(err.code, "auth_failure");
    }

    #[test]
    fn classify_auth_failure_ssh() {
        let err = classify_git_error("permission denied (publickey).");
        assert_eq!(err.code, "auth_failure");
    }

    #[test]
    fn classify_auth_failure_remote_read() {
        let err = classify_git_error("fatal: could not read from remote repository.");
        assert_eq!(err.code, "auth_failure");
    }

    #[test]
    fn classify_auth_failure_host_key() {
        let err = classify_git_error("Host key verification failed.");
        assert_eq!(err.code, "auth_failure");
    }

    #[test]
    fn classify_auth_failure_connection_refused() {
        let err = classify_git_error("ssh: connect to host github.com port 22: Connection refused");
        assert_eq!(err.code, "auth_failure");
    }

    #[test]
    fn classify_non_fast_forward() {
        let err = classify_git_error("! [rejected] main -> main (non-fast-forward)");
        assert_eq!(err.code, "non_fast_forward");
    }

    #[test]
    fn classify_non_fast_forward_fetch_first() {
        let err = classify_git_error("hint: Updates were rejected because the remote contains work that you do not have locally. Fetch first.");
        assert_eq!(err.code, "non_fast_forward");
    }

    #[test]
    fn classify_non_fast_forward_failed_push() {
        let err = classify_git_error("error: failed to push some refs to 'origin'");
        assert_eq!(err.code, "non_fast_forward");
    }

    #[test]
    fn classify_no_upstream() {
        let err = classify_git_error("fatal: The current branch feature has no upstream branch.");
        assert_eq!(err.code, "no_upstream");
    }

    #[test]
    fn classify_generic_error() {
        let err = classify_git_error("some random error that doesn't match any pattern");
        assert_eq!(err.code, "remote_error");
    }

    #[test]
    fn classify_mixed_case_auth() {
        let err = classify_git_error("FATAL: AUTHENTICATION FAILED");
        assert_eq!(err.code, "auth_failure");
    }

    #[test]
    fn classify_combined_stderr_with_progress_and_error() {
        let stderr = "Counting objects: 100% (3/3), done.\nfatal: Authentication failed for 'https://github.com/user/repo.git'";
        let err = classify_git_error(stderr);
        assert_eq!(err.code, "auth_failure");
    }
}

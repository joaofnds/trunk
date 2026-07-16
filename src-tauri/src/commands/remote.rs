use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::TrunkError;
use crate::git::{graph, types::GraphResult};
use crate::shell_env;
use crate::state::{CommitCache, RepoState, RunningOp, kill_process};

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
    running: &Mutex<HashMap<String, u32>>,
) -> Result<(), TrunkError> {
    // Check mutual exclusion (per-repo)
    {
        let guard = running.lock().unwrap();
        if guard.contains_key(repo_path) {
            return Err(TrunkError::new(
                "op_in_progress",
                "A remote operation is already running for this repository",
            ));
        }
    }

    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("PATH", shell_env::system_path())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| TrunkError::new("remote_error", e.to_string()))?;

    // Store PID for cancel support (keyed by repo path)
    if let Some(pid) = child.id() {
        let mut guard = running.lock().unwrap();
        guard.insert(repo_path.to_owned(), pid);
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
            .rfind(|s| !s.trim().is_empty())
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

    // Clear RunningOp for this repo regardless of outcome
    {
        let mut guard = running.lock().unwrap();
        guard.remove(repo_path);
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
            TrunkError::new("not_open", format!("Repository not open: {}", path)).to_json()
        })?
        .clone();

    let path_owned = path.to_owned();
    let graph_result: GraphResult = tauri::async_runtime::spawn_blocking(move || {
        let mut repo = git2::Repository::open(&path_buf)
            .map_err(|e| TrunkError::new("git_error", e.to_string()))?;
        graph::walk_commits(&mut repo, 0, usize::MAX)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    cache
        .0
        .lock()
        .unwrap()
        .insert(path_owned.clone(), graph_result);
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
            TrunkError::new("not_open", format!("Repository not open: {}", path)).to_json()
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
    .map_err(|e| e.to_json())?;

    refresh_graph(&path, &state_map, &cache, &app).await
}

/// Silent periodic fetch. Best-effort: skips when the repo is mid-operation
/// (rebase/merge/cherry-pick/revert) or another remote op is already running,
/// and swallows any error so the UI never surfaces a popup or toast.
#[tauri::command]
pub async fn git_fetch_background(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let Some(path_buf) = state_map.get(&path).cloned() else {
        return Ok(());
    };

    let path_for_state = path_buf.clone();
    let is_clean = tauri::async_runtime::spawn_blocking(move || {
        git2::Repository::open(&path_for_state)
            .map(|r| r.state() == git2::RepositoryState::Clean)
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false);
    if !is_clean {
        return Ok(());
    }

    if run_git_remote(
        &["fetch", "--all", "--tags", "--prune", "--progress"],
        &path_buf,
        &app,
        &path,
        &running.0,
    )
    .await
    .is_err()
    {
        return Ok(());
    }

    let _ = refresh_graph(&path, &state_map, &cache, &app).await;
    Ok(())
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
            TrunkError::new("not_open", format!("Repository not open: {}", path)).to_json()
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
        .map_err(|e| e.to_json())?;

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
            TrunkError::new("not_open", format!("Repository not open: {}", path)).to_json()
        })?
        .clone();

    run_git_remote(&["push", "--progress"], &path_buf, &app, &path, &running.0)
        .await
        .map_err(|e| e.to_json())?;

    refresh_graph(&path, &state_map, &cache, &app).await
}

#[tauri::command]
pub async fn delete_remote_branch(
    path: String,
    branch_name: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_buf = state_map
        .get(&path)
        .ok_or_else(|| {
            TrunkError::new("not_open", format!("Repository not open: {}", path)).to_json()
        })?
        .clone();

    // Parse "origin/feature" into remote="origin", branch="feature"
    let slash = branch_name.find('/').ok_or_else(|| {
        TrunkError::new(
            "invalid_ref",
            format!("Invalid remote branch name: {}", branch_name),
        )
        .to_json()
    })?;
    let remote = &branch_name[..slash];
    let branch = &branch_name[slash + 1..];

    run_git_remote(
        &["push", "--delete", "--progress", remote, branch],
        &path_buf,
        &app,
        &path,
        &running.0,
    )
    .await
    .map_err(|e| e.to_json())?;

    refresh_graph(&path, &state_map, &cache, &app).await
}

#[tauri::command]
pub async fn cancel_remote_op(path: String, running: State<'_, RunningOp>) -> Result<(), String> {
    let mut guard = running.0.lock().unwrap();
    if let Some(pid) = guard.remove(&path) {
        kill_process(pid);
    }
    Ok(())
}

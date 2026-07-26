use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Runtime, State};
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
    } else if lower.contains("remote rejected") || lower.contains("hook declined") {
        // Tested before divergence: a decline also prints "failed to push some refs",
        // and offering a force push as the remedy loops the user into the same refusal.
        TrunkError::new("push_declined", stderr)
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
async fn run_git_remote<R: Runtime>(
    args: &[&str],
    cwd: &std::path::Path,
    app: &AppHandle<R>,
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
async fn refresh_graph<R: Runtime>(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
    cache: &CommitCache,
    app: &AppHandle<R>,
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

pub fn get_push_target_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<PushTarget, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    resolve_push_target(&repo)
}

#[tauri::command]
pub async fn get_push_target(
    path: String,
    state: State<'_, RepoState>,
) -> Result<PushTarget, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || get_push_target_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e: TrunkError| e.to_json())
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
    git_pull_inner(
        &path,
        strategy.as_deref(),
        &state_map,
        &cache,
        &running.0,
        &app,
    )
    .await
}

pub async fn git_pull_inner<R: Runtime>(
    path: &str,
    strategy: Option<&str>,
    state_map: &HashMap<String, PathBuf>,
    cache: &CommitCache,
    running: &Mutex<HashMap<String, u32>>,
    app: &AppHandle<R>,
) -> Result<(), String> {
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| {
            TrunkError::new("not_open", format!("Repository not open: {}", path)).to_json()
        })?
        .clone();

    let args: Vec<&str> = match strategy {
        Some("ff") => vec!["pull", "--ff", "--progress"],
        Some("ff-only") => vec!["pull", "--ff-only", "--progress"],
        Some("rebase") => vec!["pull", "--rebase", "--progress"],
        _ => vec!["pull", "--progress"],
    };

    run_git_remote(&args, &path_buf, app, path, running)
        .await
        .map_err(|e| e.to_json())?;

    let probe_path = path_buf.clone();
    let conflicted = tauri::async_runtime::spawn_blocking(move || {
        let repo = git2::Repository::open(&probe_path).map_err(TrunkError::from)?;
        crate::commands::has_unmerged_paths(&repo)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    // Refresh before reporting the conflict, or the UI never repaints and the files the
    // message points at stay invisible.
    refresh_graph(path, state_map, cache, app).await?;

    if conflicted {
        return Err(TrunkError::new(
            "autostash_conflict",
            "Pull finished, but restoring your local changes conflicted — resolve the conflicts before continuing. Your changes are also saved in the stash.",
        )
        .to_json());
    }
    Ok(())
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
    git_push_inner(&path, &state_map, &cache, &running.0, &app).await
}

pub async fn git_push_inner<R: Runtime>(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
    cache: &CommitCache,
    running: &Mutex<HashMap<String, u32>>,
    app: &AppHandle<R>,
) -> Result<(), String> {
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| {
            TrunkError::new("not_open", format!("Repository not open: {}", path)).to_json()
        })?
        .clone();

    run_git_remote(&["push", "--progress"], &path_buf, app, path, running)
        .await
        .map_err(|e| e.to_json())?;

    refresh_graph(path, state_map, cache, app).await
}

/// Fixed prefix of the recovery force push. Both lease flags are mandatory:
/// `--force-with-lease` alone is unsafe in Trunk because the background fetch can
/// refresh the lease, so `--force-if-includes` requires the remote tip to be in the
/// local reflog. Never a bare `--force`.
pub const FORCE_PUSH_ARGS: [&str; 4] = [
    "push",
    "--force-with-lease",
    "--force-if-includes",
    "--progress",
];

/// Where a bare `git push` would send the current branch.
#[derive(Debug, serde::Serialize)]
pub struct PushTarget {
    pub remote: Option<String>,
    pub branch: Option<String>,
}

/// Resolve the push target the way git does, so the argv and the confirmation
/// name the same ref. git2's `branch.upstream()` reads `branch.<name>.remote`
/// only and cannot see a triangular `pushRemote` / `pushDefault` config.
pub fn resolve_push_target(repo: &git2::Repository) -> Result<PushTarget, TrunkError> {
    let head = repo.head().ok();
    let branch = head
        .as_ref()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().ok())
        .map(str::to_owned);

    let config = repo.config().map_err(TrunkError::from)?;
    let branch_key = |suffix: &str| {
        branch
            .as_deref()
            .and_then(|name| config.get_string(&format!("branch.{name}.{suffix}")).ok())
    };
    let remote = branch_key("pushRemote")
        .or_else(|| config.get_string("remote.pushDefault").ok())
        .or_else(|| branch_key("remote"))
        // A bare push falls back to `origin` by name, not to "the only remote":
        // with a sole differently-named remote git fatals with "no upstream branch".
        .or_else(|| repo.find_remote("origin").ok().map(|_| "origin".to_owned()));

    Ok(PushTarget { remote, branch })
}

#[tauri::command]
pub async fn git_push_force(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    git_push_force_inner(&path, &state_map, &cache, &running.0, &app).await
}

pub async fn git_push_force_inner<R: Runtime>(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
    cache: &CommitCache,
    running: &Mutex<HashMap<String, u32>>,
    app: &AppHandle<R>,
) -> Result<(), String> {
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| {
            TrunkError::new("not_open", format!("Repository not open: {}", path)).to_json()
        })?
        .clone();

    let target_path = path_buf.clone();
    let target = tauri::async_runtime::spawn_blocking(move || {
        let repo = git2::Repository::open(&target_path).map_err(TrunkError::from)?;
        // Guarding here rather than in the caller: a frontend gate can be stale or
        // skipped, and this rewrites remote history.
        if repo.state() != git2::RepositoryState::Clean {
            return Err(TrunkError::new(
                "op_in_progress_local",
                "Finish or abort the merge, rebase or cherry-pick in progress before force pushing.",
            ));
        }
        resolve_push_target(&repo)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    let (Some(remote), Some(branch)) = (target.remote, target.branch) else {
        return Err(TrunkError::new(
            "no_push_target",
            "Trunk cannot tell which branch and remote this push would rewrite, so it will not force push.",
        )
        .to_json());
    };

    // Naming the ref explicitly is what keeps the push to the branch the user
    // confirmed; a bare argv lets `push.default` / `remote.<name>.push` widen it.
    let refspec = format!("HEAD:refs/heads/{branch}");
    let mut args = FORCE_PUSH_ARGS.to_vec();
    args.push(&remote);
    args.push(&refspec);

    run_git_remote(&args, &path_buf, app, path, running)
        .await
        .map_err(|e| e.to_json())?;

    refresh_graph(path, state_map, cache, app).await
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

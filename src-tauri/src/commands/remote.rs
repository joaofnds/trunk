use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::TrunkError;
use crate::git::graph;
use crate::git::graph_input::GraphSnapshot;
use crate::shell_env;
use crate::state::{CommitCache, OpenRepos, RemoteOps, RepoState, RunningOp, kill_process};

/// git's own stderr lines, with the ones the remote wrote dropped. Scoping the lease
/// markers to these is what keeps a hook printing either phrase from turning every
/// ordinary divergence into a refusal, which would withhold the force-push remedy.
fn git_own_lines(lower: &str) -> impl Iterator<Item = &str> {
    lower
        .lines()
        .filter(|line| !line.trim_start().starts_with("remote:"))
}

/// Classifies git stderr output into structured error codes.
#[must_use]
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
    } else if git_own_lines(&lower).any(|line| {
        line.contains("remote ref updated since checkout") || line.contains("stale info")
    }) {
        TrunkError::new("push_lease_refused", stderr)
    } else if lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("failed to push some refs")
    {
        TrunkError::new("non_fast_forward", stderr)
    } else if lower.contains("no upstream") || lower.contains("has no upstream branch") {
        TrunkError::new("no_upstream", stderr)
    } else if lower.contains("could not apply") && lower.contains("rebase --continue") {
        // A pull with rebase that stopped on a conflict. Left to the fallback it
        // reaches the user as git's whole stderr, hints and all; it is an expected
        // outcome of pulling, and the app has its own words and its own controls
        // for it.
        TrunkError::new("rebase_conflict", stderr)
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
    running: &Mutex<RemoteOps>,
) -> Result<(), TrunkError> {
    // Check mutual exclusion (per-repo)
    {
        let guard = running.lock().unwrap();
        if guard.busy(repo_path) {
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
        // Nothing reads stdout, and git blocks writing a large merge diffstat
        // into a full pipe while this task blocks in wait().
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| TrunkError::new("remote_error", e.to_string()))?;

    // Store PID for cancel support (keyed by repo path)
    if let Some(pid) = child.id() {
        let mut guard = running.lock().unwrap();
        guard.start(repo_path.to_owned(), pid);
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
        guard.finish(repo_path);
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
    path_buf: PathBuf,
    cache: &CommitCache,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
) -> Result<(), TrunkError> {
    let path_owned = path.to_owned();
    let visibility = ref_visibility.get(path);
    let graph_result: GraphSnapshot = tauri::async_runtime::spawn_blocking(move || {
        let mut repo = git2::Repository::open(&path_buf)
            .map_err(|e| TrunkError::new("git_error", e.to_string()))?;
        graph::snapshot(&mut repo, &visibility)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;

    cache
        .0
        .lock()
        .unwrap()
        .insert(path_owned.clone(), graph_result);
    let _ = app.emit("repo-changed", path_owned);
    Ok(())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn git_fetch<R: Runtime>(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let path_buf = state_map
        .path_for(&path)
        .map_err(|e| e.to_json())?
        .to_path_buf();

    run_git_remote(
        &["fetch", "--all", "--progress"],
        &path_buf,
        &app,
        &path,
        &running.0,
    )
    .await
    .map_err(|e| e.to_json())?;

    refresh_graph(&path, path_buf, &cache, &ref_visibility, &app)
        .await
        .map_err(|e| e.to_json())
}

/// Fetch every remote quietly, skipping when the repo is busy.
///
/// Best-effort: skips when the repo is mid-operation (rebase/merge/cherry-pick/revert)
/// or another remote op is already running, and swallows any error so the UI never
/// surfaces a popup or toast.
///
/// # Errors
///
/// Never returns an error. The `Result` is the shape every command shares. A
/// repository that is closed, mid-operation, or already running a remote
/// operation is skipped, and a failed fetch is swallowed.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn git_fetch_background<R: Runtime>(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let Some(path_buf) = state_map
        .location_of(&path)
        .map(std::path::Path::to_path_buf)
    else {
        return Ok(());
    };

    let path_for_state = path_buf.clone();
    let is_clean = tauri::async_runtime::spawn_blocking(move || {
        git2::Repository::open(&path_for_state)
            .is_ok_and(|r| r.state() == git2::RepositoryState::Clean)
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

    let _ = refresh_graph(&path, path_buf, &cache, &ref_visibility, &app).await;
    Ok(())
}

/// Which remote and branch a push from here would target.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error
/// when the repository config will not read.
pub fn get_push_target_inner(path: &str, state_map: &OpenRepos) -> Result<PushTarget, TrunkError> {
    let repo = state_map.open(path)?;
    resolve_push_target(&repo)
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn get_push_target(
    path: String,
    state: State<'_, RepoState>,
) -> Result<PushTarget, String> {
    let state_map = state.snapshot();
    tauri::async_runtime::spawn_blocking(move || get_push_target_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e: TrunkError| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn git_pull<R: Runtime>(
    path: String,
    strategy: Option<String>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    git_pull_inner(
        &path,
        strategy.as_deref(),
        &state_map,
        &cache,
        &running.0,
        &ref_visibility,
        &app,
    )
    .await
    .map_err(|e| e.to_json())
}

/// Pull with the chosen strategy, then rebuild the graph.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `rebase_conflict` when an
/// autostash restore conflicts, `auth_failure` when the remote refuses the
/// credentials, and `remote_error` carrying git's own message otherwise.
pub async fn git_pull_inner<R: Runtime>(
    path: &str,
    strategy: Option<&str>,
    state_map: &OpenRepos,
    cache: &CommitCache,
    running: &Mutex<RemoteOps>,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
) -> Result<(), TrunkError> {
    let path_buf = state_map.path_for(path)?.to_path_buf();

    let args: Vec<&str> = match strategy {
        Some("ff") => vec!["pull", "--ff", "--progress"],
        Some("ff-only") => vec!["pull", "--ff-only", "--progress"],
        Some("rebase") => vec!["pull", "--rebase", "--progress"],
        _ => vec!["pull", "--progress"],
    };

    run_git_remote(&args, &path_buf, app, path, running).await?;

    let probe_path = path_buf.clone();
    let conflicted = tauri::async_runtime::spawn_blocking(move || {
        let repo = git2::Repository::open(&probe_path).map_err(TrunkError::from)?;
        crate::git::repository::has_unmerged_paths(&repo)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;

    // Refresh before reporting the conflict, or the UI never repaints and the files the
    // message points at stay invisible.
    refresh_graph(path, path_buf, cache, ref_visibility, app).await?;

    if conflicted {
        return Err(TrunkError::new(
            "autostash_conflict",
            "Pull finished, but restoring your local changes conflicted — resolve the conflicts before continuing. Your changes are also saved in the stash.",
        ));
    }
    Ok(())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn git_push<R: Runtime>(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    git_push_inner(&path, &state_map, &cache, &running.0, &ref_visibility, &app)
        .await
        .map_err(|e| e.to_json())
}

/// Push HEAD to its target, then rebuild the graph.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `no_upstream` when HEAD has no
/// push target, `non_fast_forward` when the remote has moved on,
/// `auth_failure` when the remote refuses the credentials, and `remote_error`
/// carrying git's own message otherwise.
pub async fn git_push_inner<R: Runtime>(
    path: &str,
    state_map: &OpenRepos,
    cache: &CommitCache,
    running: &Mutex<RemoteOps>,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
) -> Result<(), TrunkError> {
    let path_buf = state_map.path_for(path)?.to_path_buf();

    run_git_remote(&["push", "--progress"], &path_buf, app, path, running).await?;

    refresh_graph(path, path_buf, cache, ref_visibility, app).await
}

/// Fixed prefix of the recovery force push.
///
/// Both lease flags are mandatory: `--force-with-lease` alone is unsafe in Trunk
/// because the background fetch can refresh the lease, so `--force-if-includes`
/// requires the remote tip to be in the local reflog. Never a bare `--force`.
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

/// Resolve the *remote* the way git does — the full `pushRemote` / `pushDefault`
/// chain, which git2's `branch.upstream()` cannot see because it reads
/// `branch.<name>.remote` only.
///
/// The *branch* is HEAD's shorthand and nothing else: `branch.<name>.merge`,
/// `push.default` and a renaming `remote.<name>.push` are not consulted, so under
/// those configs this names a different ref than a bare `git push` would.
///
/// # Errors
///
/// Returns the git error when the repository config will not read. A detached
/// HEAD or a missing remote is not an error: the corresponding field is `None`.
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

/// The remote and branch the user confirmed in the force-push dialog.
///
/// The pair travels together because the check below is about the pair: a force push runs
/// only while the repository is still on the branch the dialog named.
pub struct ConfirmedPush<'a> {
    pub remote: &'a str,
    pub branch: &'a str,
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn git_push_force<R: Runtime>(
    path: String,
    remote: String,
    branch: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    git_push_force_inner(
        &path,
        ConfirmedPush {
            remote: &remote,
            branch: &branch,
        },
        &state_map,
        &cache,
        &running.0,
        &ref_visibility,
        &app,
    )
    .await
    .map_err(|e| e.to_json())
}

/// Force-push HEAD with a lease, refusing if the remote moved unexpectedly.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `no_upstream` when HEAD has no
/// push target, `push_lease_refused` when the remote moved since the last
/// fetch, `push_declined` when the remote rejects it, `auth_failure` when the
/// remote refuses the credentials, and `remote_error` otherwise.
pub async fn git_push_force_inner<R: Runtime>(
    path: &str,
    confirmed: ConfirmedPush<'_>,
    state_map: &OpenRepos,
    cache: &CommitCache,
    running: &Mutex<RemoteOps>,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
) -> Result<(), TrunkError> {
    let (confirmed_remote, confirmed_branch) = (confirmed.remote, confirmed.branch);
    let path_buf = state_map.path_for(path)?.to_path_buf();

    let target_path = path_buf.clone();
    let target = tauri::async_runtime::spawn_blocking(move || {
        let repo = git2::Repository::open(&target_path).map_err(TrunkError::from)?;
        // Guarding here rather than in the caller: a frontend gate can be stale or
        // skipped, and this rewrites remote history.
        if crate::git::repository::is_mid_operation(&repo)? {
            return Err(TrunkError::new(
                "op_in_progress_local",
                "Finish or abort the merge, rebase or cherry-pick in progress, and resolve any conflicted files, before force pushing.",
            ));
        }
        resolve_push_target(&repo)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;

    let (Some(remote), Some(branch)) = (target.remote, target.branch) else {
        return Err(TrunkError::new(
            "no_push_target",
            "Trunk cannot tell which branch and remote this push would rewrite, so it will not force push.",
        ));
    };

    // The banner snapshots the push that failed and the repository can move under it.
    // Without this the refspec would still name the confirmed ref, but Trunk would push
    // onto it from a working tree that has since left it.
    if remote != confirmed_remote || branch != confirmed_branch {
        return Err(TrunkError::new(
            "push_target_changed",
            format!(
                "You confirmed a force push of {confirmed_branch}, but the repository is now on {branch}. Nothing was pushed."
            ),
        ));
    }

    // Naming the ref explicitly is what keeps the push to the branch the user
    // confirmed; a bare argv lets `push.default` / `remote.<name>.push` widen it.
    let refspec = format!("HEAD:refs/heads/{confirmed_branch}");
    let mut args = FORCE_PUSH_ARGS.to_vec();
    args.push("--");
    args.push(confirmed_remote);
    args.push(&refspec);

    run_git_remote(&args, &path_buf, app, path, running).await?;

    refresh_graph(path, path_buf, cache, ref_visibility, app).await
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn delete_remote_branch<R: Runtime>(
    path: String,
    branch_name: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let path_buf = state_map
        .path_for(&path)
        .map_err(|e| e.to_json())?
        .to_path_buf();

    // Parse "origin/feature" into remote="origin", branch="feature"
    let slash = branch_name.find('/').ok_or_else(|| {
        TrunkError::new(
            "invalid_ref",
            format!("Invalid remote branch name: {branch_name}"),
        )
        .to_json()
    })?;
    let remote = &branch_name[..slash];
    let branch = &branch_name[slash + 1..];

    run_git_remote(
        &["push", "--delete", "--progress", "--", remote, branch],
        &path_buf,
        &app,
        &path,
        &running.0,
    )
    .await
    .map_err(|e| e.to_json())?;

    refresh_graph(&path, path_buf, &cache, &ref_visibility, &app)
        .await
        .map_err(|e| e.to_json())
}

/// # Errors
///
/// Never returns an error. The `Result` is the shape every command shares.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn cancel_remote_op(path: String, running: State<'_, RunningOp>) -> Result<(), String> {
    let running = running.0.lock().unwrap().finish(&path);
    if let Some(pid) = running {
        kill_process(pid);
    }
    Ok(())
}

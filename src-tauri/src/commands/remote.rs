use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::remote_ops::{RemoteProcess, RemoteReservation, RemoteTarget};
use crate::shell_env;
use crate::state::{CommitCache, OpenRepos, RemoteOps, RepoState, RunningOp};
use crate::watcher::RepoChanged;
use trunk_git::error::TrunkError;
use trunk_git::pull_safety::PullSafetyCopy;

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

struct RemoteCompletion<'a> {
    reservation: RemoteReservation<'a>,
    session: u64,
}

/// Spawns a foreground git subprocess with stderr progress events and an owned
/// reservation retained through the caller's graph reconciliation.
///
/// Stores child PID in `running` for cancel support.
/// Emits `remote-progress` Tauri events per stderr line.
/// On failure, classifies the error using `classify_git_error`.
async fn run_git_remote<'a, R: Runtime>(
    args: &[&str],
    cwd: &std::path::Path,
    app: &AppHandle<R>,
    repo_path: &str,
    running: &'a Mutex<RemoteOps>,
) -> Result<RemoteCompletion<'a>, TrunkError> {
    let held = reserve_remote(cwd, app, repo_path, running).await?;
    run_reserved(args, cwd, app, repo_path, &held.reservation).await?;
    Ok(held)
}

/// Takes the repository's one foreground remote slot, so nothing else runs git
/// against it until the returned reservation drops.
async fn reserve_remote<'a, R: Runtime>(
    cwd: &std::path::Path,
    app: &AppHandle<R>,
    repo_path: &str,
    running: &'a Mutex<RemoteOps>,
) -> Result<RemoteCompletion<'a>, TrunkError> {
    let expected_session = app
        .state::<CommitCache>()
        .session_id(repo_path)
        .ok_or_else(|| TrunkError::new("not_open", "Repository session was closed"))?;
    let location = cwd.to_path_buf();
    let common = tauri::async_runtime::spawn_blocking(move || {
        let repo = git2::Repository::open(location)?;
        repo.commondir()
            .canonicalize()
            .map(|path| path.to_string_lossy().to_string())
            .map_err(|error| TrunkError::new("remote_error", error.to_string()))
    })
    .await
    .map_err(|error| TrunkError::new("spawn_error", error.to_string()))??;
    let reservation = RemoteReservation::acquire_foreground_checked(
        running,
        RemoteTarget {
            path: repo_path,
            common: &common,
        },
        || app.state::<CommitCache>().session_id(repo_path) == Some(expected_session),
    )?;

    Ok(RemoteCompletion {
        reservation,
        session: expected_session,
    })
}

async fn run_reserved<R: Runtime>(
    args: &[&str],
    cwd: &std::path::Path,
    app: &AppHandle<R>,
    repo_path: &str,
    reservation: &RemoteReservation<'_>,
) -> Result<(), TrunkError> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .env("PATH", shell_env::system_path())
        // Nothing reads stdout, and git blocks writing a large merge diffstat
        // into a full pipe while this task blocks in wait().
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| TrunkError::new("remote_error", e.to_string()))?;

    // Store PID for cancel support (keyed by repo path)
    if let Some(pid) = child.id() {
        reservation.attach(RemoteProcess::foreground(pid));
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

    let status = child.wait().await;
    if status.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    reservation.exited();
    let status = status.map_err(|e| TrunkError::new("remote_error", e.to_string()))?;
    if reservation.cancelled() {
        return Err(TrunkError::new("cancelled", "Remote operation cancelled"));
    }

    if !status.success() {
        let full_stderr = collected_stderr.join("\n");
        return Err(classify_git_error(&full_stderr));
    }

    Ok(())
}

async fn checked_manual_fetch<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    session: u64,
    location: PathBuf,
) {
    let names = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, TrunkError> {
        let repo = git2::Repository::open(location)?;
        trunk_git::fetch::applicable_remotes(&repo)
    })
    .await;
    if let Ok(Ok(names)) = names {
        let service = app.state::<crate::background_fetch::BackgroundFetch>();
        let cache = app.state::<CommitCache>();
        for name in names {
            service.checked(path, session, Some(&name), &cache);
        }
    }
}

async fn checked_manual_pull<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    session: u64,
    location: PathBuf,
) {
    let remote = tauri::async_runtime::spawn_blocking(move || {
        let repo = git2::Repository::open(location).ok()?;
        let head = repo.head().ok()?;
        let branch = head.shorthand().ok()?;
        repo.config()
            .ok()?
            .get_string(&format!("branch.{branch}.remote"))
            .ok()
    })
    .await;
    if let Ok(Some(remote)) = remote
        && remote != "."
    {
        app.state::<crate::background_fetch::BackgroundFetch>()
            .checked(path, session, Some(&remote), &app.state::<CommitCache>());
    }
}

/// Rebuild the commit graph and update the cache after a successful remote operation.
async fn refresh_graph<R: Runtime>(
    path: &str,
    path_buf: PathBuf,
    cache: &CommitCache,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
    session: u64,
) -> Result<(), TrunkError> {
    let path_owned = path.to_owned();
    let rebuild = crate::state::GraphRebuild::new(cache, ref_visibility);
    rebuild
        .rebuild_in_session(
            path_owned.clone(),
            session,
            move || -> Result<crate::state::GraphRead, TrunkError> {
                let mut repo = git2::Repository::open(&path_buf)
                    .map_err(|e| TrunkError::new("git_error", e.to_string()))?;
                crate::state::read_graph(&mut repo)
            },
        )
        .await?;

    let _ = app.emit("repo-changed", RepoChanged::whole_repo(path_owned));
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
) -> Result<crate::background_fetch::FetchReport, String> {
    let state_map = state.snapshot();
    let path_buf = state_map
        .path_for(&path)
        .map_err(|e| e.to_json())?
        .to_path_buf();

    let completion = run_git_remote(
        &["fetch", "--all", "--progress"],
        &path_buf,
        &app,
        &path,
        &running.0,
    )
    .await
    .map_err(|e| e.to_json())?;

    checked_manual_fetch(&app, &path, completion.session, path_buf.clone()).await;
    refresh_graph(
        &path,
        path_buf,
        &cache,
        &ref_visibility,
        &app,
        completion.session,
    )
    .await
    .map_err(|e| e.to_json())?;
    let session = cache
        .session_id(&path)
        .ok_or_else(|| TrunkError::new("not_open", "Repository is closed").to_json())?;
    Ok(app
        .state::<crate::background_fetch::BackgroundFetch>()
        .report(&path, session))
}

/// Check all configured remotes without progress events or foreground dialogs.
/// The reservation spans worker exit and change-aware graph reconciliation.
/// # Errors
///
/// Returns an error when the repository is closed or its fetch configuration cannot be read.
#[tauri::command]
pub async fn git_fetch_background<R: Runtime>(
    path: String,
    interval_ms: Option<u64>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    background: State<'_, crate::background_fetch::BackgroundFetch>,
    app: AppHandle<R>,
) -> Result<crate::background_fetch::FetchReport, String> {
    crate::background_fetch::fetch(
        &path,
        interval_ms.unwrap_or(crate::background_fetch::DEFAULT_FETCH_INTERVAL_MS),
        crate::background_fetch::FetchContext {
            state: &state,
            cache: &cache,
            running: &running,
            visibility: &ref_visibility,
            service: &background,
            app: &app,
        },
    )
    .await
    .map_err(|error| error.to_json())
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
) -> Result<crate::background_fetch::FetchReport, String> {
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
    .map_err(|e| e.to_json())?;
    let session = cache
        .session_id(&path)
        .ok_or_else(|| TrunkError::new("not_open", "Repository is closed").to_json())?;
    Ok(app
        .state::<crate::background_fetch::BackgroundFetch>()
        .report(&path, session))
}

/// Pull with the chosen strategy, then rebuild the graph.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `rebase_conflict` when a
/// pull with rebase stops on a conflict, `autostash_conflict` when the pull finished
/// but restoring the autostash conflicted, `cancelled` when the repository closed while
/// git ran, `auth_failure` when the remote refuses the credentials, and `remote_error`
/// carrying git's own message otherwise. Each carries `pull_safety_copy` when the pull
/// kept one, and a pull git finished that still kept one returns `pull_kept_copy`, so
/// the copy is always named.
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

    let completion = reserve_remote(&path_buf, app, path, running).await?;
    let copy = save_pull_safety_copy(path_buf.clone()).await;
    let ran = run_reserved(&args, &path_buf, app, path, &completion.reservation).await;
    let kept = settle_pull_safety_copy(copy, path_buf.clone()).await;

    let finished = finish_pull(
        ran,
        path,
        path_buf,
        cache,
        ref_visibility,
        app,
        completion.session,
    )
    .await;
    if !kept {
        return finished;
    }

    let copy = Some(trunk_git::pull_safety::MESSAGE);
    match finished {
        Ok(()) => {
            Err(TrunkError::new("pull_kept_copy", "The pull finished.").with_pull_safety_copy(copy))
        }
        Err(error) => Err(error.with_pull_safety_copy(copy)),
    }
}

/// A copy that cannot be saved leaves the pull to run unguarded, as git alone would run
/// it, so the failure is logged rather than returned.
async fn save_pull_safety_copy(location: PathBuf) -> Option<PullSafetyCopy> {
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let mut repo = git2::Repository::open(location)?;
        PullSafetyCopy::save(&mut repo)
    })
    .await
    .map_err(|error| TrunkError::new("spawn_error", error.to_string()))
    .flatten();

    saved.unwrap_or_else(|error| {
        eprintln!("pull safety copy not saved: {}", error.message);
        None
    })
}

/// A copy that cannot be settled stays in the stash list, and is reported as kept.
async fn settle_pull_safety_copy(copy: Option<PullSafetyCopy>, location: PathBuf) -> bool {
    let Some(copy) = copy else {
        return false;
    };

    tauri::async_runtime::spawn_blocking(move || {
        git2::Repository::open(location).map_or(true, |mut repo| copy.settle(&mut repo))
    })
    .await
    .unwrap_or(true)
}

async fn finish_pull<R: Runtime>(
    ran: Result<(), TrunkError>,
    path: &str,
    path_buf: PathBuf,
    cache: &CommitCache,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
    session: u64,
) -> Result<(), TrunkError> {
    ran?;

    checked_manual_pull(app, path, session, path_buf.clone()).await;
    let probe_path = path_buf.clone();
    let conflicted = tauri::async_runtime::spawn_blocking(move || {
        let repo = git2::Repository::open(&probe_path).map_err(TrunkError::from)?;
        trunk_git::repository::has_unmerged_paths(&repo)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;

    // Refresh before reporting the conflict, or the UI never repaints and the files the
    // message points at stay invisible.
    refresh_graph(path, path_buf, cache, ref_visibility, app, session).await?;

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

    let completion = run_git_remote(&["push", "--progress"], &path_buf, app, path, running).await?;

    refresh_graph(
        path,
        path_buf,
        cache,
        ref_visibility,
        app,
        completion.session,
    )
    .await
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
        if trunk_git::repository::is_mid_operation(&repo)? {
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

    let completion = run_git_remote(&args, &path_buf, app, path, running).await?;

    refresh_graph(
        path,
        path_buf,
        cache,
        ref_visibility,
        app,
        completion.session,
    )
    .await
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

    let completion = run_git_remote(
        &["push", "--delete", "--progress", "--", remote, branch],
        &path_buf,
        &app,
        &path,
        &running.0,
    )
    .await
    .map_err(|e| e.to_json())?;

    refresh_graph(
        &path,
        path_buf,
        &cache,
        &ref_visibility,
        &app,
        completion.session,
    )
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
    let process = running.0.lock().unwrap().cancel(&path);
    if let Some(process) = process {
        process.stop();
    }
    Ok(())
}

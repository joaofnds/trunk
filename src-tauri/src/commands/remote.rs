use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::commands::remote_tracking::Remotes;
use crate::remote_ops::{self, RemoteProcess, RemoteReservation, RemoteTarget};
use crate::state::{CommitCache, OpenRepos, RemoteOps, RepoState, RunningOp};
use crate::user_git::{UserConfig, UserGit, refusal};
use crate::watcher::{RepoChanged, WatcherState};
use trunk_git::error::TrunkError;
use trunk_git::pull_safety::PullSafetyCopy;

/// git's own stderr lines, with the ones the remote wrote dropped. Scoping a phrase to
/// these keeps a hook that prints it from deciding the classification: "permission
/// denied" in a hook's reason would hide that reason behind a credentials banner, and a
/// lease marker would turn an ordinary divergence into a refusal and withhold the
/// force-push remedy.
fn git_own_lines(lower: &str) -> impl Iterator<Item = &str> {
    lower
        .lines()
        .filter(|line| !line.trim_start().starts_with("remote:"))
}

/// Classifies git stderr output into structured error codes.
#[must_use]
pub fn classify_git_error(stderr: &str) -> TrunkError {
    let lower = stderr.to_lowercase();

    if git_own_lines(&lower).any(|line| {
        line.contains("authentication failed")
            || line.contains("permission denied")
            || line.contains("host key verification failed")
    }) {
        TrunkError::new("auth_failure", stderr)
    } else if lower.contains("remote rejected") || lower.contains("hook declined") {
        // Its own kind, so the user is not offered a force push, which a decline
        // refuses again.
        TrunkError::new("push_declined", stderr)
    } else if git_own_lines(&lower).any(|line| {
        line.contains("remote ref updated since checkout") || line.contains("stale info")
    }) {
        TrunkError::new("push_lease_refused", stderr)
    } else if lower.contains("non-fast-forward") || lower.contains("fetch first") {
        TrunkError::new("non_fast_forward", stderr)
    } else if git_own_lines(&lower).any(|line| line.contains("(already exists)")) {
        TrunkError::new("tag_exists", stderr)
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

/// Spawns a foreground git subprocess with an owned reservation retained through
/// the caller's graph reconciliation.
///
/// Stores child PID in `running` for cancel support.
/// On failure, classifies the error using `classify_git_error`.
async fn run_git_remote<'a, R: Runtime>(
    activity: &crate::activity::Activity,
    args: &[&str],
    cwd: &std::path::Path,
    app: &AppHandle<R>,
    repo_path: &str,
    running: &'a Mutex<RemoteOps>,
) -> Result<RemoteCompletion<'a>, TrunkError> {
    let held = reserve_remote(activity, cwd, app, repo_path, running).await?;
    run_reserved(args, cwd, &held.reservation).await?;
    Ok(held)
}

/// Takes the repository's one foreground remote slot, so nothing else runs git
/// against it until the returned reservation drops. A background fetch holding
/// the repository is waited for, never failed on.
async fn reserve_remote<'a, R: Runtime>(
    activity: &crate::activity::Activity,
    cwd: &std::path::Path,
    app: &AppHandle<R>,
    repo_path: &str,
    running: &'a Mutex<RemoteOps>,
) -> Result<RemoteCompletion<'a>, TrunkError> {
    let expected_session = app
        .state::<CommitCache>()
        .session_id(repo_path)
        .ok_or_else(remote_ops::session_closed)?;
    let location = cwd.to_path_buf();
    let common = activity
        .spawn_blocking(move || {
            let repo = git2::Repository::open(location)?;
            repo.commondir()
                .canonicalize()
                .map(|path| path.to_string_lossy().to_string())
                .map_err(|error| TrunkError::new("remote_error", error.to_string()))
        })
        .await
        .map_err(|error| TrunkError::new("spawn_error", error.to_string()))??;
    let reservation = RemoteReservation::acquire_foreground_when_free(
        running,
        RemoteTarget {
            path: repo_path,
            common: &common,
        },
        || app.state::<CommitCache>().session_id(repo_path) == Some(expected_session),
    )
    .await?;

    Ok(RemoteCompletion {
        reservation,
        session: expected_session,
    })
}

async fn run_reserved(
    args: &[&str],
    cwd: &std::path::Path,
    reservation: &RemoteReservation<'_>,
) -> Result<(), TrunkError> {
    let mut git = UserGit::in_dir(cwd);
    git.args(args);
    let git = git
        .spawn()
        .map_err(|e| TrunkError::new("remote_error", e.to_string()))?;
    if let Some(pid) = git.id() {
        reservation.attach(RemoteProcess::foreground(pid));
    }

    let output = git.wait().await;
    reservation.exited();
    let output = output.map_err(|e| TrunkError::new("remote_error", e.to_string()))?;
    if reservation.cancelled() {
        return Err(remote_ops::operation_cancelled());
    }

    if !output.status.success() {
        let mut refused = classify_git_error(&String::from_utf8_lossy(&output.stderr));
        // The merge a pull runs reports its conflicts on stdout, not stderr.
        if refused.code == "remote_error"
            && String::from_utf8_lossy(&output.stdout).contains("Automatic merge failed")
        {
            refused.code = "merge_conflict".into();
        }
        refused.message = what_git_said(&output);
        return Err(refused);
    }

    Ok(())
}

/// Everything git said about a remote command that failed: its stderr, where fetch
/// and push report, then its stdout, where the merge a pull runs names its conflicts.
fn what_git_said(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let said: Vec<&str> = [stderr.trim(), stdout.trim()]
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect();
    if said.is_empty() {
        return refusal(output);
    }

    said.join("\n")
}

async fn checked_manual_fetch<R: Runtime>(
    activity: &crate::activity::Activity,
    app: &AppHandle<R>,
    path: &str,
    session: u64,
    location: PathBuf,
) {
    let names = activity
        .spawn_blocking(move || -> Result<Vec<String>, TrunkError> {
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
    activity: &crate::activity::Activity,
    app: &AppHandle<R>,
    path: &str,
    session: u64,
    location: PathBuf,
) {
    let remote = activity
        .spawn_blocking(move || {
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
    activity: &crate::activity::Activity,
    path: &str,
    repository: crate::state::OpenRepo,
    cache: &CommitCache,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
    session: u64,
) -> Result<(), TrunkError> {
    let path_owned = path.to_owned();
    let rebuild = crate::state::GraphRebuild::new(activity.clone(), cache, ref_visibility);
    match rebuild
        .rebuild_in_session(
            path_owned.clone(),
            session,
            move || -> Result<crate::state::GraphRead, TrunkError> { repository.read_graph() },
        )
        .await
    {
        Err(error) if error.code == "not_open" => return Ok(()),
        outcome => outcome?,
    };

    let _ = app.emit("repo-changed", RepoChanged::completed(path_owned, cache));
    Ok(())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn git_fetch<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<Option<crate::background_fetch::FetchReport>, String> {
    let state_map = state.snapshot();
    git_fetch_inner(
        &activity,
        &path,
        &state_map,
        &cache,
        &running.0,
        &ref_visibility,
        &app,
    )
    .await
    .map_err(|e| e.to_json())
}

/// Fetch every remote, then rebuild the graph and report what each remote's fetch did,
/// or `None` when the repository closed while the fetch ran, since its report went with it.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `op_in_progress` while
/// another remote operation runs on it, `cancelled` when the user cancels the fetch,
/// a `git_*` code when the repository cannot be opened, `spawn_error` when a blocking
/// step cannot be joined, and otherwise the code [`classify_git_error`] gives what git
/// said, such as `auth_failure` or `remote_error`.
pub async fn git_fetch_inner<R: Runtime>(
    activity: &crate::activity::Activity,
    path: &str,
    state_map: &OpenRepos,
    cache: &CommitCache,
    running: &Mutex<RemoteOps>,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
) -> Result<Option<crate::background_fetch::FetchReport>, TrunkError> {
    let repository = state_map.repository(path)?.clone();
    let path_buf = repository.location().to_path_buf();

    let completion =
        run_git_remote(activity, &["fetch", "--all"], &path_buf, app, path, running).await?;

    checked_manual_fetch(activity, app, path, completion.session, path_buf.clone()).await;
    refresh_graph(
        activity,
        path,
        repository,
        cache,
        ref_visibility,
        app,
        completion.session,
    )
    .await?;
    Ok(fetch_report(app, cache, path))
}

fn fetch_report<R: Runtime>(
    app: &AppHandle<R>,
    cache: &CommitCache,
    path: &str,
) -> Option<crate::background_fetch::FetchReport> {
    let session = cache.session_id(path)?;
    Some(
        app.state::<crate::background_fetch::BackgroundFetch>()
            .report(path, session),
    )
}

/// Check all configured remotes without foreground dialogs.
/// The reservation spans worker exit and change-aware graph reconciliation.
/// # Errors
///
/// Returns an error when the repository is closed or its fetch configuration cannot be read.
#[tauri::command]
pub async fn git_fetch_background<R: Runtime>(
    activity: crate::activity::Activity,
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
            activity: &activity,
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
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
) -> Result<PushTarget, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || get_push_target_inner(&path, &state_map))
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
    activity: crate::activity::Activity,
    path: String,
    strategy: Option<String>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<Option<crate::background_fetch::FetchReport>, String> {
    let state_map = state.snapshot();
    git_pull_inner(
        &activity,
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
    Ok(fetch_report(&app, &cache, &path))
}

/// Pull with the chosen strategy, then rebuild the graph.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, a `git_*` code when the
/// repository will not open, `spawn_error` when a blocking step cannot be joined,
/// `rebase_conflict` or `merge_conflict` when the pull stops on a conflict, `autostash_conflict` when the pull finished
/// but restoring the autostash conflicted, `cancelled` when the repository closed while
/// git ran, `auth_failure` when the remote refuses the credentials, and `remote_error`
/// carrying git's own message otherwise. Each carries `pull_safety_copy` when the pull
/// kept one, and a pull git finished that still kept one returns `pull_kept_copy`, so
/// the copy is always named.
pub async fn git_pull_inner<R: Runtime>(
    activity: &crate::activity::Activity,
    path: &str,
    strategy: Option<&str>,
    state_map: &OpenRepos,
    cache: &CommitCache,
    running: &Mutex<RemoteOps>,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
) -> Result<(), TrunkError> {
    let repository = state_map.repository(path)?.clone();
    let path_buf = repository.location().to_path_buf();

    let dir = path_buf.clone();
    let config = activity
        .spawn_blocking(move || PullConfig::read(&dir))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;
    let args = pull_args(strategy, &config);

    let completion = reserve_remote(activity, &path_buf, app, path, running).await?;
    // Held from the copy to its settling, so no other writer in the app stages over the
    // merge git writes, or moves the stash list between finding the copy and dropping
    // it. A cancel ends the pull while it still waits, and the abandoned wait frees
    // the turn the moment it takes it.
    let turn = tokio::select! {
        turn = wait_for_write_turn(activity, path_buf.clone()) => turn?,
        () = completion.reservation.until_cancelled() => {
            return Err(remote_ops::operation_cancelled());
        }
    };
    let copy = save_pull_safety_copy(activity, path_buf.clone()).await;
    let ran = run_reserved(&args, &path_buf, &completion.reservation).await;
    let kept = settle_pull_safety_copy(activity, copy, path_buf.clone()).await;

    let finished = finish_pull(
        activity,
        ran,
        turn,
        path,
        repository,
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

/// Wait, off the async runtime, until no other writer in the app holds the repository.
async fn wait_for_write_turn(
    activity: &crate::activity::Activity,
    location: PathBuf,
) -> Result<trunk_git::write_gate::Turn, TrunkError> {
    activity
        .spawn_blocking(move || {
            let repo = git2::Repository::open(location)?;
            Ok(trunk_git::write_gate::wait_for_turn(&repo))
        })
        .await
        .map_err(|error| TrunkError::new("spawn_error", error.to_string()))?
}

/// What the user's configuration already says about how a pull combines a branch that
/// diverged from its upstream and what it does with uncommitted changes, as git reads it.
struct PullConfig {
    ff: bool,
    merge_autostash: bool,
    rebase_autostash: bool,
}

impl PullConfig {
    fn read(dir: &std::path::Path) -> Result<Self, TrunkError> {
        let config = UserConfig::read(
            dir,
            r"^(pull\.ff|rebase\.autostash|merge\.autostash)$",
            "remote_error",
        )?;

        Ok(Self {
            ff: config.is_set("pull.ff"),
            merge_autostash: config.is_set("merge.autostash"),
            rebase_autostash: config.is_set("rebase.autostash"),
        })
    }
}

/// git's own pull wherever the configuration decides, and where it is silent and git
/// would refuse, what `GitKraken`'s pull does: merge a diverged branch, and stash
/// uncommitted changes around the pull. git decides whether the pull rebases and reads
/// the stash setting of the way it chose, so each stash setting the user left unset is
/// given for this pull alone. `--ff` outranks only `pull.ff`, so a configured
/// `pull.rebase` still rebases.
fn pull_args(strategy: Option<&str>, config: &PullConfig) -> Vec<&'static str> {
    let mut args = Vec::new();
    if !config.merge_autostash {
        args.extend(["-c", "merge.autostash=true"]);
    }
    if !config.rebase_autostash {
        args.extend(["-c", "rebase.autostash=true"]);
    }

    args.push("pull");
    match strategy {
        Some("ff") => args.push("--ff"),
        Some("ff-only") => args.push("--ff-only"),
        Some("rebase") => args.push("--rebase"),
        _ if config.ff => {}
        _ => args.push("--ff"),
    }
    args
}

/// A copy that cannot be saved leaves the pull to run unguarded, as git alone would run
/// it, so the failure is logged rather than returned.
async fn save_pull_safety_copy(
    activity: &crate::activity::Activity,
    location: PathBuf,
) -> Option<PullSafetyCopy> {
    let saved = activity
        .spawn_blocking(move || {
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
async fn settle_pull_safety_copy(
    activity: &crate::activity::Activity,
    copy: Option<PullSafetyCopy>,
    location: PathBuf,
) -> bool {
    let Some(copy) = copy else {
        return false;
    };

    activity
        .spawn_blocking(move || {
            git2::Repository::open(location).map_or(true, |mut repo| copy.settle(&mut repo))
        })
        .await
        .unwrap_or(true)
}

async fn finish_pull<R: Runtime>(
    activity: &crate::activity::Activity,
    ran: Result<(), TrunkError>,
    turn: trunk_git::write_gate::Turn,
    path: &str,
    repository: crate::state::OpenRepo,
    cache: &CommitCache,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
    session: u64,
) -> Result<(), TrunkError> {
    ran?;

    let path_buf = repository.location().to_path_buf();
    checked_manual_pull(activity, app, path, session, path_buf.clone()).await;
    let probe_path = path_buf.clone();
    let conflicted = activity
        .spawn_blocking(move || {
            let repo = git2::Repository::open(&probe_path).map_err(TrunkError::from)?;
            trunk_git::repository::has_unmerged_paths(&repo)
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;

    let watch_refresh = match app.try_state::<WatcherState>() {
        Some(watcher) => watcher.cover_pending(path, session, cache, &turn).await,
        None => None,
    };
    // Other Git actions may wait for the write turn while holding the graph rebuild lock.
    drop(turn);

    // Refresh before reporting the conflict, or the UI never repaints and the files the
    // message points at stay invisible.
    refresh_graph(
        activity,
        path,
        repository,
        cache,
        ref_visibility,
        app,
        session,
    )
    .await?;
    if let Some(watch_refresh) = watch_refresh {
        watch_refresh.complete();
    }

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
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    git_push_inner(
        &activity,
        &path,
        &state_map,
        &cache,
        &running.0,
        &ref_visibility,
        &app,
    )
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
    activity: &crate::activity::Activity,
    path: &str,
    state_map: &OpenRepos,
    cache: &CommitCache,
    running: &Mutex<RemoteOps>,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
) -> Result<(), TrunkError> {
    let repository = state_map.repository(path)?.clone();
    let path_buf = repository.location().to_path_buf();

    let completion = run_git_remote(activity, &["push"], &path_buf, app, path, running).await?;

    refresh_graph(
        activity,
        path,
        repository,
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
pub const FORCE_PUSH_ARGS: [&str; 3] = ["push", "--force-with-lease", "--force-if-includes"];

/// Where a bare `git push` would send the current branch.
#[derive(Debug, serde::Serialize)]
pub struct PushTarget {
    pub remote: Option<String>,
    pub branch: Option<String>,
}

/// Resolve the *remote* the way git does, through the full `pushRemote` /
/// `pushDefault` chain, which git2's `branch.upstream()` cannot see because it reads
/// `branch.<name>.remote` only.
///
/// The *branch* is HEAD's shorthand, except under `push.default=upstream` (or its old
/// name `tracking`) when pushing to the upstream's remote, where git pushes to
/// `branch.<name>.merge`. A renaming `remote.<name>.push` is not consulted, so under it
/// this names a different ref than a bare `git push` would.
///
/// # Errors
///
/// Returns `git_error` with git's message when git cannot read the configuration. A
/// detached HEAD or a missing remote is not an error: the corresponding field is
/// `None`.
pub fn resolve_push_target(repo: &git2::Repository) -> Result<PushTarget, TrunkError> {
    let head = repo.head().ok();
    let branch = head
        .as_ref()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().ok())
        .map(str::to_owned);
    Ok(push_target_of(&push_config(repo)?, branch))
}

/// The settings a bare push reads to pick its remote and branch, as the user's git
/// reads them.
fn push_config(repo: &git2::Repository) -> Result<UserConfig, TrunkError> {
    UserConfig::read(
        repo.workdir().unwrap_or_else(|| repo.path()),
        r"^(branch\..*\.(pushremote|remote|merge)|remote\.pushdefault|push\.default|remote\.origin\.url)$",
        "git_error",
    )
}

fn push_target_of(config: &UserConfig, branch: Option<String>) -> PushTarget {
    let value = |name: &str| config.get(name).flatten().map(str::to_owned);
    let branch_key = |suffix: &str| {
        branch
            .as_deref()
            .and_then(|name| value(&format!("branch.{name}.{suffix}")))
    };
    let remote = branch_key("pushremote")
        .or_else(|| value("remote.pushdefault"))
        .or_else(|| branch_key("remote"))
        // A bare push falls back to `origin` by name, not to "the only remote":
        // with a sole differently-named remote git fatals with "no upstream branch".
        .or_else(|| {
            config
                .is_set("remote.origin.url")
                .then(|| "origin".to_owned())
        });

    let pushes_to_upstream = matches!(
        value("push.default").as_deref(),
        Some("upstream" | "tracking")
    ) && remote.is_some()
        && branch_key("remote") == remote;
    let upstream_branch = branch_key("merge")
        .filter(|_| pushes_to_upstream)
        .and_then(|merge| merge.strip_prefix("refs/heads/").map(str::to_owned));
    let branch = upstream_branch.or(branch);

    PushTarget { remote, branch }
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn push_branch<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    branch: String,
    publish: bool,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    push_branch_inner(
        &activity,
        &path,
        &branch,
        publish,
        &state_map,
        &cache,
        &running.0,
        &ref_visibility,
        &app,
    )
    .await
    .map_err(|e| e.to_json())
}

/// Push a local branch, checked out or not. One that tracks nothing is pushed under its
/// own name and tracked there only once the user agreed to `publish` it.
///
/// The remote and the remote branch are the ones a bare push of the branch would use,
/// named in full so no branch name reads as a refspec of its own.
///
/// # Errors
///
/// Returns `invalid_ref` when the repository has no such branch, `no_push_target` when no
/// remote is configured for it, `no_upstream` when it tracks nothing and `publish` is not
/// set, and the classified git error when the push fails.
pub async fn push_branch_inner<R: Runtime>(
    activity: &crate::activity::Activity,
    path: &str,
    branch: &str,
    publish: bool,
    state_map: &OpenRepos,
    cache: &CommitCache,
    running: &Mutex<RemoteOps>,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
) -> Result<(), TrunkError> {
    let repository = state_map.repository(path)?.clone();
    let path_buf = repository.location().to_path_buf();

    let target_path = path_buf.clone();
    let name = branch.to_owned();
    let (target, tracked) = activity
        .spawn_blocking(move || {
            let repo = git2::Repository::open(&target_path).map_err(TrunkError::from)?;
            if repo.find_branch(&name, git2::BranchType::Local).is_err() {
                return Err(TrunkError::new(
                    "invalid_ref",
                    format!("There is no branch named {name} to push."),
                ));
            }
            let config = push_config(&repo)?;
            let tracked = config.is_set(&format!("branch.{name}.merge"));
            Ok((push_target_of(&config, Some(name)), tracked))
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;
    let Some(remote) = target.remote else {
        return Err(TrunkError::new(
            "no_push_target",
            format!("{branch} has no remote to push to, so nothing was pushed."),
        ));
    };
    if !tracked && !publish {
        return Err(TrunkError::new(
            "no_upstream",
            format!("{branch} does not track a branch on {remote} yet."),
        ));
    }

    let destination = target.branch.as_deref().unwrap_or(branch);
    let refspec = format!("refs/heads/{branch}:refs/heads/{destination}");
    let mut args = vec!["push"];
    if !tracked {
        args.push("--set-upstream");
    }
    args.extend(["--", &remote, &refspec]);
    let completion = run_git_remote(activity, &args, &path_buf, app, path, running).await?;

    refresh_graph(
        activity,
        path,
        repository,
        cache,
        ref_visibility,
        app,
        completion.session,
    )
    .await
}

/// The remote and branch the user confirmed in the force-push dialog or the publish banner.
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
    activity: crate::activity::Activity,
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
        &activity,
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

/// The banner snapshots the push that failed and the repository can move under it. Without
/// this the refspec would still name the confirmed ref, but Trunk would push onto it from a
/// working tree that has since left it.
fn ensure_still_confirmed(
    remote: &str,
    branch: &str,
    confirmed: &ConfirmedPush<'_>,
    push: &str,
) -> Result<(), TrunkError> {
    if remote == confirmed.remote && branch == confirmed.branch {
        return Ok(());
    }

    let (confirmed_remote, confirmed_branch) = (confirmed.remote, confirmed.branch);
    Err(TrunkError::new(
        "push_target_changed",
        format!(
            "You confirmed {push} of {confirmed_branch} to {confirmed_remote}, but it would now push {branch} to {remote}. Nothing was pushed."
        ),
    ))
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
    activity: &crate::activity::Activity,
    path: &str,
    confirmed: ConfirmedPush<'_>,
    state_map: &OpenRepos,
    cache: &CommitCache,
    running: &Mutex<RemoteOps>,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
) -> Result<(), TrunkError> {
    let (confirmed_remote, confirmed_branch) = (confirmed.remote, confirmed.branch);
    let repository = state_map.repository(path)?.clone();
    let path_buf = repository.location().to_path_buf();

    let target_path = path_buf.clone();
    let target = activity.spawn_blocking(move || {
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
    ensure_still_confirmed(&remote, &branch, &confirmed, "a force push")?;

    // Naming the ref explicitly is what keeps the push to the branch the user
    // confirmed; a bare argv lets `push.default` / `remote.<name>.push` widen it.
    let refspec = format!("HEAD:refs/heads/{confirmed_branch}");
    let mut args = FORCE_PUSH_ARGS.to_vec();
    args.push("--");
    args.push(confirmed_remote);
    args.push(&refspec);

    let completion = run_git_remote(activity, &args, &path_buf, app, path, running).await?;

    refresh_graph(
        activity,
        path,
        repository,
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
pub async fn git_push_publish<R: Runtime>(
    activity: crate::activity::Activity,
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
    git_push_publish_inner(
        &activity,
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

/// Push HEAD's branch to the confirmed remote under its own name and track it there.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `no_push_target` when HEAD names
/// no branch or no remote, `push_target_changed` when HEAD left the confirmed branch,
/// `push_declined` when the remote rejects it, `auth_failure` when the remote refuses the
/// credentials, and `remote_error` otherwise.
pub async fn git_push_publish_inner<R: Runtime>(
    activity: &crate::activity::Activity,
    path: &str,
    confirmed: ConfirmedPush<'_>,
    state_map: &OpenRepos,
    cache: &CommitCache,
    running: &Mutex<RemoteOps>,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
) -> Result<(), TrunkError> {
    let repository = state_map.repository(path)?.clone();
    let path_buf = repository.location().to_path_buf();

    let target_path = path_buf.clone();
    let target = activity
        .spawn_blocking(move || {
            let repo = git2::Repository::open(&target_path).map_err(TrunkError::from)?;
            resolve_push_target(&repo)
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;
    let (Some(remote), Some(branch)) = (target.remote, target.branch) else {
        return Err(TrunkError::new(
            "no_push_target",
            "Trunk cannot tell which branch and remote to push to, so nothing was pushed.",
        ));
    };
    ensure_still_confirmed(&remote, &branch, &confirmed, "a push")?;

    let refspec = format!("HEAD:refs/heads/{}", confirmed.branch);
    let args = ["push", "--set-upstream", "--", confirmed.remote, &refspec];
    let completion = run_git_remote(activity, &args, &path_buf, app, path, running).await?;

    refresh_graph(
        activity,
        path,
        repository,
        cache,
        ref_visibility,
        app,
        completion.session,
    )
    .await
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn delete_remote_branch<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    branch_name: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    running: State<'_, RunningOp>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    delete_remote_branch_inner(
        &activity,
        &path,
        &branch_name,
        &state_map,
        &cache,
        &running.0,
        &ref_visibility,
        &app,
    )
    .await
    .map_err(|e| e.to_json())
}

/// Delete `branch_name`, a remote-tracking name such as `origin/feature`, from its
/// remote, then rebuild the graph.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository or it closes during the
/// delete, `invalid_ref` when no one remote tracks `branch_name`, `op_in_progress` while
/// another remote operation runs on it, `cancelled` when the user cancels the
/// delete, a `git_*` code when the repository cannot be opened, `spawn_error` when a
/// blocking step cannot be joined, and otherwise the code [`classify_git_error`]
/// gives what git said, such as `push_declined` when a hook or the server refuses
/// it, `auth_failure` or `remote_error`.
pub async fn delete_remote_branch_inner<R: Runtime>(
    activity: &crate::activity::Activity,
    path: &str,
    branch_name: &str,
    state_map: &OpenRepos,
    cache: &CommitCache,
    running: &Mutex<RemoteOps>,
    ref_visibility: &crate::state::RefVisibilityState,
    app: &AppHandle<R>,
) -> Result<(), TrunkError> {
    let repository = state_map.repository(path)?.clone();
    let path_buf = repository.location().to_path_buf();

    let location = path_buf.clone();
    let tracking = branch_name.to_owned();
    let (remote, branch) = activity
        .spawn_blocking(move || tracked_remote_ref(&location, &tracking))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;

    let completion = run_git_remote(
        activity,
        &["push", "--delete", "--", &remote, &branch],
        &path_buf,
        app,
        path,
        running,
    )
    .await?;

    refresh_graph(
        activity,
        path,
        repository,
        cache,
        ref_visibility,
        app,
        completion.session,
    )
    .await
}

/// The remote that `branch_name`, a remote-tracking branch such as
/// `origin/feature`, belongs to, and the branch on it the ref stands for.
fn tracked_remote_ref(
    location: &std::path::Path,
    branch_name: &str,
) -> Result<(String, String), TrunkError> {
    let repo = git2::Repository::open(location)?;
    let source = Remotes::read(&repo).source_of(branch_name).ok_or_else(|| {
        TrunkError::new(
            "invalid_ref",
            format!("{branch_name} is not a branch of a configured remote"),
        )
    })?;
    Ok((source.remote, source.branch))
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
pub async fn list_remotes(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
) -> Result<Vec<String>, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || list_remotes_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e: TrunkError| e.to_json())
}

/// The names of the repository's configured remotes.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error
/// when its config will not read.
pub fn list_remotes_inner(path: &str, state_map: &OpenRepos) -> Result<Vec<String>, TrunkError> {
    let repo = state_map.open(path)?;
    let names = repo.remotes()?;
    Ok(names.iter().flatten().flatten().map(String::from).collect())
}

/// What a tag change does to the tag on the remote.
#[derive(Clone, Copy)]
pub enum TagChange {
    Push,
    Delete,
}

/// A tag, by its short name, and the configured remote a change to it goes to.
pub struct TagOnRemote<'a> {
    pub remote: &'a str,
    pub tag: &'a str,
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn push_tag<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    remote: String,
    tag_name: String,
    state: State<'_, RepoState>,
    running: State<'_, RunningOp>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let target = TagOnRemote {
        remote: &remote,
        tag: &tag_name,
    };
    change_remote_tag_inner(
        &activity,
        &path,
        TagChange::Push,
        &target,
        &state.snapshot(),
        &running.0,
        &app,
    )
    .await
    .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn delete_remote_tag<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    remote: String,
    tag_name: String,
    state: State<'_, RepoState>,
    running: State<'_, RunningOp>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let target = TagOnRemote {
        remote: &remote,
        tag: &tag_name,
    };
    change_remote_tag_inner(
        &activity,
        &path,
        TagChange::Delete,
        &target,
        &state.snapshot(),
        &running.0,
        &app,
    )
    .await
    .map_err(|e| e.to_json())
}

/// Push a local tag to a remote, or delete a tag from one. Neither changes a ref
/// here, since no remote-tracking ref follows a remote's tags, so the graph stays.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `invalid_ref` when the
/// remote is not configured or a pushed tag does not exist here, `op_in_progress`
/// while another remote operation runs on it, `cancelled` when the user cancels it,
/// `tag_exists` when the remote has a different tag of that name, and otherwise the
/// code [`classify_git_error`] gives what git said, such as `push_declined`,
/// `auth_failure` or `remote_error`.
pub async fn change_remote_tag_inner<R: Runtime>(
    activity: &crate::activity::Activity,
    path: &str,
    change: TagChange,
    target: &TagOnRemote<'_>,
    state_map: &OpenRepos,
    running: &Mutex<RemoteOps>,
    app: &AppHandle<R>,
) -> Result<(), TrunkError> {
    let path_buf = state_map.repository(path)?.location().to_path_buf();
    let refname = format!("refs/tags/{}", target.tag);

    let location = path_buf.clone();
    let (remote, checked) = (target.remote.to_owned(), refname.clone());
    activity
        .spawn_blocking(move || check_tag_change(&location, change, &remote, &checked))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;

    let args: &[&str] = match change {
        TagChange::Push => &["push", "--", target.remote, &refname],
        TagChange::Delete => &["push", "--delete", "--", target.remote, &refname],
    };
    run_git_remote(activity, args, &path_buf, app, path, running).await?;
    Ok(())
}

fn check_tag_change(
    location: &std::path::Path,
    change: TagChange,
    remote: &str,
    refname: &str,
) -> Result<(), TrunkError> {
    let repo = git2::Repository::open(location)?;
    let configured = repo
        .remotes()?
        .iter()
        .flatten()
        .any(|name| name == Some(remote));
    if !configured {
        return Err(TrunkError::new(
            "invalid_ref",
            format!("{remote} is not a remote of this repository"),
        ));
    }
    if !git2::Reference::is_valid_name(refname) {
        return Err(TrunkError::new(
            "invalid_ref",
            format!("{refname} is not a tag name git accepts"),
        ));
    }
    if matches!(change, TagChange::Push) && repo.find_reference(refname).is_err() {
        return Err(TrunkError::new(
            "invalid_ref",
            format!("This repository has no tag {refname}"),
        ));
    }
    Ok(())
}

/// # Errors
///
/// Never returns an error. The `Result` is the shape every command shares.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn cancel_remote_op(
    _activity: crate::activity::Activity,
    path: String,
    running: State<'_, RunningOp>,
) -> Result<(), String> {
    let process = running.0.lock().unwrap().cancel(&path);
    if let Some(process) = process {
        process.stop();
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::what_git_said;
    use std::os::unix::process::ExitStatusExt;
    use std::process::{ExitStatus, Output};

    fn failed(stdout: &str, stderr: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(1 << 8),
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn what_git_said_puts_stderr_before_stdout() {
        let output = failed("CONFLICT in f\n", "From origin\n");

        assert_eq!(what_git_said(&output), "From origin\nCONFLICT in f");
    }

    #[test]
    fn what_git_said_without_a_word_names_the_exit_code() {
        assert_eq!(
            what_git_said(&failed("", "\n")),
            "git exited with code 1 and printed no reason. A hook may have refused it."
        );
    }
}

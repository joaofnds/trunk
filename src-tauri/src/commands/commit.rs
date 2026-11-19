use crate::commands::commit_actions::head_if_still;
use crate::state::{CommitCache, OpenRepos, RepoState};
use crate::types::HeadCommitMessage;
use crate::user_git::{UserGit, refusal};
use crate::watcher::RepoChanged;
use std::path::Path;
use tauri::{AppHandle, Emitter, Runtime, State};
use trunk_git::error::TrunkError;

fn refresh_commit_cache(
    path: &str,
    state_map: &OpenRepos,
) -> Result<crate::state::GraphRead, TrunkError> {
    state_map.read_graph(path)
}

fn build_message(subject: &str, body: Option<&str>) -> String {
    match body {
        Some(b) if !b.trim().is_empty() => format!("{subject}\n\n{b}"),
        _ => subject.to_owned(),
    }
}

/// Commit the index through `git commit`, so the repository's hooks run and
/// the commit is signed as its config asks. git concludes a cherry-pick or
/// revert in progress itself.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and `commit_error`
/// carrying git's own output when `git` will not run or refuses the commit,
/// a hook's refusal included.
pub fn create_commit_inner(
    path: &str,
    subject: &str,
    body: Option<&str>,
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    let message = build_message(subject, body);
    let repo_dir = state_map.path_for(path)?;
    state_map.hold_for_git(path, |_| run_git_commit(repo_dir, &["-m", &message]))
}

/// An amend as its caller names it. Its strings travel as named fields: passed
/// positionally, a swapped subject and oid would still compile.
pub struct AmendRequest<'a> {
    pub subject: &'a str,
    pub body: Option<&'a str>,
    /// The commit the user chose to amend, HEAD when they did.
    pub expected_head_oid: &'a str,
}

/// Replace HEAD's commit through `git commit --amend`, with the current index
/// and a new message. The original author stays, as in the terminal.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `amend_stale` when
/// HEAD is no longer the commit the user chose to amend, the git error when
/// HEAD will not read, and `commit_error` carrying git's own output when `git`
/// will not run or refuses the amend, a hook's refusal included.
pub fn amend_commit_inner(
    path: &str,
    request: &AmendRequest,
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    let message = build_message(request.subject, request.body);
    let repo_dir = state_map.path_for(path)?;
    state_map.hold_for_git(path, |repo| {
        // An amend queued behind a pull or another commit would otherwise
        // replace the commit that landed meanwhile, under this message.
        if head_if_still(repo, request.expected_head_oid)?.is_none() {
            return Err(TrunkError::new(
                "amend_stale",
                "HEAD is no longer the commit this amend was opened on, so nothing was amended",
            ));
        }
        run_git_commit(repo_dir, &["--amend", "-m", &message])
    })
}

fn run_git_commit(repo_dir: &Path, flags: &[&str]) -> Result<(), TrunkError> {
    let output = UserGit::in_dir(repo_dir)
        .arg("commit")
        .args(flags)
        .output()
        .map_err(|e| TrunkError::new("commit_error", e.to_string()))?;

    if output.status.success() {
        return Ok(());
    }

    Err(TrunkError::new("commit_error", refusal(&output)))
}

/// HEAD's commit message, split into subject and body.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when HEAD is
/// unborn or does not peel to a commit.
pub fn get_head_commit_message_inner(
    path: &str,
    state_map: &OpenRepos,
) -> Result<HeadCommitMessage, TrunkError> {
    let repo = state_map.open(path)?;
    let commit = repo.head()?.peel_to_commit()?;
    Ok(HeadCommitMessage {
        oid: commit.id().to_string(),
        subject: commit.summary().ok().flatten().unwrap_or("").to_owned(),
        body: commit.body().ok().flatten().map(str::to_owned),
    })
}

/// The name the repository's commits are signed with, `user.name` read
/// through its whole config chain, or `None` when no level sets it. The review
/// shows the reviewer's initials from it.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error
/// when its config will not load.
pub fn get_user_name_inner(
    path: &str,
    state_map: &OpenRepos,
) -> Result<Option<String>, TrunkError> {
    let repo = state_map.open(path)?;
    let config = repo.config()?;
    match config.get_string("user.name") {
        Ok(name) => Ok(Some(name)),
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(e) => Err(TrunkError::from(e)),
    }
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
#[tauri::command]
pub async fn get_user_name(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
) -> Result<Option<String>, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || get_user_name_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
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
pub async fn create_commit<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    subject: String,
    body: Option<String>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let rebuild = crate::state::GraphRebuild::new(activity.clone(), &cache, &ref_visibility);
    let state_map = state.snapshot();
    let path_clone = path.clone();
    rebuild
        .rebuild(path.clone(), move || {
            create_commit_inner(&path_clone, &subject, body.as_deref(), &state_map)?;
            refresh_commit_cache(&path_clone, &state_map)
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));
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
pub async fn amend_commit<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    subject: String,
    body: Option<String>,
    expected_head_oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let rebuild = crate::state::GraphRebuild::new(activity.clone(), &cache, &ref_visibility);
    let state_map = state.snapshot();
    let path_clone = path.clone();
    rebuild
        .rebuild(path.clone(), move || {
            amend_commit_inner(
                &path_clone,
                &AmendRequest {
                    subject: &subject,
                    body: body.as_deref(),
                    expected_head_oid: &expected_head_oid,
                },
                &state_map,
            )?;
            refresh_commit_cache(&path_clone, &state_map)
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));
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
pub async fn get_head_commit_message(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
) -> Result<HeadCommitMessage, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || get_head_commit_message_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

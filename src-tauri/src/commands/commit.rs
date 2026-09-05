use crate::error::TrunkError;
use crate::git::graph_input::GraphSnapshot;
use crate::git::{graph, types::HeadCommitMessage};
use crate::state::{CommitCache, OpenRepos, RepoState};
use tauri::{AppHandle, Emitter, Runtime, State};

fn refresh_commit_cache(
    path: &str,
    state_map: &OpenRepos,
    visibility: &crate::git::graph_input::RefVisibility,
) -> Result<GraphSnapshot, TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let mut repo = git2::Repository::open(path_buf).map_err(TrunkError::from)?;
    graph::snapshot(&mut repo, visibility)
}

fn build_message(subject: &str, body: Option<&str>) -> String {
    match body {
        Some(b) if !b.trim().is_empty() => format!("{subject}\n\n{b}"),
        _ => subject.to_owned(),
    }
}

/// Commit the index, clearing any cherry-pick or revert state left behind.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when the
/// signature is unset, the index will not write, or the commit fails. An
/// unborn HEAD is not an error: the commit becomes the first one.
pub fn create_commit_inner(
    path: &str,
    subject: &str,
    body: Option<&str>,
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;
    let sig = repo.signature()?;
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let message = build_message(subject, body);

    let parents = match repo.head() {
        Ok(h) => vec![h.peel_to_commit()?],
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => vec![],
        Err(e) => return Err(TrunkError::from(e)),
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

    repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parent_refs)?;
    // git2's commit is plumbing: unlike `git commit` it leaves CHERRY_PICK_HEAD
    // and REVERT_HEAD in place. The normal commit form renders during both
    // (StagingPanel's isOperation covers only merge and rebase), so without this
    // the repository stays mid-operation forever with no in-app way out.
    repo.cleanup_state()?;
    Ok(())
}

/// Replace HEAD's commit with one carrying the current index and a new message.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when HEAD is
/// unborn, the signature is unset, or the index will not write.
pub fn amend_commit_inner(
    path: &str,
    subject: &str,
    body: Option<&str>,
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let sig = repo.signature()?;
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let message = build_message(subject, body);

    head_commit.amend(
        Some("HEAD"),
        Some(&sig),
        Some(&sig),
        None,
        Some(&message),
        Some(&tree),
    )?;
    Ok(())
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
        subject: commit.summary().ok().flatten().unwrap_or("").to_owned(),
        body: commit.body().ok().flatten().map(str::to_owned),
    })
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
    path: String,
    subject: String,
    body: Option<String>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.snapshot();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        create_commit_inner(&path_clone, &subject, body.as_deref(), &state_map)?;
        refresh_commit_cache(&path_clone, &state_map, &visibility)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
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
    path: String,
    subject: String,
    body: Option<String>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.snapshot();
    let path_clone = path.clone();
    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        amend_commit_inner(&path_clone, &subject, body.as_deref(), &state_map)?;
        refresh_commit_cache(&path_clone, &state_map, &visibility)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
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
    path: String,
    state: State<'_, RepoState>,
) -> Result<HeadCommitMessage, String> {
    let state_map = state.snapshot();
    tauri::async_runtime::spawn_blocking(move || get_head_commit_message_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

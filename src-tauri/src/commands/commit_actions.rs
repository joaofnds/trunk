use crate::state::{CommitCache, OpenRepos, RepoState};
use crate::types::UndoResult;
use crate::user_git::UserGit;
use crate::watcher::RepoChanged;
use tauri::{AppHandle, Emitter, Runtime, State};
use trunk_git::error::TrunkError;
use trunk_git::graph_input::GraphSnapshot;

/// Outcome of a clean two-step revert begin.
///
/// The async wrapper emits `repo-changed` (`REVERT_HEAD` is set before the
/// editor opens), so a later cancel still surfaces the in-progress UI. A
/// conflicted revert returns `Err(conflict_state)` instead — there is a single
/// editor outcome, so a 2-field struct is simpler than a tagged enum here.
#[derive(Debug, serde::Serialize)]
pub struct RevertBeginResult {
    pub graph: GraphSnapshot,
    pub message: Option<String>,
}

/// Detach HEAD onto a commit, refusing to overwrite uncommitted work.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `dirty_workdir` when the working
/// tree has uncommitted changes, and the git error when `oid` does not resolve
/// or the checkout fails.
pub fn checkout_commit_inner(
    path: &str,
    oid: &str,
    state_map: &OpenRepos,
) -> Result<crate::state::GraphRead, TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let repo = git2::Repository::open(path_buf)?;

    trunk_git::write_gate::hold(&repo, |repo| {
        if trunk_git::repository::is_repo_dirty(repo)? {
            return Err(TrunkError::new(
                "dirty_workdir",
                "Working tree has uncommitted changes",
            ));
        }

        let obj = repo.revparse_single(oid)?;
        repo.checkout_tree(&obj, Some(git2::build::CheckoutBuilder::new().safe()))?;
        repo.set_head_detached(obj.id())?;
        Ok(())
    })?;
    drop(repo);

    state_map.read_graph(path)
}

/// Create an annotated tag on a commit.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when `oid` does
/// not resolve, the signature is unset, or the tag name is taken.
pub fn create_tag_inner(
    path: &str,
    oid: &str,
    tag_name: &str,
    message: &str,
    state_map: &OpenRepos,
) -> Result<crate::state::GraphRead, TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let repo = git2::Repository::open(path_buf)?;
    let obj = repo.revparse_single(oid)?;
    let sig = repo.signature().map_err(TrunkError::from)?;
    let msg = if message.trim().is_empty() {
        tag_name.to_owned()
    } else {
        message.to_owned()
    };
    repo.tag(tag_name, &obj, &sig, &msg, false)?;
    drop(obj);
    drop(repo);

    state_map.read_graph(path)
}

/// Delete a tag.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when no such tag
/// exists or it will not delete.
pub fn delete_tag_inner(
    path: &str,
    tag_name: &str,
    state_map: &OpenRepos,
) -> Result<crate::state::GraphRead, TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let repo = git2::Repository::open(path_buf)?;
    let tag_ref_name = format!("refs/tags/{tag_name}");
    let mut reference = repo.find_reference(&tag_ref_name)?;
    reference.delete()?;
    drop(reference);
    drop(repo);

    state_map.read_graph(path)
}

/// The error for a pick or revert git refused, named by what it left behind:
/// `conflict_state` when the index holds conflicted paths, and `other` with
/// git's own message otherwise. git's text is no guide, since the message for
/// a pick HEAD already has says "possibly due to conflict resolution".
fn stopped_error(path: &std::path::Path, stderr: &[u8], other: &str) -> TrunkError {
    let conflicted = git2::Repository::open(path)
        .and_then(|repo| repo.index())
        .is_ok_and(|index| index.has_conflicts());
    let code = if conflicted { "conflict_state" } else { other };
    TrunkError::new(code, String::from_utf8_lossy(stderr).to_string())
}

/// Whether git stopped the pick because HEAD already has its changes: the pick
/// is still in progress, nothing conflicts, and the index holds HEAD's own tree.
fn pick_is_empty(path: &std::path::Path) -> Result<bool, TrunkError> {
    let repo = git2::Repository::open(path)?;
    if repo.state() != git2::RepositoryState::CherryPick {
        return Ok(false);
    }

    let index = repo.index()?;
    if index.has_conflicts() {
        return Ok(false);
    }

    let head_tree = repo.head()?.peel_to_tree()?;
    let staged = repo.diff_tree_to_index(Some(&head_tree), Some(&index), None)?;
    Ok(staged.deltas().len() == 0)
}

fn cherry_pick_skip(path: &std::path::Path) -> Result<(), TrunkError> {
    let output = UserGit::in_dir(path)
        .args(["cherry-pick", "--skip"])
        .output()
        .map_err(|e| TrunkError::new("cherry_pick_error", e.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(TrunkError::new("cherry_pick_error", stderr.to_string()));
    }
    Ok(())
}

/// Cherry-pick a commit onto HEAD.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `conflict_state` when the pick
/// conflicts, `cherry_pick_empty` when HEAD already has the commit's changes (the pick is
/// then ended, since there is nothing left to commit), and `cherry_pick_error` carrying
/// git's own message when `git` will not run or the pick fails for any other reason.
pub fn cherry_pick_inner(
    path: &str,
    oid: &str,
    state_map: &OpenRepos,
) -> Result<crate::state::GraphRead, TrunkError> {
    let path_buf = state_map.path_for(path)?;
    state_map.hold_for_git(path, |_| {
        let output = UserGit::in_dir(path_buf)
            .args(["cherry-pick", "--", oid])
            .output()
            .map_err(|e| TrunkError::new("cherry_pick_error", e.to_string()))?;

        if !output.status.success() {
            if pick_is_empty(path_buf)? {
                cherry_pick_skip(path_buf)?;
                let reason = String::from_utf8_lossy(&output.stderr).to_string();
                return Err(TrunkError::new("cherry_pick_empty", reason));
            }
            return Err(stopped_error(path_buf, &output.stderr, "cherry_pick_error"));
        }

        Ok(())
    })?;

    state_map.read_graph(path)
}

/// Conclude a conflicted cherry-pick by committing the resolved tree.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and `cherry_pick_error` carrying
/// git's own message when `git` will not run or the commit fails.
pub fn cherry_pick_continue_inner(
    path: &str,
    message: &str,
    state_map: &OpenRepos,
) -> Result<crate::state::GraphRead, TrunkError> {
    let path_buf = state_map.path_for(path)?;
    state_map.hold_for_git(path, |_| {
        // Mirrors revert_continue: --cleanup=strip drops git's `# Conflicts:` block,
        // and `git commit -m` concludes the pick, clearing CHERRY_PICK_HEAD.
        let output = UserGit::in_dir(path_buf)
            .args(["commit", "-m", message, "--cleanup=strip"])
            .output()
            .map_err(|e| TrunkError::new("cherry_pick_error", e.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(TrunkError::new("cherry_pick_error", stderr.to_string()));
        }

        Ok(())
    })?;

    state_map.read_graph(path)
}

/// Abandon an in-progress cherry-pick and restore the previous tree.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and `cherry_pick_error` carrying
/// git's own message when `git` will not run or the abort fails.
pub fn cherry_pick_abort_inner(
    path: &str,
    state_map: &OpenRepos,
) -> Result<crate::state::GraphRead, TrunkError> {
    let path_buf = state_map.path_for(path)?;
    state_map.hold_for_git(path, |_| {
        // merge_abort cannot stand in here: `git merge --abort` needs MERGE_HEAD,
        // which a cherry-pick never sets.
        let output = UserGit::in_dir(path_buf)
            .args(["cherry-pick", "--abort"])
            .output()
            .map_err(|e| TrunkError::new("cherry_pick_error", e.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(TrunkError::new("cherry_pick_error", stderr.to_string()));
        }

        Ok(())
    })?;

    state_map.read_graph(path)
}

/// Stage a revert without committing, so the message can be edited first.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `conflict_state` when the revert
/// conflicts, and `revert_error` carrying git's own message when `git` will
/// not run or the revert fails for any other reason.
pub fn revert_commit_begin_inner(
    path: &str,
    oid: &str,
    state_map: &OpenRepos,
) -> Result<(crate::state::GraphRead, Option<String>), TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let message = state_map.hold_for_git(path, |repo| {
        // Stage the revert without committing so the editor can edit the message.
        // git writes the default message (Revert "<subject>" + full 40-char OID) to
        // .git/MERGE_MSG. REVERT_HEAD is set; the wrapper emits repo-changed.
        let output = UserGit::in_dir(path_buf)
            .args(["revert", "--no-commit", "--", oid])
            .output()
            .map_err(|e| TrunkError::new("revert_error", e.to_string()))?;

        if !output.status.success() {
            return Err(stopped_error(path_buf, &output.stderr, "revert_error"));
        }

        // Read before the next writer can abort this revert or start another. The
        // message is git's verbatim default: `# Conflicts:` lines (conflicted revert)
        // are stripped at commit time via --cleanup=strip, never here.
        Ok(std::fs::read_to_string(repo.path().join("MERGE_MSG")).ok())
    })?;

    let source = state_map.read_graph(path)?;
    Ok((source, message))
}

/// Conclude a staged revert by committing it.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and `revert_error` carrying git's
/// own message when `git` will not run or the commit fails.
pub fn revert_continue_inner(
    path: &str,
    message: &str,
    state_map: &OpenRepos,
) -> Result<crate::state::GraphRead, TrunkError> {
    let path_buf = state_map.path_for(path)?;
    state_map.hold_for_git(path, |_| {
        // --cleanup=strip drops git's `# Conflicts:` comment block so conflicted
        // revert bodies stay clean (MSG-03 fidelity). git commit -m clears REVERT_HEAD.
        let output = UserGit::in_dir(path_buf)
            .args(["commit", "-m", message, "--cleanup=strip"])
            .output()
            .map_err(|e| TrunkError::new("revert_error", e.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(TrunkError::new("revert_error", stderr.to_string()));
        }

        Ok(())
    })?;

    state_map.read_graph(path)
}

/// Abandon an in-progress revert and restore a clean tree.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and `revert_error` carrying git's
/// own message when `git` will not run or the abort fails.
pub fn revert_abort_inner(
    path: &str,
    state_map: &OpenRepos,
) -> Result<crate::state::GraphRead, TrunkError> {
    let path_buf = state_map.path_for(path)?;
    state_map.hold_for_git(path, |_| {
        // The MSG-06 recovery path for revert: clears REVERT_HEAD + restores a clean
        // tree. Without it a cancelled revert traps the user (RESEARCH finding 4).
        let output = UserGit::in_dir(path_buf)
            .args(["revert", "--abort"])
            .output()
            .map_err(|e| TrunkError::new("revert_error", e.to_string()))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(TrunkError::new("revert_error", stderr.to_string()));
        }

        Ok(())
    })?;

    state_map.read_graph(path)
}

/// Reset HEAD to a commit in soft, mixed or hard mode.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `invalid_mode` when `mode` is not
/// one of soft, mixed or hard, and `reset_error` carrying git's own message
/// when `git` will not run or the reset fails.
pub fn reset_to_commit_inner(
    path: &str,
    oid: &str,
    mode: &str,
    state_map: &OpenRepos,
) -> Result<crate::state::GraphRead, TrunkError> {
    let path_buf = state_map.path_for(path)?;

    let valid_modes = ["soft", "mixed", "hard"];
    if !valid_modes.contains(&mode) {
        return Err(TrunkError::new(
            "invalid_mode",
            format!("Invalid reset mode: {mode}"),
        ));
    }

    state_map.hold_for_git(path, |_| {
        run_git_reset(path_buf, &[&format!("--{mode}"), oid], "reset_error")
    })?;

    state_map.read_graph(path)
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
pub async fn reset_to_commit<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    oid: String,
    mode: String,
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
            reset_to_commit_inner(&path_clone, &oid, &mode, &state_map)
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
pub async fn checkout_commit<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    oid: String,
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
            checkout_commit_inner(&path_clone, &oid, &state_map)
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));
    Ok(())
}

// The four leading arguments are the command's wire contract with the frontend, and the rest
// are state Tauri injects by type; neither half can be grouped without changing one of those.
/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn create_tag<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    oid: String,
    tag_name: String,
    message: String,
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
            create_tag_inner(&path_clone, &oid, &tag_name, &message, &state_map)
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
pub async fn delete_tag<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    tag_name: String,
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
            delete_tag_inner(&path_clone, &tag_name, &state_map)
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
pub async fn cherry_pick<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    oid: String,
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
            cherry_pick_inner(&path_clone, &oid, &state_map)
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
pub async fn revert_commit_begin<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<RevertBeginResult, String> {
    let rebuild = crate::state::GraphRebuild::new(activity.clone(), &cache, &ref_visibility);
    let state_map = state.snapshot();
    let path_clone = path.clone();

    // begin mutated the repo (REVERT_HEAD set + staged) before the editor opens, so the
    // rebuilt graph is cached and repo-changed emitted below — a later cancel must still
    // surface the in-progress banner (RESEARCH Pitfall 2/4).
    let (graph, message) = rebuild
        .rebuild_carrying(path.clone(), move || {
            revert_commit_begin_inner(&path_clone, &oid, &state_map)
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));
    Ok(RevertBeginResult { graph, message })
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
pub async fn cherry_pick_continue<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    message: String,
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
            cherry_pick_continue_inner(&path_clone, &message, &state_map)
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
pub async fn cherry_pick_abort<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
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
            cherry_pick_abort_inner(&path_clone, &state_map)
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
pub async fn revert_continue<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    message: String,
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
            revert_continue_inner(&path_clone, &message, &state_map)
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
pub async fn revert_abort<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
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
            revert_abort_inner(&path_clone, &state_map)
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));
    Ok(())
}

/// HEAD's commit, when it is still `expected`, the commit the user acted on.
///
/// An action that waited its turn behind another writer runs on whatever that
/// writer left, so an action aimed at HEAD itself checks here, under its hold,
/// that HEAD is still the commit the user saw.
///
/// # Errors
///
/// Returns the git error when HEAD will not read, which is not the same as HEAD having moved.
pub(crate) fn head_if_still<'r>(
    repo: &'r git2::Repository,
    expected: &str,
) -> Result<Option<git2::Commit<'r>>, TrunkError> {
    let head = repo.head()?.peel_to_commit()?;
    Ok((head.id().to_string() == expected).then_some(head))
}

/// Soft-reset HEAD by one commit, returning the commit it took back and where HEAD landed, so
/// a redo can restore that commit onto that position.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `undo_stale` when HEAD is no
/// longer `expected_head_oid`, the commit the user pressed Undo on, `nothing_to_undo` for the
/// initial commit, `merge_commit` for a merge, `undo_error` carrying git's own message when
/// the reset fails, and the git error when HEAD will not read.
pub fn undo_commit_inner(
    path: &str,
    expected_head_oid: &str,
    state_map: &OpenRepos,
) -> Result<UndoResult, TrunkError> {
    let path_buf = state_map.path_for(path)?;
    state_map.hold_for_git(path, |repo| {
        // An undo queued behind a pull or a commit would otherwise take back the
        // commit that landed meanwhile, not the one the user pressed Undo on.
        let Some(head) = head_if_still(repo, expected_head_oid)? else {
            return Err(TrunkError::new(
                "undo_stale",
                "HEAD is no longer the commit Undo was pressed on, so nothing was undone",
            ));
        };

        if head.parent_count() == 0 {
            return Err(TrunkError::new(
                "nothing_to_undo",
                "Cannot undo the initial commit",
            ));
        }
        if head.parent_count() > 1 {
            return Err(TrunkError::new(
                "merge_commit",
                "Cannot undo a merge commit",
            ));
        }

        let undone_oid = head.id().to_string();
        // The parent is where the soft reset below lands HEAD, and the only position
        // a redo of this commit belongs on.
        let head_oid = head.parent_id(0)?.to_string();

        run_git_reset(path_buf, &["--soft", "HEAD~1"], "undo_error")?;

        Ok(UndoResult {
            head_oid,
            undone_oid,
        })
    })
}

/// A redo as its caller names it. The three are all strings, so they travel as
/// named fields: passed positionally, a swapped pair would still compile.
pub struct RedoRequest<'a> {
    /// The commit the undo took back.
    pub undone_oid: &'a str,
    /// Where the undo left HEAD.
    pub expected_head_oid: &'a str,
    /// The repository the undo ran in.
    pub expected_path: &'a str,
}

/// Run `git reset` with `args` in `dir`, reporting a failure under `code` with git's own words.
fn run_git_reset(dir: &std::path::Path, args: &[&str], code: &str) -> Result<(), TrunkError> {
    let output = UserGit::in_dir(dir)
        .arg("reset")
        .args(args)
        .output()
        .map_err(|e| TrunkError::new(code, e.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(TrunkError::new(code, stderr.to_string()));
    }
    Ok(())
}

/// Restore the commit an undo took back, refusing if HEAD or the repository has moved.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `redo_stale` when the redo names a
/// different repository, HEAD has moved since the undo, or the named commit's one parent is not
/// HEAD, `redo_missing` when the named commit is not in the repository, `redo_error` when the
/// reset fails, and the git error when HEAD or the commit will not read.
pub fn redo_commit_inner(
    path: &str,
    request: &RedoRequest,
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    // Two clones of one repository share every oid, so the position alone cannot
    // tell them apart. `path` names which repository this redo is allowed to
    // write to; a caller asking to redo on a different one is refused here too.
    if path != request.expected_path {
        return Err(TrunkError::new(
            "redo_stale",
            "This redo belongs to a different repository",
        ));
    }
    let repo_dir = state_map.path_for(path)?;
    state_map.hold_for_git(path, |repo| {
        let Some(current) = head_if_still(repo, request.expected_head_oid)?.map(|c| c.id()) else {
            return Err(TrunkError::new(
                "redo_stale",
                "HEAD has moved since the undo; refusing to redo onto unrelated history",
            ));
        };
        let missing = || {
            TrunkError::new(
                "redo_missing",
                "The commit this redo restores is no longer in the repository",
            )
        };
        let Ok(undone_oid) = git2::Oid::from_str(request.undone_oid) else {
            return Err(missing());
        };
        let undone = match repo.find_commit(undone_oid) {
            Ok(commit) => commit,
            Err(e) if e.code() == git2::ErrorCode::NotFound => return Err(missing()),
            Err(e) => return Err(e.into()),
        };
        // An undo from here took back a commit whose one parent is HEAD. Restoring
        // any other commit would move the branch to history the user never made on it.
        if !undone.parent_ids().eq([current]) {
            return Err(TrunkError::new(
                "redo_stale",
                "This redo names no commit made on top of HEAD",
            ));
        }
        let undone_hex = undone.id().to_string();

        // The inverse of the undo's soft reset: HEAD returns to the same commit, and
        // the index and files stay as the user left them, so anything staged since
        // the undo is still staged, on top of it. The `--` keeps a file that happens
        // to be named like the oid from being read as a path.
        run_git_reset(repo_dir, &["--soft", &undone_hex, "--"], "redo_error")
    })
}

/// Whether HEAD is a commit with exactly one parent, so it can be undone.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository. An unborn or unreadable HEAD is
/// not an error: it answers false.
pub fn check_undo_available_inner(path: &str, state_map: &OpenRepos) -> Result<bool, TrunkError> {
    let repo = state_map.open(path)?;
    let head = match repo.head() {
        Ok(h) => match h.peel_to_commit() {
            Ok(c) => c,
            Err(_) => return Ok(false),
        },
        Err(_) => return Ok(false),
    };
    // Can undo if exactly one parent (not initial, not merge)
    Ok(head.parent_count() == 1)
}

/// Where HEAD is now, or `None` when it cannot be read as a commit.
///
/// A pending redo names the position it belongs on. Comparing it against this is
/// what stops the redo being replayed onto history it does not describe.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository. An unborn or
/// unreadable HEAD is not an error: it answers `None`.
pub fn head_oid_inner(path: &str, state_map: &OpenRepos) -> Result<Option<String>, TrunkError> {
    let repo = state_map.open(path)?;
    Ok(repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .ok()
        .map(|commit| commit.id().to_string()))
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
pub async fn undo_commit<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    expected_head_oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<UndoResult, String> {
    let rebuild = crate::state::GraphRebuild::new(activity.clone(), &cache, &ref_visibility);
    let state_map = state.snapshot();
    let path_clone = path.clone();
    let (_graph, undo_result) = rebuild
        .rebuild_carrying(path.clone(), move || {
            let undo = undo_commit_inner(&path_clone, &expected_head_oid, &state_map)?;
            let source = state_map.read_graph(&path_clone)?;
            Ok((source, undo))
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));
    Ok(undo_result)
}

// The four leading arguments are the command's wire contract with the frontend, and the rest
// are state Tauri injects by type; neither half can be grouped without changing one of those.
/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn redo_commit<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    undone_oid: String,
    expected_head_oid: String,
    expected_repo_path: String,
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
            redo_commit_inner(
                &path_clone,
                &RedoRequest {
                    undone_oid: &undone_oid,
                    expected_head_oid: &expected_head_oid,
                    expected_path: &expected_repo_path,
                },
                &state_map,
            )?;
            state_map.read_graph(&path_clone)
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
pub async fn check_undo_available(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
) -> Result<bool, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || check_undo_available_inner(&path, &state_map))
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
pub async fn head_oid(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
) -> Result<Option<String>, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || head_oid_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use std::path::{Path, PathBuf};
    use tempfile::TempDir;

    // Temp-repo harness (mirrors operation_state.rs tests / review/src/doc.rs).
    // Real git2 + tempfile, no mocks (classical TDD). The code-under-test shells
    // out to `git`, so the repo config must carry a committer identity.

    fn make_repo() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Test").unwrap();
            config.set_str("user.email", "test@example.com").unwrap();
        }
        (dir, repo)
    }

    fn sig() -> Signature<'static> {
        Signature::new("Test", "test@example.com", &git2::Time::new(0, 0)).unwrap()
    }

    fn path_str(dir: &TempDir) -> String {
        dir.path().to_str().unwrap().to_string()
    }

    fn state_map_for(dir: &TempDir) -> OpenRepos {
        OpenRepos::from_iter([(path_str(dir), dir.path().to_path_buf())])
    }

    /// Commit `file`=`content` onto `parents`, carrying the first parent's tree
    /// forward so existing files persist (faithful linear history). Returns OID.
    fn commit_file(
        repo: &Repository,
        message: &str,
        parents: &[git2::Oid],
        file: &str,
        content: &[u8],
    ) -> git2::Oid {
        let blob_oid = repo.blob(content).unwrap();
        let base_tree = parents
            .first()
            .map(|oid| repo.find_commit(*oid).unwrap().tree().unwrap());
        let mut builder = repo.treebuilder(base_tree.as_ref()).unwrap();
        builder
            .insert(file, blob_oid, git2::FileMode::Blob.into())
            .unwrap();
        let tree = repo.find_tree(builder.write().unwrap()).unwrap();
        let parent_commits: Vec<_> = parents
            .iter()
            .map(|oid| repo.find_commit(*oid).unwrap())
            .collect();
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
        let s = sig();
        repo.commit(Some("HEAD"), &s, &s, message, &tree, &parent_refs)
            .unwrap()
    }

    fn revert_head_path(dir: &TempDir) -> PathBuf {
        dir.path().join(".git").join("REVERT_HEAD")
    }

    fn head_body(repo: &Repository) -> String {
        repo.head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .message()
            .unwrap()
            .to_string()
    }

    /// A two-commit linear repo: base then a "v2" change to `f.txt`. Worktree
    /// synced to HEAD so subprocess `git revert` sees a clean tree.
    fn two_commit_repo() -> (TempDir, Repository, git2::Oid) {
        let (dir, repo) = make_repo();
        let base = commit_file(&repo, "Important change to x", &[], "f.txt", b"base\n");
        let v2 = commit_file(&repo, "change to v2", &[base], "f.txt", b"v2\n");
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        (dir, repo, v2)
    }

    /// A repo where reverting the tip commit conflicts: the tip changes `f.txt`,
    /// then a later commit changes `f.txt` again, so reverting the middle commit
    /// can't apply cleanly. HEAD's tip is returned as the OID to revert.
    fn conflicting_revert_repo() -> (TempDir, Repository, git2::Oid) {
        let (dir, repo) = make_repo();
        let base = commit_file(&repo, "base", &[], "f.txt", b"base\n");
        let mid = commit_file(&repo, "mid change to v2", &[base], "f.txt", b"v2\n");
        // A later commit rewrites the same file so reverting `mid` conflicts.
        commit_file(&repo, "later change to v3", &[mid], "f.txt", b"v3\n");
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        (dir, repo, mid)
    }

    #[test]
    fn revert_commit_begin_returns_default_message_with_full_oid() {
        let (dir, _repo, oid) = two_commit_repo();
        let oid_str = oid.to_string();
        let map = state_map_for(&dir);
        let (_source, message) =
            revert_commit_begin_inner(&path_str(&dir), &oid_str, &map).unwrap();
        let message = message.expect("clean revert must carry a message");
        assert!(
            message.starts_with("Revert \"change to v2\""),
            "got: {message:?}"
        );
        assert!(
            message.contains(&format!("This reverts commit {oid_str}.")),
            "message must carry the FULL 40-char OID, not a short OID; got: {message:?}"
        );
        assert_eq!(
            oid_str.len(),
            40,
            "OID under test must be the full 40-char form"
        );
        assert!(
            revert_head_path(&dir).exists(),
            "begin sets REVERT_HEAD (not committed yet)"
        );
    }

    #[test]
    fn revert_continue_clears_revert_head_and_commits_edited_body() {
        let (dir, repo, oid) = two_commit_repo();
        let oid_str = oid.to_string();
        let map = state_map_for(&dir);
        revert_commit_begin_inner(&path_str(&dir), &oid_str, &map).unwrap();

        let edited = "Revert \"change to v2\"\n\nedited body";
        revert_continue_inner(&path_str(&dir), edited, &map).unwrap();

        assert!(
            !revert_head_path(&dir).exists(),
            "git commit -m clears REVERT_HEAD"
        );
        let body = head_body(&repo);
        // git appends a trailing newline; the body is otherwise the edited text.
        assert_eq!(
            body.trim_end(),
            edited,
            "HEAD body must equal the edited message"
        );
        assert!(
            !body.lines().any(|l| l.starts_with('#')),
            "no commit body line may start with #; got: {body:?}"
        );
    }

    #[test]
    fn revert_commit_begin_conflict_returns_conflict_state_err() {
        let (dir, _repo, oid) = conflicting_revert_repo();
        let oid_str = oid.to_string();
        let map = state_map_for(&dir);
        let err = revert_commit_begin_inner(&path_str(&dir), &oid_str, &map)
            .expect_err("conflicted revert must return Err, never open the editor");
        assert_eq!(err.code, "conflict_state");
    }

    #[test]
    fn revert_abort_recovers_clean_tree() {
        let (dir, repo, oid) = two_commit_repo();
        let oid_str = oid.to_string();
        let map = state_map_for(&dir);
        revert_commit_begin_inner(&path_str(&dir), &oid_str, &map).unwrap();
        assert!(
            revert_head_path(&dir).exists(),
            "precondition: begin set REVERT_HEAD"
        );

        revert_abort_inner(&path_str(&dir), &map).unwrap();

        assert!(
            !revert_head_path(&dir).exists(),
            "revert --abort clears REVERT_HEAD"
        );
        assert!(
            !trunk_git::repository::is_repo_dirty(&repo).unwrap(),
            "revert --abort must leave a clean tree"
        );
    }

    #[test]
    fn revert_continue_strips_conflict_comment_block_from_commit_body() {
        let (dir, repo, oid) = conflicting_revert_repo();
        let oid_str = oid.to_string();
        let map = state_map_for(&dir);
        // Conflicted begin leaves REVERT_HEAD set; resolve by staging a fix.
        let _ = revert_commit_begin_inner(&path_str(&dir), &oid_str, &map);
        let blob = repo.blob(b"resolved\n").unwrap();
        let mut index = repo.index().unwrap();
        index
            .add(&git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: 0o100_644,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: blob,
                flags: 0,
                flags_extended: 0,
                path: b"f.txt".to_vec(),
            })
            .unwrap();
        index.write().unwrap();

        // Finish with a message that carries a trailing `# Conflicts:` block.
        let msg = "Revert \"mid change to v2\"\n\n# Conflicts:\n#\tf.txt";
        revert_continue_inner(&path_str(&dir), msg, &map).unwrap();

        let body = head_body(&repo);
        assert!(
            !body.lines().any(|l| l.starts_with('#')),
            "--cleanup=strip must remove the # Conflicts: block; got: {body:?}"
        );
    }

    /// `base` with a child the soft reset an undo makes has just taken back.
    fn undone_child_repo() -> (TempDir, Repository, git2::Oid, git2::Oid) {
        let (dir, repo) = make_repo();
        let base = commit_file(&repo, "base", &[], "f.txt", b"base\n");
        let undone = commit_file(&repo, "undone", &[base], "f.txt", b"undone\n");
        let base_commit = repo.find_object(base, None).unwrap();
        repo.reset(&base_commit, git2::ResetType::Soft, None)
            .unwrap();
        drop(base_commit);
        (dir, repo, base, undone)
    }

    /// Redo `undone` in `dir` as if the undo left HEAD at `expected_head`.
    fn redo(
        dir: &TempDir,
        undone: &str,
        expected_head: &str,
        map: &OpenRepos,
    ) -> Result<(), TrunkError> {
        let path = path_str(dir);
        redo_commit_inner(
            &path,
            &RedoRequest {
                undone_oid: undone,
                expected_head_oid: expected_head,
                expected_path: &path,
            },
            map,
        )
    }

    /// A commit on `parents` that the branch never pointed at.
    fn loose_commit(repo: &Repository, message: &str, parents: &[git2::Oid]) -> git2::Oid {
        let tree = repo.find_commit(parents[0]).unwrap().tree().unwrap();
        let parents: Vec<_> = parents
            .iter()
            .map(|oid| repo.find_commit(*oid).unwrap())
            .collect();
        let parents: Vec<_> = parents.iter().collect();
        let s = sig();
        repo.commit(None, &s, &s, message, &tree, &parents).unwrap()
    }

    #[test]
    fn redo_restores_the_undone_commit_when_head_is_still_at_the_position_it_names() {
        let (dir, repo, base, undone) = undone_child_repo();
        let map = state_map_for(&dir);

        redo(&dir, &undone.to_string(), &base.to_string(), &map)
            .expect("HEAD is at `base`, so redo must succeed");

        assert_eq!(repo.head().unwrap().target(), Some(undone));
    }

    #[test]
    fn redo_keeps_what_was_staged_and_written_since_the_undo() {
        let (dir, repo, base, undone) = undone_child_repo();
        std::fs::write(dir.path().join("later.txt"), b"staged\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("later.txt")).unwrap();
        index.write().unwrap();
        std::fs::write(dir.path().join("f.txt"), b"edited\n").unwrap();
        let map = state_map_for(&dir);

        redo(&dir, &undone.to_string(), &base.to_string(), &map).unwrap();

        let index = repo.index().unwrap();
        assert!(index.get_path(Path::new("later.txt"), 0).is_some());
        assert_eq!(
            std::fs::read(dir.path().join("f.txt")).unwrap(),
            b"edited\n"
        );
    }

    /// The git binary does the reset so the user's own git finds what a reset of
    /// theirs would leave: `ORIG_HEAD` naming where the branch was.
    #[test]
    fn redo_leaves_orig_head_where_the_branch_was() {
        let (dir, _repo, base, undone) = undone_child_repo();
        let map = state_map_for(&dir);

        redo(&dir, &undone.to_string(), &base.to_string(), &map).unwrap();

        let orig_head = std::fs::read_to_string(dir.path().join(".git/ORIG_HEAD")).unwrap();
        assert_eq!(orig_head.trim(), base.to_string());
    }

    #[test]
    fn redo_refuses_when_head_has_moved_off_the_position_it_names() {
        let (dir, repo, base, undone) = undone_child_repo();
        let elsewhere = loose_commit(&repo, "elsewhere", &[base]);
        let map = state_map_for(&dir);

        let err = redo(&dir, &undone.to_string(), &elsewhere.to_string(), &map)
            .expect_err("HEAD is not where the undo left it");

        assert_eq!(err.code, "redo_stale");
        assert_eq!(repo.head().unwrap().target(), Some(base));
    }

    /// The backend cannot know what this app undid, but it can refuse to move the
    /// branch anywhere an undo from here could not have come from.
    #[test]
    fn redo_refuses_a_commit_whose_parent_is_not_head() {
        let (dir, repo, base, undone) = undone_child_repo();
        let grandchild = loose_commit(&repo, "grandchild", &[undone]);
        let map = state_map_for(&dir);

        let err = redo(&dir, &grandchild.to_string(), &base.to_string(), &map)
            .expect_err("the grandchild's parent is not HEAD");

        assert_eq!(err.code, "redo_stale");
        assert_eq!(repo.head().unwrap().target(), Some(base));
    }

    #[test]
    fn redo_refuses_a_merge_whose_first_parent_is_head() {
        let (dir, repo, base, undone) = undone_child_repo();
        let merge = loose_commit(&repo, "merge", &[base, undone]);
        let map = state_map_for(&dir);

        let err = redo(&dir, &merge.to_string(), &base.to_string(), &map)
            .expect_err("undo never takes back a merge");

        assert_eq!(err.code, "redo_stale");
        assert_eq!(repo.head().unwrap().target(), Some(base));
    }

    #[test]
    fn redo_reports_a_commit_the_repository_no_longer_has() {
        let (dir, repo, base, _undone) = undone_child_repo();
        let map = state_map_for(&dir);

        let gone = "0123456789abcdef0123456789abcdef01234567";
        let err = redo(&dir, gone, &base.to_string(), &map).expect_err("no such commit");

        assert_eq!(err.code, "redo_missing");
        assert_eq!(repo.head().unwrap().target(), Some(base));
    }

    #[test]
    fn redo_reports_an_oid_that_names_no_commit() {
        let (dir, repo, base, _undone) = undone_child_repo();
        let blob = repo.blob(b"not a commit\n").unwrap();
        let map = state_map_for(&dir);

        let err = redo(&dir, &blob.to_string(), &base.to_string(), &map)
            .expect_err("a blob is not a commit");

        assert_eq!(err.code, "redo_missing");
        assert_eq!(repo.head().unwrap().target(), Some(base));
    }

    #[test]
    fn redo_refuses_a_genuine_redo_in_a_different_repository() {
        // Two clones of the same history share every oid, so the undone commit is
        // a child of HEAD in both, and only the repository check tells them apart.
        let (dir_a, _repo_a, base_a, undone_a) = undone_child_repo();
        let (dir_b, repo_b, base_b, undone_b) = undone_child_repo();
        assert_eq!((base_a, undone_a), (base_b, undone_b));
        let mut map = state_map_for(&dir_a);
        map.register(
            path_str(&dir_b),
            crate::state::OpenRepo::new(dir_b.path().to_path_buf()),
        );

        let err = redo_commit_inner(
            &path_str(&dir_b),
            &RedoRequest {
                undone_oid: &undone_a.to_string(),
                expected_head_oid: &base_a.to_string(),
                expected_path: &path_str(&dir_a),
            },
            &map,
        )
        .expect_err("the redo belongs to dir_a, not dir_b");

        assert_eq!(err.code, "redo_stale");
        assert_eq!(repo_b.head().unwrap().target(), Some(base_b));
    }
}

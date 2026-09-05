use crate::error::TrunkError;
use crate::git::{
    graph,
    types::{BranchInfo, RefLabel, RefType, RefsResponse, StashEntry},
};
use crate::shell_env;
use crate::state::{CommitCache, GraphCache, OpenRepos, RepoState};
use git2::BranchType;
use tauri::{AppHandle, Emitter, Runtime, State};

/// Inner implementation of `list_refs` — separated for testability without Tauri state.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when the
/// repository will not open or its refs will not enumerate.
pub fn list_refs_inner(path: &str, state_map: &OpenRepos) -> Result<RefsResponse, TrunkError> {
    let mut repo = state_map.open(path)?;

    // Resolve HEAD name before any mutable borrows
    let head_name: Option<String> = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(str::to_owned));

    let local: Vec<BranchInfo> = repo
        .branches(Some(BranchType::Local))?
        .filter_map(std::result::Result::ok)
        .map(|(branch, _)| {
            let name = branch.name().ok().flatten().unwrap_or("").to_owned();
            let is_head = head_name.as_deref() == Some(name.as_str());
            let upstream = branch
                .upstream()
                .ok()
                .and_then(|u| u.name().ok().flatten().map(str::to_owned));
            let last_commit_timestamp = branch
                .get()
                .peel_to_commit()
                .map_or(0, |c| c.author().when().seconds());
            let (ahead, behind) = match (&upstream, branch.get().target()) {
                (Some(_), Some(local_oid)) => branch
                    .upstream()
                    .ok()
                    .and_then(|ub| ub.get().target())
                    .map_or((0, 0), |remote_oid| {
                        repo.graph_ahead_behind(local_oid, remote_oid)
                            .unwrap_or((0, 0))
                    }),
                _ => (0, 0),
            };
            BranchInfo {
                name,
                is_head,
                upstream,
                ahead,
                behind,
                last_commit_timestamp,
            }
        })
        .collect();

    // Remote branches — filter out entries where name ends with "/HEAD"
    let remote: Vec<BranchInfo> = repo
        .branches(Some(BranchType::Remote))?
        .filter_map(std::result::Result::ok)
        .filter_map(|(branch, _)| {
            let name = branch.name().ok().flatten()?.to_owned();
            if name.ends_with("/HEAD") {
                return None;
            }
            Some(BranchInfo {
                name,
                is_head: false,
                upstream: None,
                ahead: 0,
                behind: 0,
                last_commit_timestamp: 0,
            })
        })
        .collect();

    // Tags
    let mut tags: Vec<RefLabel> = Vec::new();
    repo.tag_foreach(|_oid, name_bytes| {
        let name = std::str::from_utf8(name_bytes).unwrap_or("").to_owned();
        let short_name = name.strip_prefix("refs/tags/").unwrap_or(&name).to_owned();
        tags.push(RefLabel {
            name,
            short_name,
            ref_type: RefType::Tag,
            is_head: false,
            color_index: 0,
        });
        true
    })?;

    // Stashes — requires &mut repo
    // Collect raw OIDs first (foreach holds mutable borrow), then resolve parents in second pass
    let mut raw_stashes: Vec<(usize, String, git2::Oid)> = Vec::new();
    repo.stash_foreach(|idx, name, oid| {
        raw_stashes.push((idx, name.to_owned(), *oid));
        true
    })?;
    let stashes: Vec<StashEntry> = raw_stashes
        .into_iter()
        .map(|(idx, name, stash_oid)| {
            let parent_oid = repo
                .find_commit(stash_oid)
                .ok()
                .and_then(|c| c.parent_id(0).ok())
                .map(|o| o.to_string());
            StashEntry {
                index: idx,
                short_name: format!("stash@{{{idx}}}"),
                name,
                oid: stash_oid.to_string(),
                parent_oid,
            }
        })
        .collect();

    Ok(RefsResponse {
        local,
        remote,
        tags,
        stashes,
    })
}

/// Delete a local branch. Rejects deletion of the currently checked-out (HEAD) branch.
/// Delete a local branch and rebuild the graph cache.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `cannot_delete_head` when
/// `branch_name` is the checked-out branch, and the git error when the branch
/// is missing or will not delete.
pub fn delete_branch_inner(
    path: &str,
    branch_name: &str,
    state_map: &OpenRepos,
    cache_map: &mut GraphCache,
    visibility: &crate::git::graph_input::RefVisibility,
) -> Result<(), TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let repo = git2::Repository::open(path_buf)?;

    // Check if this is the HEAD branch
    let head_name = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(str::to_owned));
    if head_name.as_deref() == Some(branch_name) {
        return Err(TrunkError::new(
            "cannot_delete_head",
            "Cannot delete the currently checked-out branch",
        ));
    }

    let mut branch = repo.find_branch(branch_name, BranchType::Local)?;
    branch.delete()?;
    drop(branch);
    drop(repo);

    // Rebuild graph cache
    let mut repo2 = git2::Repository::open(path_buf)?;
    let graph_result = graph::snapshot(&mut repo2, visibility)?;
    cache_map.insert(path.to_owned(), graph_result);

    Ok(())
}

/// Rename a local branch. Fails if `new_name` already exists.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when the
/// branch is missing or `new_name` is already taken.
pub fn rename_branch_inner(
    path: &str,
    old_name: &str,
    new_name: &str,
    state_map: &OpenRepos,
    cache_map: &mut GraphCache,
    visibility: &crate::git::graph_input::RefVisibility,
) -> Result<(), TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let repo = git2::Repository::open(path_buf)?;
    let mut branch = repo.find_branch(old_name, BranchType::Local)?;
    branch.rename(new_name, false)?; // false = no force (fail if new_name exists)
    drop(branch);
    drop(repo);

    // Rebuild graph cache
    let mut repo2 = git2::Repository::open(path_buf)?;
    let graph_result = graph::snapshot(&mut repo2, visibility)?;
    cache_map.insert(path.to_owned(), graph_result);

    Ok(())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn list_refs(path: String, state: State<'_, RepoState>) -> Result<RefsResponse, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || list_refs_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// Inner implementation of `resolve_ref` — separated for testability.
/// The commit oid `ref_name` resolves to.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when
/// `ref_name` does not resolve or does not peel to a commit.
pub fn resolve_ref_inner(
    path: &str,
    ref_name: &str,
    state_map: &OpenRepos,
) -> Result<String, TrunkError> {
    let repo = state_map.open(path)?;
    let obj = repo.revparse_single(ref_name).map_err(TrunkError::from)?;
    let commit = obj.peel_to_commit().map_err(TrunkError::from)?;
    Ok(commit.id().to_string())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn resolve_ref(
    path: String,
    ref_name: String,
    state: State<'_, RepoState>,
) -> Result<String, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || resolve_ref_inner(&path, &ref_name, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// Run a graph-rebuilding branch operation off the UI thread and merge only the
/// entries it produced into the shared cache. The map is keyed by repository, so
/// writing a whole snapshot back would revert every graph another repository
/// refreshed while this operation was running.
async fn rebuild_graph_cache<F>(cache: &CommitCache, op: F) -> Result<(), TrunkError>
where
    F: FnOnce(&mut GraphCache) -> Result<(), TrunkError> + Send + 'static,
{
    let rebuilt = tauri::async_runtime::spawn_blocking(move || {
        let mut rebuilt = GraphCache::default();
        op(&mut rebuilt).map(|()| rebuilt)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;

    cache.0.lock().unwrap().absorb(rebuilt);
    Ok(())
}

/// A safe checkout refuses with `Conflict` only when uncommitted work would be
/// overwritten, which is the `dirty_workdir` outcome the branch commands already
/// raise by hand when they pre-check the working tree.
fn classify_checkout_error(e: git2::Error) -> TrunkError {
    if e.code() == git2::ErrorCode::Conflict {
        return TrunkError::new(
            "dirty_workdir",
            "Working tree has uncommitted changes that this checkout would overwrite",
        );
    }

    e.into()
}

/// Inner implementation of `checkout_branch` — separated for testability.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `dirty_workdir` when the
/// checkout would overwrite uncommitted changes, and the git error when the
/// branch is missing or HEAD will not move.
pub fn checkout_branch_inner(
    path: &str,
    branch_name: &str,
    state_map: &OpenRepos,
    cache_map: &mut GraphCache,
    visibility: &crate::git::graph_input::RefVisibility,
) -> Result<(), TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let repo = git2::Repository::open(path_buf)?;

    let branch_ref = format!("refs/heads/{branch_name}");
    {
        let (object, _reference) = repo.revparse_ext(&branch_ref)?;
        repo.checkout_tree(
            &object,
            Some(&mut git2::build::CheckoutBuilder::new().safe()),
        )
        .map_err(classify_checkout_error)?;
    }
    repo.set_head(&branch_ref)?;
    drop(repo);

    // Rebuild graph cache after checkout
    let mut repo2 = git2::Repository::open(path_buf)?;
    let graph_result = graph::snapshot(&mut repo2, visibility)?;
    cache_map.insert(path.to_owned(), graph_result);

    Ok(())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn checkout_branch<R: Runtime>(
    path: String,
    branch_name: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();

    rebuild_graph_cache(&cache, move |rebuilt| {
        checkout_branch_inner(&path_clone, &branch_name, &state_map, rebuilt, &visibility)
    })
    .await
    .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", path);

    Ok(())
}

/// Fast-forward the checked-out branch to `target_oid`, refusing anything that
/// is not a fast-forward.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `merge_error` when `git` will not
/// run, and `not_fast_forward` carrying git's own message when the merge is
/// not a fast-forward.
pub fn fast_forward_to_inner(
    path: &str,
    target_oid: &str,
    state_map: &OpenRepos,
    cache_map: &mut GraphCache,
    visibility: &crate::git::graph_input::RefVisibility,
) -> Result<(), TrunkError> {
    let path_buf = state_map.path_for(path)?;

    let output = std::process::Command::new("git")
        .args(["merge", "--ff-only", "--", target_oid])
        .current_dir(path_buf)
        .env("PATH", shell_env::system_path())
        .output()
        .map_err(|e| TrunkError::new("merge_error", e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(TrunkError::new("not_fast_forward", stderr));
    }

    // Rebuild graph cache
    let mut repo = git2::Repository::open(path_buf)?;
    let graph_result = graph::snapshot(&mut repo, visibility)?;
    cache_map.insert(path.to_owned(), graph_result);

    Ok(())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn fast_forward_to<R: Runtime>(
    path: String,
    target_oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();

    rebuild_graph_cache(&cache, move |rebuilt| {
        fast_forward_to_inner(&path_clone, &target_oid, &state_map, rebuilt, &visibility)
    })
    .await
    .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", path);

    Ok(())
}

/// Inner implementation of `create_branch` — separated for testability.
///
/// When `from_oid` is Some, branches from that OID; when None, branches from HEAD.
/// Creates the branch first (always safe), then checks out. If dirty workdir at checkout time,
/// returns `dirty_workdir` error (branch exists but HEAD didn't move).
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `dirty_workdir` when the branch
/// was created but the working tree blocked the checkout, `git_error` when
/// HEAD is unborn, and the git error when the name is taken or `from_oid` does
/// not resolve.
pub fn create_branch_inner(
    path: &str,
    name: &str,
    from_oid: Option<&str>,
    state_map: &OpenRepos,
    cache_map: &mut GraphCache,
    visibility: &crate::git::graph_input::RefVisibility,
) -> Result<(), TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let repo = git2::Repository::open(path_buf)?;

    let target_oid = match from_oid {
        Some(oid_str) => repo.revparse_single(oid_str)?.id(),
        None => repo
            .head()?
            .target()
            .ok_or_else(|| TrunkError::new("git_error", "HEAD has no target (unborn branch?)"))?,
    };
    let target_commit = repo.find_commit(target_oid)?;
    // false = no force; fails if name already exists
    repo.branch(name, &target_commit, false)?;
    // Drop target_commit (and its borrow on repo) before mutable operations
    drop(target_commit);

    // Check dirty workdir before checkout (branch already created above)
    if crate::git::repository::is_repo_dirty(&repo)? {
        drop(repo);
        // Rebuild cache even though checkout didn't happen — branch was created
        let mut repo2 = git2::Repository::open(path_buf)?;
        let graph_result = graph::snapshot(&mut repo2, visibility)?;
        cache_map.insert(path.to_owned(), graph_result);
        return Err(TrunkError::new(
            "dirty_workdir",
            "Branch created but working tree has uncommitted changes — checkout skipped",
        ));
    }

    // Auto-checkout the new branch (checkout_tree updates index + working tree, then set_head moves HEAD)
    let branch_ref = format!("refs/heads/{name}");
    {
        let (object, _reference) = repo.revparse_ext(&branch_ref)?;
        repo.checkout_tree(
            &object,
            Some(&mut git2::build::CheckoutBuilder::new().safe()),
        )?;
    }
    repo.set_head(&branch_ref)?;
    drop(repo);

    // Rebuild graph cache after branch creation
    let mut repo2 = git2::Repository::open(path_buf)?;
    let graph_result = graph::snapshot(&mut repo2, visibility)?;
    cache_map.insert(path.to_owned(), graph_result);

    Ok(())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn create_branch<R: Runtime>(
    path: String,
    name: String,
    from_oid: Option<String>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();

    rebuild_graph_cache(&cache, move |rebuilt| {
        create_branch_inner(
            &path_clone,
            &name,
            from_oid.as_deref(),
            &state_map,
            rebuilt,
            &visibility,
        )
    })
    .await
    .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", path);

    Ok(())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn delete_branch<R: Runtime>(
    path: String,
    branch_name: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();

    rebuild_graph_cache(&cache, move |rebuilt| {
        delete_branch_inner(&path_clone, &branch_name, &state_map, rebuilt, &visibility)
    })
    .await
    .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", path);
    Ok(())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn rename_branch<R: Runtime>(
    path: String,
    old_name: String,
    new_name: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();

    rebuild_graph_cache(&cache, move |rebuilt| {
        rename_branch_inner(
            &path_clone,
            &old_name,
            &new_name,
            &state_map,
            rebuilt,
            &visibility,
        )
    })
    .await
    .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::graph_input::GraphSnapshot;
    use std::sync::{Arc, Mutex};

    /// An empty graph tagged by the ref it hides, so the assertions can tell which
    /// snapshot each entry holds.
    fn graph(tag: usize) -> GraphSnapshot {
        let mut visibility = crate::git::graph_input::RefVisibility::default();
        visibility.hidden_refs.insert(format!("refs/tags/{tag}"));

        GraphSnapshot::new(crate::git::graph_input::GraphSource::default(), visibility)
    }

    #[test]
    fn another_repos_graph_refreshed_mid_operation_is_not_rolled_back() {
        let cache = Arc::new(CommitCache(Mutex::new(GraphCache::default())));
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo/b".to_owned(), graph(1));
        let concurrent = Arc::clone(&cache);

        tauri::async_runtime::block_on(rebuild_graph_cache(&cache, move |rebuilt| {
            concurrent
                .0
                .lock()
                .unwrap()
                .insert("/repo/b".to_owned(), graph(9));
            rebuilt.insert("/repo/a".to_owned(), graph(1));
            Ok(())
        }))
        .unwrap();

        let cached = cache.0.lock().unwrap();
        assert_eq!(
            cached.get("/repo/a").unwrap().visibility(),
            graph(1).visibility()
        );
        assert_eq!(
            cached.get("/repo/b").unwrap().visibility(),
            graph(9).visibility(),
            "/repo/b was reverted to the pre-operation snapshot"
        );
    }

    #[test]
    fn a_failed_operation_leaves_the_cache_untouched() {
        let cache = CommitCache(Mutex::new(GraphCache::default()));
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo/b".to_owned(), graph(7));

        let err = tauri::async_runtime::block_on(rebuild_graph_cache(&cache, |rebuilt| {
            rebuilt.insert("/repo/a".to_owned(), graph(1));
            Err(TrunkError::new("boom", "no"))
        }))
        .unwrap_err();

        assert_eq!(err.code, "boom");
        let cached = cache.0.lock().unwrap();
        assert!(!cached.holds("/repo/a"));
        assert_eq!(
            cached.get("/repo/b").unwrap().visibility(),
            graph(7).visibility()
        );
    }
}

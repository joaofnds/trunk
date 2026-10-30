use crate::shell_env;
use crate::state::{CommitCache, GraphCache, OpenRepos, RepoState};
use crate::types::{BranchInfo, RefsResponse, StashEntry};
use crate::watcher::RepoChanged;
use git2::BranchType;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use trunk_git::error::TrunkError;
use trunk_git::types::{RefLabel, RefType};
use trunk_git::worktree::{BranchHold, WorktreeRemoval};

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
                remote: None,
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
            let remote = branch
                .get()
                .name()
                .ok()
                .and_then(|refname| repo.branch_remote_name(refname).ok())
                .and_then(|buf| buf.as_str().ok().map(str::to_owned));
            Some(BranchInfo {
                name,
                is_head: false,
                upstream: None,
                ahead: 0,
                behind: 0,
                last_commit_timestamp: 0,
                remote,
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

/// Delete a local branch and rebuild the graph cache, first removing the linked
/// worktree that holds it when `worktree` names the one the user agreed to remove.
///
/// Rejects deletion of the currently checked-out (HEAD) branch.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `cannot_delete_head` when
/// `branch_name` is the checked-out branch, the git error when the branch is missing or
/// will not delete, every error `trunk_git::worktree::remove` names, `worktree_changed`
/// when no removal was accepted and a linked worktree now holds the branch, and
/// `branch_not_deleted` when the worktree went but the branch would not.
pub fn delete_branch_inner(
    path: &str,
    branch_name: &str,
    worktree: Option<&WorktreeRemoval>,
    state_map: &OpenRepos,
    cache_map: &mut GraphCache,
    visibility: &trunk_git::graph_input::RefVisibility,
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
    if let Some(worktree) = worktree {
        trunk_git::worktree::remove(&repo, branch_name, worktree, &open_tabs(state_map))?;
        branch.delete().map_err(|error| {
            TrunkError::new(
                "branch_not_deleted",
                format!(
                    "the worktree at {} was removed but the branch could not be deleted: {}",
                    worktree.path,
                    error.message()
                ),
            )
        })?;
    } else {
        trunk_git::worktree::ensure_no_linked_holder(&repo, branch_name, &open_tabs(state_map))?;
        branch.delete()?;
    }
    drop(branch);
    drop(repo);

    // Rebuild graph cache
    let mut repo2 = git2::Repository::open(path_buf)?;
    let read = crate::state::read_graph(&mut repo2)?;
    cache_map.insert_read(path.to_owned(), read, visibility.clone());

    Ok(())
}

/// Which worktree holds local branch `branch_name`, so Delete can offer to remove it.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when the
/// repository will not open or its worktrees will not list.
pub fn branch_hold_inner(
    path: &str,
    branch_name: &str,
    state_map: &OpenRepos,
) -> Result<BranchHold, TrunkError> {
    let repo = state_map.open(path)?;
    trunk_git::worktree::assess(&repo, branch_name, &open_tabs(state_map))
}

fn open_tabs(state_map: &OpenRepos) -> Vec<std::path::PathBuf> {
    state_map
        .locations()
        .filter_map(|(_, location)| location.canonicalize().ok())
        .collect()
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
    visibility: &trunk_git::graph_input::RefVisibility,
) -> Result<(), TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let repo = git2::Repository::open(path_buf)?;
    let mut branch = repo.find_branch(old_name, BranchType::Local)?;
    branch.rename(new_name, false)?; // false = no force (fail if new_name exists)
    drop(branch);
    drop(repo);

    // Rebuild graph cache
    let mut repo2 = git2::Repository::open(path_buf)?;
    let read = crate::state::read_graph(&mut repo2)?;
    cache_map.insert_read(path.to_owned(), read, visibility.clone());

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
pub async fn list_refs(path: String, state: State<'_, RepoState>) -> Result<RefsResponse, String> {
    let state_map = state.snapshot();
    tauri::async_runtime::spawn_blocking(move || list_refs_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// The commit oid `ref_name` resolves to.
///
/// Separated from the command wrapper so a test can call it directly.
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
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn resolve_ref(
    path: String,
    ref_name: String,
    state: State<'_, RepoState>,
) -> Result<String, String> {
    let state_map = state.snapshot();
    tauri::async_runtime::spawn_blocking(move || resolve_ref_inner(&path, &ref_name, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
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

/// Write `target`'s tree over the index and working tree, keeping every uncommitted
/// change it does not touch. git2 writes nothing when it refuses on a conflict.
fn checkout_safely(repo: &git2::Repository, target: &git2::Object<'_>) -> Result<(), TrunkError> {
    repo.checkout_tree(target, Some(git2::build::CheckoutBuilder::new().safe()))
        .map_err(classify_checkout_error)
}

fn check_out_local(repo: &git2::Repository, branch_ref: &str) -> Result<(), TrunkError> {
    let (object, _reference) = repo.revparse_ext(branch_ref)?;
    checkout_safely(repo, &object)?;
    repo.set_head(branch_ref)?;

    Ok(())
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
    visibility: &trunk_git::graph_input::RefVisibility,
) -> Result<(), TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let repo = git2::Repository::open(path_buf)?;

    check_out_local(&repo, &format!("refs/heads/{branch_name}"))?;
    drop(repo);

    // Rebuild graph cache after checkout
    let mut repo2 = git2::Repository::open(path_buf)?;
    let read = crate::state::read_graph(&mut repo2)?;
    cache_map.insert_read(path.to_owned(), read, visibility.clone());

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
pub async fn checkout_branch<R: Runtime>(
    path: String,
    branch_name: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let path_clone = path.clone();
    let rebuild = crate::state::GraphRebuild::new(&cache, &ref_visibility);

    rebuild
        .rebuild_merging(path.clone(), move |visibility, rebuilt| {
            checkout_branch_inner(&path_clone, &branch_name, &state_map, rebuilt, visibility)
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::whole_repo(path));

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
    visibility: &trunk_git::graph_input::RefVisibility,
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
    let read = crate::state::read_graph(&mut repo)?;
    cache_map.insert_read(path.to_owned(), read, visibility.clone());

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
pub async fn fast_forward_to<R: Runtime>(
    path: String,
    target_oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let path_clone = path.clone();
    let rebuild = crate::state::GraphRebuild::new(&cache, &ref_visibility);

    rebuild
        .rebuild_merging(path.clone(), move |visibility, rebuilt| {
            fast_forward_to_inner(&path_clone, &target_oid, &state_map, rebuilt, visibility)
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::whole_repo(path));

    Ok(())
}

/// Create local branch `name` at `target` and check it out, carrying every uncommitted
/// change the checkout does not touch. A refusal writes no ref and no file: the name is
/// checked and its ref locked before the checkout, and the ref is written only after it.
fn create_and_check_out(
    repo: &git2::Repository,
    name: &str,
    target: &git2::Commit<'_>,
    start: &str,
) -> Result<(), TrunkError> {
    if !git2::Branch::name_is_valid(name)? {
        return Err(reference_error(
            git2::ErrorCode::InvalidSpec,
            &format!("'{name}' is not a valid branch name"),
        ));
    }
    if let Some(existing) = branch_in_the_path_of(repo, name)? {
        return Err(reference_error(
            git2::ErrorCode::Exists,
            &format!("A branch named '{existing}' already exists, so '{name}' cannot be created"),
        ));
    }

    let refname = format!("refs/heads/{name}");
    let mut transaction = repo.transaction()?;
    transaction.lock_ref(&refname)?;
    if repo.find_reference(&refname).is_ok() {
        return Err(reference_error(
            git2::ErrorCode::Exists,
            &format!("A branch named '{name}' already exists"),
        ));
    }

    checkout_safely(repo, target.as_object())?;

    transaction.set_target(
        &refname,
        target.id(),
        None,
        &format!("branch: Created from {start}"),
    )?;
    transaction.commit()?;
    repo.set_head(&refname)?;

    Ok(())
}

/// The local branch whose ref path holds `name`'s as a directory or a parent file,
/// `feat` for `feat/x` and `x/y` for `x`, which git refuses to have beside it.
fn branch_in_the_path_of(
    repo: &git2::Repository,
    name: &str,
) -> Result<Option<String>, TrunkError> {
    for branch in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = branch?;
        let Some(existing) = branch.name()? else {
            continue;
        };
        if name.starts_with(&format!("{existing}/")) || existing.starts_with(&format!("{name}/")) {
            return Ok(Some(existing.to_owned()));
        }
    }

    Ok(None)
}

/// A refusal raised before libgit2 would have raised it, under the code it uses.
fn reference_error(code: git2::ErrorCode, message: &str) -> TrunkError {
    git2::Error::new(code, git2::ErrorClass::Reference, message).into()
}

/// Inner implementation of `create_branch` — separated for testability.
///
/// When `from_oid` is Some, branches from that OID; when None, branches from HEAD. The
/// new branch is checked out with every uncommitted change it does not conflict with.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `dirty_workdir` when the
/// checkout would overwrite uncommitted changes, `git_error` when HEAD is unborn,
/// `git_invalid_spec` when the name is invalid, `git_exists` when it is taken or a branch
/// is in its path, and the git error when `from_oid` does not resolve. On every error no
/// branch is created and the working tree is as it was.
pub fn create_branch_inner(
    path: &str,
    name: &str,
    from_oid: Option<&str>,
    state_map: &OpenRepos,
    cache_map: &mut GraphCache,
    visibility: &trunk_git::graph_input::RefVisibility,
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
    create_and_check_out(&repo, name, &target_commit, from_oid.unwrap_or("HEAD"))?;
    drop(target_commit);
    drop(repo);

    // Rebuild graph cache after branch creation
    let mut repo2 = git2::Repository::open(path_buf)?;
    let read = crate::state::read_graph(&mut repo2)?;
    cache_map.insert_read(path.to_owned(), read, visibility.clone());

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
pub async fn create_branch<R: Runtime>(
    path: String,
    name: String,
    from_oid: Option<String>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let path_clone = path.clone();
    let rebuild = crate::state::GraphRebuild::new(&cache, &ref_visibility);

    rebuild
        .rebuild_merging(path.clone(), move |visibility, rebuilt| {
            create_branch_inner(
                &path_clone,
                &name,
                from_oid.as_deref(),
                &state_map,
                rebuilt,
                visibility,
            )
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::whole_repo(path));

    Ok(())
}

/// What a remote-tracking ref stands for, read through the fetch refspec that wrote
/// it, as git reads it when it sets an upstream.
struct Tracking {
    /// The remote that fetches into the ref.
    remote: String,
    /// The local branch name: the part of the ref the refspec's `*` matched.
    name: String,
    /// The branch on the remote, which a renaming refspec makes differ from `name`.
    merge: String,
}

impl Tracking {
    fn of(repo: &git2::Repository, remote_ref: &str) -> Result<Self, TrunkError> {
        let remote = repo.branch_remote_name(remote_ref)?.as_str()?.to_owned();
        let found = repo.find_remote(&remote)?;
        let spec = found
            .refspecs()
            .find(|spec| spec.direction() == git2::Direction::Fetch && spec.dst_matches(remote_ref))
            .ok_or_else(|| {
                reference_error(
                    git2::ErrorCode::NotFound,
                    &format!("No fetch refspec of '{remote}' writes '{remote_ref}'"),
                )
            })?;
        let merge = spec.rtransform(remote_ref)?.as_str()?.to_owned();
        let name = spec
            .dst()?
            .split_once('*')
            .and_then(|(prefix, _)| remote_ref.strip_prefix(prefix))
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                reference_error(
                    git2::ErrorCode::InvalidSpec,
                    &format!("'{remote_ref}' names no branch of '{remote}'"),
                )
            })?
            .to_owned();
        Ok(Self {
            remote,
            name,
            merge,
        })
    }
}

/// Inner implementation of `checkout_remote_branch` — separated for testability.
///
/// Checks out remote-tracking ref `remote_ref` as `git switch <branch>` does: an
/// existing local branch of that name is checked out where it is, and otherwise a new
/// one is created at the remote branch, tracking it, with the same carry-over and
/// refusals as `create_branch_inner`.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `git_invalid_spec` when
/// `remote_ref` is not under `refs/remotes/`, `dirty_workdir` when the checkout would
/// overwrite uncommitted changes, the errors `create_branch_inner` names for the local
/// name, and the git error when no remote owns `remote_ref` or its upstream will not save.
pub fn checkout_remote_branch_inner(
    path: &str,
    remote_ref: &str,
    state_map: &OpenRepos,
    cache_map: &mut GraphCache,
    visibility: &trunk_git::graph_input::RefVisibility,
) -> Result<String, TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let repo = git2::Repository::open(path_buf)?;

    if !remote_ref.starts_with("refs/remotes/") {
        return Err(reference_error(
            git2::ErrorCode::InvalidSpec,
            &format!("'{remote_ref}' is not a remote branch"),
        ));
    }
    let tracking = Tracking::of(&repo, remote_ref)?;
    let name = tracking.name;

    let local_ref = format!("refs/heads/{name}");
    if repo.find_reference(&local_ref).is_ok() {
        check_out_local(&repo, &local_ref)?;
    } else {
        let target = repo.find_reference(remote_ref)?.peel_to_commit()?;
        create_and_check_out(&repo, &name, &target, remote_ref)?;
        let mut config = repo.config()?;
        config.set_str(&format!("branch.{name}.remote"), &tracking.remote)?;
        config.set_str(&format!("branch.{name}.merge"), &tracking.merge)?;
    }
    drop(repo);

    let mut repo2 = git2::Repository::open(path_buf)?;
    let read = crate::state::read_graph(&mut repo2)?;
    cache_map.insert_read(path.to_owned(), read, visibility.clone());

    Ok(name)
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
pub async fn checkout_remote_branch<R: Runtime>(
    path: String,
    remote_ref: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<String, String> {
    let state_map = state.snapshot();
    let path_clone = path.clone();
    let rebuild = crate::state::GraphRebuild::new(&cache, &ref_visibility);

    let name = rebuild
        .rebuild_merging(path.clone(), move |visibility, rebuilt| {
            checkout_remote_branch_inner(&path_clone, &remote_ref, &state_map, rebuilt, visibility)
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::whole_repo(path));

    Ok(name)
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
pub async fn branch_hold(
    path: String,
    branch_name: String,
    state: State<'_, RepoState>,
) -> Result<BranchHold, String> {
    let state_map = state.snapshot();
    tauri::async_runtime::spawn_blocking(move || branch_hold_inner(&path, &branch_name, &state_map))
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
pub async fn delete_branch<R: Runtime>(
    path: String,
    branch_name: String,
    worktree: Option<WorktreeRemoval>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let path_clone = path.clone();
    let rebuild = crate::state::GraphRebuild::new(&cache, &ref_visibility);
    let tabs = app.clone();

    rebuild
        .rebuild_merging(path.clone(), move |visibility, rebuilt| {
            // Read the open tabs after the gate, not before it, so a tab opened on the
            // worktree while this delete waited still refuses its removal.
            let state_map = tabs.state::<RepoState>().snapshot();
            delete_branch_inner(
                &path_clone,
                &branch_name,
                worktree.as_ref(),
                &state_map,
                rebuilt,
                visibility,
            )
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::whole_repo(path));
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
pub async fn rename_branch<R: Runtime>(
    path: String,
    old_name: String,
    new_name: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let path_clone = path.clone();
    let rebuild = crate::state::GraphRebuild::new(&cache, &ref_visibility);

    rebuild
        .rebuild_merging(path.clone(), move |visibility, rebuilt| {
            rename_branch_inner(
                &path_clone,
                &old_name,
                &new_name,
                &state_map,
                rebuilt,
                visibility,
            )
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::whole_repo(path));
    Ok(())
}

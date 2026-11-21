use crate::commands::remote_tracking::{Remotes, is_remote_head_alias, spelled_by};
use crate::state::{CommitCache, GraphCache, OpenRepos, RepoState};
use crate::types::{BranchInfo, DeletedBranch, RefsResponse, StashEntry};
use crate::user_git::{UserGit, refusal};
use crate::watcher::RepoChanged;
use git2::BranchType;
use std::collections::HashMap;
use std::sync::Mutex;
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

    let remote = remote_branches(&repo)?;

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

/// Delete a local branch and rebuild the graph cache.
///
/// The linked worktree that holds it goes first when `worktree` names the one the user
/// agreed to remove. The delete goes into `deletions` with the branch's settings, for an
/// undo to put back.
///
/// Rejects deletion of the currently checked-out (HEAD) branch.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `cannot_delete_head` when
/// `branch_name` is the checked-out branch, the git error when the branch is missing
/// or it or its settings will not delete, every error `trunk_git::worktree::remove`
/// names, `worktree_changed` when no removal was accepted and a worktree has the branch
/// checked out or is rebasing or bisecting it, and `branch_not_deleted` when the
/// worktree went but the branch would not.
pub fn delete_branch_inner(
    path: &str,
    branch_name: &str,
    worktree: Option<&WorktreeRemoval>,
    deletions: &Deletions,
    state_map: &OpenRepos,
    cache_map: &mut GraphCache,
    visibility: &trunk_git::graph_input::RefVisibility,
) -> Result<DeletedBranch, TrunkError> {
    let repo = state_map.open(path)?;
    let mut branch = repo.find_branch(branch_name, BranchType::Local)?;
    let deleted = delete_found(
        &repo,
        &mut branch,
        branch_name,
        worktree,
        deletions,
        state_map,
        path,
    )?;
    drop(branch);
    drop(repo);

    let read = state_map.read_graph(path)?;
    cache_map.insert_read(path.to_owned(), read, visibility.clone());
    Ok(deleted)
}

fn delete_found(
    repo: &git2::Repository,
    branch: &mut git2::Branch<'_>,
    branch_name: &str,
    worktree: Option<&WorktreeRemoval>,
    deletions: &Deletions,
    state_map: &OpenRepos,
    path: &str,
) -> Result<DeletedBranch, TrunkError> {
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

    let tip = branch.get().peel_to_commit()?.id();
    let head = head_target(repo)?;
    let settings = if let Some(worktree) = worktree {
        trunk_git::worktree::remove(repo, branch_name, worktree, &open_tabs(state_map))?;
        delete_unused(repo, branch, branch_name, state_map).map_err(|error| {
            TrunkError::new(
                "branch_not_deleted",
                format!(
                    "the worktree at {} was removed but the branch could not be deleted: {}",
                    worktree.path, error.message
                ),
            )
        })?
    } else {
        delete_unused(repo, branch, branch_name, state_map)?
    };
    let deletion = deletions.keep(Deletion {
        path: path.to_owned(),
        name: branch_name.to_owned(),
        tip,
        settings,
    });
    Ok(DeletedBranch {
        deletion,
        name: branch_name.to_owned(),
        tip: tip.to_string(),
        head_oid: head.map(|oid| oid.to_string()),
    })
}

/// Where HEAD points, or None while it names a branch with no commit yet.
fn head_target(repo: &git2::Repository) -> Result<Option<git2::Oid>, TrunkError> {
    match repo.head() {
        Ok(head) => Ok(head.target()),
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// A branch's own settings, `branch.<name>.<variable>` in the repository's config, as
/// (variable, value) in file order. Its upstream lives here.
type Settings = Vec<(String, String)>;

/// The branches deleted in this session, each under the number its delete was given.
///
/// An undo puts one back with its settings. The settings stay here rather than travel
/// to the webview and back, because a branch's settings decide where its pushes go and
/// what its pulls bring in.
#[derive(Default)]
pub struct Deletions(Mutex<DeletionLog>);

#[derive(Default)]
struct DeletionLog {
    issued: u64,
    kept: HashMap<u64, Deletion>,
}

#[derive(Clone)]
struct Deletion {
    path: String,
    name: String,
    tip: git2::Oid,
    settings: Settings,
}

impl Deletions {
    fn keep(&self, deletion: Deletion) -> u64 {
        let mut log = self.lock();
        log.issued += 1;
        let number = log.issued;
        log.kept.insert(number, deletion);
        number
    }

    fn find(&self, path: &str, number: u64) -> Option<Deletion> {
        self.lock()
            .kept
            .get(&number)
            .filter(|deletion| deletion.path == path)
            .cloned()
    }

    fn forget(&self, number: u64) {
        self.lock().kept.remove(&number);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, DeletionLog> {
        self.0.lock().unwrap()
    }
}

// git keeps a branch's settings under `branch.<name>.`, and a branch name may hold
// dots. libgit2's own delete and rename find that section by a pattern that also
// matches every branch named under it, so deleting "feature" would take the upstream
// of "feature.x" with it. libgit2 moves only the ref here, and the settings are
// changed one exact name at a time.

/// Delete `branch` and its settings, handing the settings back, refusing while any
/// worktree has it checked out or is rebasing or bisecting it, as git does.
fn delete_unused(
    repo: &git2::Repository,
    branch: &mut git2::Branch<'_>,
    name: &str,
    state_map: &OpenRepos,
) -> Result<Settings, TrunkError> {
    trunk_git::worktree::ensure_not_held(repo, name, &open_tabs(state_map))?;

    SettingsEdit::apply(repo, |edit| {
        let settings = edit.clear(name)?;
        branch.get_mut().delete()?;
        Ok(settings)
    })
}

/// Rename `branch` from `old_name` to `new_name`, moving its settings with it.
fn rename_local(
    repo: &git2::Repository,
    branch: &mut git2::Branch<'_>,
    old_name: &str,
    new_name: &str,
) -> Result<(), TrunkError> {
    let old_ref = branch.get().name()?.to_owned();
    let new_ref = format!("refs/heads/{new_name}");
    if repo.find_reference(&new_ref).is_ok() {
        return Err(TrunkError::new(
            "branch_exists",
            format!("A branch named '{new_name}' already exists"),
        ));
    }

    let tip = branch.get().peel_to_commit()?.id();
    SettingsEdit::apply(repo, |edit| {
        let settings = edit.clear(old_name)?;
        edit.clear(new_name)?;
        edit.add(new_name, &settings)?;
        match branch.get_mut().rename(
            &new_ref,
            false,
            &format!("branch: renamed {old_ref} to {new_ref}"),
        ) {
            Ok(_) => Ok(()),
            Err(error) => Err(put_back(repo, &old_ref, tip, error.into())),
        }
    })
}

/// libgit2 deletes the old ref before it locks the new one, and leaves it deleted
/// when the new one will not write. Recreate it at `tip`, as git's own rename does.
fn put_back(
    repo: &git2::Repository,
    old_ref: &str,
    tip: git2::Oid,
    error: TrunkError,
) -> TrunkError {
    if repo.find_reference(old_ref).is_ok() {
        return error;
    }
    match repo.reference(
        old_ref,
        tip,
        false,
        "branch: put back after a failed rename",
    ) {
        Ok(_) => error,
        Err(e) => TrunkError::new(
            error.code.clone(),
            format!(
                "{}, and {old_ref} could not be put back at {tip}: {}",
                error.message,
                e.message()
            ),
        ),
    }
}

/// Changes to branches' settings in the repository's own config. libgit2 rewrites the
/// file once for each key, so every change is recorded, and a failure part way takes
/// back the ones made before it.
struct SettingsEdit {
    config: git2::Config,
    made: Vec<Made>,
}

enum Made {
    /// The keys `add` wrote, each once.
    Added(Vec<String>),
    /// The keys `clear` removed, each with its values, in file order.
    Cleared(Vec<(String, Vec<String>)>),
}

impl SettingsEdit {
    /// Run `change`, and take back every settings change it made when it fails.
    fn apply<T>(
        repo: &git2::Repository,
        change: impl FnOnce(&mut Self) -> Result<T, TrunkError>,
    ) -> Result<T, TrunkError> {
        let mut edit = Self {
            config: repo.config()?.open_level(git2::ConfigLevel::Local)?,
            made: Vec::new(),
        };
        change(&mut edit).map_err(|error| edit.take_back(error))
    }

    /// Remove every setting of branch `name`, handing back the ones a later write can
    /// put back. A setting written with no value means true, and one whose value is not
    /// text is removed without being handed back.
    ///
    /// libgit2 matches a value pattern against a setting with no value by reading a
    /// null pointer, so a variable that appears once goes by its exact name, and a
    /// repeated one that has an entry with no value is refused before anything changes.
    fn clear(&mut self, name: &str) -> Result<Settings, TrunkError> {
        let prefix = format!("branch.{name}.");
        let mut variables: Vec<(String, usize, bool)> = Vec::new();
        let mut settings = Settings::new();
        let mut entries = self.config.entries(None)?;
        while let Some(entry) = entries.next() {
            let entry = entry?;
            let Some(variable) = entry
                .name_bytes()
                .strip_prefix(prefix.as_bytes())
                .filter(|rest| !rest.contains(&b'.'))
                .and_then(|rest| std::str::from_utf8(rest).ok())
            else {
                continue;
            };
            match variables.iter_mut().find(|(seen, _, _)| seen == variable) {
                Some((_, count, valueless)) => {
                    *count += 1;
                    *valueless |= !entry.has_value();
                }
                None => variables.push((variable.to_owned(), 1, !entry.has_value())),
            }
            let value = if entry.has_value() {
                std::str::from_utf8(entry.value_bytes()).ok()
            } else {
                Some("true")
            };
            if let Some(value) = value {
                settings.push((variable.to_owned(), value.to_owned()));
            }
        }
        drop(entries);

        if let Some((variable, _, _)) = variables
            .iter()
            .find(|(_, count, valueless)| *count > 1 && *valueless)
        {
            return Err(TrunkError::new(
                "settings_unsupported",
                format!(
                    "{prefix}{variable} is set more than once and once with no value, which Trunk cannot change, so nothing was changed"
                ),
            ));
        }
        let mut cleared = Vec::new();
        let outcome =
            variables
                .into_iter()
                .try_for_each(|(variable, count, _)| -> Result<(), git2::Error> {
                    let key = format!("{prefix}{variable}");
                    if count == 1 {
                        self.config.remove(&key)?;
                    } else {
                        self.config.remove_multivar(&key, ".*")?;
                    }
                    let values = settings
                        .iter()
                        .filter(|(kept, _)| *kept == variable)
                        .map(|(_, value)| value.clone())
                        .collect();
                    cleared.push((key, values));
                    Ok(())
                });
        self.made.push(Made::Cleared(cleared));
        outcome?;
        Ok(settings)
    }

    /// Add each of `settings` under `branch.<name>.`. A pattern that matches only an
    /// empty value adds rather than replaces, so a repeated setting keeps every value.
    fn add(&mut self, name: &str, settings: &Settings) -> Result<(), TrunkError> {
        let mut added: Vec<String> = Vec::new();
        let outcome =
            settings
                .iter()
                .try_for_each(|(variable, value)| -> Result<(), git2::Error> {
                    let key = format!("branch.{name}.{variable}");
                    self.config.set_multivar(&key, "^$", value)?;
                    if !added.contains(&key) {
                        added.push(key);
                    }
                    Ok(())
                });
        self.made.push(Made::Added(added));
        Ok(outcome?)
    }

    /// Take back every change, latest first, and hand back `error`, saying so when a
    /// change would not come back.
    fn take_back(mut self, error: TrunkError) -> TrunkError {
        let mut stuck = None;
        for made in std::mem::take(&mut self.made).into_iter().rev() {
            let undone = match made {
                Made::Added(keys) => keys
                    .iter()
                    .try_for_each(|key| self.config.remove_multivar(key, ".*")),
                Made::Cleared(cleared) => cleared.iter().try_for_each(|(key, values)| {
                    values
                        .iter()
                        .try_for_each(|value| self.config.set_multivar(key, "^$", value))
                }),
            };
            if let Err(e) = undone {
                stuck.get_or_insert(e);
            }
        }
        match stuck {
            None => error,
            Some(e) => TrunkError::new(
                error.code.clone(),
                format!(
                    "{}, and the branch settings it had changed could not all be put back: {}",
                    error.message,
                    e.message()
                ),
            ),
        }
    }
}

/// Put back the branch `deletion` took, at the commit it pointed at and with its
/// settings, then rebuild the graph cache. `seen_head` is where HEAD was when Undo was
/// pressed.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `undo_stale` when HEAD has
/// moved since Undo was pressed, `branch_exists` when a branch made since has taken the
/// name, `restore_missing` when this session made no such delete in `path` or the
/// repository no longer has the commit, and the git error when the branch or its
/// settings will not write.
pub fn restore_branch_inner(
    path: &str,
    deletion: u64,
    seen_head: Option<git2::Oid>,
    deletions: &Deletions,
    state_map: &OpenRepos,
    cache_map: &mut GraphCache,
    visibility: &trunk_git::graph_input::RefVisibility,
) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;
    let Some(deleted) = deletions.find(path, deletion) else {
        return Err(TrunkError::new(
            "restore_missing",
            "There is no deleted branch to put back",
        ));
    };
    let name = deleted.name.as_str();

    // Undo chose between this delete and a commit by where HEAD was, so a commit that
    // landed since is the latest thing and this is no longer what Undo meant.
    if head_target(&repo)? != seen_head {
        return Err(TrunkError::new(
            "undo_stale",
            "HEAD has moved since Undo was pressed, so nothing was undone",
        ));
    }
    if repo.find_branch(name, BranchType::Local).is_ok() {
        return Err(name_taken(name));
    }
    let tip = match repo.find_commit(deleted.tip) {
        Ok(tip) => tip,
        Err(error) if error.code() == git2::ErrorCode::NotFound => {
            return Err(TrunkError::new(
                "restore_missing",
                "The commit the deleted branch pointed at is no longer in the repository",
            ));
        }
        Err(error) => return Err(error.into()),
    };

    SettingsEdit::apply(&repo, |edit| {
        edit.clear(name)?;
        edit.add(name, &deleted.settings)?;
        match repo.branch(name, &tip, false) {
            Err(error)
                if matches!(
                    error.code(),
                    git2::ErrorCode::Exists | git2::ErrorCode::Directory
                ) =>
            {
                Err(name_taken(name))
            }
            other => other.map(drop).map_err(TrunkError::from),
        }
    })?;
    deletions.forget(deletion);
    drop(tip);
    drop(repo);

    let read = state_map.read_graph(path)?;
    cache_map.insert_read(path.to_owned(), read, visibility.clone());
    Ok(())
}

fn name_taken(name: &str) -> TrunkError {
    TrunkError::new(
        "branch_exists",
        format!(
            "A branch made since the delete has taken the name '{name}', so the deleted one was not restored"
        ),
    )
}

/// Delete `branch_name` again after an undo restored it, while it still points at
/// `expected_tip`.
///
/// The delete itself refuses a ref that moved after that check, since
/// libgit2 deletes a ref only while it holds the value it was read with.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `redo_missing` when the branch
/// is gone, `redo_stale` when it has moved, since the redo would take commits the undone
/// delete never held, and every error `delete_branch_inner` names.
pub fn redo_branch_delete_inner(
    path: &str,
    branch_name: &str,
    expected_tip: git2::Oid,
    deletions: &Deletions,
    state_map: &OpenRepos,
    cache_map: &mut GraphCache,
    visibility: &trunk_git::graph_input::RefVisibility,
) -> Result<DeletedBranch, TrunkError> {
    let stale = || {
        TrunkError::new(
            "redo_stale",
            format!("The branch '{branch_name}' has moved since the undo, so it was not deleted"),
        )
    };
    let repo = state_map.open(path)?;
    let mut branch = match repo.find_branch(branch_name, BranchType::Local) {
        Ok(branch) => branch,
        Err(error) if error.code() == git2::ErrorCode::NotFound => {
            return Err(TrunkError::new(
                "redo_missing",
                format!("The branch '{branch_name}' is already gone"),
            ));
        }
        Err(error) => return Err(error.into()),
    };
    if branch.get().peel_to_commit()?.id() != expected_tip {
        return Err(stale());
    }
    let deleted = delete_found(
        &repo,
        &mut branch,
        branch_name,
        None,
        deletions,
        state_map,
        path,
    )
    .map_err(|error| {
        if error.code == "git_modified" {
            stale()
        } else {
            error
        }
    })?;
    drop(branch);
    drop(repo);

    let read = state_map.read_graph(path)?;
    cache_map.insert_read(path.to_owned(), read, visibility.clone());
    Ok(deleted)
}

/// How many commits deleting local branch `branch_name` would leave on no other
/// branch, remote-tracking branch, tag, stash or HEAD.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when the
/// branch is missing or the history will not walk.
pub fn commits_only_on_branch_inner(
    path: &str,
    branch_name: &str,
    state_map: &OpenRepos,
) -> Result<usize, TrunkError> {
    let repo = state_map.open(path)?;
    let branch = repo.find_branch(branch_name, BranchType::Local)?;
    let own_ref = branch.get().name_bytes().to_vec();

    let mut walk = repo.revwalk()?;
    walk.push(branch.get().peel_to_commit()?.id())?;
    for reference in repo.references()? {
        let reference = reference?;
        if reference.name_bytes() == own_ref.as_slice() {
            continue;
        }
        if let Ok(commit) = reference.peel_to_commit() {
            walk.hide(commit.id())?;
        }
    }
    if let Ok(head) = repo.head()
        && let Ok(commit) = head.peel_to_commit()
    {
        walk.hide(commit.id())?;
    }

    walk.try_fold(0, |count, oid| oid.map(|_| count + 1))
        .map_err(TrunkError::from)
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
    let repo = state_map.open(path)?;
    let mut branch = repo.find_branch(old_name, BranchType::Local)?;
    rename_local(&repo, &mut branch, old_name, new_name)?;
    drop(branch);
    drop(repo);

    // Rebuild graph cache
    let read = state_map.read_graph(path)?;
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
pub async fn list_refs(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
) -> Result<RefsResponse, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || list_refs_inner(&path, &state_map))
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
    activity: crate::activity::Activity,
    path: String,
    ref_name: String,
    state: State<'_, RepoState>,
) -> Result<String, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || resolve_ref_inner(&path, &ref_name, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// A safe checkout refuses with `Conflict` only when uncommitted work would be
/// overwritten, which the branch commands report as `dirty_workdir`.
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
/// change it does not touch, then run `point_head`. No other writer in this process
/// runs until HEAD names the tree the index holds. git2 writes nothing when it refuses
/// on a conflict.
pub(crate) fn checkout_safely(
    repo: &git2::Repository,
    target: &git2::Object<'_>,
    point_head: impl FnOnce() -> Result<(), TrunkError>,
) -> Result<(), TrunkError> {
    trunk_git::write_gate::hold(repo, |repo| {
        repo.checkout_tree(target, Some(git2::build::CheckoutBuilder::new().safe()))
            .map_err(classify_checkout_error)?;

        point_head()
    })
}

fn check_out_local(repo: &git2::Repository, branch_name: &str) -> Result<(), TrunkError> {
    // libgit2 writes the branch's files before set_head refuses a branch another
    // worktree holds, which would leave this one showing the difference as edits.
    if let Some(holder) = trunk_git::worktree::held_elsewhere(repo, branch_name)? {
        return Err(TrunkError::new(
            "branch_in_worktree",
            format!(
                "{branch_name} is checked out in the worktree at {}, so this one was left as it was",
                holder.display()
            ),
        ));
    }

    let branch_ref = format!("refs/heads/{branch_name}");
    let (object, _reference) = repo.revparse_ext(&branch_ref)?;
    checkout_safely(repo, &object, || Ok(repo.set_head(&branch_ref)?))
}

/// Inner implementation of `checkout_branch` — separated for testability.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `branch_in_worktree` when
/// another worktree has the branch checked out, `dirty_workdir` when the checkout
/// would overwrite uncommitted changes, and the git error when the branch is missing
/// or HEAD will not move.
pub fn checkout_branch_inner(
    path: &str,
    branch_name: &str,
    state_map: &OpenRepos,
    cache_map: &mut GraphCache,
    visibility: &trunk_git::graph_input::RefVisibility,
) -> Result<(), TrunkError> {
    let path_buf = state_map.path_for(path)?;
    let repo = git2::Repository::open(path_buf)?;

    check_out_local(&repo, branch_name)?;
    drop(repo);

    // Rebuild graph cache after checkout
    let read = state_map.read_graph(path)?;
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
    activity: crate::activity::Activity,
    path: String,
    branch_name: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let path_clone = path.clone();
    let rebuild = crate::state::GraphRebuild::new(activity.clone(), &cache, &ref_visibility);

    rebuild
        .rebuild_merging(path.clone(), move |visibility, rebuilt| {
            checkout_branch_inner(&path_clone, &branch_name, &state_map, rebuilt, visibility)
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));

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

    state_map.hold_for_git(path, |_| {
        let output = UserGit::in_dir(path_buf)
            .args(["merge", "--ff-only", "--", target_oid])
            .output()
            .map_err(|e| TrunkError::new("merge_error", e.to_string()))?;
        if !output.status.success() {
            return Err(TrunkError::new("not_fast_forward", refusal(&output)));
        }

        Ok(())
    })?;

    // Rebuild graph cache
    let read = state_map.read_graph(path)?;
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
    activity: crate::activity::Activity,
    path: String,
    target_oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let path_clone = path.clone();
    let rebuild = crate::state::GraphRebuild::new(activity.clone(), &cache, &ref_visibility);

    rebuild
        .rebuild_merging(path.clone(), move |visibility, rebuilt| {
            fast_forward_to_inner(&path_clone, &target_oid, &state_map, rebuilt, visibility)
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));

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
        return Err(TrunkError::new(
            "invalid_branch_name",
            format!("'{name}' is not a valid branch name"),
        ));
    }
    if let Some(existing) = branch_in_the_path_of(repo, name)? {
        return Err(TrunkError::new(
            "branch_exists",
            format!("A branch named '{existing}' already exists, so '{name}' cannot be created"),
        ));
    }

    let refname = format!("refs/heads/{name}");
    let mut transaction = repo.transaction()?;
    transaction.lock_ref(&refname)?;
    if repo.find_reference(&refname).is_ok() {
        return Err(TrunkError::new(
            "branch_exists",
            format!("A branch named '{name}' already exists"),
        ));
    }

    checkout_safely(repo, target.as_object(), || {
        transaction.set_target(
            &refname,
            target.id(),
            None,
            &format!("branch: Created from {start}"),
        )?;
        transaction.commit()?;
        repo.set_head(&refname)?;

        Ok(())
    })
}

/// The local branch whose ref path holds `name`'s as a directory or a parent file,
/// `feat` for `feat/x` and `x/y` for `x`, which git refuses to have beside it. Where
/// `core.ignorecase` says the filesystem ignores case, `Feat/x` clashes with `feat` too.
fn branch_in_the_path_of(
    repo: &git2::Repository,
    name: &str,
) -> Result<Option<String>, TrunkError> {
    let ignore_case = repo.config()?.get_bool("core.ignorecase").unwrap_or(false);
    let fold = |s: &str| {
        if ignore_case {
            s.to_lowercase()
        } else {
            s.to_owned()
        }
    };
    let name_key = fold(name);
    for branch in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = branch?;
        let Some(existing) = branch.name()? else {
            continue;
        };
        let existing_key = fold(existing);
        if name_key.starts_with(&format!("{existing_key}/"))
            || existing_key.starts_with(&format!("{name_key}/"))
        {
            return Ok(Some(existing.to_owned()));
        }
    }

    Ok(None)
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
/// `invalid_branch_name` when the name is invalid, `branch_exists` when it is taken or a branch
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
    let read = state_map.read_graph(path)?;
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
    activity: crate::activity::Activity,
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
    let rebuild = crate::state::GraphRebuild::new(activity.clone(), &cache, &ref_visibility);

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

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));

    Ok(())
}

/// Every remote-tracking branch but a remote's HEAD, named with its remote.
fn remote_branches(repo: &git2::Repository) -> Result<Vec<BranchInfo>, TrunkError> {
    let remotes = Remotes::read(repo);
    let branches = repo
        .branches(Some(BranchType::Remote))?
        .filter_map(std::result::Result::ok)
        .filter_map(|(branch, _)| {
            let reference = branch.get();
            if reference.symbolic_target_bytes().is_some()
                && (is_remote_head_alias(reference, || &remotes)
                    || reference.peel_to_commit().is_err())
            {
                return None;
            }
            let name = branch.name().ok().flatten()?.to_owned();

            let remote = reference
                .name()
                .ok()
                .and_then(|refname| remotes.name_of(refname));
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

    Ok(branches)
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
        let (spec, spelled) = found
            .refspecs()
            .find_map(|spec| spelled_by(&spec, remote_ref).map(|spelled| (spec, spelled)))
            .ok_or_else(|| {
                TrunkError::new(
                    "no_fetch_refspec",
                    format!("No fetch refspec of '{remote}' writes '{remote_ref}'"),
                )
            })?;
        let merge = spec.rtransform(spelled)?.as_str()?.to_owned();
        let name = spec
            .dst()?
            .split_once('*')
            .and_then(|(prefix, _)| spelled.strip_prefix(prefix))
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                TrunkError::new(
                    "not_a_remote_branch",
                    format!("'{remote_ref}' names no branch of '{remote}'"),
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
/// Returns `not_open` when `path` names no open repository, `not_a_remote_branch` when
/// `remote_ref` is not under `refs/remotes/` or its remote's refspec names no branch in
/// it, `no_fetch_refspec` when no fetch refspec of its remote writes it,
/// `branch_in_worktree` when another worktree has the existing local branch checked out,
/// `dirty_workdir` when the checkout would overwrite uncommitted changes, the errors
/// `create_branch_inner` names for the local name, and the git error when no remote owns
/// `remote_ref` or its upstream will not save.
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
        return Err(TrunkError::new(
            "not_a_remote_branch",
            format!("'{remote_ref}' is not a remote branch"),
        ));
    }
    let tracking = Tracking::of(&repo, remote_ref)?;
    let name = tracking.name;

    if repo.find_reference(&format!("refs/heads/{name}")).is_ok() {
        check_out_local(&repo, &name)?;
    } else {
        let target = repo.find_reference(remote_ref)?.peel_to_commit()?;
        create_and_check_out(&repo, &name, &target, remote_ref)?;
        let mut config = repo.config()?;
        config.set_str(&format!("branch.{name}.remote"), &tracking.remote)?;
        config.set_str(&format!("branch.{name}.merge"), &tracking.merge)?;
    }
    drop(repo);

    let read = state_map.read_graph(path)?;
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
    activity: crate::activity::Activity,
    path: String,
    remote_ref: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<String, String> {
    let state_map = state.snapshot();
    let path_clone = path.clone();
    let rebuild = crate::state::GraphRebuild::new(activity.clone(), &cache, &ref_visibility);

    let name = rebuild
        .rebuild_merging(path.clone(), move |visibility, rebuilt| {
            checkout_remote_branch_inner(&path_clone, &remote_ref, &state_map, rebuilt, visibility)
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));

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
    activity: crate::activity::Activity,
    path: String,
    branch_name: String,
    state: State<'_, RepoState>,
) -> Result<BranchHold, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || branch_hold_inner(&path, &branch_name, &state_map))
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
pub async fn commits_only_on_branch(
    activity: crate::activity::Activity,
    path: String,
    branch_name: String,
    state: State<'_, RepoState>,
) -> Result<usize, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || commits_only_on_branch_inner(&path, &branch_name, &state_map))
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
    activity: crate::activity::Activity,
    path: String,
    branch_name: String,
    worktree: Option<WorktreeRemoval>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<DeletedBranch, String> {
    let path_clone = path.clone();
    let rebuild = crate::state::GraphRebuild::new(activity.clone(), &cache, &ref_visibility);
    let tabs = app.clone();

    let deleted = rebuild
        .rebuild_merging(path.clone(), move |visibility, rebuilt| {
            // Read the open tabs after the gate, not before it, so a tab opened on the
            // worktree while this delete waited still refuses its removal.
            let state_map = tabs.state::<RepoState>().snapshot();
            delete_branch_inner(
                &path_clone,
                &branch_name,
                worktree.as_ref(),
                &tabs.state::<Deletions>(),
                &state_map,
                rebuilt,
                visibility,
            )
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));
    Ok(deleted)
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
pub async fn restore_branch<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    deletion: u64,
    seen_head_oid: Option<String>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let seen_head = seen_head_oid
        .map(|oid| git2::Oid::from_str(&oid))
        .transpose()
        .map_err(|e| TrunkError::from(e).to_json())?;
    let path_clone = path.clone();
    let rebuild = crate::state::GraphRebuild::new(activity, &cache, &ref_visibility);
    let tabs = app.clone();

    rebuild
        .rebuild_merging(path.clone(), move |visibility, rebuilt| {
            let state_map = tabs.state::<RepoState>().snapshot();
            restore_branch_inner(
                &path_clone,
                deletion,
                seen_head,
                &tabs.state::<Deletions>(),
                &state_map,
                rebuilt,
                visibility,
            )
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
pub async fn redo_branch_delete<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    branch_name: String,
    expected_tip: String,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<DeletedBranch, String> {
    let expected_tip =
        git2::Oid::from_str(&expected_tip).map_err(|e| TrunkError::from(e).to_json())?;
    let path_clone = path.clone();
    let rebuild = crate::state::GraphRebuild::new(activity, &cache, &ref_visibility);
    let tabs = app.clone();

    let deleted = rebuild
        .rebuild_merging(path.clone(), move |visibility, rebuilt| {
            let state_map = tabs.state::<RepoState>().snapshot();
            redo_branch_delete_inner(
                &path_clone,
                &branch_name,
                expected_tip,
                &tabs.state::<Deletions>(),
                &state_map,
                rebuilt,
                visibility,
            )
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));
    Ok(deleted)
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
    activity: crate::activity::Activity,
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
    let rebuild = crate::state::GraphRebuild::new(activity.clone(), &cache, &ref_visibility);

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

    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));
    Ok(())
}

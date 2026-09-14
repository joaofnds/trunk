#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use crate::error::TrunkError;
use crate::git::graph_input::GraphSource;
use crate::git::{graph, types::StashEntry};
use crate::state::{CommitCache, OpenRepos, RepoState};
use crate::watcher::RepoChanged;
use tauri::{AppHandle, Emitter, Runtime, State};

/// Kept apart: only pop can leave an entry behind, so only pop's message may say so.
const POP_CONFLICT_MESSAGE: &str = "Stash applied with conflicts — resolve conflicts before continuing. Note: stash was NOT removed.";
const APPLY_CONFLICT_MESSAGE: &str =
    "Stash applied with conflicts — resolve conflicts before continuing";

/// A planned worktree modification during stash creation.
enum PlanAction {
    WriteFile {
        path: String,
        content: Vec<u8>,
        mode: u32,
    },
    DeleteFile {
        path: String,
    },
}

/// `stash@{n}` is a position in a stack anything can renumber — a second window,
/// a terminal, or this app on another tab. Resolving the caller's stash commit to
/// its current position at call time is what keeps an operation on the entry the
/// user picked; a stale position silently names a different one.
fn stash_index_of(repo: &mut git2::Repository, oid: &str) -> Result<usize, TrunkError> {
    let wanted = git2::Oid::from_str(oid)
        .map_err(|_| TrunkError::new("stash_not_found", format!("Not a stash id: {oid}")))?;

    let mut found = None;
    repo.stash_foreach(|idx, _, stash_oid| {
        if *stash_oid == wanted {
            found = Some(idx);
            return false;
        }
        true
    })?;

    found.ok_or_else(|| {
        TrunkError::new(
            "stash_not_found",
            "That stash is no longer in this repository — it was applied or dropped elsewhere.",
        )
    })
}

/// Every stash entry in the repository, newest first.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when the
/// stash reflog will not enumerate.
pub fn list_stashes_inner(
    path: &str,
    state_map: &OpenRepos,
) -> Result<Vec<StashEntry>, TrunkError> {
    let mut repo = state_map.open(path)?;
    let mut raw: Vec<(usize, String, git2::Oid)> = Vec::new();
    repo.stash_foreach(|idx, name, oid| {
        raw.push((idx, name.to_owned(), *oid));
        true
    })?;
    Ok(raw
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
        .collect())
}

/// Stash only the staged changes and return the rebuilt graph.
///
/// If nothing is staged, refuses and returns `nothing_to_stash`.
/// If staged and unstaged edits in a file cannot be cleanly separated, refuses and
/// returns `cannot_separate_changes` without modifying the worktree or index.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `nothing_to_stash` when the
/// index has no staged changes, `cannot_separate_changes` when changes cannot be separated,
/// and the git error when the signature is unset or the stash will not write.
pub fn stash_save_inner(
    path: &str,
    message: &str,
    state_map: &OpenRepos,
) -> Result<GraphSource, TrunkError> {
    let mut repo = state_map.open(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| TrunkError::new("bare_repo", "Cannot stash in a bare repository"))?
        .to_path_buf();

    let head = match repo.head() {
        Ok(h) => h,
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => {
            return Err(TrunkError::new(
                "unborn_branch",
                "Cannot create a stash before the initial commit.",
            ));
        }
        Err(e) => return Err(TrunkError::from(e)),
    };
    let head_commit = head.peel_to_commit().map_err(TrunkError::from)?;
    let head_tree = head_commit.tree().map_err(TrunkError::from)?;

    let mut index = repo.index().map_err(TrunkError::from)?;
    if index.has_conflicts() {
        return Err(TrunkError::new(
            "conflicted_index",
            "Cannot stash while there are unresolved merge conflicts. Resolve conflicts first.",
        ));
    }
    let index_tree_oid = index.write_tree().map_err(TrunkError::from)?;
    if index_tree_oid == head_tree.id() {
        return Err(TrunkError::new(
            "nothing_to_stash",
            "Nothing to stash — stage changes first.",
        ));
    }

    let mut status_opts = crate::git::status::dirty_status_options();
    let statuses = repo
        .statuses(Some(&mut status_opts))
        .map_err(TrunkError::from)?;

    let mut plan = Vec::new();
    let mut unseparated_conflicts = Vec::new();

    for entry in statuses.iter() {
        let status = entry.status();
        if !status.intersects(crate::git::status::STAGED_BITS) {
            continue;
        }
        let Ok(rel_path) = entry.path() else {
            continue;
        };

        let wt_diverges = status.intersects(
            git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED
                | git2::Status::WT_TYPECHANGE,
        );

        if wt_diverges {
            // Worktree diverges from index: three-way merge
            // ancestor = index blob
            // ours = worktree bytes
            // theirs = HEAD blob
            let index_blob_opt = match index.get_path(Path::new(rel_path), 0) {
                Some(idx_entry) => repo.find_blob(idx_entry.id).ok(),
                None => None,
            };

            let wt_bytes_opt = if status.intersects(git2::Status::WT_DELETED) {
                None
            } else {
                std::fs::read(workdir.join(rel_path)).ok()
            };

            let (head_blob_opt, head_mode) = head_tree.get_path(Path::new(rel_path)).map_or_else(
                |_| (None, 0o100_644),
                |head_entry| {
                    let mode = head_entry.filemode().cast_unsigned();
                    let blob = head_entry
                        .to_object(&repo)
                        .ok()
                        .and_then(|obj| obj.into_blob().ok());
                    (blob, mode)
                },
            );

            match (index_blob_opt, wt_bytes_opt, head_blob_opt) {
                (Some(idx_blob), Some(wt_bytes), Some(head_blob)) => {
                    let p = Path::new(rel_path);
                    let mut a_in = git2::MergeFileInput::new();
                    a_in.content(idx_blob.content()).path(p);
                    let mut o_in = git2::MergeFileInput::new();
                    o_in.content(&wt_bytes).path(p);
                    let mut t_in = git2::MergeFileInput::new();
                    t_in.content(head_blob.content()).path(p);

                    match git2::merge_file(&a_in, &o_in, &t_in, None) {
                        Ok(res) if res.is_automergeable() => {
                            plan.push(PlanAction::WriteFile {
                                path: rel_path.to_string(),
                                content: res.content().to_vec(),
                                mode: head_mode,
                            });
                        }
                        _ => {
                            unseparated_conflicts.push(rel_path.to_string());
                        }
                    }
                }
                _ => {
                    unseparated_conflicts.push(rel_path.to_string());
                }
            }
        } else {
            // Worktree matches index: write HEAD blob back, or delete file if not in HEAD.
            match head_tree.get_path(Path::new(rel_path)) {
                Ok(head_entry) => {
                    let head_obj = head_entry.to_object(&repo).map_err(TrunkError::from)?;
                    let head_blob = head_obj.as_blob().ok_or_else(|| {
                        TrunkError::new("git_error", "HEAD tree entry is not a blob")
                    })?;
                    plan.push(PlanAction::WriteFile {
                        path: rel_path.to_string(),
                        content: head_blob.content().to_vec(),
                        mode: head_entry.filemode().cast_unsigned(),
                    });
                }
                Err(e) if e.code() == git2::ErrorCode::NotFound => {
                    plan.push(PlanAction::DeleteFile {
                        path: rel_path.to_string(),
                    });
                }
                Err(e) => return Err(TrunkError::from(e)),
            }
        }
    }

    if !unseparated_conflicts.is_empty() {
        unseparated_conflicts.sort();
        unseparated_conflicts.dedup();
        let file_list = unseparated_conflicts.join(", ");
        return Err(TrunkError::new(
            "cannot_separate_changes",
            format!(
                "Cannot separate staged and unstaged changes in {file_list}. Commit or discard the unstaged changes to these files, then stash."
            ),
        ));
    }

    let sig = repo.signature().map_err(TrunkError::from)?;
    let branch = if head.is_branch() {
        head.shorthand().unwrap_or("HEAD")
    } else {
        "HEAD"
    };
    let head_oid_str = head_commit.id().to_string();
    let abbrev = &head_oid_str[..7.min(head_oid_str.len())];
    let subject = head_commit.summary().ok().flatten().unwrap_or("");
    let base = format!("{branch}: {abbrev} {subject}");

    let trimmed = message.trim();
    let stash_msg = if trimmed.is_empty() {
        format!("WIP on {base}")
    } else if trimmed.starts_with("On ") || trimmed.starts_with("WIP on ") {
        trimmed.to_owned()
    } else {
        format!("On {branch}: {trimmed}")
    };

    let index_tree = repo.find_tree(index_tree_oid).map_err(TrunkError::from)?;
    let index_commit_oid = repo
        .commit(
            None,
            &sig,
            &sig,
            &format!("index on {base}\n"),
            &index_tree,
            &[&head_commit],
        )
        .map_err(TrunkError::from)?;
    let index_commit = repo
        .find_commit(index_commit_oid)
        .map_err(TrunkError::from)?;

    let stash_commit_oid = repo
        .commit(
            None,
            &sig,
            &sig,
            &format!("{stash_msg}\n"),
            &index_tree,
            &[&head_commit, &index_commit],
        )
        .map_err(TrunkError::from)?;

    repo.reference_ensure_log("refs/stash")
        .map_err(TrunkError::from)?;
    repo.reference("refs/stash", stash_commit_oid, true, &stash_msg)
        .map_err(TrunkError::from)?;

    for action in plan {
        match action {
            PlanAction::WriteFile {
                path,
                content,
                mode,
            } => {
                let target = workdir.join(path);
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if target.is_symlink() || target.is_file() {
                    let _ = std::fs::remove_file(&target);
                }
                #[cfg(unix)]
                if mode == 0o120_000 || (mode & 0o170_000) == 0o120_000 {
                    if let Ok(target_str) = std::str::from_utf8(&content) {
                        let _ = std::os::unix::fs::symlink(target_str, &target);
                    }
                } else {
                    std::fs::write(&target, &content).map_err(|e| {
                        TrunkError::new("io_error", format!("Failed to write file: {e}"))
                    })?;
                    let _ =
                        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode));
                }
                #[cfg(not(unix))]
                {
                    std::fs::write(&target, &content).map_err(|e| {
                        TrunkError::new("io_error", format!("Failed to write file: {e}"))
                    })?;
                }
            }
            PlanAction::DeleteFile { path } => {
                let target = workdir.join(path);
                if target.is_symlink() || target.is_file() {
                    let _ = std::fs::remove_file(&target);
                }
                let mut curr = target.parent();
                while let Some(parent) = curr {
                    if parent == workdir {
                        break;
                    }
                    if std::fs::remove_dir(parent).is_err() {
                        break;
                    }
                    curr = parent.parent();
                }
            }
        }
    }

    let mut index = repo.index().map_err(TrunkError::from)?;
    index.read_tree(&head_tree).map_err(TrunkError::from)?;
    index.write().map_err(TrunkError::from)?;

    drop(head_tree);
    drop(head_commit);
    drop(head);
    drop(index_tree);
    drop(index_commit);
    drop(statuses);

    graph::capture(&mut repo)
}

/// Apply a stash and drop it, keeping it when the apply conflicts.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `stash_not_found` when `oid` is
/// no longer in the stash reflog, `conflict_state` when the apply conflicts,
/// and the git error otherwise.
pub fn stash_pop_inner(
    path: &str,
    oid: &str,
    state_map: &OpenRepos,
) -> Result<GraphSource, TrunkError> {
    let mut repo = state_map.open(path)?;
    let index = stash_index_of(&mut repo, oid)?;
    // Apply and drop separately rather than `stash_pop`: git2's pop drops the entry even
    // when it applied with conflicts, leaving the user's stashed work nowhere once they
    // clear the conflict markers. Real `git stash pop` keeps it, and so does this.
    repo.stash_apply(index, None).map_err(|e| {
        if e.message().contains("conflict") || e.message().contains("merge") {
            TrunkError::new("conflict_state", POP_CONFLICT_MESSAGE)
        } else {
            TrunkError::from(e)
        }
    })?;
    if crate::git::repository::has_unmerged_paths(&repo)? {
        return Err(TrunkError::new("conflict_state", POP_CONFLICT_MESSAGE));
    }
    repo.stash_drop(index).map_err(TrunkError::from)?;
    graph::capture(&mut repo)
}

/// Apply a stash, leaving it in the reflog.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `stash_not_found` when `oid` is
/// no longer in the stash reflog, `conflict_state` when the apply conflicts,
/// and the git error otherwise.
pub fn stash_apply_inner(
    path: &str,
    oid: &str,
    state_map: &OpenRepos,
) -> Result<GraphSource, TrunkError> {
    let mut repo = state_map.open(path)?;
    let index = stash_index_of(&mut repo, oid)?;
    repo.stash_apply(index, None).map_err(|e| {
        if e.message().contains("conflict") || e.message().contains("merge") {
            TrunkError::new("conflict_state", APPLY_CONFLICT_MESSAGE)
        } else {
            TrunkError::from(e)
        }
    })?;
    if crate::git::repository::has_unmerged_paths(&repo)? {
        return Err(TrunkError::new("conflict_state", APPLY_CONFLICT_MESSAGE));
    }
    graph::capture(&mut repo)
}

/// Drop a stash without applying it.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `stash_not_found` when `oid` is
/// no longer in the stash reflog, and the git error when the drop fails.
pub fn stash_drop_inner(
    path: &str,
    oid: &str,
    state_map: &OpenRepos,
) -> Result<GraphSource, TrunkError> {
    let mut repo = state_map.open(path)?;
    let index = stash_index_of(&mut repo, oid)?;
    repo.stash_drop(index).map_err(TrunkError::from)?;
    graph::capture(&mut repo)
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
pub async fn list_stashes(
    path: String,
    state: State<'_, RepoState>,
) -> Result<Vec<StashEntry>, String> {
    let state_map = state.snapshot();
    tauri::async_runtime::spawn_blocking(move || list_stashes_inner(&path, &state_map))
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
pub async fn stash_save<R: Runtime>(
    path: String,
    message: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let rebuild = crate::state::GraphRebuild::new(&cache, &ref_visibility);
    let state_map = state.snapshot();
    let path_clone = path.clone();
    rebuild
        .rebuild(path.clone(), move || {
            stash_save_inner(&path_clone, &message, &state_map)
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
pub async fn stash_pop<R: Runtime>(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let rebuild = crate::state::GraphRebuild::new(&cache, &ref_visibility);
    let state_map = state.snapshot();
    let path_clone = path.clone();
    rebuild
        .rebuild(path.clone(), move || {
            stash_pop_inner(&path_clone, &oid, &state_map)
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
pub async fn stash_apply<R: Runtime>(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let rebuild = crate::state::GraphRebuild::new(&cache, &ref_visibility);
    let state_map = state.snapshot();
    let path_clone = path.clone();
    rebuild
        .rebuild(path.clone(), move || {
            stash_apply_inner(&path_clone, &oid, &state_map)
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
pub async fn stash_drop<R: Runtime>(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let rebuild = crate::state::GraphRebuild::new(&cache, &ref_visibility);
    let state_map = state.snapshot();
    let path_clone = path.clone();
    rebuild
        .rebuild(path.clone(), move || {
            stash_drop_inner(&path_clone, &oid, &state_map)
        })
        .await
        .map_err(|e| e.to_json())?;

    let _ = app.emit("repo-changed", RepoChanged::whole_repo(path));
    Ok(())
}

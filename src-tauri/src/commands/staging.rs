use crate::commands::diff::{hunks_of, staged_view_diff, unstaged_view_diff};
use crate::state::{OpenRepos, RepoState};
use crate::types::{DiffRequestOptions, FileStatus, FileStatusType, ShownHunk, WorkingTreeStatus};
use git2::{Status, StatusOptions};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::State;
use trunk_git::error::TrunkError;
use trunk_git::status::{STAGED_BITS, UNSTAGED_BITS, dirty_status_options};

const fn classify_index(s: Status) -> Option<FileStatusType> {
    if s.contains(Status::INDEX_NEW) {
        return Some(FileStatusType::New);
    }
    if s.contains(Status::INDEX_MODIFIED) {
        return Some(FileStatusType::Modified);
    }
    if s.contains(Status::INDEX_DELETED) {
        return Some(FileStatusType::Deleted);
    }
    if s.contains(Status::INDEX_RENAMED) {
        return Some(FileStatusType::Renamed);
    }
    if s.contains(Status::INDEX_TYPECHANGE) {
        return Some(FileStatusType::Typechange);
    }
    if s.contains(Status::CONFLICTED) {
        return Some(FileStatusType::Conflicted);
    }
    None
}

const fn classify_workdir(s: Status) -> Option<FileStatusType> {
    if s.contains(Status::WT_NEW) {
        return Some(FileStatusType::New);
    }
    if s.contains(Status::WT_MODIFIED) {
        return Some(FileStatusType::Modified);
    }
    if s.contains(Status::WT_DELETED) {
        return Some(FileStatusType::Deleted);
    }
    if s.contains(Status::WT_RENAMED) {
        return Some(FileStatusType::Renamed);
    }
    if s.contains(Status::WT_TYPECHANGE) {
        return Some(FileStatusType::Typechange);
    }
    None
}

/// A conflicted path has no working-tree blob to inspect — the sides live in the
/// index at stages 1-3. Any side that is binary makes the merge editor the wrong
/// tool for the file.
fn conflict_is_binary(repo: &git2::Repository, file_path: &str) -> bool {
    let Ok(index) = repo.index() else {
        return false;
    };
    let Ok(conflicts) = index.conflicts() else {
        return false;
    };

    for conflict in conflicts.flatten() {
        let sides = [&conflict.our, &conflict.their, &conflict.ancestor];
        let names_this_file = sides
            .iter()
            .filter_map(|side| side.as_ref())
            .any(|entry| entry.path == file_path.as_bytes());
        if !names_this_file {
            continue;
        }
        return sides
            .iter()
            .filter_map(|side| side.as_ref())
            .filter_map(|entry| repo.find_blob(entry.id).ok())
            .any(|blob| blob.is_binary());
    }

    false
}

/// Where a renamed entry came from, taken from the status delta that carries
/// both sides. `None` whenever the two sides name the same path, which is every
/// status but a rename — the same rule `commands::diff::file_diff_of` applies,
/// so a file list renders a rename identically whether it came from the status
/// or from a diff.
fn renamed_from(delta: Option<git2::DiffDelta<'_>>) -> Option<String> {
    let delta = delta?;
    let old = delta.old_file().path()?;

    if Some(old) == delta.new_file().path() {
        return None;
    }

    Some(old.to_string_lossy().into_owned())
}

/// Dirty entries with each staged rename paired into one, which is how the staging
/// list and the uncommitted-changes counts both describe the tree.
fn working_tree_status_options() -> StatusOptions {
    let mut opts = dirty_status_options();
    opts.renames_head_to_index(true);
    opts
}

/// The working tree's staged, unstaged and untracked entries.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when the status
/// walk fails.
pub fn get_status_inner(
    path: &str,
    state_map: &OpenRepos,
) -> Result<WorkingTreeStatus, TrunkError> {
    let repo = state_map.open(path)?;
    let mut opts = working_tree_status_options();
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut unstaged: Vec<FileStatus> = Vec::new();
    let mut staged: Vec<FileStatus> = Vec::new();
    let mut conflicted: Vec<FileStatus> = Vec::new();

    for entry in statuses.iter() {
        let status = entry.status();
        let file_path = entry.path().unwrap_or("").to_owned();

        // Check for conflicts first
        if status.contains(Status::CONFLICTED) {
            conflicted.push(FileStatus {
                path: file_path.clone(),
                old_path: None,
                status: FileStatusType::Conflicted,
                is_binary: conflict_is_binary(&repo, &file_path),
            });
            continue;
        }

        // Index (staged) entries. `entry.path()` reads the delta's old side, so a
        // paired rename needs its current path read from the delta's new side
        // instead — otherwise the row would carry the same path twice.
        if let Some(status_type) = classify_index(status) {
            let path = entry
                .head_to_index()
                .and_then(|delta| delta.new_file().path())
                .map_or_else(|| file_path.clone(), |p| p.to_string_lossy().into_owned());

            staged.push(FileStatus {
                path,
                old_path: renamed_from(entry.head_to_index()),
                status: status_type,
                is_binary: false,
            });
        }

        // Working directory (unstaged) entries — a file can appear in both.
        // `file_path` reads the same delta's old side when `head_to_index` pairs
        // a rename, so it needs the same current-path correction as the staged
        // branch above, even though this branch's own delta is `index_to_workdir`.
        if let Some(status_type) = classify_workdir(status) {
            let path = entry
                .head_to_index()
                .and_then(|delta| delta.new_file().path())
                .map_or_else(|| file_path.clone(), |p| p.to_string_lossy().into_owned());

            unstaged.push(FileStatus {
                path,
                old_path: renamed_from(entry.index_to_workdir()),
                status: status_type,
                is_binary: false,
            });
        }
    }

    Ok(WorkingTreeStatus {
        unstaged,
        staged,
        conflicted,
    })
}

/// Whether staging should record the path rather than remove it. `Path::exists()`
/// follows symlinks, so a link whose target is gone reads as deleted and the whole
/// link is dropped from the index; `symlink_metadata` stats the link itself.
fn present_in_workdir(abs_path: &Path) -> bool {
    abs_path.symlink_metadata().is_ok()
}

/// Stage one path, recording a deletion when it is gone from the working tree.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `bare_repo` for a repository with no working tree, and the git error when
/// the index will not update.
pub fn stage_file_inner(
    path: &str,
    file_path: &str,
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    state_map.hold_for_writing(path, |repo| {
        let mut index = repo.index()?;
        let abs_path = repo
            .workdir()
            .ok_or_else(|| TrunkError::new("bare_repo", "Cannot stage in a bare repository"))?
            .join(file_path);
        if present_in_workdir(&abs_path) {
            index.add_path(Path::new(file_path))?;
        } else {
            index.remove_path(Path::new(file_path))?;
        }
        index.write()?;
        Ok(())
    })
}

/// Stage several paths in one index write. An empty list is a no-op.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `bare_repo` for a repository with no working tree, and the git error when
/// the index will not update.
pub fn stage_files_inner(
    path: &str,
    file_paths: &[String],
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    if file_paths.is_empty() {
        return Ok(());
    }
    state_map.hold_for_writing(path, |repo| {
        let workdir = repo
            .workdir()
            .ok_or_else(|| TrunkError::new("bare_repo", "Cannot stage in a bare repository"))?;
        let mut index = repo.index()?;
        for fp in file_paths {
            let abs_path = workdir.join(fp);
            if present_in_workdir(&abs_path) {
                index.add_path(Path::new(fp))?;
            } else {
                index.remove_path(Path::new(fp))?;
            }
        }
        index.write()?;
        Ok(())
    })
}

fn is_head_unborn(repo: &git2::Repository) -> bool {
    match repo.head() {
        Err(e) => e.code() == git2::ErrorCode::UnbornBranch,
        Ok(_) => false,
    }
}

/// Restore one path in the index to its HEAD state.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when the index
/// will not update.
pub fn unstage_file_inner(
    path: &str,
    file_path: &str,
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    state_map.hold_for_writing(path, |repo| {
        if is_head_unborn(repo) {
            // No commits yet, so just remove it from the index
            let mut index = repo.index()?;
            index.remove_path(Path::new(file_path))?;
            index.write()?;
        } else {
            let head_commit = repo.head()?.peel_to_commit()?;
            let paths = with_staged_rename_sources(repo, &[file_path])?;
            repo.reset_default(
                Some(head_commit.as_object()),
                paths.iter().map(String::as_str),
            )?;
        }

        Ok(())
    })
}

/// The given paths, each followed by the path it was renamed from when the index
/// holds it as a staged rename. The staging list shows a staged rename as one row
/// named by its new path, so unstaging that row has to put back both sides.
fn with_staged_rename_sources(
    repo: &git2::Repository,
    paths: &[&str],
) -> Result<Vec<String>, TrunkError> {
    let head_tree = repo.head()?.peel_to_tree()?;
    let mut diff = repo.diff_tree_to_index(Some(&head_tree), None, None)?;
    diff.find_similar(Some(git2::DiffFindOptions::new().renames(true)))?;

    let mut out: Vec<String> = paths.iter().map(|p| (*p).to_owned()).collect();
    for delta in diff.deltas() {
        let is_wanted = delta
            .new_file()
            .path()
            .is_some_and(|new| paths.iter().any(|p| Path::new(p) == new));
        if delta.status() == git2::Delta::Renamed && is_wanted {
            out.extend(renamed_from(Some(delta)));
        }
    }

    Ok(out)
}

/// Restore several paths in the index to their HEAD state.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when the index
/// will not update.
pub fn unstage_files_inner(
    path: &str,
    file_paths: &[String],
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    if file_paths.is_empty() {
        return Ok(());
    }
    state_map.hold_for_writing(path, |repo| {
        if is_head_unborn(repo) {
            let mut index = repo.index()?;
            for fp in file_paths {
                index.remove_path(Path::new(fp))?;
            }
            index.write()?;
        } else {
            let head_commit = repo.head()?.peel_to_commit()?;
            let wanted: Vec<&str> = file_paths.iter().map(String::as_str).collect();
            let paths = with_staged_rename_sources(repo, &wanted)?;
            repo.reset_default(
                Some(head_commit.as_object()),
                paths.iter().map(String::as_str),
            )?;
        }

        Ok(())
    })
}

/// A working-tree change to a file the index already tracks.
const TRACKED_WORKTREE_CHANGE: Status = Status::WT_MODIFIED
    .union(Status::WT_DELETED)
    .union(Status::WT_RENAMED)
    .union(Status::WT_TYPECHANGE);

/// Throw away one path's working-tree changes, keeping what is staged, and
/// delete it when untracked.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `file_not_found`
/// when the path has no working-tree change, `bare_repo` for a repository with
/// no working tree, `io_error` when an untracked file will not delete, and the
/// git error when the checkout fails.
pub fn discard_file_inner(
    path: &str,
    file_path: &str,
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    discard_files_inner(path, &[file_path.to_string()], state_map)
}

/// Throw away the named paths' working-tree changes, keeping what is staged.
///
/// Untracked paths are deleted. Tracked ones are restored in one checkout, so
/// the index is written once. A path with no working-tree change fails the
/// call before anything is written. An untracked file that will not delete
/// fails it after the checkout, leaving the tracked paths discarded.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `file_not_found`
/// when a path has no working-tree change, `bare_repo` for a repository with
/// no working tree, `io_error` when an untracked file will not delete, and the
/// git error when the checkout fails.
pub fn discard_files_inner(
    path: &str,
    file_paths: &[String],
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    if file_paths.is_empty() {
        return Ok(());
    }

    state_map.hold_for_writing(path, |repo| {
        let mut opts = StatusOptions::new();
        for file_path in file_paths {
            opts.pathspec(file_path);
        }
        opts.disable_pathspec_match(true)
            .include_untracked(true)
            .include_ignored(false)
            .recurse_untracked_dirs(true);
        let statuses = repo.statuses(Some(&mut opts))?;
        let status_by_path: HashMap<String, Status> = statuses
            .iter()
            .filter_map(|entry| Some((entry.path().ok()?.to_string(), entry.status())))
            .collect();

        let mut untracked = Vec::new();
        let mut tracked = Vec::new();
        for file_path in file_paths {
            let status = status_by_path
                .get(file_path)
                .copied()
                .unwrap_or(Status::CURRENT);
            if status.contains(Status::WT_NEW) {
                untracked.push(file_path);
            } else if status.intersects(TRACKED_WORKTREE_CHANGE) {
                tracked.push(file_path);
            } else {
                return Err(TrunkError::new(
                    "file_not_found",
                    format!("File not in working tree changes: {file_path}"),
                ));
            }
        }

        restore_from_index(repo, &tracked)?;

        if !untracked.is_empty() {
            let workdir = repo.workdir().ok_or_else(|| {
                TrunkError::new("bare_repo", "Cannot discard in a bare repository")
            })?;
            for file_path in untracked {
                std::fs::remove_file(workdir.join(file_path)).map_err(|e| {
                    TrunkError::new("io_error", format!("Failed to delete {file_path}: {e}"))
                })?;
            }
        }

        Ok(())
    })
}

/// Restore the named tracked paths in the working tree from the index.
///
/// From the index, not HEAD: a HEAD checkout resets the index entry too and
/// throws away the part of the file the user staged. An empty list restores
/// nothing, where a checkout with no pathspec would restore every path.
fn restore_from_index<S: AsRef<str>>(
    repo: &git2::Repository,
    paths: &[S],
) -> Result<(), TrunkError> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force().disable_pathspec_match(true);
    for path in paths {
        checkout.path(path.as_ref());
    }
    repo.checkout_index(None, Some(&mut checkout))?;
    Ok(())
}

/// Throw away every working-tree change, keeping what is staged, and delete
/// untracked files too.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `bare_repo` for a
/// repository with no working tree, the git error when the checkout fails, and
/// `io_error` naming an untracked file that would not delete, once every other
/// one is deleted.
pub fn discard_all_inner(path: &str, state_map: &OpenRepos) -> Result<(), TrunkError> {
    state_map.hold_for_writing(path, |repo| {
        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .include_ignored(false)
            .recurse_untracked_dirs(true);

        let statuses = repo.statuses(Some(&mut opts))?;
        let workdir = repo
            .workdir()
            .ok_or_else(|| TrunkError::new("bare_repo", "Cannot discard in a bare repository"))?;

        // Collect untracked file paths before checkout. A directory listed whole is
        // a repository nested in this one, and deleting it would take its history,
        // so it stays, as `git clean -fd` leaves it.
        let untracked_paths: Vec<PathBuf> = statuses
            .iter()
            .filter(|entry| entry.status().contains(Status::WT_NEW))
            .filter_map(|entry| {
                let path = entry.path().ok()?;
                (!path.ends_with('/')).then(|| workdir.join(path))
            })
            .collect();

        // Naming the changed paths keeps a conflicted file's resolution in progress:
        // a checkout of every path rewrites its conflict markers, and libgit2's
        // skip_unmerged deletes it.
        let changed_paths: Vec<String> = statuses
            .iter()
            .filter(|entry| entry.status().intersects(TRACKED_WORKTREE_CHANGE))
            .filter_map(|entry| entry.path().ok().map(str::to_string))
            .collect();

        restore_from_index(repo, &changed_paths)?;

        // Every file is tried, so one that will not delete leaves only itself
        // behind, and the user hears about it rather than being told all went.
        // A file already gone is as discarded as the user asked.
        let mut undeleted = Vec::new();
        for file_path in &untracked_paths {
            match std::fs::remove_file(file_path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    undeleted.push((file_path, e));
                    continue;
                }
            }
            // The file's own directory goes too, once nothing else is in it.
            if let Some(parent) = file_path.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }

        match undeleted.as_slice() {
            [] => Ok(()),
            [(file_path, e), rest @ ..] => {
                let name = file_path.strip_prefix(workdir).unwrap_or(file_path);
                let more = match rest.len() {
                    0 => String::new(),
                    n => format!(" and {n} more"),
                };
                Err(TrunkError::new(
                    "io_error",
                    format!("Failed to delete {}{more}: {e}", name.display()),
                ))
            }
        }
    })
}

/// Stage every change in the working tree, untracked files included, and leave each
/// conflicted file conflicted. Marking one resolved is its own step, which checks the
/// file for conflict markers first.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when the index
/// will not update.
pub fn stage_all_inner(path: &str, state_map: &OpenRepos) -> Result<(), TrunkError> {
    state_map.hold_for_writing(path, |repo| {
        let mut index = repo.index()?;
        let conflicted = conflicted_paths(&index)?;
        let mut skip_conflicted = |file: &Path, _: &[u8]| i32::from(conflicted.contains(file));
        index.add_all(
            std::iter::once(&"*"),
            git2::IndexAddOption::DEFAULT,
            Some(&mut skip_conflicted),
        )?;
        index.write()?;
        Ok(())
    })
}

/// Every path the index holds a conflict for, whichever side names it.
fn conflicted_paths(index: &git2::Index) -> Result<HashSet<PathBuf>, TrunkError> {
    let mut paths = HashSet::new();
    for conflict in index.conflicts()? {
        let conflict = conflict?;
        for entry in [conflict.ancestor, conflict.our, conflict.their]
            .into_iter()
            .flatten()
        {
            paths.insert(PathBuf::from(
                String::from_utf8_lossy(&entry.path).into_owned(),
            ));
        }
    }

    Ok(paths)
}

/// Stage the hunk the view showed from a file's unstaged diff.
///
/// # Errors
///
/// As `stage_lines_inner`, for every changed line of the hunk.
pub fn stage_hunk_inner(
    path: &str,
    file_path: &str,
    shown: &ShownHunk,
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(), TrunkError> {
    stage_lines_inner(
        path,
        file_path,
        shown,
        &shown.changed_lines(),
        state_map,
        options,
    )
}

/// Unstage the hunk the view showed from a file's staged diff.
///
/// # Errors
///
/// As `unstage_lines_inner`, for every changed line of the hunk.
pub fn unstage_hunk_inner(
    path: &str,
    file_path: &str,
    shown: &ShownHunk,
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(), TrunkError> {
    unstage_lines_inner(
        path,
        file_path,
        shown,
        &shown.changed_lines(),
        state_map,
        options,
    )
}

/// Throw away the hunk the view showed from a file's unstaged diff.
///
/// # Errors
///
/// As `discard_lines_inner`, for every changed line of the hunk.
pub fn discard_hunk_inner(
    path: &str,
    file_path: &str,
    shown: &ShownHunk,
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(), TrunkError> {
    discard_lines_inner(
        path,
        file_path,
        shown,
        &shown.changed_lines(),
        state_map,
        options,
    )
}

/// Locate the delta the user's file belongs to in a whole-repository diff.
///
/// The view names a file by its new-side path, so that is what the frontend
/// sends back for a staging gesture; a rename is also reachable by its old
/// path, which is what a caller working from the pre-rename name has. Matching
/// both mirrors the display's own selection, so staging and the view always
/// pick the same delta.
fn delta_index_of(diff: &git2::Diff, file_path: &str) -> Option<usize> {
    let wanted = Path::new(file_path);

    diff.deltas().position(|delta| {
        delta.new_file().path() == Some(wanted) || delta.old_file().path() == Some(wanted)
    })
}

/// Restore the whole index to HEAD.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when HEAD will
/// not read or the index will not reset.
pub fn unstage_all_inner(path: &str, state_map: &OpenRepos) -> Result<(), TrunkError> {
    state_map.hold_for_writing(path, |repo| {
        if is_head_unborn(repo) {
            let mut index = repo.index()?;
            index.clear()?;
            index.write()?;
        } else {
            let head_commit = repo.head()?.peel_to_commit()?;
            // A staged rename is one entry carrying both of its paths.
            let staged_paths: Vec<String> = get_status_inner(path, state_map)?
                .staged
                .into_iter()
                .flat_map(|f| std::iter::once(f.path).chain(f.old_path))
                .collect();
            if !staged_paths.is_empty() {
                repo.reset_default(
                    Some(head_commit.as_object()),
                    staged_paths.iter().map(String::as_str),
                )?;
            }
        }

        Ok(())
    })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DirtyCounts {
    pub staged: usize,
    pub unstaged: usize,
    pub conflicted: usize,
    // Per-status file counts, combined across staged + unstaged with each path
    // counted once (priority: conflicted > new > deleted > renamed > typechange > modified).
    pub modified: usize,
    pub new: usize,
    pub deleted: usize,
    pub renamed: usize,
    pub typechange: usize,
}

/// How many entries are staged, unstaged and untracked.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when the status
/// walk fails, which includes a bare repository having no working tree.
pub fn get_dirty_counts_inner(
    path: &str,
    state_map: &OpenRepos,
) -> Result<DirtyCounts, TrunkError> {
    let repo = state_map.open(path)?;
    let mut opts = working_tree_status_options();
    let statuses = repo.statuses(Some(&mut opts)).map_err(TrunkError::from)?;
    let mut staged = 0usize;
    let mut unstaged = 0usize;
    let mut conflicted = 0usize;
    let mut modified = 0usize;
    let mut new = 0usize;
    let mut deleted = 0usize;
    let mut renamed = 0usize;
    let mut typechange = 0usize;
    for entry in statuses.iter() {
        let s = entry.status();
        if s.intersects(STAGED_BITS) {
            staged += 1;
        }
        if s.intersects(UNSTAGED_BITS) {
            unstaged += 1;
        }
        // Classify each changed path into a single bucket by priority so the
        // per-status counts sum to the number of distinct dirty files.
        if s.intersects(Status::CONFLICTED) {
            conflicted += 1;
        } else if s.intersects(Status::INDEX_NEW | Status::WT_NEW) {
            new += 1;
        } else if s.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
            deleted += 1;
        } else if s.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
            renamed += 1;
        } else if s.intersects(Status::INDEX_TYPECHANGE | Status::WT_TYPECHANGE) {
            typechange += 1;
        } else if s.intersects(Status::INDEX_MODIFIED | Status::WT_MODIFIED) {
            modified += 1;
        }
    }

    Ok(DirtyCounts {
        staged,
        unstaged,
        conflicted,
        modified,
        new,
        deleted,
        renamed,
        typechange,
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
pub async fn discard_file(
    activity: crate::activity::Activity,
    path: String,
    file_path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || discard_file_inner(&path, &file_path, &state_map))
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
pub async fn discard_files(
    activity: crate::activity::Activity,
    path: String,
    file_paths: Vec<String>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || discard_files_inner(&path, &file_paths, &state_map))
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
pub async fn discard_all(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || discard_all_inner(&path, &state_map))
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
pub async fn get_dirty_counts(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
) -> Result<DirtyCounts, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || get_dirty_counts_inner(&path, &state_map))
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
pub async fn get_status(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
) -> Result<WorkingTreeStatus, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || get_status_inner(&path, &state_map))
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
pub async fn stage_file(
    activity: crate::activity::Activity,
    path: String,
    file_path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || stage_file_inner(&path, &file_path, &state_map))
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
pub async fn unstage_file(
    activity: crate::activity::Activity,
    path: String,
    file_path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || unstage_file_inner(&path, &file_path, &state_map))
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
pub async fn stage_files(
    activity: crate::activity::Activity,
    path: String,
    file_paths: Vec<String>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || stage_files_inner(&path, &file_paths, &state_map))
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
pub async fn unstage_files(
    activity: crate::activity::Activity,
    path: String,
    file_paths: Vec<String>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || unstage_files_inner(&path, &file_paths, &state_map))
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
pub async fn stage_all(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || stage_all_inner(&path, &state_map))
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
pub async fn unstage_all(
    activity: crate::activity::Activity,
    path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || unstage_all_inner(&path, &state_map))
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
pub async fn stage_hunk(
    activity: crate::activity::Activity,
    path: String,
    file_path: String,
    hunk: ShownHunk,
    options: Option<DiffRequestOptions>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let options = options.unwrap_or_default();
    activity
        .spawn_blocking(move || stage_hunk_inner(&path, &file_path, &hunk, &state_map, &options))
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
pub async fn unstage_hunk(
    activity: crate::activity::Activity,
    path: String,
    file_path: String,
    hunk: ShownHunk,
    options: Option<DiffRequestOptions>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let options = options.unwrap_or_default();
    activity
        .spawn_blocking(move || unstage_hunk_inner(&path, &file_path, &hunk, &state_map, &options))
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
pub async fn discard_hunk(
    activity: crate::activity::Activity,
    path: String,
    file_path: String,
    hunk: ShownHunk,
    options: Option<DiffRequestOptions>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let options = options.unwrap_or_default();
    activity
        .spawn_blocking(move || discard_hunk_inner(&path, &file_path, &hunk, &state_map, &options))
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
pub async fn stage_lines(
    activity: crate::activity::Activity,
    path: String,
    file_path: String,
    hunk: ShownHunk,
    line_indices: Vec<u32>,
    options: Option<DiffRequestOptions>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let options = options.unwrap_or_default();
    activity
        .spawn_blocking(move || {
            stage_lines_inner(
                &path,
                &file_path,
                &hunk,
                &line_indices,
                &state_map,
                &options,
            )
        })
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
pub async fn unstage_lines(
    activity: crate::activity::Activity,
    path: String,
    file_path: String,
    hunk: ShownHunk,
    line_indices: Vec<u32>,
    options: Option<DiffRequestOptions>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let options = options.unwrap_or_default();
    activity
        .spawn_blocking(move || {
            unstage_lines_inner(
                &path,
                &file_path,
                &hunk,
                &line_indices,
                &state_map,
                &options,
            )
        })
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
pub async fn discard_lines(
    activity: crate::activity::Activity,
    path: String,
    file_path: String,
    hunk: ShownHunk,
    line_indices: Vec<u32>,
    options: Option<DiffRequestOptions>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let options = options.unwrap_or_default();
    activity
        .spawn_blocking(move || {
            discard_lines_inner(
                &path,
                &file_path,
                &hunk,
                &line_indices,
                &state_map,
                &options,
            )
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// Build a partial unified diff patch from selected line indices.
///
/// When `reverse` is false (staging): builds a forward patch from the source diff.
///   - Selected `+` lines: kept as `+` (staged)
///   - Selected `-` lines: kept as `-` (staged)
///   - Unselected `+` lines: skipped (not staged)
///   - Unselected `-` lines: converted to context (not staged)
///
/// When `reverse` is true (unstaging/discarding): builds a reverse patch from a forward diff.
///   - Selected `+` lines: become `-` (undo the add)
///   - Selected `-` lines: become `+` (undo the delete)
///   - Unselected `+` lines: become context (keep the add)
///   - Unselected `-` lines: skipped (keep the delete undone... not present)
///   - `old_start/new_start` are swapped (old=new side of original, new=old side)
fn build_partial_patch_text(
    file_path: &str,
    patch: &git2::Patch<'_>,
    hunk_idx: usize,
    selected_indices: &[u32],
    reverse: bool,
) -> Result<Vec<u8>, TrunkError> {
    let (hunk, _) = patch.hunk(hunk_idx)?;
    let body = rewrite_hunk_lines(patch, hunk_idx, selected_indices, reverse)?;

    let old_start = if reverse {
        hunk.new_start()
    } else {
        hunk.old_start()
    };

    let new_start = body.lone_new_start(old_start);
    let HunkBody {
        lines,
        old_count,
        new_count,
    } = body;

    let mut text = patch_header(file_path, patch, reverse, new_count == 0);
    text.extend_from_slice(
        format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@\n").as_bytes(),
    );
    text.extend(lines.concat());

    Ok(text)
}

/// One hunk's rewritten lines, with the line counts its header must declare.
struct HunkBody {
    lines: Vec<Vec<u8>>,
    old_count: u32,
    new_count: u32,
}

impl HunkBody {
    /// Where this hunk starts on its new side when it is a patch's only hunk.
    ///
    /// libgit2 places each hunk at its new-side start in the file as patched so far
    /// and does not search for it (probed, git2 0.21). The hunk's own new start
    /// counts every line the file's other hunks add or remove above it, which a
    /// one-hunk patch does not carry, so it is derived from the old side instead:
    /// the same lines precede the hunk on both sides. A side with no lines names the
    /// line before the hunk rather than its first, as git writes it.
    const fn lone_new_start(&self, old_start: u32) -> u32 {
        let preceding = if self.old_count == 0 {
            old_start
        } else {
            old_start.saturating_sub(1)
        };
        if self.new_count == 0 {
            preceding
        } else {
            preceding + 1
        }
    }
}

/// Whether libgit2 gave this origin to a no-newline-at-end-of-file marker.
///
/// It marks one side or the other (probed, git2 0.21): '>' the old side, '<' the
/// new side, '=' both. Which side it names does not matter here, because the
/// marker follows the line it annotates either way.
const fn is_no_newline_marker(origin: char) -> bool {
    matches!(origin, '<' | '>' | '=')
}

/// Rewrite one hunk's lines, keeping only what the selection stages.
///
/// Each line becomes an addition, a deletion, context, or nothing, per the origin
/// and selection table on `build_partial_patch_text`.
fn rewrite_hunk_lines(
    patch: &git2::Patch<'_>,
    hunk_idx: usize,
    selected_indices: &[u32],
    reverse: bool,
) -> Result<HunkBody, TrunkError> {
    let selected_set: HashSet<u32> = selected_indices.iter().copied().collect();
    let num_lines = patch.num_lines_in_hunk(hunk_idx)?;
    let is_selected =
        |line_idx: usize| selected_set.contains(&u32::try_from(line_idx).unwrap_or(u32::MAX));
    let origins = (0..num_lines)
        .map(|line_idx| patch.line_in_hunk(hunk_idx, line_idx).map(|l| l.origin()))
        .collect::<Result<Vec<char>, _>>()?;
    let stages_an_addition_after = |line_idx: usize| {
        (line_idx + 1..num_lines).any(|later| origins[later] == '+' && is_selected(later))
    };

    let mut body = HunkBody {
        lines: Vec::new(),
        old_count: 0,
        new_count: 0,
    };
    let mut run = ChangeRun::default();
    // The text of an unterminated old last line this patch terminates. The working
    // tree spells that line terminated as the first addition after it, and only
    // there: a later addition of the same text is a line of its own.
    let mut terminated: Option<Vec<u8>> = None;

    for line_idx in 0..num_lines {
        let line = patch.line_in_hunk(hunk_idx, line_idx)?;
        let origin = line.origin();
        let content = line.content();

        if is_no_newline_marker(origin) {
            continue;
        }

        // An unterminated old last line stays last only if nothing is staged
        // after it. A staged addition below it needs its newline, which the
        // working tree spells as the same text, terminated, among the additions.
        if origin == '-'
            && !reverse
            && !is_selected(line_idx)
            && !content.ends_with(b"\n")
            && stages_an_addition_after(line_idx)
        {
            let copy = [content, b"\n"].concat();
            run.deletions.push(patch_line(b'-', content));
            run.additions.push(patch_line(b'+', &copy));
            body.old_count += 1;
            body.new_count += 1;
            terminated = Some(copy);
            continue;
        }
        if origin == '+' && !reverse && terminated.take().is_some_and(|copy| copy == content) {
            continue;
        }

        let selected = is_selected(line_idx);

        match (origin, selected, reverse) {
            // A selected line is staged onto one side. Reversing swaps which one,
            // so an add undone reads as a delete and a delete undone as an add.
            ('+', true, false) | ('-', true, true) => {
                run.additions.push(patch_line(b'+', content));
                body.new_count += 1;
            }
            ('+', true, true) | ('-', true, false) => {
                run.deletions.push(patch_line(b'-', content));
                body.old_count += 1;
            }
            // Contributes nothing: an unselected add is not staged, and an
            // unselected delete is already absent from the reversed old side.
            ('+', false, false) | ('-', false, true) => {}
            // Everything else survives on both sides, so it becomes context.
            _ => {
                run.flush_into(&mut body.lines);
                body.lines.push(patch_line(b' ', content));
                body.old_count += 1;
                body.new_count += 1;
            }
        }
    }
    run.flush_into(&mut body.lines);

    Ok(body)
}

/// The changed lines between two pieces of context, held apart by side.
///
/// Reversing a patch turns each add into a delete and each delete into an add,
/// which leaves them interleaved in libgit2's original order. git writes a run's
/// deletions before its additions, and libgit2's own parser only accepts an
/// end-of-file marker on the last line of a side's run, so a patch built in the
/// interleaved order is rejected outright (probed, git2 0.21).
#[derive(Default)]
struct ChangeRun {
    deletions: Vec<Vec<u8>>,
    additions: Vec<Vec<u8>>,
}

impl ChangeRun {
    fn flush_into(&mut self, lines: &mut Vec<Vec<u8>>) {
        lines.append(&mut self.deletions);
        lines.append(&mut self.additions);
    }
}

/// One line of a hunk's body, its byte content as the file holds it after `marker`.
///
/// A line libgit2 hands over without a newline is the file's last, and git spells
/// that as the marker on its own line straight after. The marker counts toward
/// neither side's line count.
fn patch_line(marker: u8, content: &[u8]) -> Vec<u8> {
    let mut line = vec![marker];
    line.extend_from_slice(content);
    if !content.ends_with(b"\n") {
        line.extend_from_slice(b"\n\\ No newline at end of file\n");
    }
    line
}

/// The header a hunk's patch must carry, as git writes it, newline-terminated.
///
/// libgit2 takes everything but the lines themselves from here: each side's path,
/// the mode the file ends with, and whether the patch creates or deletes it. What a
/// header leaves out, the apply loses, so a file without a mode comes out 100644 and
/// one never declared new or deleted is refused for its `/dev/null` side.
///
/// Each side names its own path. They differ for a rename, and reversing the patch
/// swaps which side is which. A rename also says so, because libgit2 only takes the
/// old path out of the index for a patch it parsed as one, and otherwise leaves both
/// files staged, so the old one would come back with the next commit.
///
/// The patch changes lines only: a file that exists on both sides keeps the mode it
/// has where the patch applies.
fn patch_header(
    file_path: &str,
    patch: &git2::Patch<'_>,
    reverse: bool,
    leaves_no_lines: bool,
) -> Vec<u8> {
    let delta = patch.delta();
    let status = delta.status();
    let is_new = matches!(status, git2::Delta::Added | git2::Delta::Untracked);
    let is_gone = status == git2::Delta::Deleted;

    let (before, after) = if reverse {
        (delta.new_file(), delta.old_file())
    } else {
        (delta.old_file(), delta.new_file())
    };
    let creates = if reverse { is_gone } else { is_new };
    let deletes = leaves_no_lines && if reverse { is_new } else { is_gone };

    let path_of =
        |file: &git2::DiffFile<'_>| file.path_bytes().unwrap_or(file_path.as_bytes()).to_vec();
    let (before_path, after_path) = (path_of(&before), path_of(&after));
    let old_side = header_path(b"a/", &before_path);
    let new_side = header_path(b"b/", &after_path);

    let mut header = [b"diff --git ", &old_side[..], b" ", &new_side[..], b"\n"].concat();
    if creates {
        header.extend(format!("new file mode {:o}\n", u32::from(after.mode())).into_bytes());
    } else if deletes {
        header.extend(format!("deleted file mode {:o}\n", u32::from(before.mode())).into_bytes());
    }
    if status == git2::Delta::Renamed {
        header.extend(format!("similarity index {RENAME_SIMILARITY}%\n").into_bytes());
        header.extend([b"rename from ", &header_path(b"", &before_path)[..], b"\n"].concat());
        header.extend([b"rename to ", &header_path(b"", &after_path)[..], b"\n"].concat());
    }
    header.extend(format!("index {}..{}", before.id(), after.id()).into_bytes());
    if !creates && !deletes {
        header.extend(format!(" {:o}", u32::from(before.mode())).into_bytes());
    }
    header.push(b'\n');
    header.extend(if creates {
        b"--- /dev/null".to_vec()
    } else {
        [b"--- ", &old_side[..]].concat()
    });
    header.push(b'\n');
    header.extend(if deletes {
        b"+++ /dev/null".to_vec()
    } else {
        [b"+++ ", &new_side[..]].concat()
    });
    header.push(b'\n');

    header
}

/// A path as a patch header spells it, after `prefix`, quoted as git quotes one.
///
/// libgit2 ends an unquoted path at whitespace, trims it at the end of a line, and
/// decodes any path that starts with a quote, so a path holding whitespace, a quote,
/// a backslash or a control byte goes in double quotes with its C escapes.
fn header_path(prefix: &[u8], path: &[u8]) -> Vec<u8> {
    let needs_quotes = path
        .iter()
        .any(|&byte| byte <= b' ' || byte == b'"' || byte == b'\\' || byte == 0x7f);
    if !needs_quotes {
        return [prefix, path].concat();
    }

    let mut quoted = vec![b'"'];
    quoted.extend_from_slice(prefix);
    for &byte in path {
        match byte {
            b'"' | b'\\' => quoted.extend([b'\\', byte]),
            _ if byte < b' ' || byte == 0x7f => {
                quoted.extend(format!("\\{byte:03o}").into_bytes());
            }
            _ => quoted.push(byte),
        }
    }
    quoted.push(b'"');

    quoted
}

/// The similarity a rename's patch declares. libgit2 parses a rename only after a
/// similarity line, while its apply never reads the figure (`patch_parse.c` and
/// `apply.c`, libgit2 1.9.7), so any percentage does.
const RENAME_SIMILARITY: u8 = 100;

/// The file's unstaged diff, index to working tree, as the view built it.
///
/// A file with no unstaged change, or a binary one, no longer holds the hunk the view
/// showed, so the action is refused as stale.
fn unstaged_patch<'r>(
    repo: &'r git2::Repository,
    file_path: &str,
    options: &DiffRequestOptions,
) -> Result<git2::Patch<'r>, TrunkError> {
    let diff = unstaged_view_diff(repo, file_path, options)?;

    if diff.deltas().len() == 0 {
        return Err(stale_hunk(file_path));
    }

    git2::Patch::from_diff(&diff, 0)?.ok_or_else(|| stale_hunk(file_path))
}

/// The file's staged diff, HEAD to index, as the view built it, refused as stale
/// when the file has no staged change or a binary one.
fn staged_patch<'r>(
    repo: &'r git2::Repository,
    file_path: &str,
    options: &DiffRequestOptions,
) -> Result<git2::Patch<'r>, TrunkError> {
    let diff = staged_view_diff(repo, options)?;
    let delta_index = delta_index_of(&diff, file_path).ok_or_else(|| stale_hunk(file_path))?;

    git2::Patch::from_diff(&diff, delta_index)?.ok_or_else(|| stale_hunk(file_path))
}

/// Where the hunk the view showed sits in the file's diff as it is now.
fn shown_hunk_index(
    patch: &git2::Patch<'_>,
    file_path: &str,
    shown: &ShownHunk,
) -> Result<usize, TrunkError> {
    hunks_of(patch)?
        .iter()
        .position(|hunk| shown.matches(hunk))
        .ok_or_else(|| stale_hunk(file_path))
}

/// The refusal of an action on a hunk the file no longer holds.
fn stale_hunk(file_path: &str) -> TrunkError {
    TrunkError::new(
        "stale_hunk",
        format!("{file_path} changed since its diff was shown"),
    )
}

/// Apply a partial patch built by `build_partial_patch_text`.
fn apply_patch_text(
    repo: &git2::Repository,
    patch_text: &[u8],
    location: git2::ApplyLocation,
) -> Result<(), TrunkError> {
    let partial_diff = git2::Diff::from_buffer(patch_text)
        .map_err(|e| TrunkError::new("patch_parse_failed", e.message().to_owned()))?;

    repo.apply(&partial_diff, location, None)
        .map_err(|e| TrunkError::new("line_apply_failed", e.message().to_owned()))
}

/// Stage selected lines of the hunk the view showed from a file's unstaged diff.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `stale_hunk` when the file no
/// longer has the hunk the view showed, `patch_parse_failed` when the rebuilt patch will not
/// parse, and `line_apply_failed` when it will not apply.
pub fn stage_lines_inner(
    path: &str,
    file_path: &str,
    shown: &ShownHunk,
    line_indices: &[u32],
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(), TrunkError> {
    state_map.hold_for_writing(path, |repo| {
        let current = unstaged_patch(repo, file_path, options)?;
        let hunk_index = shown_hunk_index(&current, file_path, shown)?;
        let patch_text =
            build_partial_patch_text(file_path, &current, hunk_index, line_indices, false)?;
        drop(current);

        apply_patch_text(repo, &patch_text, git2::ApplyLocation::Index)
    })
}

/// Unstage selected lines of the hunk the view showed from a file's staged diff.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `stale_hunk` when the file no
/// longer has the hunk the view showed, `patch_parse_failed` when the rebuilt patch will not
/// parse, and `line_apply_failed` when it will not apply.
pub fn unstage_lines_inner(
    path: &str,
    file_path: &str,
    shown: &ShownHunk,
    line_indices: &[u32],
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(), TrunkError> {
    state_map.hold_for_writing(path, |repo| {
        let current = staged_patch(repo, file_path, options)?;
        let hunk_index = shown_hunk_index(&current, file_path, shown)?;
        let patch_text =
            build_partial_patch_text(file_path, &current, hunk_index, line_indices, true)?;
        drop(current);

        apply_patch_text(repo, &patch_text, git2::ApplyLocation::Index)
    })
}

/// Throw away selected lines of the hunk the view showed from a file's unstaged diff.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `stale_hunk` when the file no
/// longer has the hunk the view showed, `patch_parse_failed` when the rebuilt patch will not
/// parse, and `line_apply_failed` when it will not apply.
pub fn discard_lines_inner(
    path: &str,
    file_path: &str,
    shown: &ShownHunk,
    line_indices: &[u32],
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(), TrunkError> {
    state_map.hold_for_writing(path, |repo| {
        let current = unstaged_patch(repo, file_path, options)?;
        let hunk_index = shown_hunk_index(&current, file_path, shown)?;
        let patch_text =
            build_partial_patch_text(file_path, &current, hunk_index, line_indices, true)?;
        drop(current);

        apply_patch_text(repo, &patch_text, git2::ApplyLocation::WorkDir)
    })
}

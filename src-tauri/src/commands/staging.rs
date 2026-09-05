use crate::commands::diff::{staging_staged_diff, staging_workdir_diff};
use crate::error::TrunkError;
use crate::git::status::{STAGED_BITS, UNSTAGED_BITS, dirty_status_options};
use crate::git::types::{DiffRequestOptions, FileStatus, FileStatusType, WorkingTreeStatus};
use crate::state::{OpenRepos, RepoState};
use git2::{Status, StatusOptions};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::State;

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

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true);

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
    let repo = state_map.open(path)?;
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
    let repo = state_map.open(path)?;
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
}

/// Ensure the index has an entry for `file_path` so that `repo.apply(Index)` works
/// on untracked files. Seeds an empty blob if the file is absent from the index.
fn seed_index_for_untracked(repo: &git2::Repository, file_path: &str) -> Result<(), TrunkError> {
    let needs_seed = {
        let index = repo.index()?;
        index.get_path(Path::new(file_path), 0).is_none()
    };
    if needs_seed {
        let empty_oid = repo.blob(&[])?;
        let mut index = repo.index()?;
        let entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o100_644,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: empty_oid,
            flags: 0,
            flags_extended: 0,
            path: file_path.as_bytes().to_vec(),
        };
        index.add(&entry)?;
        index.write()?;
    }
    Ok(())
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
    let repo = state_map.open(path)?;

    if is_head_unborn(&repo) {
        // No commits yet — just remove from index
        let mut index = repo.index()?;
        index.remove_path(Path::new(file_path))?;
        index.write()?;
    } else {
        // Reset the file to HEAD state using reset_default
        let head_commit = repo.head()?.peel_to_commit()?;
        repo.reset_default(Some(head_commit.as_object()), std::iter::once(file_path))?;
    }

    Ok(())
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
    let repo = state_map.open(path)?;

    if is_head_unborn(&repo) {
        let mut index = repo.index()?;
        for fp in file_paths {
            index.remove_path(Path::new(fp))?;
        }
        index.write()?;
    } else {
        let head_commit = repo.head()?.peel_to_commit()?;
        repo.reset_default(
            Some(head_commit.as_object()),
            file_paths.iter().map(String::as_str),
        )?;
    }

    Ok(())
}

/// Throw away one path's working-tree changes, deleting it when untracked.
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
    let repo = state_map.open(path)?;

    let mut opts = StatusOptions::new();
    opts.pathspec(file_path)
        .disable_pathspec_match(true)
        .include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts))?;

    if statuses.is_empty() {
        return Err(TrunkError::new(
            "file_not_found",
            format!("File not in working tree changes: {file_path}"),
        ));
    }

    let status = statuses
        .get(0)
        .ok_or_else(|| {
            TrunkError::new(
                "file_not_found",
                format!("File not in working tree changes: {file_path}"),
            )
        })?
        .status();

    if status.contains(Status::WT_NEW) {
        // Untracked file — delete from disk
        let full_path = repo
            .workdir()
            .ok_or_else(|| TrunkError::new("bare_repo", "Cannot discard in a bare repository"))?
            .join(file_path);
        std::fs::remove_file(&full_path).map_err(|e| {
            TrunkError::new("io_error", format!("Failed to delete {file_path}: {e}"))
        })?;
    } else if status.intersects(
        Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_RENAMED | Status::WT_TYPECHANGE,
    ) {
        // Tracked file with working tree changes — checkout from HEAD
        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout
            .path(file_path)
            .disable_pathspec_match(true)
            .force();
        repo.checkout_head(Some(&mut checkout))?;
    } else {
        return Err(TrunkError::new(
            "file_not_found",
            format!("File not in working tree changes: {file_path}"),
        ));
    }

    Ok(())
}

/// Throw away every working-tree change, deleting untracked files too.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `bare_repo` for a
/// repository with no working tree, and the git error when the checkout fails.
pub fn discard_all_inner(path: &str, state_map: &OpenRepos) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| TrunkError::new("bare_repo", "Cannot discard in a bare repository"))?;

    // Collect untracked file paths before checkout
    let untracked_paths: Vec<PathBuf> = statuses
        .iter()
        .filter(|entry| entry.status().contains(Status::WT_NEW))
        .filter_map(|entry| entry.path().ok().map(|p| workdir.join(p)))
        .collect();

    // Force checkout HEAD to restore all tracked modifications
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    repo.checkout_head(Some(&mut checkout))?;

    // Delete untracked files
    for file_path in &untracked_paths {
        let _ = std::fs::remove_file(file_path);
        // Try to remove empty parent directories
        if let Some(parent) = file_path.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }

    Ok(())
}

/// Stage every change in the working tree, untracked files included.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when the index
/// will not update.
pub fn stage_all_inner(path: &str, state_map: &OpenRepos) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;
    let mut index = repo.index()?;
    index.add_all(std::iter::once(&"*"), git2::IndexAddOption::DEFAULT, None)?;
    index.write()?;
    Ok(())
}

/// Stage one hunk of a file's unstaged diff, addressed by its index.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `file_not_found` when the file has
/// no unstaged change or is binary, `stale_hunk_index` when `hunk_index` is
/// past the end, and `hunk_apply_failed` when the hunk will not apply.
pub fn stage_hunk_inner(
    path: &str,
    file_path: &str,
    hunk_index: u32,
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;

    let diff = staging_workdir_diff(&repo, file_path, options, false)?;

    // Validate: at least one delta expected
    if diff.deltas().len() == 0 {
        return Err(TrunkError::new(
            "file_not_found",
            format!("No unstaged changes for: {file_path}"),
        ));
    }

    // Count hunks via Patch to validate hunk_index
    let patch = git2::Patch::from_diff(&diff, 0)?
        .ok_or_else(|| TrunkError::new("file_not_found", "Binary or unchanged file"))?;
    let num_hunks = patch.num_hunks();
    if (hunk_index as usize) >= num_hunks {
        return Err(TrunkError::new(
            "stale_hunk_index",
            format!("Hunk index {hunk_index} out of range (file has {num_hunks} hunks)"),
        ));
    }
    drop(patch); // Release borrow on diff

    seed_index_for_untracked(&repo, file_path)?;

    // Apply only the target hunk to the index
    let target = hunk_index as usize;
    let mut current: usize = 0;
    let mut apply_opts = git2::ApplyOptions::new();
    apply_opts.hunk_callback(move |_hunk| {
        let apply = current == target;
        current += 1;
        apply
    });

    repo.apply(&diff, git2::ApplyLocation::Index, Some(&mut apply_opts))
        .map_err(|e| TrunkError::new("hunk_apply_failed", e.message().to_owned()))?;

    Ok(())
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

/// Restrict an apply to one delta of a whole-repository diff.
///
/// `repo.apply` writes every delta it is handed. These diffs are no longer
/// narrowed by a pathspec — that would break rename pairing — so without this
/// gate a hunk gesture on one file would also apply every other staged file's
/// changes.
fn only_delta(apply_opts: &mut git2::ApplyOptions, delta_index: usize) {
    let mut seen: usize = 0;

    apply_opts.delta_callback(move |_delta| {
        let apply = seen == delta_index;
        seen += 1;
        apply
    });
}

/// Unstage one hunk of a file's staged diff, addressed by its index.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `file_not_found` when the file has
/// no staged change, `stale_hunk_index` when `hunk_index` is past the end, and
/// `hunk_apply_failed` when the hunk will not apply.
pub fn unstage_hunk_inner(
    path: &str,
    file_path: &str,
    hunk_index: u32,
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;

    // Reversed (index -> HEAD), so applying it to the index undoes the staged
    // change.
    let diff = staging_staged_diff(&repo, options, true)?;

    let delta_index = delta_index_of(&diff, file_path).ok_or_else(|| {
        TrunkError::new(
            "file_not_found",
            format!("No staged changes for: {file_path}"),
        )
    })?;

    let patch = git2::Patch::from_diff(&diff, delta_index)?
        .ok_or_else(|| TrunkError::new("file_not_found", "Binary or unchanged file"))?;
    let num_hunks = patch.num_hunks();
    if (hunk_index as usize) >= num_hunks {
        return Err(TrunkError::new(
            "stale_hunk_index",
            format!("Hunk index {hunk_index} out of range (file has {num_hunks} hunks)"),
        ));
    }
    drop(patch);

    // Apply reversed hunk to index
    let target = hunk_index as usize;
    let mut current: usize = 0;
    let mut apply_opts = git2::ApplyOptions::new();
    apply_opts.hunk_callback(move |_hunk| {
        let apply = current == target;
        current += 1;
        apply
    });
    only_delta(&mut apply_opts, delta_index);

    repo.apply(&diff, git2::ApplyLocation::Index, Some(&mut apply_opts))
        .map_err(|e| TrunkError::new("hunk_apply_failed", e.message().to_owned()))?;

    Ok(())
}

/// Throw away one hunk of a file's unstaged diff, addressed by its index.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `file_not_found` when the file has
/// no unstaged change or is binary, `stale_hunk_index` when `hunk_index` is
/// past the end, and `hunk_apply_failed` when the hunk will not apply.
pub fn discard_hunk_inner(
    path: &str,
    file_path: &str,
    hunk_index: u32,
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;

    // Reversed (workdir -> index) so applying to the workdir undoes the change.
    let diff = staging_workdir_diff(&repo, file_path, options, true)?;

    if diff.deltas().len() == 0 {
        return Err(TrunkError::new(
            "file_not_found",
            format!("No unstaged changes for: {file_path}"),
        ));
    }

    // Validate hunk_index
    let patch = git2::Patch::from_diff(&diff, 0)?
        .ok_or_else(|| TrunkError::new("file_not_found", "Binary or unchanged file"))?;
    let num_hunks = patch.num_hunks();
    if (hunk_index as usize) >= num_hunks {
        return Err(TrunkError::new(
            "stale_hunk_index",
            format!("Hunk index {hunk_index} out of range (file has {num_hunks} hunks)"),
        ));
    }
    drop(patch);

    // Apply reversed hunk to workdir
    let target = hunk_index as usize;
    let mut current: usize = 0;
    let mut apply_opts = git2::ApplyOptions::new();
    apply_opts.hunk_callback(move |_hunk| {
        let apply = current == target;
        current += 1;
        apply
    });

    repo.apply(&diff, git2::ApplyLocation::WorkDir, Some(&mut apply_opts))
        .map_err(|e| TrunkError::new("hunk_apply_failed", e.message().to_owned()))?;

    Ok(())
}

/// Restore the whole index to HEAD.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when HEAD will
/// not read or the index will not reset.
pub fn unstage_all_inner(path: &str, state_map: &OpenRepos) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;

    if is_head_unborn(&repo) {
        let mut index = repo.index()?;
        index.clear()?;
        index.write()?;
    } else {
        let head_commit = repo.head()?.peel_to_commit()?;
        // Collect all staged paths first
        let staged_paths: Vec<String> = get_status_inner(path, state_map)?
            .staged
            .into_iter()
            .map(|f| f.path)
            .collect();
        if !staged_paths.is_empty() {
            repo.reset_default(
                Some(head_commit.as_object()),
                staged_paths.iter().map(String::as_str),
            )?;
        }
    }

    Ok(())
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
    let mut opts = dirty_status_options();
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
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn discard_file(
    path: String,
    file_path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || discard_file_inner(&path, &file_path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn discard_all(path: String, state: State<'_, RepoState>) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || discard_all_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn get_dirty_counts(
    path: String,
    state: State<'_, RepoState>,
) -> Result<DirtyCounts, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || get_dirty_counts_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e: TrunkError| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn get_status(
    path: String,
    state: State<'_, RepoState>,
) -> Result<WorkingTreeStatus, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || get_status_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn stage_file(
    path: String,
    file_path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || stage_file_inner(&path, &file_path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn unstage_file(
    path: String,
    file_path: String,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || unstage_file_inner(&path, &file_path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn stage_files(
    path: String,
    file_paths: Vec<String>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || stage_files_inner(&path, &file_paths, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn unstage_files(
    path: String,
    file_paths: Vec<String>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        unstage_files_inner(&path, &file_paths, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn stage_all(path: String, state: State<'_, RepoState>) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || stage_all_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn unstage_all(path: String, state: State<'_, RepoState>) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || unstage_all_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn stage_hunk(
    path: String,
    file_path: String,
    hunk_index: u32,
    options: Option<DiffRequestOptions>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        stage_hunk_inner(&path, &file_path, hunk_index, &state_map, &options)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn unstage_hunk(
    path: String,
    file_path: String,
    hunk_index: u32,
    options: Option<DiffRequestOptions>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        unstage_hunk_inner(&path, &file_path, hunk_index, &state_map, &options)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn discard_hunk(
    path: String,
    file_path: String,
    hunk_index: u32,
    options: Option<DiffRequestOptions>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        discard_hunk_inner(&path, &file_path, hunk_index, &state_map, &options)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn stage_lines(
    path: String,
    file_path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
    options: Option<DiffRequestOptions>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        stage_lines_inner(
            &path,
            &file_path,
            hunk_index,
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
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn unstage_lines(
    path: String,
    file_path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
    options: Option<DiffRequestOptions>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        unstage_lines_inner(
            &path,
            &file_path,
            hunk_index,
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
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
#[tauri::command]
pub async fn discard_lines(
    path: String,
    file_path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
    options: Option<DiffRequestOptions>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let options = options.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        discard_lines_inner(
            &path,
            &file_path,
            hunk_index,
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
) -> Result<String, TrunkError> {
    let selected_set: HashSet<u32> = selected_indices.iter().copied().collect();

    let (hunk, _) = patch.hunk(hunk_idx)?;
    let num_lines = patch.num_lines_in_hunk(hunk_idx)?;

    let mut patch_lines: Vec<String> = Vec::new();
    let mut old_count: u32 = 0;
    let mut new_count: u32 = 0;

    for line_idx in 0..num_lines {
        let line = patch.line_in_hunk(hunk_idx, line_idx)?;
        let content = String::from_utf8_lossy(line.content());
        // Ensure content ends with newline for patch format
        let content_str = if content.ends_with('\n') {
            content.into_owned()
        } else {
            format!("{content}\n")
        };

        if reverse {
            match line.origin() {
                '+' => {
                    if selected_set.contains(&u32::try_from(line_idx).unwrap_or(u32::MAX)) {
                        // Selected add -> reverse to delete
                        patch_lines.push(format!("-{content_str}"));
                        old_count += 1;
                    } else {
                        // Unselected add -> keep as context (it stays)
                        patch_lines.push(format!(" {content_str}"));
                        old_count += 1;
                        new_count += 1;
                    }
                }
                '-' => {
                    if selected_set.contains(&u32::try_from(line_idx).unwrap_or(u32::MAX)) {
                        // Selected delete -> reverse to add (restore)
                        patch_lines.push(format!("+{content_str}"));
                        new_count += 1;
                    }
                    // Unselected delete: skip (it's already absent from the "old" side
                    // in reverse perspective)
                }
                _ => {
                    // Context line
                    patch_lines.push(format!(" {content_str}"));
                    old_count += 1;
                    new_count += 1;
                }
            }
        } else {
            match line.origin() {
                '+' => {
                    if selected_set.contains(&u32::try_from(line_idx).unwrap_or(u32::MAX)) {
                        patch_lines.push(format!("+{content_str}"));
                        new_count += 1;
                    }
                    // Unselected add: skip entirely
                }
                '-' => {
                    if selected_set.contains(&u32::try_from(line_idx).unwrap_or(u32::MAX)) {
                        patch_lines.push(format!("-{content_str}"));
                        old_count += 1;
                    } else {
                        // Unselected delete: convert to context
                        patch_lines.push(format!(" {content_str}"));
                        old_count += 1;
                        new_count += 1;
                    }
                }
                _ => {
                    // Context line
                    patch_lines.push(format!(" {content_str}"));
                    old_count += 1;
                    new_count += 1;
                }
            }
        }
    }

    // For reversed patches, old/new sides are swapped
    let (old_start, new_start) = if reverse {
        (hunk.new_start(), hunk.old_start())
    } else {
        (hunk.old_start(), hunk.new_start())
    };

    // Each side names its own path. They differ for a rename, and a header
    // that repeats one of them is rejected outright ("mismatched new path
    // names"). Reversing the patch swaps which side is which.
    let delta = patch.delta();
    let delta_status = delta.status();
    let path_of = |file: git2::DiffFile<'_>| {
        file.path().map_or_else(
            || file_path.to_string(),
            |p| p.to_string_lossy().into_owned(),
        )
    };
    let (old_path, new_path) = if reverse {
        (path_of(delta.new_file()), path_of(delta.old_file()))
    } else {
        (path_of(delta.old_file()), path_of(delta.new_file()))
    };

    let old_header = if (!reverse && delta_status == git2::Delta::Added)
        || (reverse && delta_status == git2::Delta::Deleted)
    {
        "--- /dev/null".to_string()
    } else {
        format!("--- a/{old_path}")
    };
    let new_header = if (!reverse && delta_status == git2::Delta::Deleted)
        || (reverse && delta_status == git2::Delta::Added)
    {
        "+++ /dev/null".to_string()
    } else {
        format!("+++ b/{new_path}")
    };

    let lines_joined = patch_lines.join("");

    let patch_text = format!(
        "diff --git a/{old_path} b/{new_path}\n{old_header}\n{new_header}\n@@ -{old_start},{old_count} +{new_start},{new_count} @@\n{lines_joined}",
    );

    Ok(patch_text)
}

/// Stage selected lines within one hunk of a file's unstaged diff.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `file_not_found` when the file has
/// no unstaged change or is binary, `stale_hunk_index` when `hunk_index` is
/// past the end, `patch_parse_failed` when the rebuilt patch will not parse,
/// and `line_apply_failed` when it will not apply.
pub fn stage_lines_inner(
    path: &str,
    file_path: &str,
    hunk_index: u32,
    line_indices: &[u32],
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;

    let diff = staging_workdir_diff(&repo, file_path, options, false)?;

    if diff.deltas().len() == 0 {
        return Err(TrunkError::new(
            "file_not_found",
            format!("No unstaged changes for: {file_path}"),
        ));
    }

    let patch = git2::Patch::from_diff(&diff, 0)?
        .ok_or_else(|| TrunkError::new("file_not_found", "Binary or unchanged file"))?;

    if (hunk_index as usize) >= patch.num_hunks() {
        return Err(TrunkError::new(
            "stale_hunk_index",
            format!(
                "Hunk index {} out of range (file has {} hunks)",
                hunk_index,
                patch.num_hunks()
            ),
        ));
    }

    let patch_text =
        build_partial_patch_text(file_path, &patch, hunk_index as usize, line_indices, false)?;
    drop(patch);
    drop(diff);

    seed_index_for_untracked(&repo, file_path)?;

    let partial_diff = git2::Diff::from_buffer(patch_text.as_bytes())
        .map_err(|e| TrunkError::new("patch_parse_failed", e.message().to_owned()))?;

    repo.apply(&partial_diff, git2::ApplyLocation::Index, None)
        .map_err(|e| TrunkError::new("line_apply_failed", e.message().to_owned()))?;

    Ok(())
}

/// Unstage selected lines within one hunk of a file's staged diff.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `file_not_found` when the file has
/// no staged change, `stale_hunk_index` when `hunk_index` is past the end,
/// `patch_parse_failed` when the rebuilt patch will not parse, and
/// `line_apply_failed` when it will not apply.
pub fn unstage_lines_inner(
    path: &str,
    file_path: &str,
    hunk_index: u32,
    line_indices: &[u32],
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;

    // Forward, so line indices match the user's view; the partial patch built
    // from it is reversed instead, to undo the selected lines.
    let diff = staging_staged_diff(&repo, options, false)?;

    let delta_index = delta_index_of(&diff, file_path).ok_or_else(|| {
        TrunkError::new(
            "file_not_found",
            format!("No staged changes for: {file_path}"),
        )
    })?;

    let patch = git2::Patch::from_diff(&diff, delta_index)?
        .ok_or_else(|| TrunkError::new("file_not_found", "Binary or unchanged file"))?;

    if (hunk_index as usize) >= patch.num_hunks() {
        return Err(TrunkError::new(
            "stale_hunk_index",
            format!(
                "Hunk index {} out of range (file has {} hunks)",
                hunk_index,
                patch.num_hunks()
            ),
        ));
    }

    // Build a reversed partial patch: undoes selected lines in the index
    let patch_text =
        build_partial_patch_text(file_path, &patch, hunk_index as usize, line_indices, true)?;
    drop(patch);
    drop(diff);

    let partial_diff = git2::Diff::from_buffer(patch_text.as_bytes())
        .map_err(|e| TrunkError::new("patch_parse_failed", e.message().to_owned()))?;

    repo.apply(&partial_diff, git2::ApplyLocation::Index, None)
        .map_err(|e| TrunkError::new("line_apply_failed", e.message().to_owned()))?;

    Ok(())
}

/// Throw away selected lines within one hunk of a file's unstaged diff.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `file_not_found` when the file has
/// no unstaged change or is binary, `stale_hunk_index` when `hunk_index` is
/// past the end, `patch_parse_failed` when the rebuilt patch will not parse,
/// and `line_apply_failed` when it will not apply.
pub fn discard_lines_inner(
    path: &str,
    file_path: &str,
    hunk_index: u32,
    line_indices: &[u32],
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;

    // Forward, so line indices match the user's view; the partial patch built
    // from it is reversed instead, to undo the selected lines.
    let diff = staging_workdir_diff(&repo, file_path, options, false)?;

    if diff.deltas().len() == 0 {
        return Err(TrunkError::new(
            "file_not_found",
            format!("No unstaged changes for: {file_path}"),
        ));
    }

    let patch = git2::Patch::from_diff(&diff, 0)?
        .ok_or_else(|| TrunkError::new("file_not_found", "Binary or unchanged file"))?;

    if (hunk_index as usize) >= patch.num_hunks() {
        return Err(TrunkError::new(
            "stale_hunk_index",
            format!(
                "Hunk index {} out of range (file has {} hunks)",
                hunk_index,
                patch.num_hunks()
            ),
        ));
    }

    // Build a reversed partial patch: undoes selected lines in the working directory
    let patch_text =
        build_partial_patch_text(file_path, &patch, hunk_index as usize, line_indices, true)?;
    drop(patch);
    drop(diff);

    let partial_diff = git2::Diff::from_buffer(patch_text.as_bytes())
        .map_err(|e| TrunkError::new("patch_parse_failed", e.message().to_owned()))?;

    repo.apply(&partial_diff, git2::ApplyLocation::WorkDir, None)
        .map_err(|e| TrunkError::new("line_apply_failed", e.message().to_owned()))?;

    Ok(())
}

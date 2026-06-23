use crate::error::TrunkError;
use crate::git::types::{FileStatus, FileStatusType, WorkingTreeStatus};
use crate::state::RepoState;
use git2::{Status, StatusOptions};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::State;

fn classify_index(s: Status) -> Option<FileStatusType> {
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

fn classify_workdir(s: Status) -> Option<FileStatusType> {
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

pub fn get_status_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<WorkingTreeStatus, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);

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
                status: FileStatusType::Conflicted,
                is_binary: false,
            });
            continue;
        }

        // Index (staged) entries
        if let Some(status_type) = classify_index(status) {
            staged.push(FileStatus {
                path: file_path.clone(),
                status: status_type,
                is_binary: false,
            });
        }

        // Working directory (unstaged) entries — a file can appear in both
        if let Some(status_type) = classify_workdir(status) {
            unstaged.push(FileStatus {
                path: file_path,
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

pub fn stage_file_inner(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let mut index = repo.index()?;
    let abs_path = repo
        .workdir()
        .ok_or_else(|| TrunkError::new("bare_repo", "Cannot stage in a bare repository"))?
        .join(file_path);
    if abs_path.exists() {
        index.add_path(Path::new(file_path))?;
    } else {
        index.remove_path(Path::new(file_path))?;
    }
    index.write()?;
    Ok(())
}

pub fn stage_files_inner(
    path: &str,
    file_paths: &[String],
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    if file_paths.is_empty() {
        return Ok(());
    }
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| TrunkError::new("bare_repo", "Cannot stage in a bare repository"))?;
    let mut index = repo.index()?;
    for fp in file_paths {
        let abs_path = workdir.join(fp);
        if abs_path.exists() {
            index.add_path(Path::new(fp))?;
        } else {
            index.remove_path(Path::new(fp))?;
        }
    }
    index.write()?;
    Ok(())
}

/// Build diff options for workdir diffs that include untracked files.
fn workdir_diff_opts(file_path: &str) -> git2::DiffOptions {
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file_path);
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.show_untracked_content(true);
    opts
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
            mode: 0o100644,
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

pub fn unstage_file_inner(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

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

pub fn unstage_files_inner(
    path: &str,
    file_paths: &[String],
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    if file_paths.is_empty() {
        return Ok(());
    }
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

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

pub fn discard_file_inner(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

    let mut opts = StatusOptions::new();
    opts.pathspec(file_path)
        .include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts))?;

    if statuses.is_empty() {
        return Err(TrunkError::new(
            "file_not_found",
            format!("File not in working tree changes: {}", file_path),
        ));
    }

    let status = statuses.get(0).unwrap().status();

    if status.contains(Status::WT_NEW) {
        // Untracked file — delete from disk
        let full_path = repo.workdir().unwrap().join(file_path);
        std::fs::remove_file(&full_path).map_err(|e| {
            TrunkError::new("io_error", format!("Failed to delete {}: {}", file_path, e))
        })?;
    } else if status.intersects(
        Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_RENAMED | Status::WT_TYPECHANGE,
    ) {
        // Tracked file with working tree changes — checkout from HEAD
        let mut checkout = git2::build::CheckoutBuilder::new();
        checkout.path(file_path).force();
        repo.checkout_head(Some(&mut checkout))?;
    } else {
        return Err(TrunkError::new(
            "file_not_found",
            format!("File not in working tree changes: {}", file_path),
        ));
    }

    Ok(())
}

pub fn discard_all_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);

    let statuses = repo.statuses(Some(&mut opts))?;

    // Collect untracked file paths before checkout
    let untracked_paths: Vec<PathBuf> = statuses
        .iter()
        .filter(|entry| entry.status().contains(Status::WT_NEW))
        .filter_map(|entry| entry.path().map(|p| repo.workdir().unwrap().join(p)))
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

pub fn stage_all_inner(path: &str, state_map: &HashMap<String, PathBuf>) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let mut index = repo.index()?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
    index.write()?;
    Ok(())
}

pub fn stage_hunk_inner(
    path: &str,
    file_path: &str,
    hunk_index: u32,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

    // Generate diff for this file (index -> workdir), including untracked files
    let mut diff_opts = workdir_diff_opts(file_path);
    let diff = repo.diff_index_to_workdir(None, Some(&mut diff_opts))?;

    // Validate: at least one delta expected
    if diff.deltas().len() == 0 {
        return Err(TrunkError::new(
            "file_not_found",
            format!("No unstaged changes for: {}", file_path),
        ));
    }

    // Count hunks via Patch to validate hunk_index
    let patch = git2::Patch::from_diff(&diff, 0)?
        .ok_or_else(|| TrunkError::new("file_not_found", "Binary or unchanged file"))?;
    let num_hunks = patch.num_hunks();
    if (hunk_index as usize) >= num_hunks {
        return Err(TrunkError::new(
            "stale_hunk_index",
            format!(
                "Hunk index {} out of range (file has {} hunks)",
                hunk_index, num_hunks
            ),
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

pub fn unstage_hunk_inner(
    path: &str,
    file_path: &str,
    hunk_index: u32,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

    // Generate reversed diff (index -> HEAD) so applying it to index undoes the staged change
    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.pathspec(file_path).reverse(true);

    let diff = if is_head_unborn(&repo) {
        repo.diff_tree_to_index(None, None, Some(&mut diff_opts))?
    } else {
        let head_tree = repo.head()?.peel_to_tree()?;
        repo.diff_tree_to_index(Some(&head_tree), None, Some(&mut diff_opts))?
    };

    // Validate delta exists
    if diff.deltas().len() == 0 {
        return Err(TrunkError::new(
            "file_not_found",
            format!("No staged changes for: {}", file_path),
        ));
    }

    // Validate hunk_index
    let patch = git2::Patch::from_diff(&diff, 0)?
        .ok_or_else(|| TrunkError::new("file_not_found", "Binary or unchanged file"))?;
    let num_hunks = patch.num_hunks();
    if (hunk_index as usize) >= num_hunks {
        return Err(TrunkError::new(
            "stale_hunk_index",
            format!(
                "Hunk index {} out of range (file has {} hunks)",
                hunk_index, num_hunks
            ),
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

    repo.apply(&diff, git2::ApplyLocation::Index, Some(&mut apply_opts))
        .map_err(|e| TrunkError::new("hunk_apply_failed", e.message().to_owned()))?;

    Ok(())
}

pub fn discard_hunk_inner(
    path: &str,
    file_path: &str,
    hunk_index: u32,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

    // Generate reversed diff (workdir -> index) so applying to workdir undoes the change
    let mut diff_opts = workdir_diff_opts(file_path);
    diff_opts.reverse(true);
    let diff = repo.diff_index_to_workdir(None, Some(&mut diff_opts))?;

    if diff.deltas().len() == 0 {
        return Err(TrunkError::new(
            "file_not_found",
            format!("No unstaged changes for: {}", file_path),
        ));
    }

    // Validate hunk_index
    let patch = git2::Patch::from_diff(&diff, 0)?
        .ok_or_else(|| TrunkError::new("file_not_found", "Binary or unchanged file"))?;
    let num_hunks = patch.num_hunks();
    if (hunk_index as usize) >= num_hunks {
        return Err(TrunkError::new(
            "stale_hunk_index",
            format!(
                "Hunk index {} out of range (file has {} hunks)",
                hunk_index, num_hunks
            ),
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

pub fn unstage_all_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

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

pub fn get_dirty_counts_inner(
    path: &str,
    state_map: &std::collections::HashMap<String, std::path::PathBuf>,
) -> Result<DirtyCounts, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);
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
        if s.intersects(
            Status::INDEX_NEW
                | Status::INDEX_MODIFIED
                | Status::INDEX_DELETED
                | Status::INDEX_RENAMED
                | Status::INDEX_TYPECHANGE,
        ) {
            staged += 1;
        }
        if s.intersects(
            Status::WT_NEW
                | Status::WT_MODIFIED
                | Status::WT_DELETED
                | Status::WT_RENAMED
                | Status::WT_TYPECHANGE,
        ) {
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

#[tauri::command]
pub async fn discard_all(path: String, state: State<'_, RepoState>) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || discard_all_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

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

#[tauri::command]
pub async fn stage_all(path: String, state: State<'_, RepoState>) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || stage_all_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn unstage_all(path: String, state: State<'_, RepoState>) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || unstage_all_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn stage_hunk(
    path: String,
    file_path: String,
    hunk_index: u32,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        stage_hunk_inner(&path, &file_path, hunk_index, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn unstage_hunk(
    path: String,
    file_path: String,
    hunk_index: u32,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        unstage_hunk_inner(&path, &file_path, hunk_index, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn discard_hunk(
    path: String,
    file_path: String,
    hunk_index: u32,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        discard_hunk_inner(&path, &file_path, hunk_index, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn stage_lines(
    path: String,
    file_path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        stage_lines_inner(&path, &file_path, hunk_index, line_indices, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn unstage_lines(
    path: String,
    file_path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        unstage_lines_inner(&path, &file_path, hunk_index, line_indices, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn discard_lines(
    path: String,
    file_path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
    state: State<'_, RepoState>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        discard_lines_inner(&path, &file_path, hunk_index, line_indices, &state_map)
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
///   - old_start/new_start are swapped (old=new side of original, new=old side)
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
            format!("{}\n", content)
        };

        if reverse {
            match line.origin() {
                '+' => {
                    if selected_set.contains(&(line_idx as u32)) {
                        // Selected add -> reverse to delete
                        patch_lines.push(format!("-{}", content_str));
                        old_count += 1;
                    } else {
                        // Unselected add -> keep as context (it stays)
                        patch_lines.push(format!(" {}", content_str));
                        old_count += 1;
                        new_count += 1;
                    }
                }
                '-' => {
                    if selected_set.contains(&(line_idx as u32)) {
                        // Selected delete -> reverse to add (restore)
                        patch_lines.push(format!("+{}", content_str));
                        new_count += 1;
                    }
                    // Unselected delete: skip (it's already absent from the "old" side
                    // in reverse perspective)
                }
                _ => {
                    // Context line
                    patch_lines.push(format!(" {}", content_str));
                    old_count += 1;
                    new_count += 1;
                }
            }
        } else {
            match line.origin() {
                '+' => {
                    if selected_set.contains(&(line_idx as u32)) {
                        patch_lines.push(format!("+{}", content_str));
                        new_count += 1;
                    }
                    // Unselected add: skip entirely
                }
                '-' => {
                    if selected_set.contains(&(line_idx as u32)) {
                        patch_lines.push(format!("-{}", content_str));
                        old_count += 1;
                    } else {
                        // Unselected delete: convert to context
                        patch_lines.push(format!(" {}", content_str));
                        old_count += 1;
                        new_count += 1;
                    }
                }
                _ => {
                    // Context line
                    patch_lines.push(format!(" {}", content_str));
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

    // Check delta status for diff header
    let delta_status = patch.delta().status();
    let old_header = if (!reverse && delta_status == git2::Delta::Added)
        || (reverse && delta_status == git2::Delta::Deleted)
    {
        "--- /dev/null".to_string()
    } else {
        format!("--- a/{}", file_path)
    };
    let new_header = if (!reverse && delta_status == git2::Delta::Deleted)
        || (reverse && delta_status == git2::Delta::Added)
    {
        "+++ /dev/null".to_string()
    } else {
        format!("+++ b/{}", file_path)
    };

    let lines_joined = patch_lines.join("");

    let patch_text = format!(
        "diff --git a/{path} b/{path}\n{old_header}\n{new_header}\n@@ -{old_start},{old_count} +{new_start},{new_count} @@\n{lines_joined}",
        path = file_path,
        old_header = old_header,
        new_header = new_header,
        old_start = old_start,
        old_count = old_count,
        new_start = new_start,
        new_count = new_count,
        lines_joined = lines_joined,
    );

    Ok(patch_text)
}

pub fn stage_lines_inner(
    path: &str,
    file_path: &str,
    hunk_index: u32,
    line_indices: Vec<u32>,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

    // Generate diff for this file (index -> workdir), including untracked files
    let mut diff_opts = workdir_diff_opts(file_path);
    let diff = repo.diff_index_to_workdir(None, Some(&mut diff_opts))?;

    if diff.deltas().len() == 0 {
        return Err(TrunkError::new(
            "file_not_found",
            format!("No unstaged changes for: {}", file_path),
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
        build_partial_patch_text(file_path, &patch, hunk_index as usize, &line_indices, false)?;
    drop(patch);
    drop(diff);

    seed_index_for_untracked(&repo, file_path)?;

    let partial_diff = git2::Diff::from_buffer(patch_text.as_bytes())
        .map_err(|e| TrunkError::new("patch_parse_failed", e.message().to_owned()))?;

    repo.apply(&partial_diff, git2::ApplyLocation::Index, None)
        .map_err(|e| TrunkError::new("line_apply_failed", e.message().to_owned()))?;

    Ok(())
}

pub fn unstage_lines_inner(
    path: &str,
    file_path: &str,
    hunk_index: u32,
    line_indices: Vec<u32>,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

    // Generate the staged diff (HEAD -> index), same as what the user sees.
    // We use the forward diff so line indices match the user's view,
    // then build a reversed partial patch to undo selected lines.
    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.pathspec(file_path);

    let diff = if is_head_unborn(&repo) {
        repo.diff_tree_to_index(None, None, Some(&mut diff_opts))?
    } else {
        let head_tree = repo.head()?.peel_to_tree()?;
        repo.diff_tree_to_index(Some(&head_tree), None, Some(&mut diff_opts))?
    };

    if diff.deltas().len() == 0 {
        return Err(TrunkError::new(
            "file_not_found",
            format!("No staged changes for: {}", file_path),
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

    // Build a reversed partial patch: undoes selected lines in the index
    let patch_text =
        build_partial_patch_text(file_path, &patch, hunk_index as usize, &line_indices, true)?;
    drop(patch);
    drop(diff);

    let partial_diff = git2::Diff::from_buffer(patch_text.as_bytes())
        .map_err(|e| TrunkError::new("patch_parse_failed", e.message().to_owned()))?;

    repo.apply(&partial_diff, git2::ApplyLocation::Index, None)
        .map_err(|e| TrunkError::new("line_apply_failed", e.message().to_owned()))?;

    Ok(())
}

pub fn discard_lines_inner(
    path: &str,
    file_path: &str,
    hunk_index: u32,
    line_indices: Vec<u32>,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

    // Generate the unstaged diff (index -> workdir), same as what the user sees.
    // We use the forward diff so line indices match the user's view,
    // then build a reversed partial patch to undo selected lines.
    let mut diff_opts = workdir_diff_opts(file_path);
    let diff = repo.diff_index_to_workdir(None, Some(&mut diff_opts))?;

    if diff.deltas().len() == 0 {
        return Err(TrunkError::new(
            "file_not_found",
            format!("No unstaged changes for: {}", file_path),
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
        build_partial_patch_text(file_path, &patch, hunk_index as usize, &line_indices, true)?;
    drop(patch);
    drop(diff);

    let partial_diff = git2::Diff::from_buffer(patch_text.as_bytes())
        .map_err(|e| TrunkError::new("patch_parse_failed", e.message().to_owned()))?;

    repo.apply(&partial_diff, git2::ApplyLocation::WorkDir, None)
        .map_err(|e| TrunkError::new("line_apply_failed", e.message().to_owned()))?;

    Ok(())
}

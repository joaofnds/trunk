use std::path::Path;

use crate::state::{CommitCache, OpenRepos, RepoState};
use crate::types::MergeSides;
use crate::watcher::RepoChanged;
use tauri::{AppHandle, Emitter, Runtime, State};
use trunk_git::blob_reader::{self, WorkingTreeFile};
use trunk_git::conflicted_file::{self, ReadError, Sides};
use trunk_git::error::TrunkError;

/// The file's conflict entry, or `not_conflicted` when the index holds none for
/// it. Both the read and the write path ask this first: the editor outlives the
/// operation that opened it, so "is this file still conflicted" is the question
/// that separates a real resolution from one aimed at history that has moved on.
fn conflict_entry(
    repo: &git2::Repository,
    file_path: &str,
) -> Result<git2::IndexConflict, TrunkError> {
    let index = repo.index()?;
    let mut conflicts = index
        .conflicts()
        .map_err(|e| TrunkError::new("conflict_error", e.to_string()))?;

    conflicts
        .find(|entry| {
            entry.as_ref().is_ok_and(|c| {
                let entry_path = c
                    .our
                    .as_ref()
                    .or(c.their.as_ref())
                    .or(c.ancestor.as_ref())
                    .map(|e| String::from_utf8_lossy(&e.path).into_owned());
                entry_path.as_deref() == Some(file_path)
            })
        })
        .ok_or_else(|| {
            TrunkError::new(
                "not_conflicted",
                format!("File not in conflict: {file_path}"),
            )
        })?
        .map_err(|e| TrunkError::new("conflict_error", e.to_string()))
}

/// The two sides of a conflict where both still hold the file as a file. A deleted
/// side has no text to take, and reading it as empty would let the save path stage an
/// empty file where that side meant no file at all. A link or submodule side holds a
/// target rather than text, and git leaves the link in the working tree, so reading
/// or writing the path there would reach whatever it points at.
fn sides_with_text<'a>(
    conflict: &'a git2::IndexConflict,
    file_path: &str,
) -> Result<(&'a git2::IndexEntry, &'a git2::IndexEntry), TrunkError> {
    let (Some(our), Some(their)) = (&conflict.our, &conflict.their) else {
        let message = if conflict.our.is_none() && conflict.their.is_none() {
            format!("{file_path} was deleted on both sides. Delete it to accept the deletion.")
        } else {
            format!(
                "{file_path} was deleted on one side. Stage it to keep it, or delete it to accept the deletion."
            )
        };
        return Err(TrunkError::new("delete_conflict", message));
    };
    for side in [our, their] {
        let kind = match side.mode & 0o170_000 {
            0o100_000 => continue,
            0o120_000 => "a symbolic link",
            0o160_000 => "a submodule",
            _ => "not a file",
        };
        return Err(TrunkError::new(
            "link_conflict",
            format!("{file_path} is {kind} on one side, so resolve it outside the merge editor."),
        ));
    }

    Ok((our, their))
}

/// The regions of a conflicted file as git left it in the working tree, beside the
/// two sides the index holds.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `no_workdir` for a
/// bare repository, `not_conflicted` when the index holds no conflict for
/// `file_path`, `delete_conflict` when one side deleted the file, `link_conflict`
/// when a side is a link or submodule, `missing_file` when the working tree holds no
/// file there, `binary_conflict` when a side or the file is not text,
/// `unclosed_conflict` when a conflict in the file never closes, `read_error` when
/// the file will not read, and the git error when a blob or the attributes will not
/// read.
pub fn get_merge_sides_inner(
    path: &str,
    file_path: &str,
    state_map: &OpenRepos,
) -> Result<MergeSides, TrunkError> {
    let repo = state_map.open(path)?;
    if repo.workdir().is_none() {
        return Err(TrunkError::new("no_workdir", "Bare repository"));
    }
    let conflict = conflict_entry(&repo, file_path)?;
    let (our, their) = sides_with_text(&conflict, file_path)?;

    // `from_utf8_lossy` would replace every invalid byte with U+FFFD and the save
    // path writes that text back over the file, with both original sides already
    // dropped from the index. Refusing here is what keeps the sides recoverable.
    let binary = || {
        TrunkError::new(
            "binary_conflict",
            format!("{file_path} is binary, so resolve it outside the merge editor."),
        )
    };
    let text = |bytes: Vec<u8>| String::from_utf8(bytes).map_err(|_| binary());
    let ours = text(repo.find_blob(our.id)?.content().to_vec())?;
    let theirs = text(repo.find_blob(their.id)?.content().to_vec())?;
    let working = match read_working_file(&repo, file_path)? {
        WorkingTreeFile::Text(bytes) => text(bytes)?,
        WorkingTreeFile::Binary { .. } => return Err(binary()),
    };
    let sides = Sides {
        ours: &ours,
        theirs: &theirs,
    };

    let regions = if working == ours && !git_merges_text(&repo, file_path)? {
        conflicted_file::unmerged_regions(sides)?
    } else {
        conflicted_file::regions(sides, &working, conflict_marker_size(&repo, file_path)?)
            .map_err(|error| match error {
                ReadError::UnclosedConflict => TrunkError::new(
                    "unclosed_conflict",
                    format!(
                        "{file_path} has a conflict whose markers do not close. Fix the markers in your editor, then open it here again."
                    ),
                ),
                ReadError::Git(error) => error.into(),
            })?
    };
    Ok(MergeSides { regions })
}

/// The working-tree file at `file_path`, read without following a link, so a link
/// planted there cannot show a file from outside the repository.
fn read_working_file(
    repo: &git2::Repository,
    file_path: &str,
) -> Result<WorkingTreeFile, TrunkError> {
    blob_reader::read_working_tree_file_without_links(repo, file_path).map_err(|error| {
        if error.code == "not_found" {
            TrunkError::new(
                "missing_file",
                format!(
                    "{file_path} is not a file in the working tree. Restore it to resolve it here."
                ),
            )
        } else {
            TrunkError::new("read_error", error.message)
        }
    })
}

/// Whether git merges the file's text, which it does unless its `merge` attribute is
/// unset or names the binary driver. A file git does not merge is left as the current
/// side, with no markers.
fn git_merges_text(repo: &git2::Repository, file_path: &str) -> Result<bool, TrunkError> {
    let merge = repo.get_attr(
        std::path::Path::new(file_path),
        "merge",
        git2::AttrCheckFlags::FILE_THEN_INDEX,
    )?;
    Ok(!matches!(
        git2::AttrValue::from_string(merge),
        git2::AttrValue::False | git2::AttrValue::String("binary")
    ))
}

/// The marker size git wrote the file's conflicts with: its `conflict-marker-size`
/// attribute, or git's default.
fn conflict_marker_size(repo: &git2::Repository, file_path: &str) -> Result<usize, TrunkError> {
    let size = repo.get_attr(
        std::path::Path::new(file_path),
        "conflict-marker-size",
        git2::AttrCheckFlags::FILE_THEN_INDEX,
    )?;
    Ok(size
        .and_then(|size| size.parse().ok())
        .filter(|&size| size > 0)
        .unwrap_or(conflicted_file::DEFAULT_MARKER_SIZE))
}

/// Write the resolved content over the file and stage it, clearing the conflict.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `no_workdir` for a
/// bare repository, `not_conflicted` when the index holds no conflict for
/// `file_path`, `delete_conflict` when a side deleted it, `link_conflict` when a side
/// is a link or submodule, `write_error` when the file will not write or sits inside
/// a linked directory, and the git error when the index will not stage.
pub fn save_merge_result_inner(
    path: &str,
    file_path: &str,
    content: &str,
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    state_map.hold_for_writing(path, |repo| {
        let repo_path = repo
            .workdir()
            .ok_or_else(|| TrunkError::new("no_workdir", "Bare repository"))?;

        // Refuse before touching the file. An editor left open after its operation
        // ended would otherwise overwrite the restored content and stage it, and
        // nothing committed it, so the repository could not give it back. A side that
        // deleted the file is refused for the reason the read path gives.
        sides_with_text(&conflict_entry(repo, file_path)?, file_path)?;

        write_working_file(repo_path, file_path, content)?;

        // Stage the file (clears conflict entry from index)
        let mut index = repo.index()?;
        index.add_path(std::path::Path::new(file_path))?;
        index.write()?;

        Ok(())
    })
}

/// Writes the resolution as a regular file at `file_path`, as staging records it. A
/// link standing at the path is replaced rather than written through, so the write
/// cannot reach a file outside the repository, and a directory on the way that is a
/// link is refused for the same reason.
fn write_working_file(workdir: &Path, file_path: &str, content: &str) -> Result<(), TrunkError> {
    let write_error =
        |error: std::io::Error| TrunkError::new("write_error", format!("{file_path}: {error}"));
    let full_path = workdir.join(file_path);
    let mut parent = workdir.to_path_buf();
    for component in Path::new(file_path)
        .parent()
        .into_iter()
        .flat_map(Path::components)
    {
        parent.push(component);
        if std::fs::symlink_metadata(&parent)
            .map_err(write_error)?
            .is_symlink()
        {
            return Err(TrunkError::new(
                "write_error",
                format!(
                    "{file_path} is inside a symbolic link, so resolve it outside the merge editor."
                ),
            ));
        }
    }
    if full_path.is_symlink() {
        std::fs::remove_file(&full_path).map_err(write_error)?;
    }
    std::fs::write(&full_path, content).map_err(write_error)
}

/// The files among `file_paths` whose working copy still holds conflict markers.
///
/// The markers are read as the merge editor reads them, since marking such a file
/// resolved would stage them as content. A file missing from the working tree holds
/// none, and neither does a link or a binary file.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `no_workdir` for a
/// bare repository, `read_error` when a file exists but will not read, and the git
/// error when the attributes will not read.
pub fn conflict_marker_files_inner(
    path: &str,
    file_paths: &[String],
    state_map: &OpenRepos,
) -> Result<Vec<String>, TrunkError> {
    let repo = state_map.open(path)?;
    if repo.workdir().is_none() {
        return Err(TrunkError::new("no_workdir", "Bare repository"));
    }

    let mut found = Vec::new();
    for file_path in file_paths {
        let content = match read_working_file(&repo, file_path) {
            Ok(WorkingTreeFile::Text(content)) => content,
            Ok(WorkingTreeFile::Binary { .. }) => continue,
            Err(error) if error.code == "missing_file" => continue,
            Err(error) => return Err(error),
        };
        let size = conflict_marker_size(&repo, file_path)?;
        if conflicted_file::holds_conflict(&String::from_utf8_lossy(&content), size) {
            found.push(file_path.clone());
        }
    }
    Ok(found)
}

// --- Tauri command wrappers ---

/// # Errors
///
/// Returns the inner error as JSON, and `spawn_error` when the blocking task
/// cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn get_merge_sides(
    activity: crate::activity::Activity,
    path: String,
    file_path: String,
    state: State<'_, RepoState>,
) -> Result<MergeSides, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || get_merge_sides_inner(&path, &file_path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, and `spawn_error` when the blocking task
/// cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn save_merge_result<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    file_path: String,
    content: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let state_map = state.snapshot();
    let path_clone = path.clone();
    activity
        .spawn_blocking(move || {
            save_merge_result_inner(&path_clone, &file_path, &content, &state_map)
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())?;

    // Staging a resolution moves no ref and writes no commit, so the cached
    // graph still holds. The change is announced at once rather than when the
    // watcher sees the index write.
    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));
    Ok(())
}

/// # Errors
///
/// Returns the inner error as JSON, and `spawn_error` when the blocking task
/// cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn conflict_marker_files(
    activity: crate::activity::Activity,
    path: String,
    file_paths: Vec<String>,
    state: State<'_, RepoState>,
) -> Result<Vec<String>, String> {
    let state_map = state.snapshot();
    activity
        .spawn_blocking(move || conflict_marker_files_inner(&path, &file_paths, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

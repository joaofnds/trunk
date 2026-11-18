use crate::state::{CommitCache, OpenRepos, RepoState};
use crate::types::MergeSides;
use crate::watcher::RepoChanged;
use tauri::{AppHandle, Emitter, Runtime, State};
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

/// The two sides of a conflict where both still hold the file. A deleted side
/// has no text to take, and reading it as empty would let the save path stage an
/// empty file where that side meant no file at all.
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

    Ok((our, their))
}

/// The three sides of a conflicted file, read from the index.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `not_conflicted`
/// when the index holds no conflict for `file_path`, `delete_conflict` when one
/// side deleted the file, `binary_conflict` when a side is not valid UTF-8, and
/// the git error when a blob will not read.
pub fn get_merge_sides_inner(
    path: &str,
    file_path: &str,
    state_map: &OpenRepos,
) -> Result<MergeSides, TrunkError> {
    let repo = state_map.open(path)?;
    let conflict = conflict_entry(&repo, file_path)?;
    let (our, their) = sides_with_text(&conflict, file_path)?;

    // `from_utf8_lossy` would replace every invalid byte with U+FFFD and the save
    // path writes that text back over the file, with both original sides already
    // dropped from the index. Refusing here is what keeps the sides recoverable.
    let read_blob = |entry: &git2::IndexEntry| -> Result<String, TrunkError> {
        let blob = repo.find_blob(entry.id)?;
        String::from_utf8(blob.content().to_vec()).map_err(|_| {
            TrunkError::new(
                "binary_conflict",
                format!("{file_path} is binary, so resolve it outside the merge editor."),
            )
        })
    };

    Ok(MergeSides {
        base: conflict
            .ancestor
            .as_ref()
            .map(read_blob)
            .transpose()?
            .unwrap_or_default(),
        ours: read_blob(our)?,
        theirs: read_blob(their)?,
    })
}

/// Write the resolved content over the file and stage it, clearing the conflict.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `no_workdir` for a
/// bare repository, `not_conflicted` when the index holds no conflict for
/// `file_path`, `delete_conflict` when a side deleted it, `write_error` when the
/// file will not write, and the git error when the index will not stage.
pub fn save_merge_result_inner(
    path: &str,
    file_path: &str,
    content: &str,
    state_map: &OpenRepos,
) -> Result<(), TrunkError> {
    let repo = state_map.open(path)?;
    let repo_path = repo
        .workdir()
        .ok_or_else(|| TrunkError::new("no_workdir", "Bare repository"))?;

    // Refuse before touching the file. An editor left open after its operation
    // ended would otherwise overwrite the restored content and stage it, and
    // nothing committed it, so the repository could not give it back. A side that
    // deleted the file is refused for the reason the read path gives.
    sides_with_text(&conflict_entry(&repo, file_path)?, file_path)?;

    // Write merged content to disk
    let full_path = repo_path.join(file_path);
    std::fs::write(&full_path, content)
        .map_err(|e| TrunkError::new("write_error", e.to_string()))?;

    // Stage the file (clears conflict entry from index)
    let mut index = repo.index()?;
    index.add_path(std::path::Path::new(file_path))?;
    index.write()?;

    Ok(())
}

/// Whether `content` holds a conflict git wrote and nobody resolved: an
/// opening, a separating and a closing marker, each at the start of a line.
fn holds_conflict_markers(content: &[u8]) -> bool {
    let mut opening = false;
    let mut separator = false;
    let mut closing = false;
    for line in content.split(|&b| b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        opening |= line == b"<<<<<<<" || line.starts_with(b"<<<<<<< ");
        separator |= line == b"=======";
        closing |= line == b">>>>>>>" || line.starts_with(b">>>>>>> ");
    }
    opening && separator && closing
}

/// The files among `file_paths` whose working copy still holds conflict
/// markers, so marking them resolved would stage the markers as content. A file
/// missing from the working tree holds none.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `no_workdir` for a
/// bare repository, and `read_error` when a file exists but will not read.
pub fn conflict_marker_files_inner(
    path: &str,
    file_paths: &[String],
    state_map: &OpenRepos,
) -> Result<Vec<String>, TrunkError> {
    let repo = state_map.open(path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| TrunkError::new("no_workdir", "Bare repository"))?;

    let mut found = Vec::new();
    for file_path in file_paths {
        let content = match std::fs::read(workdir.join(file_path)) {
            Ok(content) => content,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(TrunkError::new("read_error", e.to_string())),
        };
        if holds_conflict_markers(&content) {
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

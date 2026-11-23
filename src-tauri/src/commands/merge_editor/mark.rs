use super::{conflict_entry, conflict_marker_size, merge_revision, save};
use crate::state::{CommitCache, OpenRepos, RepoState};
use crate::watcher::RepoChanged;
use std::path::Path;
use tauri::{AppHandle, Emitter, Runtime, State};
use trunk_git::{
    blob_reader::{self, ResolutionFile},
    conflicted_file,
    error::TrunkError,
};

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ConfirmedFile {
    pub path: String,
    pub revision: String,
}

#[derive(Debug, serde::Serialize)]
pub struct MarkConfirmation {
    pub files: Vec<ConfirmedFile>,
    pub marked: Vec<String>,
}

struct Snapshot {
    working: ResolutionFile,
    mode: u32,
    revision: String,
    marked: bool,
}

impl Snapshot {
    fn read(repo: &git2::Repository, path: &str) -> Result<Self, TrunkError> {
        let conflict = conflict_entry(repo, path)?;
        let working = ResolutionFile::read(repo, path)?;
        let marker_size = conflict_marker_size(repo, path)?;
        let content_revision = merge_revision(&working.bytes, &conflict, marker_size, true)?;
        let current_mode = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .map(|e| e.mode);
        let config = repo.config()?;
        let mode = match working.mode {
            0o100_644 | 0o100_755
                if current_mode == Some(0o120_000)
                    && !config.get_bool("core.symlinks").unwrap_or(true) =>
            {
                0o120_000
            }
            0o100_644 | 0o100_755 if !config.get_bool("core.filemode").unwrap_or(true) => {
                if current_mode == Some(0o100_755) {
                    0o100_755
                } else {
                    0o100_644
                }
            }
            mode => mode,
        };
        let revision = format!(
            "{content_revision}:{}:{}:{}:{}:{mode}",
            working.device, working.inode, working.mode, working.permissions
        );
        let marked = matches!(mode, 0o100_644 | 0o100_755)
            && !blob_reader::is_binary(&working.bytes)
            && conflicted_file::holds_conflict(
                &String::from_utf8_lossy(&working.bytes),
                marker_size,
            );

        Ok(Self {
            working,
            mode,
            revision,
            marked,
        })
    }

    fn validate(repo: &git2::Repository, file: &ConfirmedFile) -> Result<Self, TrunkError> {
        let snapshot = Self::read(repo, &file.path)?;
        if snapshot.revision != file.revision {
            return Err(TrunkError::new(
                "conflict_changed",
                format!(
                    "{} changed. Review the file before marking it resolved.",
                    file.path
                ),
            ));
        }
        Ok(snapshot)
    }

    fn object(
        &self,
        repo: &git2::Repository,
        index: &Path,
        path: &str,
    ) -> Result<Option<(git2::Oid, u32)>, TrunkError> {
        let oid = match self.mode {
            0 => return Ok(None),
            0o120_000 => repo.blob(&self.working.bytes)?,
            0o160_000 => git2::Oid::from_bytes(&self.working.bytes)?,
            _ => save::clean_blob(repo, index, path, &self.working.bytes)?,
        };
        Ok(Some((oid, self.mode)))
    }
}

/// # Errors
///
/// Refuses missing conflicts and unreadable working entries.
pub fn prepare_mark_resolved_inner(
    path: &str,
    file_paths: &[String],
    repos: &OpenRepos,
) -> Result<MarkConfirmation, TrunkError> {
    let repo = repos.open(path)?;
    let mut confirmation = MarkConfirmation {
        files: Vec::with_capacity(file_paths.len()),
        marked: Vec::new(),
    };
    for path in file_paths {
        let snapshot = Snapshot::read(&repo, path)?;
        if snapshot.marked {
            confirmation.marked.push(path.clone());
        }
        confirmation.files.push(ConfirmedFile {
            path: path.clone(),
            revision: snapshot.revision,
        });
    }
    Ok(confirmation)
}

/// # Errors
///
/// Refuses the batch if any confirmed working entry or conflict stage has changed.
pub fn mark_conflicts_resolved_inner(
    path: &str,
    files: &[ConfirmedFile],
    repos: &OpenRepos,
) -> Result<(), TrunkError> {
    let repo = repos.open(path)?;
    if files.is_empty() {
        return Ok(());
    }
    let index_path = repo
        .index()?
        .path()
        .ok_or_else(|| TrunkError::new("stage_failed", "Missing index path"))?
        .to_owned();
    let conversions =
        save::CleanConversions::read(&repo, &index_path, files.iter().map(|f| f.path.as_str()))?;
    let mut regular_paths = Vec::new();
    let mut objects = Vec::with_capacity(files.len());
    for file in files {
        let snapshot = Snapshot::validate(&repo, file)?;
        if matches!(snapshot.mode, 0o100_644 | 0o100_755) {
            regular_paths.push(file.path.as_str());
        }
        objects.push(snapshot.object(&repo, &index_path, &file.path)?);
    }
    trunk_git::write_gate::hold(&repo, |repo| {
        let _lock = save::index_lock(repo, &index_path)?;
        conversions.validate(repo, &index_path, &regular_paths)?;
        for file in files {
            Snapshot::validate(repo, file)?;
        }
        save::publish_index(repo, &index_path, |index| {
            for (file, object) in files.iter().zip(objects) {
                save::stage_entry(index, &file.path, object)?;
            }
            Ok(())
        })
    })
}

/// # Errors
///
/// Returns the snapshot error or a blocking-worker failure.
#[tauri::command]
pub async fn prepare_mark_resolved(
    activity: crate::activity::Activity,
    path: String,
    file_paths: Vec<String>,
    state: State<'_, RepoState>,
) -> Result<MarkConfirmation, String> {
    let repos = state.snapshot();
    activity
        .spawn_blocking(move || prepare_mark_resolved_inner(&path, &file_paths, &repos))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the staging error or a blocking-worker failure.
#[tauri::command]
pub async fn mark_conflicts_resolved<R: Runtime>(
    activity: crate::activity::Activity,
    path: String,
    files: Vec<ConfirmedFile>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let repos = state.snapshot();
    let repo_path = path.clone();
    activity
        .spawn_blocking(move || mark_conflicts_resolved_inner(&repo_path, &files, &repos))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())?;
    let _ = app.emit("repo-changed", RepoChanged::completed(path, &cache));
    Ok(())
}

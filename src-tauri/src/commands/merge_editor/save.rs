use super::{
    check_text_sides, conflict_marker_size, git_merges_text, merge_revision, sides_with_text,
};
use crate::user_git::{UserGit, refusal};
use std::fs::File;
use std::io::{self, Seek, Write};
use std::path::Path;
use trunk_git::blob_reader::WorkingTreeEdit;
use trunk_git::error::TrunkError;

fn stage_error(error: impl std::fmt::Display) -> TrunkError {
    TrunkError::new(
        "stage_failed",
        format!("Could not stage the resolution. {error}"),
    )
}

/// Hold the actual Git lock before refreshing the index, including while a
/// private libgit2 index is serialized. The lock file itself stays empty.
pub(super) fn index_lock(
    repo: &git2::Repository,
    path: &Path,
) -> Result<tempfile::TempPath, TrunkError> {
    let mut lock_path = path.as_os_str().to_owned();
    lock_path.push(".lock");
    let mut options = File::options();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&lock_path).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            stage_error("Another Git operation holds the index lock. Retry after it finishes.")
        } else {
            stage_error(error)
        }
    })?;
    let lock = tempfile::TempPath::try_from_path(lock_path).map_err(stage_error)?;
    repo.index()?.read(true)?;
    Ok(lock)
}

/// Configured clean filters and working-tree encodings belong to the user's Git.
pub(super) fn clean_blob(
    repo: &git2::Repository,
    workdir: &Path,
    index: &Path,
    path: &str,
    content: &[u8],
) -> Result<git2::Oid, TrunkError> {
    let mut input = tempfile::tempfile().map_err(stage_error)?;
    input.write_all(content).map_err(stage_error)?;
    input.rewind().map_err(stage_error)?;
    let mut git = UserGit::in_dir(workdir);
    git.env("GIT_DIR", repo.path())
        .env("GIT_WORK_TREE", workdir)
        .env("GIT_INDEX_FILE", index)
        .args(["hash-object", "-w", "--stdin", "--path", path])
        .stdin(input.into());
    let output = tauri::async_runtime::block_on(async {
        git.spawn()?
            .wait_bounded(std::time::Duration::from_secs(30))
            .await
    })
    .map_err(stage_error)?;
    if !output.status.success() {
        return Err(stage_error(refusal(&output)));
    }

    let oid = git2::Oid::from_str(
        std::str::from_utf8(&output.stdout)
            .map_err(stage_error)?
            .trim(),
    )
    .map_err(stage_error)?;
    Ok(repo.find_blob(oid)?.id())
}

pub(super) fn resolve(
    repo: &git2::Repository,
    path: &str,
    content: &str,
    expected: &str,
) -> Result<(), TrunkError> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| TrunkError::new("no_workdir", "Bare repository"))?;
    let index_path = repo
        .index()?
        .path()
        .ok_or_else(|| stage_error("The repository index has no path."))?
        .to_owned();
    if !index_path.exists() {
        return Err(TrunkError::new(
            "not_conflicted",
            format!("File not in conflict: {path}"),
        ));
    }
    let approved = content.as_bytes();
    let written = trunk_git::write_gate::hold(repo, |repo| {
        let _lock = index_lock(repo, &index_path)?;
        let (working, conflict, revision) = snapshot(repo, path)?;
        if revision != expected {
            return Err(WorkingTreeEdit::changed());
        }

        working.replace(repo, approved)?;
        revision_of(repo, path, approved, &conflict)
    })?;

    let stage = || {
        let id = clean_blob(repo, workdir, &index_path, path, approved)?;
        trunk_git::write_gate::hold(repo, |repo| {
            let _lock = index_lock(repo, &index_path)?;
            let (working, conflict, revision) = snapshot(repo, path)?;
            if revision != written {
                return Err(WorkingTreeEdit::changed());
            }

            let (ours, _) = sides_with_text(&conflict, path)?;
            let mode = if repo.config()?.get_bool("core.filemode").unwrap_or(true) {
                if working.executable() {
                    0o100_755
                } else {
                    0o100_644
                }
            } else {
                ours.mode
            };
            publish_index(repo, &index_path, |index| {
                stage_entry(index, path, Some((id, mode)))
            })
        })
    };
    stage().map_err(|mut error| {
        if error.code == "conflict_changed" || error.code == "not_conflicted" {
            return error;
        }
        let current = git2::Repository::open(workdir)
            .map_err(TrunkError::from)
            .and_then(|current| snapshot(&current, path).map(|(_, _, revision)| revision));
        match current {
            Ok(revision) if revision == written => {
                error.working_revision = Some(written);
                error
            }
            Ok(_) => WorkingTreeEdit::changed(),
            Err(current) => current,
        }
    })
}

fn revision_of(
    repo: &git2::Repository,
    path: &str,
    working: &[u8],
    conflict: &git2::IndexConflict,
) -> Result<String, TrunkError> {
    Ok(merge_revision(
        working,
        conflict,
        conflict_marker_size(repo, path)?,
        git_merges_text(repo, path)?,
    )?)
}

fn snapshot<'a>(
    repo: &git2::Repository,
    path: &'a str,
) -> Result<(WorkingTreeEdit<'a>, git2::IndexConflict, String), TrunkError> {
    let conflict = check_text_sides(repo, path)?;
    let working = WorkingTreeEdit::open(repo, path).map_err(|_| WorkingTreeEdit::changed())?;
    let revision = revision_of(repo, path, working.bytes(), &conflict)?;
    Ok((working, conflict, revision))
}

pub(super) fn publish_index(
    repo: &git2::Repository,
    index_path: &Path,
    update: impl FnOnce(&mut git2::Index) -> Result<(), TrunkError>,
) -> Result<(), TrunkError> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("trunk-merge-index-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let dir = builder.tempdir_in(repo.path()).map_err(stage_error)?;
    let shadow = dir.path().join("index");
    let mut source = File::open(index_path).map_err(stage_error)?;
    let metadata = source.metadata().map_err(stage_error)?;
    {
        let mut copy = File::create_new(&shadow).map_err(stage_error)?;
        io::copy(&mut source, &mut copy).map_err(stage_error)?;
        copy.set_modified(metadata.modified().map_err(stage_error)?)
            .map_err(stage_error)?;
    }
    let mut index = git2::Index::open(&shadow)?;
    repo.set_index(&mut index)?;
    update(&mut index)?;
    index.write().map_err(stage_error)?;

    std::fs::set_permissions(&shadow, metadata.permissions()).map_err(stage_error)?;
    std::fs::rename(shadow, index_path).map_err(stage_error)
}

pub(super) fn stage_entry(
    index: &mut git2::Index,
    path: &str,
    object: Option<(git2::Oid, u32)>,
) -> Result<(), TrunkError> {
    index.remove_path(Path::new(path))?;
    let Some((id, mode)) = object else {
        return Ok(());
    };
    index.add(&git2::IndexEntry {
        id,
        mode,
        path: path.as_bytes().to_vec(),
        ctime: git2::IndexTime::new(0, 0),
        mtime: git2::IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        uid: 0,
        gid: 0,
        file_size: 0,
        flags: 0,
        flags_extended: 0,
    })?;
    Ok(())
}

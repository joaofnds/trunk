//! Reading a file's bytes at a given revision, and the sandbox that keeps those
//! reads inside the repository.
//!
//! Committed revs (Head/Index/Commit) resolve through git2 against a tree or the
//! index, so they can only name objects the repo already contains. `WorkingTree`
//! is the one variant that touches the filesystem, and it is therefore the only
//! one that needs a guard: [`read_working_tree_file`] canonicalizes both the repo
//! root and the target before comparing them, which defeats `..` traversal and
//! symlinks that point outside the tree.
//!
//! The guard is private and every path into it runs through
//! [`read_file_at_inner`], so a caller cannot reach the filesystem read without
//! passing the check.
//!
//! This module is independent of Tauri, `RepoState`, and IPC. Its generic
//! working-tree reader uses `std::fs`; current-file reads use capability-based
//! directory handles so no path component is followed as a link. The adapter
//! half — resolving a repo path out of the open-repo map, decoding
//! `trunk-asset://` URLs, and the `#[tauri::command]` wrapper — lives in
//! `commands/markdown.rs`.

use crate::error::TrunkError;
#[cfg(unix)]
use cap_fs_ext::OpenOptionsSyncExt;
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::Path;

/// Which version of a file to read.
///
/// Shared by `read_file_at`, the block-diff renderer, and the `trunk-asset://` protocol
/// handler so all agree on what "the file at this rev" means. The frontend derives it
/// from `diffKind` + side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RevSpec {
    WorkingTree,
    Index,
    Head,
    /// The file does not exist at this rev — e.g. the before side of a root
    /// commit (no parent tree). Every read maps to `not_found`, so the diff
    /// renders the present side alone.
    Empty,
    Commit {
        oid: String,
    },
}

impl RevSpec {
    /// Encode as the *host* of a `trunk-asset://<token>/<path>` URL. Kept
    /// colon-free (`commit-<oid>`, not `commit:<oid>`) so it is a valid URI
    /// authority — a colon there reads as `host:port` and the URL parser (and
    /// ammonia) reject it. The keywords can't collide with a hex oid, so
    /// decoding stays unambiguous.
    #[must_use]
    pub fn to_url_token(&self) -> String {
        match self {
            Self::WorkingTree => "working-tree".to_string(),
            Self::Index => "index".to_string(),
            Self::Head => "head".to_string(),
            Self::Empty => "empty".to_string(),
            Self::Commit { oid } => format!("commit-{oid}"),
        }
    }

    /// The rev a `trunk-asset://` URL token names.
    ///
    /// # Errors
    ///
    /// Returns `invalid_rev` when the token is not one of the fixed names and
    /// is not a `commit-<oid>` form.
    pub fn from_url_token(token: &str) -> Result<Self, TrunkError> {
        match token {
            "working-tree" => Ok(Self::WorkingTree),
            "index" => Ok(Self::Index),
            "head" => Ok(Self::Head),
            "empty" => Ok(Self::Empty),
            other => other
                .strip_prefix("commit-")
                .map(|oid| Self::Commit {
                    oid: oid.to_string(),
                })
                .ok_or_else(|| {
                    TrunkError::new("invalid_rev", format!("unknown rev token: {other}"))
                }),
        }
    }
}

/// Read a file's raw bytes at `rev`.
///
/// Committed revs (Head/Index/Commit) read git blobs from a tree/index and are
/// inherently sandboxed; the working-tree case is the only one that touches the
/// filesystem, so it rejects any path escaping the repo root (canonicalized to defeat
/// `..` and symlink traversal).
///
/// # Errors
///
/// Returns `not_found` for the empty rev or a path absent at that revision,
/// `bare_repo` when a working-tree read has no working tree, `invalid_oid` when
/// a commit rev will not parse, `not_a_blob` when the path is not a file, and
/// `io_error` when a working-tree file will not read or escapes the repository
/// root.
pub fn read_file_at_inner(
    repo: &git2::Repository,
    file_path: &str,
    rev: &RevSpec,
) -> Result<Vec<u8>, TrunkError> {
    match rev {
        RevSpec::WorkingTree => read_working_tree_file(repo, file_path),
        RevSpec::Index => read_index_blob(repo, file_path),
        RevSpec::Empty => Err(TrunkError::new(
            "not_found",
            format!("no file at the empty rev: {file_path}"),
        )),
        RevSpec::Head => {
            let head = repo.head().map_err(|e| match e.code() {
                git2::ErrorCode::UnbornBranch => TrunkError::new(
                    "not_found",
                    format!("no commit yet, so nothing at HEAD: {file_path}"),
                ),
                _ => e.into(),
            })?;
            let tree = head.peel_to_tree()?;
            read_tree_blob(repo, &tree, file_path)
        }
        RevSpec::Commit { oid } => {
            let oid = git2::Oid::from_str(oid)
                .map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
            let tree = repo.find_commit(oid)?.tree()?;
            read_tree_blob(repo, &tree, file_path)
        }
    }
}

fn read_working_tree_file(repo: &git2::Repository, file_path: &str) -> Result<Vec<u8>, TrunkError> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| TrunkError::new("bare_repo", "cannot read working tree of a bare repo"))?;
    let root = workdir
        .canonicalize()
        .map_err(|e| TrunkError::new("io_error", e.to_string()))?;
    let target = root
        .join(file_path)
        .canonicalize()
        .map_err(|e| TrunkError::new("not_found", format!("{file_path}: {e}")))?;
    if !target.starts_with(&root) {
        return Err(TrunkError::new(
            "path_escape",
            format!("path escapes repository root: {file_path}"),
        ));
    }
    std::fs::read(&target).map_err(|e| TrunkError::new("io_error", e.to_string()))
}

/// Read a regular working-tree file without following links below the workdir.
///
/// Unlike [`read_working_tree_file`], this operation is for current-file pins,
/// where following an in-repository link could expose ignored or Git-internal
/// content. It opens each component relative to a directory handle and reads
/// from the final admitted handle, so a rename cannot swap the checked object.
///
/// # Errors
///
/// Returns `not_found` for an invalid or missing path and for a refused link,
/// `bare_repo` when the repository has no workdir, and `io_error` for other
/// filesystem failures or a final object that is not a regular file.
pub fn read_working_tree_file_without_links(
    repo: &git2::Repository,
    file_path: &str,
) -> Result<Vec<u8>, TrunkError> {
    let path = ValidatedRelativePath::parse(file_path)?;
    read_validated_working_tree_file(repo, &path)
}

fn read_validated_working_tree_file(
    repo: &git2::Repository,
    path: &ValidatedRelativePath<'_>,
) -> Result<Vec<u8>, TrunkError> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| TrunkError::new("bare_repo", "cannot read working tree of a bare repo"))?;
    let mut directory = Dir::open_ambient_dir(workdir, cap_std::ambient_authority())
        .map_err(|error| io_error(path.input, error))?;

    for parent in &path.parents {
        directory = directory
            .open_dir_nofollow(parent)
            .map_err(|error| path_open_error(path.input, error))?;
    }

    let mut file = directory
        .open_with(path.file_name, &no_link_open_options())
        .map_err(|error| path_open_error(path.input, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| io_error(path.input, error))?;
    if metadata.file_type().is_symlink() {
        return Err(not_found(path.input));
    }

    if !metadata.is_file() {
        return Err(TrunkError::new(
            "io_error",
            format!("not a regular file: {}", path.input),
        ));
    }

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| io_error(path.input, error))?;
    Ok(bytes)
}

fn no_link_open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    options.nonblock(true);
    options
}

/// Read a current-file path only when the index records it as a regular file.
///
/// # Errors
///
/// Returns `not_found` when the path is not an admissible index path or its
/// index entry is absent or non-regular. Filesystem errors come from
/// [`read_working_tree_file_without_links`].
pub fn read_tracked_working_tree_file(
    repo: &git2::Repository,
    file_path: &str,
) -> Result<Vec<u8>, TrunkError> {
    let path = ValidatedRelativePath::parse(file_path)?;
    let index = repo.index().map_err(|_| not_found(file_path))?;
    if index
        .get_path(path.as_path(), 0)
        .is_none_or(|entry| entry.mode & 0o170_000 != 0o100_000)
    {
        return Err(not_found(file_path));
    }

    read_validated_working_tree_file(repo, &path)
}

struct ValidatedRelativePath<'a> {
    input: &'a str,
    parents: Vec<&'a OsStr>,
    file_name: &'a OsStr,
}

impl<'a> ValidatedRelativePath<'a> {
    fn parse(input: &'a str) -> Result<Self, TrunkError> {
        if input.is_empty() || input.contains('\0') {
            return Err(not_found(input));
        }

        let mut names = Vec::new();
        for component in Path::new(input).components() {
            let std::path::Component::Normal(name) = component else {
                return Err(not_found(input));
            };
            names.push(name);
        }
        let Some(file_name) = names.pop() else {
            return Err(not_found(input));
        };

        Ok(Self {
            input,
            parents: names,
            file_name,
        })
    }

    fn as_path(&self) -> &Path {
        Path::new(self.input)
    }
}

fn path_open_error(file_path: &str, error: io::Error) -> TrunkError {
    if matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    ) || is_refused_link(&error)
    {
        not_found(file_path)
    } else {
        io_error(file_path, error)
    }
}

#[cfg(unix)]
fn is_refused_link(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ELOOP)
}

#[cfg(windows)]
fn is_refused_link(error: &io::Error) -> bool {
    error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_STOPPED_ON_SYMLINK as i32)
}

fn not_found(file_path: &str) -> TrunkError {
    TrunkError::new("not_found", format!("file is unavailable: {file_path}"))
}

fn io_error(file_path: &str, error: io::Error) -> TrunkError {
    TrunkError::new("io_error", format!("{file_path}: {error}"))
}

fn read_index_blob(repo: &git2::Repository, file_path: &str) -> Result<Vec<u8>, TrunkError> {
    let index = repo.index()?;
    let entry = index
        .get_path(Path::new(file_path), 0)
        .ok_or_else(|| TrunkError::new("not_found", format!("not in index: {file_path}")))?;
    let blob = repo.find_blob(entry.id)?;
    Ok(blob.content().to_vec())
}

fn read_tree_blob(
    repo: &git2::Repository,
    tree: &git2::Tree,
    file_path: &str,
) -> Result<Vec<u8>, TrunkError> {
    let entry = tree
        .get_path(Path::new(file_path))
        .map_err(|_| TrunkError::new("not_found", format!("not in tree: {file_path}")))?;
    let obj = entry.to_object(repo)?;
    let blob = obj
        .as_blob()
        .ok_or_else(|| TrunkError::new("not_a_blob", format!("not a file: {file_path}")))?;
    Ok(blob.content().to_vec())
}

/// The one-file-at-three-revs fixture.
///
/// Lives here because it is a blob-reading fixture. The app's `commands/markdown.rs`
/// renderer tests share it through the `test-util` feature rather than keeping a
/// second copy in step with this one.
#[cfg(any(test, feature = "test-util"))]
pub mod test_repo {
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    /// # Panics
    ///
    /// Never in practice: the name and email are valid literals.
    #[must_use]
    pub fn sig() -> git2::Signature<'static> {
        git2::Signature::new("Test", "test@example.com", &git2::Time::new(0, 0)).unwrap()
    }

    /// Repo with `doc.md` committed as "committed", staged as "staged", and left
    /// as "workdir" in the working tree — so each rev returns a distinct value.
    ///
    /// # Panics
    ///
    /// When the temporary directory or any git write fails.
    #[must_use]
    pub fn with_three_revs() -> (TempDir, git2::Repository, git2::Oid) {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();

        fs::write(dir.path().join("doc.md"), b"committed").unwrap();
        let commit_oid = {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("doc.md")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let s = sig();
            repo.commit(Some("HEAD"), &s, &s, "initial", &tree, &[])
                .unwrap()
        };

        fs::write(dir.path().join("doc.md"), b"staged").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("doc.md")).unwrap();
            index.write().unwrap();
        }

        fs::write(dir.path().join("doc.md"), b"workdir").unwrap();

        (dir, repo, commit_oid)
    }
}

#[cfg(test)]
mod tests {
    use super::test_repo::with_three_revs;
    use super::*;

    #[test]
    fn reads_head_blob() {
        let (_dir, repo, _oid) = with_three_revs();
        let bytes = read_file_at_inner(&repo, "doc.md", &RevSpec::Head).unwrap();
        assert_eq!(bytes, b"committed");
    }

    #[test]
    fn reads_index_blob() {
        let (_dir, repo, _oid) = with_three_revs();
        let bytes = read_file_at_inner(&repo, "doc.md", &RevSpec::Index).unwrap();
        assert_eq!(bytes, b"staged");
    }

    #[test]
    fn reads_working_tree_file() {
        let (_dir, repo, _oid) = with_three_revs();
        let bytes = read_file_at_inner(&repo, "doc.md", &RevSpec::WorkingTree).unwrap();
        assert_eq!(bytes, b"workdir");
    }

    #[cfg(unix)]
    #[test]
    fn generic_working_tree_reads_follow_an_in_root_symlink() {
        let (dir, repo, _oid) = with_three_revs();
        std::fs::write(dir.path().join("target.md"), "linked target").unwrap();
        std::os::unix::fs::symlink("target.md", dir.path().join("link.md")).unwrap();

        let bytes = read_file_at_inner(&repo, "link.md", &RevSpec::WorkingTree).unwrap();

        assert_eq!(bytes, b"linked target");
    }

    #[test]
    fn reads_commit_blob() {
        let (_dir, repo, oid) = with_three_revs();
        let rev = RevSpec::Commit {
            oid: oid.to_string(),
        };
        let bytes = read_file_at_inner(&repo, "doc.md", &rev).unwrap();
        assert_eq!(bytes, b"committed");
    }

    #[test]
    fn empty_rev_reads_as_not_found() {
        let (_dir, repo, _oid) = with_three_revs();
        let err = read_file_at_inner(&repo, "doc.md", &RevSpec::Empty).unwrap_err();
        assert_eq!(
            err.code, "not_found",
            "the Empty rev has no file at any path: {err:?}"
        );
    }

    #[test]
    fn rejects_working_tree_path_escape() {
        let (_dir, repo, _oid) = with_three_revs();
        let err = read_file_at_inner(&repo, "../../../../../../etc/hosts", &RevSpec::WorkingTree)
            .unwrap_err();
        // A path resolving outside the repo is either rejected as an escape or
        // never found — both keep the file's bytes from leaving the sandbox.
        assert!(
            err.code == "path_escape" || err.code == "not_found",
            "expected escape/not_found, got {}",
            err.code
        );
    }

    #[test]
    fn rev_url_token_round_trips() {
        for rev in [
            RevSpec::WorkingTree,
            RevSpec::Index,
            RevSpec::Head,
            RevSpec::Empty,
            RevSpec::Commit {
                oid: "deadbeef".to_string(),
            },
        ] {
            let token = rev.to_url_token();
            assert_eq!(RevSpec::from_url_token(&token).unwrap(), rev);
        }
    }

    #[test]
    fn rev_url_token_rejects_garbage() {
        assert!(RevSpec::from_url_token("not-a-rev").is_err());
    }
}

#[cfg(all(test, unix))]
mod no_link_tests {
    use super::*;
    use std::fs;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use tempfile::TempDir;

    fn repo_with_tracked_file(path: &str, content: &str) -> (TempDir, git2::Repository) {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let file = dir.path().join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(path)).unwrap();
        index.write().unwrap();
        drop(index);
        (dir, repo)
    }

    #[test]
    fn no_link_read_returns_nested_regular_file_bytes() {
        let (_dir, repo) = repo_with_tracked_file("nested/file.txt", "ordinary");

        let bytes = read_working_tree_file_without_links(&repo, "nested/file.txt").unwrap();

        assert_eq!(bytes, b"ordinary");
    }

    #[test]
    fn no_link_read_preserves_the_bare_repo_error() {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init_bare(dir.path()).unwrap();

        let error = read_working_tree_file_without_links(&repo, "file.txt").unwrap_err();

        assert_eq!(error.code, "bare_repo");
    }

    #[test]
    fn no_link_read_refuses_a_final_symlink() {
        let (dir, repo) = repo_with_tracked_file("target.txt", "DUMMY_SECRET");
        std::os::unix::fs::symlink("target.txt", dir.path().join("link.txt")).unwrap();

        let error = read_working_tree_file_without_links(&repo, "link.txt").unwrap_err();

        assert_eq!(error.code, "not_found");
        assert!(!error.message.contains("DUMMY_SECRET"));
    }

    #[test]
    fn no_link_read_refuses_a_symlinked_parent() {
        let (dir, repo) = repo_with_tracked_file("protected/secret.txt", "DUMMY_SECRET");
        std::os::unix::fs::symlink("protected", dir.path().join("alias")).unwrap();

        let error = read_working_tree_file_without_links(&repo, "alias/secret.txt").unwrap_err();

        assert_eq!(error.code, "not_found");
        assert!(!error.message.contains("DUMMY_SECRET"));
    }

    #[test]
    fn no_link_read_reports_a_directory_as_io_error() {
        let (dir, repo) = repo_with_tracked_file("tracked.txt", "ordinary");
        fs::create_dir(dir.path().join("directory")).unwrap();

        let error = read_working_tree_file_without_links(&repo, "directory").unwrap_err();

        assert_eq!(error.code, "io_error");
    }

    #[test]
    fn no_link_read_reports_permission_denied_as_io_error() {
        let (dir, repo) = repo_with_tracked_file("private.txt", "ordinary");
        let path = dir.path().join("private.txt");
        let original = fs::metadata(&path).unwrap().permissions();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o0)).unwrap();

        let result = read_working_tree_file_without_links(&repo, "private.txt");

        fs::set_permissions(&path, original).unwrap();
        assert_eq!(result.unwrap_err().code, "io_error");
    }

    #[test]
    fn no_link_read_reports_a_fifo_as_an_io_error() {
        let (dir, repo) = repo_with_tracked_file("pipe", "ordinary");
        fs::remove_file(dir.path().join("pipe")).unwrap();
        let status = Command::new("mkfifo")
            .arg(dir.path().join("pipe"))
            .status()
            .unwrap();
        assert!(status.success());
        let _writer = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(dir.path().join("pipe"))
            .unwrap();

        let result = read_tracked_working_tree_file(&repo, "pipe");

        assert_eq!(result.unwrap_err().code, "io_error");
    }

    #[test]
    fn no_link_final_open_is_nonblocking() {
        let (dir, _repo) = repo_with_tracked_file("pipe", "ordinary");
        fs::remove_file(dir.path().join("pipe")).unwrap();
        let status = Command::new("mkfifo")
            .arg(dir.path().join("pipe"))
            .status()
            .unwrap();
        assert!(status.success());
        let _writer = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(dir.path().join("pipe"))
            .unwrap();
        let directory = Dir::open_ambient_dir(dir.path(), cap_std::ambient_authority()).unwrap();
        let file = directory
            .open_with("pipe", &no_link_open_options())
            .unwrap();

        // SAFETY: F_GETFL only queries the valid descriptor borrowed from `file`.
        let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };

        assert_ne!(flags, -1);
        assert_ne!(flags & libc::O_NONBLOCK, 0);
    }

    macro_rules! rejects_invalid_path {
        ($($name:ident => $path:expr;)*) => {
            $(
                #[test]
                fn $name() {
                    let (_dir, repo) = repo_with_tracked_file("tracked.txt", "ordinary");

                    let error =
                        read_working_tree_file_without_links(&repo, $path).unwrap_err();

                    assert_eq!(error.code, "not_found");
                }
            )*
        };
    }

    rejects_invalid_path! {
        no_link_read_rejects_an_empty_path => "";
        no_link_read_rejects_the_current_directory => ".";
        no_link_read_rejects_a_parent_component => "../tracked.txt";
        no_link_read_rejects_an_absolute_path => "/tracked.txt";
        no_link_read_rejects_a_nul_byte => "a\0b";
    }
}

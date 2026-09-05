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
//! This module is pure git2 + `std::fs`: no Tauri, no `RepoState`, no IPC. The
//! adapter half — resolving a repo path out of the open-repo map, decoding
//! `trunk-asset://` URLs, and the `#[tauri::command]` wrapper — lives in
//! `commands/markdown.rs`.

use crate::error::TrunkError;
use serde::{Deserialize, Serialize};
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

/// The one-file-at-three-revs fixture. Lives here because it is a blob-reading
/// fixture; `commands/markdown.rs`'s renderer tests share it rather than keeping
/// a second copy in step with this one.
#[cfg(test)]
pub(crate) mod test_repo {
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    pub fn sig() -> git2::Signature<'static> {
        git2::Signature::new("Test", "test@example.com", &git2::Time::new(0, 0)).unwrap()
    }

    /// Repo with `doc.md` committed as "committed", staged as "staged", and left
    /// as "workdir" in the working tree — so each rev returns a distinct value.
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

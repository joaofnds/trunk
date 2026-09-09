//! Enumerating the files a repository tracks, marking the ones a pending change
//! touches.
//!
//! This is the file finder's source list. It reads the index rather than walking
//! the working tree, which is what keeps untracked and ignored files out: a file
//! git does not track has no index entry, so it cannot appear here and cannot be
//! opened through the finder.
//!
//! "Changed" is [`status::DIRTY_BITS`], the same definition the dirty counters
//! and the graph walk use, so the finder's marking cannot drift from what the
//! rest of the app calls a change.

use crate::error::TrunkError;
use crate::git::status::{DIRTY_BITS, dirty_status_options};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// One row of the finder's source list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackedFile {
    pub path: String,
    /// Whether a staged or unstaged change touches this file.
    pub changed: bool,
}

/// List every file the repository tracks, marking the ones a pending change touches.
///
/// Paths are the index's own, forward-slash separated and relative to the repo
/// root, sorted so the listing is stable across calls.
///
/// # Errors
///
/// Returns the git error when the index or the status scan will not read.
pub fn tracked_files(repo: &git2::Repository) -> Result<Vec<TrackedFile>, TrunkError> {
    let changed = changed_paths(repo)?;

    let index = repo.index()?;
    let mut files: Vec<TrackedFile> = index
        .iter()
        .filter_map(|entry| String::from_utf8(entry.path).ok())
        .map(|path| TrackedFile {
            changed: changed.contains(&path),
            path,
        })
        .collect();

    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| a.path == b.path);
    Ok(files)
}

/// The paths a staged or unstaged change touches, by the app's one definition of dirty.
fn changed_paths(repo: &git2::Repository) -> Result<HashSet<String>, TrunkError> {
    let mut opts = dirty_status_options();
    let statuses = repo.statuses(Some(&mut opts))?;

    Ok(statuses
        .iter()
        .filter(|entry| entry.status().intersects(DIRTY_BITS))
        .filter_map(|entry| entry.path().ok().map(str::to_owned))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn sig() -> git2::Signature<'static> {
        git2::Signature::new("Test", "test@example.com", &git2::Time::new(0, 0)).unwrap()
    }

    /// Init a repo and commit the named files, so each is tracked and unchanged.
    fn repo_tracking(files: &[(&str, &str)]) -> (TempDir, git2::Repository) {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();

        {
            let mut index = repo.index().unwrap();
            for (path, content) in files {
                let full = dir.path().join(path);
                if let Some(parent) = full.parent() {
                    fs::create_dir_all(parent).unwrap();
                }
                fs::write(&full, content).unwrap();
                index.add_path(std::path::Path::new(path)).unwrap();
            }
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let s = sig();
            repo.commit(Some("HEAD"), &s, &s, "initial", &tree, &[])
                .unwrap();
        }

        (dir, repo)
    }

    fn paths(files: &[TrackedFile]) -> Vec<&str> {
        files.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn lists_tracked_files_excluding_untracked() {
        let (dir, repo) = repo_tracking(&[("tracked.txt", "one\n")]);
        fs::write(dir.path().join("untracked.txt"), "two\n").unwrap();

        let files = tracked_files(&repo).unwrap();

        assert_eq!(paths(&files), vec!["tracked.txt"]);
    }

    #[test]
    fn marks_changed_files() {
        let (dir, repo) = repo_tracking(&[("edited.txt", "one\n"), ("untouched.txt", "two\n")]);
        fs::write(dir.path().join("edited.txt"), "edited\n").unwrap();

        let files = tracked_files(&repo).unwrap();

        assert_eq!(
            files,
            vec![
                TrackedFile {
                    path: "edited.txt".to_string(),
                    changed: true,
                },
                TrackedFile {
                    path: "untouched.txt".to_string(),
                    changed: false,
                },
            ]
        );
    }

    #[test]
    fn an_ignored_file_is_absent() {
        let (dir, repo) = repo_tracking(&[(".gitignore", "secret.txt\n")]);
        fs::write(dir.path().join("secret.txt"), "hidden\n").unwrap();

        let files = tracked_files(&repo).unwrap();

        assert_eq!(paths(&files), vec![".gitignore"]);
    }

    #[test]
    fn lists_paths_in_sorted_order() {
        let (_dir, repo) = repo_tracking(&[
            ("src/z.rs", "z\n"),
            ("README.md", "r\n"),
            ("src/a.rs", "a\n"),
        ]);

        let files = tracked_files(&repo).unwrap();

        assert_eq!(paths(&files), vec!["README.md", "src/a.rs", "src/z.rs"]);
    }

    #[test]
    fn a_staged_change_marks_the_file_changed() {
        let (dir, repo) = repo_tracking(&[("staged.txt", "one\n")]);
        fs::write(dir.path().join("staged.txt"), "two\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("staged.txt")).unwrap();
        index.write().unwrap();
        drop(index);

        let files = tracked_files(&repo).unwrap();

        assert!(files[0].changed);
    }
}

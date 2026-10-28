//! The pull safety copy: a stash entry of the user's tracked changes, saved before git
//! runs a pull and kept only when the pull leaves the repository mid-operation.

use crate::error::TrunkError;
use crate::repository::{has_unmerged_paths, is_repo_dirty, stash_position};

pub const MESSAGE: &str = "Trunk: changes before pull";

const FALLBACK_NAME: &str = "Trunk";
const FALLBACK_EMAIL: &str = "trunk@localhost";

/// What leaves a repository mid-operation after a pull.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Markers {
    pub rebase: bool,
    pub merge: bool,
    pub merge_autostash: bool,
    pub conflicted: bool,
}

impl Markers {
    /// A rebase is read from its directory alone, never from a file inside it: a pull
    /// killed after git took its autostash leaves `rebase-merge` holding only
    /// `autostash`.
    ///
    /// # Errors
    ///
    /// Returns the git error when the status walk fails.
    pub fn read(repo: &git2::Repository) -> Result<Self, TrunkError> {
        let git_dir = repo.path();
        Ok(Self {
            rebase: git_dir.join("rebase-merge").is_dir() || git_dir.join("rebase-apply").is_dir(),
            merge: git_dir.join("MERGE_HEAD").exists(),
            merge_autostash: git_dir.join("MERGE_AUTOSTASH").exists(),
            conflicted: has_unmerged_paths(repo)?,
        })
    }

    /// Whether `after` holds a marker this reading did not.
    #[must_use]
    pub const fn gained_in(self, after: Self) -> bool {
        (after.rebase && !self.rebase)
            || (after.merge && !self.merge)
            || (after.merge_autostash && !self.merge_autostash)
            || (after.conflicted && !self.conflicted)
    }
}

/// A copy saved before a pull, with the markers the repository held at that moment.
#[derive(Debug)]
pub struct PullSafetyCopy {
    oid: git2::Oid,
    before: Markers,
}

impl PullSafetyCopy {
    /// Saves the copy when tracked files differ from HEAD and nothing is conflicted,
    /// and returns `None` when there is nothing to guard. `KEEP_ALL` leaves the index
    /// and the working tree as they were, so git starts from the tree the user had.
    ///
    /// # Errors
    ///
    /// Returns the git error when the tree cannot be read or the entry cannot be
    /// written. The caller then runs the pull without a copy, as git alone would.
    pub fn save(repo: &mut git2::Repository) -> Result<Option<Self>, TrunkError> {
        if !is_repo_dirty(repo)? {
            return Ok(None);
        }

        let before = Markers::read(repo)?;
        if before.conflicted {
            return Ok(None);
        }

        let signature = copy_signature(repo.signature())?;
        let oid = repo.stash_save(&signature, MESSAGE, Some(git2::StashFlags::KEEP_ALL))?;
        Ok(Some(Self { oid, before }))
    }

    /// Whether the copy stays in the stash list: it does when the pull left behind a
    /// marker it did not find, and is dropped by oid otherwise. A copy whose fate
    /// cannot be read, or whose drop fails, stays, since a spare entry costs the user
    /// one drop and a lost one costs their work.
    pub fn settle(self, repo: &mut git2::Repository) -> bool {
        let gained = Markers::read(repo).map_or(true, |after| self.before.gained_in(after));
        if gained {
            return true;
        }

        let Ok(position) = stash_position(repo, self.oid) else {
            return true;
        };
        let Some(position) = position else {
            return false;
        };
        repo.stash_drop(position).is_err()
    }
}

/// The repository's identity, or the fixed one when none is configured, since git's
/// own autostash derives one there and the copy must guard that pull too.
fn copy_signature(
    configured: Result<git2::Signature<'static>, git2::Error>,
) -> Result<git2::Signature<'static>, git2::Error> {
    match configured {
        Err(error) if error.code() == git2::ErrorCode::NotFound => {
            git2::Signature::now(FALLBACK_NAME, FALLBACK_EMAIL)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Markers = Markers {
        rebase: false,
        merge: false,
        merge_autostash: false,
        conflicted: false,
    };

    #[test]
    fn a_rebase_the_pull_left_behind_keeps_the_copy() {
        assert!(NONE.gained_in(Markers {
            rebase: true,
            ..NONE
        }));
    }

    #[test]
    fn a_merge_the_pull_left_behind_keeps_the_copy() {
        assert!(NONE.gained_in(Markers {
            merge: true,
            ..NONE
        }));
    }

    #[test]
    fn a_held_merge_autostash_the_pull_left_behind_keeps_the_copy() {
        assert!(NONE.gained_in(Markers {
            merge_autostash: true,
            ..NONE
        }));
    }

    #[test]
    fn conflicted_files_the_pull_left_behind_keep_the_copy() {
        assert!(NONE.gained_in(Markers {
            conflicted: true,
            ..NONE
        }));
    }

    #[test]
    fn a_marker_present_before_the_pull_does_not_keep_the_copy() {
        let merging = Markers {
            merge: true,
            ..NONE
        };

        assert!(!merging.gained_in(merging));
    }

    #[test]
    fn a_marker_the_pull_cleared_does_not_keep_the_copy() {
        let rebasing = Markers {
            rebase: true,
            ..NONE
        };

        assert!(!rebasing.gained_in(NONE));
    }

    #[test]
    fn a_repository_without_an_identity_signs_the_copy_as_trunk() {
        let missing = git2::Error::new(
            git2::ErrorCode::NotFound,
            git2::ErrorClass::Config,
            "config value 'user.name' was not found",
        );

        let signature = copy_signature(Err(missing)).unwrap();

        assert_eq!(
            (signature.name(), signature.email()),
            (Ok("Trunk"), Ok("trunk@localhost"))
        );
    }

    #[test]
    fn an_identity_that_will_not_parse_is_not_replaced() {
        let malformed = git2::Error::new(
            git2::ErrorCode::GenericError,
            git2::ErrorClass::Invalid,
            "failed to parse signature",
        );

        assert!(copy_signature(Err(malformed)).is_err());
    }

    fn git_dir_with(entries: &[&str]) -> (tempfile::TempDir, git2::Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        for entry in entries {
            let path = repo.path().join(entry);
            if entry.ends_with("_HEAD") || entry.ends_with("AUTOSTASH") {
                std::fs::write(path, "0000000000000000000000000000000000000000\n").unwrap();
            } else {
                std::fs::create_dir(path).unwrap();
            }
        }
        (dir, repo)
    }

    #[test]
    fn reads_a_rebase_from_a_rebase_merge_directory_alone() {
        let (_dir, repo) = git_dir_with(&["rebase-merge"]);

        assert_eq!(
            Markers::read(&repo).unwrap(),
            Markers {
                rebase: true,
                ..NONE
            }
        );
    }

    #[test]
    fn reads_a_rebase_from_a_rebase_apply_directory() {
        let (_dir, repo) = git_dir_with(&["rebase-apply"]);

        assert_eq!(
            Markers::read(&repo).unwrap(),
            Markers {
                rebase: true,
                ..NONE
            }
        );
    }

    #[test]
    fn reads_a_merge_from_merge_head() {
        let (_dir, repo) = git_dir_with(&["MERGE_HEAD"]);

        assert_eq!(
            Markers::read(&repo).unwrap(),
            Markers {
                merge: true,
                ..NONE
            }
        );
    }

    #[test]
    fn reads_a_held_merge_autostash_from_merge_autostash() {
        let (_dir, repo) = git_dir_with(&["MERGE_AUTOSTASH"]);

        assert_eq!(
            Markers::read(&repo).unwrap(),
            Markers {
                merge_autostash: true,
                ..NONE
            }
        );
    }
}

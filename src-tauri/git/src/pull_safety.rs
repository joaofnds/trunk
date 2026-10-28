//! The pull safety copy: a stash entry of the user's tracked changes, saved before git
//! runs a pull and kept only when the pull leaves the repository mid-operation.

use crate::error::TrunkError;
use crate::repository::{has_unmerged_paths, is_repo_dirty, stash_position};

pub const MESSAGE: &str = "Trunk: changes before pull";

/// The fixed identity a copy is signed with when the repository has none, since git's
/// own autostash still runs there and the copy must guard that pull too.
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
    /// Saves the copy when tracked files differ from HEAD and nothing is conflicted.
    /// `KEEP_ALL` leaves the index and the working tree as they were, so git starts
    /// from the tree the user had. Any failure means no copy, and the pull runs as it
    /// would without Trunk.
    pub fn save(repo: &mut git2::Repository) -> Option<Self> {
        let before = Markers::read(repo).ok()?;
        if before.conflicted || !is_repo_dirty(repo).ok()? {
            return None;
        }

        let signature = stasher(repo.signature()).ok()?;
        let oid = repo
            .stash_save(&signature, MESSAGE, Some(git2::StashFlags::KEEP_ALL))
            .ok()?;
        Some(Self { oid, before })
    }

    /// Keeps the copy when the pull left behind a marker it did not find, and drops it
    /// by oid otherwise. Returns the kept copy's message, for the pull's report. A copy
    /// whose fate cannot be read is kept, since a spare entry costs the user one drop
    /// and a lost one costs their work.
    pub fn settle(self, repo: &mut git2::Repository) -> Option<&'static str> {
        let gained = Markers::read(repo).map_or(true, |after| self.before.gained_in(after));
        if gained {
            return Some(MESSAGE);
        }

        match stash_position(repo, self.oid) {
            Ok(Some(position)) if repo.stash_drop(position).is_ok() => None,
            Ok(None) => None,
            _ => Some(MESSAGE),
        }
    }
}

fn stasher(
    configured: Result<git2::Signature<'static>, git2::Error>,
) -> Result<git2::Signature<'static>, git2::Error> {
    configured.or_else(|_| git2::Signature::now(FALLBACK_NAME, FALLBACK_EMAIL))
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
        let missing = git2::Error::from_str("config value 'user.name' was not found");

        let signature = stasher(Err(missing)).unwrap();

        assert_eq!(
            (signature.name(), signature.email()),
            (Ok("Trunk"), Ok("trunk@localhost"))
        );
    }
}

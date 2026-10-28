//! Which worktree holds a branch, and what removing a linked one would lose.

use crate::error::TrunkError;
use git2::{Repository, StatusOptions, WorktreePruneOptions};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The linked worktree the user agreed to remove so its branch can be deleted.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct WorktreeRemoval {
    pub name: String,
    pub path: String,
    pub go_ahead: bool,
}

/// What deleting a local branch would have to do about the worktree holding it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BranchHold {
    NotHeld,
    /// The main worktree has it checked out, which libgit2 refuses to delete.
    HeldByMain,
    Offer {
        name: String,
        path: String,
    },
    Warn {
        name: String,
        path: String,
        reasons: Vec<RemovalRisk>,
    },
    /// Removing would be wrong whatever the user agrees to, so nothing is offered.
    Refuse {
        paths: Vec<String>,
        reason: Refusal,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    /// The worktree's `.git` file does not point back at its admin entry, so the
    /// directory is not this worktree. Git refuses this even with `--force --force`.
    Mismatched,
    SeveralHolders,
    /// The tab's watcher and any remote operation it runs live on this directory.
    OpenInTab,
    /// Deleting the branch under a rebase makes `git rebase --continue` fail.
    Rebasing,
    /// Git still counts the branch as used by a worktree whose directory is gone, as when
    /// it sits on an unmounted drive.
    Missing,
}

/// Why removing a linked worktree may lose work.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RemovalRisk {
    /// Uncommitted, staged, conflicted or untracked changes.
    Changes,
    /// The status could not be read at all.
    Unchecked,
    Locked {
        reason: Option<String>,
    },
    /// Submodule commits may exist only inside this worktree or its admin entry.
    Submodules,
}

impl Refusal {
    fn explain(self, paths: &str) -> String {
        match self {
            Self::Mismatched => {
                format!("the worktree at {paths} does not point back at this repository")
            }
            Self::SeveralHolders => {
                format!("the worktrees at {paths} all use the branch")
            }
            Self::OpenInTab => {
                format!("the worktree at {paths} is open in a tab: close it, then delete again")
            }
            Self::Rebasing => format!("the worktree at {paths} is rebasing the branch"),
            Self::Missing => format!("the worktree at {paths}, which uses the branch, is missing"),
        }
    }
}

/// How a worktree uses a branch. Git refuses to delete a branch any worktree uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BranchUse {
    CheckedOut,
    Rebasing,
    /// Named in a `rebase --update-refs` todo, which moves it when the rebase finishes.
    MovedByRebase,
    Bisecting,
}

/// The branches the worktree whose git directory is `git_dir` uses, each as the full ref
/// name in the bytes git wrote, so a caller can match names exactly. `git_dir` is the common directory for the main
/// worktree, or a linked worktree's admin entry.
pub(crate) fn branches_used(git_dir: &Path) -> Vec<(BranchUse, Vec<u8>)> {
    let mut used = Vec::new();

    if let Some(name) = read_trimmed(&git_dir.join("HEAD")).and_then(|head| {
        head.strip_prefix(b"ref:")
            .map(|name| name.trim_ascii().to_vec())
    }) {
        used.push((BranchUse::CheckedOut, name));
    }

    for rebase in ["rebase-merge", "rebase-apply"] {
        if let Some(name) = read_trimmed(&git_dir.join(rebase).join("head-name"))
            .filter(|name| name.starts_with(b"refs/"))
        {
            used.push((BranchUse::Rebasing, name));
        }
    }

    if let Some(update_refs) = read_trimmed(&git_dir.join("rebase-merge").join("update-refs")) {
        // Each ref takes three lines: its name, then its oid before and after the rebase.
        for name in update_refs.split(|byte| *byte == b'\n').step_by(3) {
            used.push((BranchUse::MovedByRebase, name.trim_ascii().to_vec()));
        }
    }

    if let Some(start) = read_trimmed(&git_dir.join("BISECT_START")) {
        used.push((BranchUse::Bisecting, [b"refs/heads/", &start[..]].concat()));
    }

    used
}

fn read_trimmed(path: &Path) -> Option<Vec<u8>> {
    std::fs::read(path)
        .ok()
        .map(|bytes| bytes.trim_ascii().to_vec())
}

struct LinkedWorktree {
    name: String,
    admin: PathBuf,
    /// The `.git` path the admin entry records, whose parent prune deletes.
    gitfile: PathBuf,
    root: PathBuf,
    missing: bool,
    rebasing: bool,
}

/// Find who holds `branch` and, for a linked worktree, what removing it would lose.
/// `open_tabs` are the locations of the repositories open in Trunk.
///
/// # Errors
///
/// Returns the git error when the repository's worktrees will not list.
pub fn assess(
    repo: &Repository,
    branch: &str,
    open_tabs: &[PathBuf],
) -> Result<BranchHold, TrunkError> {
    let target = format!("refs/heads/{branch}");
    let common = repo.commondir();

    if !Repository::open(common)?.is_bare()
        && branches_used(common).contains(&(BranchUse::CheckedOut, target.clone().into_bytes()))
    {
        return Ok(BranchHold::HeldByMain);
    }

    let mut holders = linked_holders(repo, &target)?;
    if holders.len() > 1 {
        let mut paths: Vec<String> = holders
            .iter()
            .map(|holder| holder.root.display().to_string())
            .collect();
        paths.sort();
        return Ok(BranchHold::Refuse {
            paths,
            reason: Refusal::SeveralHolders,
        });
    }
    let Some(holder) = holders.pop() else {
        return Ok(BranchHold::NotHeld);
    };

    let refusal = if holder.rebasing {
        Some(Refusal::Rebasing)
    } else if holder.missing {
        Some(Refusal::Missing)
    } else if !points_back(&holder) {
        Some(Refusal::Mismatched)
    } else if open_tabs.iter().any(|tab| tab.starts_with(&holder.root)) {
        Some(Refusal::OpenInTab)
    } else {
        None
    };
    if let Some(reason) = refusal {
        return Ok(BranchHold::Refuse {
            paths: vec![holder.root.display().to_string()],
            reason,
        });
    }

    let reasons = risks(&holder);
    let path = holder.root.display().to_string();
    if reasons.is_empty() {
        Ok(BranchHold::Offer {
            name: holder.name,
            path,
        })
    } else {
        Ok(BranchHold::Warn {
            name: holder.name,
            path,
            reasons,
        })
    }
}

/// Check that no linked worktree took `branch` after the user was asked to delete it
/// with none to remove.
///
/// # Errors
///
/// Returns `worktree_changed` when a linked worktree now holds the branch, and the git
/// error when the repository's worktrees will not list.
pub fn ensure_no_linked_holder(
    repo: &Repository,
    branch: &str,
    open_tabs: &[PathBuf],
) -> Result<(), TrunkError> {
    match assess(repo, branch, open_tabs)? {
        BranchHold::NotHeld | BranchHold::HeldByMain => Ok(()),
        _ => Err(TrunkError::new(
            "worktree_changed",
            format!("a worktree now holds {branch}, so nothing was deleted"),
        )),
    }
}

/// Remove the worktree the user agreed to remove, after checking it is still the one
/// holding `branch` and, without the go-ahead, that it still risks nothing.
///
/// # Errors
///
/// Returns `worktree_refused` when removing it would be wrong whatever the user agrees
/// to, `worktree_changed` when another worktree now holds the branch,
/// `worktree_at_risk` when the worktree may hold work and the user has not gone ahead,
/// `worktree_not_removed` when the worktree will not prune, and `worktree_partly_removed`
/// when it was unregistered but some of its files could not be deleted.
pub fn remove(
    repo: &Repository,
    branch: &str,
    removal: &WorktreeRemoval,
    open_tabs: &[PathBuf],
) -> Result<(), TrunkError> {
    match assess(repo, branch, open_tabs)? {
        BranchHold::Offer { name, path } if name == removal.name && path == removal.path => {}
        BranchHold::Warn { name, path, .. } if name == removal.name && path == removal.path => {
            if !removal.go_ahead {
                return Err(TrunkError::new(
                    "worktree_at_risk",
                    format!("the worktree at {path} may hold work that removing it would lose"),
                ));
            }
        }
        BranchHold::Refuse { paths, reason } => {
            return Err(TrunkError::new(
                "worktree_refused",
                format!(
                    "{}, so nothing was removed",
                    reason.explain(&paths.join(" and "))
                ),
            ));
        }
        _ => {
            return Err(TrunkError::new(
                "worktree_changed",
                format!("the worktree holding {branch} changed, so nothing was removed"),
            ));
        }
    }

    let admin = repo.commondir().join("worktrees").join(&removal.name);
    let pruned = repo.find_worktree(&removal.name).and_then(|worktree| {
        worktree.prune(Some(
            WorktreePruneOptions::new()
                .valid(true)
                .working_tree(true)
                .locked(removal.go_ahead),
        ))
    });
    let path = &removal.path;
    if let Err(error) = pruned
        && admin.exists()
    {
        return Err(TrunkError::new(
            "worktree_not_removed",
            format!(
                "the worktree at {path} was not removed: {}",
                error.message()
            ),
        ));
    }

    // libgit2 stops at the first entry it cannot delete, and deletes nothing at all when
    // the recorded path is a symlink to the checkout, so finish the job and report what
    // still cannot go.
    let root = Path::new(path);
    delete_what_can_be_deleted(root);
    if root.symlink_metadata().is_err() {
        return Ok(());
    }
    Err(TrunkError::new(
        "worktree_partly_removed",
        format!(
            "the worktree at {path} was unregistered but some files could not be deleted: {}",
            left_behind(root).join(", ")
        ),
    ))
}

/// Delete every entry under `dir`, then `dir`, skipping what cannot be deleted. Symlinks
/// are deleted, never followed.
fn delete_what_can_be_deleted(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                delete_what_can_be_deleted(&path);
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    let _ = std::fs::remove_dir(dir);
}

/// Up to `SHOWN` of the files, and the directories that cannot be read, still under
/// `root`. The walk stops past `SHOWN`, since it runs while the repository's graph waits.
fn left_behind(root: &Path) -> Vec<String> {
    const SHOWN: usize = 10;

    let mut left = Vec::new();
    collect_left_behind(root, SHOWN + 1, &mut left);
    if left.len() > SHOWN {
        left.truncate(SHOWN);
        left.push("and more".to_owned());
    }
    left
}

fn collect_left_behind(dir: &Path, limit: usize, left: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        left.push(dir.display().to_string());
        return;
    };
    for entry in entries.flatten() {
        if left.len() >= limit {
            return;
        }
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            collect_left_behind(&path, limit, left);
        } else {
            left.push(path.display().to_string());
        }
    }
}

fn linked_holders(repo: &Repository, target: &str) -> Result<Vec<LinkedWorktree>, TrunkError> {
    let common = repo.commondir();
    let mut holders = Vec::new();

    for name in repo
        .worktrees()?
        .iter()
        .filter_map(|name| name.ok().flatten())
    {
        let admin = common.join("worktrees").join(name);
        let mut held = false;
        let mut rebasing = false;
        for (how, branch) in branches_used(&admin) {
            if branch != target.as_bytes() {
                continue;
            }
            match how {
                BranchUse::CheckedOut => held = true,
                BranchUse::Rebasing | BranchUse::MovedByRebase => {
                    held = true;
                    rebasing = true;
                }
                BranchUse::Bisecting => {}
            }
        }
        if !held {
            continue;
        }

        let Some(gitfile) = recorded_gitfile(&admin) else {
            continue;
        };

        let Some(recorded) = gitfile.parent() else {
            continue;
        };

        let resolved = recorded.canonicalize();
        let missing = resolved.is_err();
        let root = resolved.unwrap_or_else(|_| resolve_what_exists(recorded));

        holders.push(LinkedWorktree {
            name: name.to_owned(),
            admin,
            gitfile,
            root,
            missing,
            rebasing,
        });
    }

    Ok(holders)
}

/// `path` with its longest existing prefix resolved, as git names a worktree whose
/// directory is gone.
fn resolve_what_exists(path: &Path) -> PathBuf {
    for existing in path.ancestors() {
        if let (Ok(resolved), Ok(rest)) = (existing.canonicalize(), path.strip_prefix(existing)) {
            return resolved.join(rest);
        }
    }
    path.to_path_buf()
}

fn recorded_gitfile(admin: &Path) -> Option<PathBuf> {
    Some(admin.join(read_lossy(&admin.join("gitdir"))?.trim()))
}

/// Whether the recorded `.git` file names this admin entry, as git checks before it
/// removes a worktree. libgit2 checks only that the paths exist.
fn points_back(holder: &LinkedWorktree) -> bool {
    if holder.gitfile.file_name() != Some(".git".as_ref()) {
        return false;
    }
    let Some(contents) = read_lossy(&holder.gitfile) else {
        return false;
    };
    let Some(target) = contents.strip_prefix("gitdir:") else {
        return false;
    };

    let target = holder.root.join(target.trim());
    match (target.canonicalize(), holder.admin.canonicalize()) {
        (Ok(target), Ok(admin)) => target == admin,
        _ => false,
    }
}

fn risks(holder: &LinkedWorktree) -> Vec<RemovalRisk> {
    let mut reasons = Vec::new();

    match Repository::open(&holder.root) {
        Ok(worktree) => {
            reasons.extend(status_risk(&worktree));
            reasons.extend(gitlink_risk(&worktree, &holder.root));
        }
        Err(_) => reasons.push(RemovalRisk::Unchecked),
    }

    let lock = holder.admin.join("locked");
    if lock.symlink_metadata().is_ok() {
        reasons.push(RemovalRisk::Locked {
            reason: read_lossy(&lock)
                .map(|reason| reason.trim().to_owned())
                .filter(|reason| !reason.is_empty()),
        });
    }

    if holder.admin.join("modules").exists() {
        reasons.push(RemovalRisk::Submodules);
    }

    let mut distinct = Vec::new();
    for reason in reasons {
        if !distinct.contains(&reason) {
            distinct.push(reason);
        }
    }
    distinct
}

fn status_risk(worktree: &Repository) -> Option<RemovalRisk> {
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);

    let Ok(statuses) = worktree.statuses(Some(&mut options)) else {
        return Some(RemovalRisk::Unchecked);
    };
    let Ok(index) = worktree.index() else {
        return Some(RemovalRisk::Unchecked);
    };
    statuses
        .iter()
        .any(|entry| !outside_the_sparse_cone(&index, &entry))
        .then_some(RemovalRisk::Changes)
}

/// libgit2 reports a file a sparse checkout left out of the worktree as deleted, though
/// its content is in the commit and removing the worktree loses nothing of it.
fn outside_the_sparse_cone(index: &git2::Index, entry: &git2::StatusEntry) -> bool {
    const SKIP_WORKTREE: u16 = 0x4000;

    entry.status() == git2::Status::WT_DELETED
        && index
            .get_path(Path::new(&*String::from_utf8_lossy(entry.path_bytes())), 0)
            .is_some_and(|indexed| indexed.flags_extended & SKIP_WORKTREE != 0)
}

/// A gitlink whose directory holds a `.git` keeps commits status reports as clean. An
/// unpopulated gitlink holds none, and git removes such a worktree without force.
fn gitlink_risk(worktree: &Repository, root: &Path) -> Option<RemovalRisk> {
    const GITLINK: u32 = 0o160_000;

    let Ok(index) = worktree.index() else {
        return Some(RemovalRisk::Unchecked);
    };
    let populated = index.iter().any(|entry| {
        entry.mode == GITLINK
            && std::str::from_utf8(&entry.path).map_or(true, |path| {
                root.join(path).join(".git").symlink_metadata().is_ok()
            })
    });
    populated.then_some(RemovalRisk::Submodules)
}

fn read_lossy(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

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
                format!("the worktrees at {paths} all have the branch checked out")
            }
            Self::OpenInTab => {
                format!("the worktree at {paths} is open in a tab: close it, then delete again")
            }
        }
    }
}

struct Linked {
    name: String,
    admin: PathBuf,
    /// The `.git` path the admin entry records, whose parent prune deletes.
    gitfile: PathBuf,
    root: PathBuf,
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

    if !Repository::open(common)?.is_bare() && holds(common, &target) {
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

    let refusal = if !points_back(&holder) {
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
    let Err(error) = pruned else {
        return Ok(());
    };

    let path = &removal.path;
    if admin.exists() {
        Err(TrunkError::new(
            "worktree_not_removed",
            format!(
                "the worktree at {path} was not removed: {}",
                error.message()
            ),
        ))
    } else {
        Err(TrunkError::new(
            "worktree_partly_removed",
            format!(
                "the worktree at {path} was unregistered but some files could not be deleted: {}",
                left_behind(Path::new(path)).join(", ")
            ),
        ))
    }
}

/// The files, and the directories that cannot be read, still under `root`.
fn left_behind(root: &Path) -> Vec<String> {
    const SHOWN: usize = 10;

    let mut left = Vec::new();
    collect_left_behind(root, &mut left);
    if left.len() > SHOWN {
        let more = left.len() - SHOWN;
        left.truncate(SHOWN);
        left.push(format!("and {more} more"));
    }
    left
}

fn collect_left_behind(dir: &Path, left: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        left.push(dir.display().to_string());
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            collect_left_behind(&path, left);
        } else {
            left.push(path.display().to_string());
        }
    }
}

fn linked_holders(repo: &Repository, target: &str) -> Result<Vec<Linked>, TrunkError> {
    let common = repo.commondir();
    let mut holders = Vec::new();

    for name in repo
        .worktrees()?
        .iter()
        .filter_map(|name| name.ok().flatten())
    {
        let admin = common.join("worktrees").join(name);
        if !holds(&admin, target) {
            continue;
        }
        let Some(gitfile) = recorded_gitfile(&admin) else {
            continue;
        };
        let Some(root) = gitfile.parent().and_then(|root| root.canonicalize().ok()) else {
            continue;
        };
        holders.push(Linked {
            name: name.to_owned(),
            admin,
            gitfile,
            root,
        });
    }

    Ok(holders)
}

fn holds(admin: &Path, target: &str) -> bool {
    read_admin_file(&admin.join("HEAD"))
        .as_deref()
        .and_then(|head| head.strip_prefix("ref:"))
        .is_some_and(|head| head.trim() == target)
}

fn recorded_gitfile(admin: &Path) -> Option<PathBuf> {
    Some(admin.join(read_admin_file(&admin.join("gitdir"))?.trim()))
}

/// Whether the recorded `.git` file names this admin entry, as git checks before it
/// removes a worktree. libgit2 checks only that the paths exist.
fn points_back(holder: &Linked) -> bool {
    if holder.gitfile.file_name() != Some(".git".as_ref()) {
        return false;
    }
    let Some(contents) = read_admin_file(&holder.gitfile) else {
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

fn risks(holder: &Linked) -> Vec<RemovalRisk> {
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
            reason: read_admin_file(&lock)
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

    match worktree.statuses(Some(&mut options)) {
        Ok(statuses) if statuses.is_empty() => None,
        Ok(_) => Some(RemovalRisk::Changes),
        Err(_) => Some(RemovalRisk::Unchecked),
    }
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

fn read_admin_file(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

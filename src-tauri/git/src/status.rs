use git2::{Repository, Status, StatusOptions};

/// The one definition of "dirty" in Trunk, shared by the graph walk and the dirty
/// counters so the two cannot drift.
///
/// `include_ignored(false)` keeps ignored trees out of the scan, which libgit2's
/// defaults would otherwise walk on every refresh.
#[must_use]
pub fn dirty_status_options() -> StatusOptions {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .recurse_untracked_dirs(true);
    opts
}

pub const STAGED_BITS: Status = Status::INDEX_NEW
    .union(Status::INDEX_MODIFIED)
    .union(Status::INDEX_DELETED)
    .union(Status::INDEX_RENAMED)
    .union(Status::INDEX_TYPECHANGE);

pub const UNSTAGED_BITS: Status = Status::WT_NEW
    .union(Status::WT_MODIFIED)
    .union(Status::WT_DELETED)
    .union(Status::WT_RENAMED)
    .union(Status::WT_TYPECHANGE);

pub const DIRTY_BITS: Status = STAGED_BITS.union(UNSTAGED_BITS).union(Status::CONFLICTED);

#[must_use]
pub fn worktree_dirty(repo: &Repository) -> bool {
    let mut opts = dirty_status_options();
    // Bare repos error here rather than reporting clean, and have no worktree to be dirty.
    repo.statuses(Some(&mut opts))
        .is_ok_and(|statuses| statuses.iter().any(|e| e.status().intersects(DIRTY_BITS)))
}

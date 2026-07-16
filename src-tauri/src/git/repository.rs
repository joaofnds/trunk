use crate::error::TrunkError;
use crate::git::types::{RefLabel, RefType};
use std::collections::HashMap;

/// Returns true if the repo has any tracked modifications that would block checkout.
/// Untracked files (WT_NEW) are deliberately excluded — git allows checkout with untracked files.
pub fn is_repo_dirty(repo: &git2::Repository) -> Result<bool, git2::Error> {
    use git2::{Status, StatusOptions};
    let mut opts = StatusOptions::new();
    opts.include_untracked(false).include_ignored(false);

    let dirty_flags = Status::INDEX_NEW
        | Status::INDEX_MODIFIED
        | Status::INDEX_DELETED
        | Status::INDEX_RENAMED
        | Status::INDEX_TYPECHANGE
        | Status::WT_MODIFIED
        | Status::WT_DELETED
        | Status::WT_RENAMED
        | Status::WT_TYPECHANGE;

    let statuses = repo.statuses(Some(&mut opts))?;
    Ok(statuses.iter().any(|s| s.status().intersects(dirty_flags)))
}

pub fn validate_and_open(path: &std::path::Path) -> Result<(), TrunkError> {
    git2::Repository::open(path).map_err(|e| TrunkError {
        code: "not_a_git_repo".into(),
        message: e.message().to_owned(),
    })?;
    Ok(())
}

pub fn build_ref_map(repo: &mut git2::Repository) -> HashMap<git2::Oid, Vec<RefLabel>> {
    let mut map: HashMap<git2::Oid, Vec<RefLabel>> = HashMap::new();

    // Use the symbolic HEAD ref name (e.g. "refs/heads/main") to identify the
    // checked-out branch. OID comparison alone is wrong when multiple branches
    // point to the same commit.
    let head_ref_name = repo
        .head()
        .ok()
        .and_then(|h| h.resolve().ok())
        .and_then(|r| r.name().ok().map(|n| n.to_owned()));

    if let Ok(refs) = repo.references() {
        for reference in refs.flatten() {
            let Some(raw_oid) = reference.target() else {
                continue;
            };

            let ref_type = if reference.is_branch() && !reference.is_remote() {
                RefType::LocalBranch
            } else if reference.is_remote() {
                RefType::RemoteBranch
            } else if reference.is_tag() {
                RefType::Tag
            } else {
                continue;
            };

            // For annotated tags, peel to the underlying commit OID
            let oid = if matches!(ref_type, RefType::Tag) {
                reference
                    .peel_to_commit()
                    .map(|c| c.id())
                    .unwrap_or(raw_oid)
            } else {
                raw_oid
            };

            let name = reference.name().unwrap_or("").to_owned();
            let short_name = reference.shorthand().unwrap_or(&name).to_owned();
            let is_head = matches!(ref_type, RefType::LocalBranch)
                && head_ref_name.as_deref() == Some(name.as_str());

            map.entry(oid).or_default().push(RefLabel {
                name,
                short_name,
                ref_type,
                is_head,
                color_index: 0,
            });
        }
    }

    let _ = repo.stash_foreach(|_idx, name, oid| {
        map.entry(*oid).or_default().push(RefLabel {
            name: name.to_owned(),
            short_name: "stash".to_owned(),
            ref_type: RefType::Stash,
            is_head: false,
            color_index: 0,
        });
        true
    });

    map
}

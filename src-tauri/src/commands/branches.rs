use std::collections::HashMap;
use std::path::PathBuf;
use tauri::State;
use git2::{BranchType, Status, StatusOptions};
use crate::error::TrunkError;
use crate::git::{graph, types::{BranchInfo, RefLabel, RefType, RefsResponse}};
use crate::state::{CommitCache, RepoState};
use crate::git::types::GraphCommit;

/// Opens a repository by looking up its path in the state map.
fn open_repo_from_state(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<git2::Repository, TrunkError> {
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    git2::Repository::open(path_buf).map_err(TrunkError::from)
}

/// Returns true if the repo has any tracked modifications that would block checkout.
/// Untracked files (WT_NEW) are deliberately excluded — git allows checkout with untracked files.
fn is_dirty(repo: &git2::Repository) -> Result<bool, git2::Error> {
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

/// Inner implementation of list_refs — separated for testability without Tauri state.
pub fn list_refs_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<RefsResponse, TrunkError> {
    let mut repo = open_repo_from_state(path, state_map)?;

    // Resolve HEAD name before any mutable borrows
    let head_name: Option<String> = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(str::to_owned));

    let local: Vec<BranchInfo> = repo
        .branches(Some(BranchType::Local))?
        .filter_map(|b| b.ok())
        .map(|(branch, _)| {
            let name = branch.name().ok().flatten().unwrap_or("").to_owned();
            let is_head = head_name.as_deref() == Some(name.as_str());
            let upstream = branch
                .upstream()
                .ok()
                .and_then(|u| u.name().ok().flatten().map(str::to_owned));
            let last_commit_timestamp = branch
                .get()
                .peel_to_commit()
                .map(|c| c.author().when().seconds())
                .unwrap_or(0);
            BranchInfo {
                name,
                is_head,
                upstream,
                ahead: 0,
                behind: 0,
                last_commit_timestamp,
            }
        })
        .collect();

    // Remote branches — filter out entries where name ends with "/HEAD"
    let remote: Vec<BranchInfo> = repo
        .branches(Some(BranchType::Remote))?
        .filter_map(|b| b.ok())
        .filter_map(|(branch, _)| {
            let name = branch.name().ok().flatten()?.to_owned();
            if name.ends_with("/HEAD") {
                return None;
            }
            Some(BranchInfo {
                name,
                is_head: false,
                upstream: None,
                ahead: 0,
                behind: 0,
                last_commit_timestamp: 0,
            })
        })
        .collect();

    // Tags
    let mut tags: Vec<RefLabel> = Vec::new();
    repo.tag_foreach(|_oid, name_bytes| {
        let name = std::str::from_utf8(name_bytes).unwrap_or("").to_owned();
        let short_name = name
            .strip_prefix("refs/tags/")
            .unwrap_or(&name)
            .to_owned();
        tags.push(RefLabel {
            name,
            short_name,
            ref_type: RefType::Tag,
            is_head: false,
        });
        true
    })?;

    // Stashes — requires &mut repo
    let mut stashes: Vec<RefLabel> = Vec::new();
    repo.stash_foreach(|idx, name, _oid| {
        stashes.push(RefLabel {
            name: name.to_owned(),
            short_name: format!("stash@{{{}}}", idx),
            ref_type: RefType::Stash,
            is_head: false,
        });
        true
    })?;

    Ok(RefsResponse {
        local,
        remote,
        tags,
        stashes,
    })
}

#[tauri::command]
pub async fn list_refs(
    path: String,
    state: State<'_, RepoState>,
) -> Result<RefsResponse, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || list_refs_inner(&path, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

/// Inner implementation of checkout_branch — separated for testability.
pub fn checkout_branch_inner(
    path: &str,
    branch_name: &str,
    state_map: &HashMap<String, PathBuf>,
    cache_map: &mut HashMap<String, Vec<GraphCommit>>,
) -> Result<(), TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;

    if is_dirty(&repo)? {
        return Err(TrunkError::new(
            "dirty_workdir",
            "Working tree has uncommitted changes",
        ));
    }

    let branch_ref = format!("refs/heads/{}", branch_name);
    {
        let (object, _reference) = repo.revparse_ext(&branch_ref)?;
        repo.checkout_tree(&object, Some(&mut git2::build::CheckoutBuilder::new().safe()))?;
    }
    repo.set_head(&branch_ref)?;
    drop(repo);

    // Rebuild graph cache after checkout
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    let mut repo2 = git2::Repository::open(path_buf)?;
    let commits = graph::walk_commits(&mut repo2, 0, usize::MAX)?;
    cache_map.insert(path.to_owned(), commits);

    Ok(())
}

#[tauri::command]
pub async fn checkout_branch(
    path: String,
    branch_name: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let mut cache_map = cache.0.lock().unwrap().clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        checkout_branch_inner(&path, &branch_name, &state_map, &mut cache_map)
            .map(|_| cache_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    // Update cache in main thread with rebuilt data
    *cache.0.lock().unwrap() = result;

    Ok(())
}

/// Inner implementation of create_branch — separated for testability.
pub fn create_branch_inner(
    path: &str,
    name: &str,
    state_map: &HashMap<String, PathBuf>,
    cache_map: &mut HashMap<String, Vec<GraphCommit>>,
) -> Result<(), TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;

    // Extract head OID first so head_commit doesn't borrow repo across the drop
    let head_oid = repo.head()?.target().ok_or_else(|| {
        TrunkError::new("git_error", "HEAD has no target (unborn branch?)")
    })?;
    let head_commit = repo.find_commit(head_oid)?;
    // false = no force; fails if name already exists
    repo.branch(name, &head_commit, false)?;
    // Drop head_commit (and its borrow on repo) before mutable operations
    drop(head_commit);

    // Auto-checkout the new branch
    repo.set_head(&format!("refs/heads/{}", name))?;
    repo.checkout_head(Some(git2::build::CheckoutBuilder::default().safe()))?;
    drop(repo);

    // Rebuild graph cache after branch creation
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    let mut repo2 = git2::Repository::open(path_buf)?;
    let commits = graph::walk_commits(&mut repo2, 0, usize::MAX)?;
    cache_map.insert(path.to_owned(), commits);

    Ok(())
}

#[tauri::command]
pub async fn create_branch(
    path: String,
    name: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let mut cache_map = cache.0.lock().unwrap().clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        create_branch_inner(&path, &name, &state_map, &mut cache_map)
            .map(|_| cache_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    // Update cache in main thread with rebuilt data
    *cache.0.lock().unwrap() = result;

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::git::repository::tests::make_test_repo;

    fn list_refs_inner(
        path: &str,
        state_map: &std::collections::HashMap<String, std::path::PathBuf>,
    ) -> Result<crate::git::types::RefsResponse, crate::error::TrunkError> {
        super::list_refs_inner(path, state_map)
    }

    fn checkout_branch_inner(
        path: &str,
        branch_name: &str,
        state_map: &std::collections::HashMap<String, std::path::PathBuf>,
        cache_map: &mut std::collections::HashMap<String, Vec<crate::git::types::GraphCommit>>,
    ) -> Result<(), crate::error::TrunkError> {
        super::checkout_branch_inner(path, branch_name, state_map, cache_map)
    }

    fn create_branch_inner(
        path: &str,
        name: &str,
        state_map: &std::collections::HashMap<String, std::path::PathBuf>,
        cache_map: &mut std::collections::HashMap<String, Vec<crate::git::types::GraphCommit>>,
    ) -> Result<(), crate::error::TrunkError> {
        super::create_branch_inner(path, name, state_map, cache_map)
    }

    fn make_state_map(
        path: &std::path::Path,
    ) -> std::collections::HashMap<String, std::path::PathBuf> {
        let mut map = std::collections::HashMap::new();
        map.insert(path.to_string_lossy().to_string(), path.to_path_buf());
        map
    }

    #[test]
    fn list_refs_returns_all() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        let refs = list_refs_inner(&path, &state_map).expect("list_refs_inner failed");

        assert!(!refs.local.is_empty(), "expected at least 1 local branch");
        let main = refs
            .local
            .iter()
            .find(|b| b.name == "main")
            .expect("expected main branch");
        assert!(main.is_head, "expected main branch to be HEAD");
    }

    #[test]
    fn list_refs_hides_remote_head() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        let refs = list_refs_inner(&path, &state_map).expect("list_refs_inner failed");

        // Verify no remote entry ends with "/HEAD"
        for branch in &refs.remote {
            assert!(
                !branch.name.ends_with("/HEAD"),
                "remote list should not contain entries ending with '/HEAD', found: {}",
                branch.name
            );
        }
    }

    #[test]
    fn list_refs_head_flag() {
        let dir = make_test_repo();
        let path_str = dir.path().to_string_lossy().to_string();

        // Create a second branch "feat" and switch HEAD to it
        {
            let repo = git2::Repository::open(dir.path()).unwrap();
            let head_oid = repo.head().unwrap().target().unwrap();
            let head_commit = repo.find_commit(head_oid).unwrap();
            repo.branch("feat", &head_commit, false).unwrap();
            repo.set_head("refs/heads/feat").unwrap();
        }

        let state_map = make_state_map(dir.path());
        let refs = list_refs_inner(&path_str, &state_map).expect("list_refs_inner failed");

        let feat = refs
            .local
            .iter()
            .find(|b| b.name == "feat")
            .expect("expected feat branch");
        assert!(feat.is_head, "expected feat branch to be HEAD");

        let main = refs
            .local
            .iter()
            .find(|b| b.name == "main")
            .expect("expected main branch");
        assert!(!main.is_head, "expected main branch NOT to be HEAD");
    }

    #[test]
    fn checkout_dirty_returns_error() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();

        // Create a branch to check out to
        {
            let repo = git2::Repository::open(dir.path()).unwrap();
            let head_oid = repo.head().unwrap().target().unwrap();
            let head_commit = repo.find_commit(head_oid).unwrap();
            repo.branch("other", &head_commit, false).unwrap();
        }

        // Make a tracked modification (modify existing README.md)
        std::fs::write(dir.path().join("README.md"), "dirty content").unwrap();
        let repo = git2::Repository::open(dir.path()).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("README.md")).unwrap();
        index.write().unwrap();
        drop(repo);

        let state_map = make_state_map(dir.path());
        let mut cache_map = std::collections::HashMap::new();

        let result = checkout_branch_inner(&path, "other", &state_map, &mut cache_map);

        assert!(result.is_err(), "expected Err for dirty workdir");
        assert_eq!(
            result.unwrap_err().code,
            "dirty_workdir",
            "expected dirty_workdir error code"
        );
    }

    #[test]
    fn checkout_clean_succeeds() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();

        // Create a "next" branch to check out to
        {
            let repo = git2::Repository::open(dir.path()).unwrap();
            let head_oid = repo.head().unwrap().target().unwrap();
            let head_commit = repo.find_commit(head_oid).unwrap();
            repo.branch("next", &head_commit, false).unwrap();
        }

        let state_map = make_state_map(dir.path());
        let mut cache_map = std::collections::HashMap::new();

        let result = checkout_branch_inner(&path, "next", &state_map, &mut cache_map);

        assert!(result.is_ok(), "expected Ok for clean workdir checkout");

        let repo = git2::Repository::open(dir.path()).unwrap();
        let head_ref = repo.head().unwrap();
        assert_eq!(
            head_ref.name().unwrap(),
            "refs/heads/next",
            "expected HEAD to point at refs/heads/next"
        );
    }

    #[test]
    fn create_branch_from_head() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());
        let mut cache_map = std::collections::HashMap::new();

        let result = create_branch_inner(&path, "new-feat", &state_map, &mut cache_map);

        assert!(result.is_ok(), "expected Ok when creating new-feat branch");

        let repo = git2::Repository::open(dir.path()).unwrap();
        let branch = repo.find_branch("new-feat", git2::BranchType::Local);
        assert!(branch.is_ok(), "expected new-feat branch to exist");

        let head_ref = repo.head().unwrap();
        assert_eq!(
            head_ref.name().unwrap(),
            "refs/heads/new-feat",
            "expected HEAD to point at refs/heads/new-feat after create"
        );
    }

    #[test]
    fn create_branch_duplicate_fails() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());
        let mut cache_map = std::collections::HashMap::new();

        // "main" already exists
        let result = create_branch_inner(&path, "main", &state_map, &mut cache_map);

        assert!(result.is_err(), "expected Err when creating duplicate branch");
        assert_eq!(
            result.unwrap_err().code,
            "git_error",
            "expected git_error code for duplicate branch"
        );
    }
}

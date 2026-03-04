// Branch commands — list_refs, checkout_branch, create_branch

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

// Repository operations — stub for Phase 2 implementation

#[cfg(test)]
pub mod tests {
    /// Creates a temporary git repository with at least one merge commit.
    /// Returns the TempDir so the directory stays alive for the duration of the test.
    pub fn make_test_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("failed to create tempdir");
        let repo = git2::Repository::init(dir.path()).expect("failed to init repo");

        // Configure user identity so commits succeed
        let mut cfg = repo.config().expect("failed to get config");
        cfg.set_str("user.name", "Test User").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        drop(cfg);

        // Helper: write a file, add to index, commit
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();

        // --- Initial commit on main ---
        std::fs::write(dir.path().join("README.md"), "hello").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("README.md")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        repo.commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            "Initial commit",
            &tree,
            &[],
        )
        .unwrap();

        // --- Branch commit on 'feature' ---
        let main_commit = repo
            .find_reference("refs/heads/main")
            .unwrap()
            .peel_to_commit()
            .unwrap();

        std::fs::write(dir.path().join("feature.txt"), "feature work").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("feature.txt")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let feature_commit_oid = repo
            .commit(
                Some("refs/heads/feature"),
                &sig,
                &sig,
                "Feature commit",
                &tree,
                &[&main_commit],
            )
            .unwrap();
        let feature_commit = repo.find_commit(feature_commit_oid).unwrap();

        // --- Merge commit back into main ---
        std::fs::write(dir.path().join("merged.txt"), "merged").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("merged.txt")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        repo.commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            "Merge feature into main",
            &tree,
            &[&main_commit, &feature_commit],
        )
        .unwrap();

        dir
    }

    #[test]
    fn ref_map_head() {
        todo!()
    }

    #[test]
    fn ref_map_stash() {
        todo!()
    }
}

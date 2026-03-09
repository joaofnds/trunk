use std::collections::HashMap;
use crate::error::TrunkError;
use crate::git::types::{RefLabel, RefType};

pub fn validate_and_open(path: &std::path::Path) -> Result<(), TrunkError> {
    git2::Repository::open(path).map_err(|e| TrunkError {
        code: "not_a_git_repo".into(),
        message: e.message().to_owned(),
    })?;
    Ok(())
}

pub fn build_ref_map(repo: &mut git2::Repository) -> HashMap<git2::Oid, Vec<RefLabel>> {
    let mut map: HashMap<git2::Oid, Vec<RefLabel>> = HashMap::new();

    let head_oid = repo.head().ok().and_then(|h| h.target());

    if let Ok(refs) = repo.references() {
        for reference in refs.flatten() {
            let Some(oid) = reference.target() else {
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

            let name = reference.name().unwrap_or("").to_owned();
            let short_name = reference.shorthand().unwrap_or(&name).to_owned();
            let is_head =
                matches!(ref_type, RefType::LocalBranch) && head_oid == Some(oid);

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

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Creates a temporary git repository with a merge commit.
    /// HEAD → refs/heads/main → merge commit
    pub fn make_test_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("failed to create tempdir");
        let repo = git2::Repository::init(dir.path()).expect("failed to init repo");

        let mut cfg = repo.config().expect("failed to get config");
        cfg.set_str("user.name", "Test User").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        drop(cfg);

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

        // Point HEAD at main
        repo.set_head("refs/heads/main").unwrap();

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

    /// Creates a temporary git repository with 300 linear commits.
    pub fn make_large_test_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("failed to create tempdir");
        let repo = git2::Repository::init(dir.path()).expect("failed to init repo");

        let mut cfg = repo.config().expect("failed to get config");
        cfg.set_str("user.name", "Test User").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        drop(cfg);

        repo.set_head("refs/heads/main").unwrap();
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        let mut parent_oid: Option<git2::Oid> = None;

        for i in 0..300 {
            let filename = format!("file{}.txt", i);
            std::fs::write(dir.path().join(&filename), format!("content {}", i)).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new(&filename)).unwrap();
            index.write().unwrap();
            let tree_oid = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_oid).unwrap();

            let parents: Vec<git2::Commit> = if let Some(oid) = parent_oid {
                vec![repo.find_commit(oid).unwrap()]
            } else {
                vec![]
            };
            let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

            let oid = repo
                .commit(
                    Some("refs/heads/main"),
                    &sig,
                    &sig,
                    &format!("Commit {}", i),
                    &tree,
                    &parent_refs,
                )
                .unwrap();
            parent_oid = Some(oid);
        }

        dir
    }

    #[test]
    fn ref_map_head() {
        let dir = make_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();
        let map = build_ref_map(&mut repo);
        assert!(
            map.values().flatten().any(|r| r.is_head),
            "expected at least one ref with is_head == true"
        );
    }

    #[test]
    fn ref_map_stash() {
        let dir = make_test_repo();
        let mut repo = git2::Repository::open(dir.path()).unwrap();

        // Write and stage a change to stash
        std::fs::write(dir.path().join("stashed.txt"), "stashed work").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("stashed.txt")).unwrap();
        index.write().unwrap();

        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        repo.stash_save(&sig, "test stash", None).unwrap();

        let map = build_ref_map(&mut repo);
        assert!(
            map.values()
                .flatten()
                .any(|r| matches!(r.ref_type, RefType::Stash)),
            "expected at least one RefLabel with ref_type == Stash"
        );
    }
}

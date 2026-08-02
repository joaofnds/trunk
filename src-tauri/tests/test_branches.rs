mod common;

use common::context::TestContext;

#[test]
fn list_refs_returns_local_branches() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let refs = ctx.list_refs().expect("list_refs failed");

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
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let refs = ctx.list_refs().expect("list_refs failed");

    for branch in &refs.remote {
        assert!(
            !branch.name.ends_with("/HEAD"),
            "remote list should not contain entries ending with '/HEAD', found: {}",
            branch.name
        );
    }
}

#[test]
fn list_refs_head_flag_tracks_current_branch() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_branch("feat")
        .build();

    ctx.checkout_branch("feat").unwrap();

    let refs = ctx.list_refs().expect("list_refs failed");

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
fn checkout_with_non_conflicting_changes_succeeds() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_branch("other")
        .build();

    // Modify and stage a tracked file (same content on both branches -- no conflict)
    std::fs::write(ctx.repo_path().join("README.md"), "dirty content").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("README.md")).unwrap();
        index.write().unwrap();
    }

    let result = ctx.checkout_branch("other");
    assert!(
        result.is_ok(),
        "checkout should succeed when changes don't conflict"
    );
}

#[test]
fn checkout_clean_workdir_succeeds() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_branch("next")
        .build();

    let result = ctx.checkout_branch("next");
    assert!(result.is_ok(), "expected Ok for clean workdir checkout");

    ctx.assert_head_at("next");
}

#[test]
fn create_branch_from_head() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let result = ctx.create_branch("new-feat", None);
    assert!(result.is_ok(), "expected Ok when creating new-feat branch");

    ctx.assert_branch_exists("new-feat");
    ctx.assert_head_at("new-feat");
}

#[test]
fn create_branch_duplicate_fails() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // "main" already exists
    let result = ctx.create_branch("main", None);
    assert!(
        result.is_err(),
        "expected Err when creating duplicate branch"
    );
    assert_eq!(
        result.unwrap_err().code,
        "git_exists",
        "expected git_exists code for duplicate branch"
    );
}

#[test]
fn checkout_branch_blocked_by_local_edits_reports_dirty_workdir() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "base")
        .with_commit("Initial commit")
        .with_branch("feat")
        .checkout("feat")
        .with_file("README.md", "feature side")
        .with_commit("Feature edit")
        .checkout("main")
        .build();

    std::fs::write(ctx.repo_path().join("README.md"), "local edit").unwrap();

    let err = ctx.checkout_branch("feat").unwrap_err();

    assert_eq!(err.code, "dirty_workdir");
}

#[test]
fn create_branch_from_specific_oid() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Get the first commit OID, then create a second commit
    let first_oid = ctx.repo().head().unwrap().target().unwrap().to_string();

    // Add a second commit by writing a file and creating a commit via the repo directly
    std::fs::write(ctx.repo_path().join("extra.txt"), "content").unwrap();
    {
        let repo = ctx.repo();
        let sig = repo.signature().unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("extra.txt")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            "Second",
            &tree,
            &[&parent],
        )
        .unwrap();
    }

    let result = ctx.create_branch("from-first", Some(&first_oid));
    assert!(
        result.is_ok(),
        "create_branch from OID should succeed: {:?}",
        result.err()
    );

    // Verify the branch points at the first commit
    let repo = ctx.repo();
    let branch = repo
        .find_branch("from-first", git2::BranchType::Local)
        .unwrap();
    let branch_oid = branch.get().target().unwrap().to_string();
    assert_eq!(
        branch_oid, first_oid,
        "branch should point at from_oid, not HEAD"
    );
}

#[test]
fn delete_branch_removes_ref() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Create a branch, switch back to main, then delete it
    ctx.create_branch("to-delete", None).unwrap();
    ctx.checkout_branch("main").unwrap();

    let result = ctx.delete_branch("to-delete");
    assert!(
        result.is_ok(),
        "delete_branch should succeed: {:?}",
        result.err()
    );

    ctx.assert_branch_not_exists("to-delete");
}

#[test]
fn delete_head_branch_fails() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Try to delete main (which is HEAD)
    let result = ctx.delete_branch("main");
    assert!(result.is_err(), "deleting HEAD branch should fail");
    assert_eq!(result.unwrap_err().code, "cannot_delete_head");
}

#[test]
fn rename_branch_changes_name() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    ctx.create_branch("old-name", None).unwrap();
    ctx.checkout_branch("main").unwrap();

    let result = ctx.rename_branch("old-name", "new-name");
    assert!(
        result.is_ok(),
        "rename_branch should succeed: {:?}",
        result.err()
    );

    ctx.assert_branch_not_exists("old-name");
    ctx.assert_branch_exists("new-name");
}

#[test]
fn create_branch_dirty_workdir_returns_error() {
    let mut ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let head_oid = ctx.repo().head().unwrap().target().unwrap().to_string();

    // Make workdir dirty
    std::fs::write(ctx.repo_path().join("README.md"), "dirty content").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("README.md")).unwrap();
        index.write().unwrap();
    }

    let result = ctx.create_branch("dirty-branch", Some(&head_oid));
    assert!(result.is_err(), "should return error on dirty workdir");
    assert_eq!(result.unwrap_err().code, "dirty_workdir");

    // Branch should still have been created even though checkout was skipped
    ctx.assert_branch_exists("dirty-branch");
}

#[test]
fn list_refs_ahead_behind_tracking() {
    // Create a repo with a local branch ahead of its tracking remote branch
    let remote_dir = tempfile::tempdir().unwrap();
    let bare = git2::Repository::init_bare(remote_dir.path()).unwrap();

    // Create initial commit in bare repo
    {
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let tree_oid = bare.treebuilder(None).unwrap().write().unwrap();
        let tree = bare.find_tree(tree_oid).unwrap();
        bare.commit(Some("refs/heads/main"), &sig, &sig, "init", &tree, &[])
            .unwrap();
    }

    // Clone into working repo
    let work_dir = tempfile::tempdir().unwrap();
    let fetch_opts = git2::FetchOptions::new();
    let repo = git2::build::RepoBuilder::new()
        .branch("main")
        .fetch_options(fetch_opts)
        .clone(remote_dir.path().to_str().unwrap(), work_dir.path())
        .unwrap();

    // Make a local commit so main is ahead by 1
    {
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        std::fs::write(work_dir.path().join("file.txt"), "content").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let parent = repo
            .find_commit(repo.head().unwrap().target().unwrap())
            .unwrap();
        repo.commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            "local",
            &tree,
            &[&parent],
        )
        .unwrap();
    }

    // Build a manual TestContext for the cloned repo
    let path = work_dir.path().to_string_lossy().to_string();
    let mut state_map = std::collections::HashMap::new();
    state_map.insert(path.clone(), work_dir.path().to_path_buf());

    let refs = trunk_lib::commands::branches::list_refs_inner(&path, &state_map)
        .expect("list_refs_inner failed");
    let main = refs
        .local
        .iter()
        .find(|b| b.name == "main")
        .expect("expected main branch");

    assert!(
        main.upstream.is_some(),
        "main should have upstream tracking"
    );
    assert_eq!(main.ahead, 1, "main should be 1 ahead of remote");
    assert_eq!(main.behind, 0, "main should be 0 behind remote");
}

#[test]
fn delete_remote_branch_removes_ref() {
    // Create a bare repo as a "remote"
    let remote_dir = tempfile::tempdir().unwrap();
    let bare = git2::Repository::init_bare(remote_dir.path()).unwrap();

    // Create initial commit in bare repo
    {
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let tree_oid = bare.treebuilder(None).unwrap().write().unwrap();
        let tree = bare.find_tree(tree_oid).unwrap();
        bare.commit(Some("refs/heads/main"), &sig, &sig, "init", &tree, &[])
            .unwrap();
    }

    // Clone into working repo
    let work_dir = tempfile::tempdir().unwrap();
    let fetch_opts = git2::FetchOptions::new();
    let repo = git2::build::RepoBuilder::new()
        .branch("main")
        .fetch_options(fetch_opts)
        .clone(remote_dir.path().to_str().unwrap(), work_dir.path())
        .unwrap();

    // Create a feature branch and push it to the remote
    {
        let head_commit = repo
            .find_commit(repo.head().unwrap().target().unwrap())
            .unwrap();
        repo.branch("feature-to-delete", &head_commit, false)
            .unwrap();
    }

    // Push the branch to origin using git CLI (git2 push requires callbacks)
    let push_status = std::process::Command::new("git")
        .args(["push", "origin", "feature-to-delete"])
        .current_dir(work_dir.path())
        .output()
        .expect("failed to run git push");
    assert!(
        push_status.status.success(),
        "git push should succeed: {}",
        String::from_utf8_lossy(&push_status.stderr)
    );

    // Verify the remote branch exists
    let refs_before = trunk_lib::commands::branches::list_refs_inner(
        work_dir.path().to_string_lossy().as_ref(),
        &{
            let mut m = std::collections::HashMap::new();
            m.insert(
                work_dir.path().to_string_lossy().to_string(),
                work_dir.path().to_path_buf(),
            );
            m
        },
    )
    .expect("list_refs_inner failed");
    assert!(
        refs_before
            .remote
            .iter()
            .any(|b| b.name == "origin/feature-to-delete"),
        "remote branch origin/feature-to-delete should exist before deletion"
    );

    // Delete the remote branch via git push --delete
    let delete_status = std::process::Command::new("git")
        .args(["push", "--delete", "origin", "feature-to-delete"])
        .current_dir(work_dir.path())
        .output()
        .expect("failed to run git push --delete");
    assert!(
        delete_status.status.success(),
        "git push --delete should succeed: {}",
        String::from_utf8_lossy(&delete_status.stderr)
    );

    // Fetch to update remote tracking refs
    let fetch_status = std::process::Command::new("git")
        .args(["fetch", "--prune"])
        .current_dir(work_dir.path())
        .output()
        .expect("failed to run git fetch");
    assert!(fetch_status.status.success(), "git fetch should succeed");

    // Verify the remote branch is gone
    let refs_after = trunk_lib::commands::branches::list_refs_inner(
        work_dir.path().to_string_lossy().as_ref(),
        &{
            let mut m = std::collections::HashMap::new();
            m.insert(
                work_dir.path().to_string_lossy().to_string(),
                work_dir.path().to_path_buf(),
            );
            m
        },
    )
    .expect("list_refs_inner failed");
    assert!(
        !refs_after
            .remote
            .iter()
            .any(|b| b.name == "origin/feature-to-delete"),
        "remote branch origin/feature-to-delete should NOT exist after deletion"
    );
}

#[test]
fn resolve_ref_returns_oid_for_valid_branch() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let expected_oid = ctx
        .repo()
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .id()
        .to_string();

    let result = ctx.resolve_ref("main");
    assert!(
        result.is_ok(),
        "resolve_ref should succeed for valid branch"
    );
    assert_eq!(
        result.unwrap(),
        expected_oid,
        "resolved OID should match the branch tip commit"
    );
}

#[test]
fn resolve_ref_fails_for_nonexistent_ref() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let result = ctx.resolve_ref("refs/heads/nonexistent");
    assert!(
        result.is_err(),
        "resolve_ref should fail for nonexistent ref"
    );
}

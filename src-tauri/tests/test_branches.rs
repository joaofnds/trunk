mod common;

use common::context::TestContext;
use trunk_lib::state::OpenRepos;

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
    let state_map = OpenRepos::from_iter([(path.clone(), work_dir.path().to_path_buf())]);

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
        &OpenRepos::from_iter([(
            work_dir.path().to_string_lossy().to_string(),
            work_dir.path().to_path_buf(),
        )]),
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
        &OpenRepos::from_iter([(
            work_dir.path().to_string_lossy().to_string(),
            work_dir.path().to_path_buf(),
        )]),
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

mod deleting_a_branch_a_linked_worktree_holds {
    use super::common::context::TestContext;
    use trunk_git::worktree::{BranchHold, Refusal, RemovalRisk, WorktreeRemoval};

    fn repo_with_branch(branch: &str) -> TestContext {
        let mut ctx = TestContext::builder()
            .with_file("README.md", "hello")
            .with_commit("Initial commit")
            .build();
        ctx.create_branch(branch, None).unwrap();
        ctx.checkout_branch("main").unwrap();
        ctx
    }

    fn removal(name: &str, path: &std::path::Path, go_ahead: bool) -> WorktreeRemoval {
        WorktreeRemoval {
            name: name.into(),
            path: path.display().to_string(),
            go_ahead,
        }
    }

    fn worktree_names(ctx: &TestContext) -> Vec<String> {
        ctx.repo()
            .worktrees()
            .unwrap()
            .iter()
            .filter_map(|name| name.ok().flatten().map(str::to_owned))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    #[test]
    fn removes_a_clean_worktree_then_the_branch() {
        let mut ctx = repo_with_branch("wt-branch");
        let path = ctx.add_linked_worktree("wt", "wt-branch");

        let result = ctx.delete_branch_removing("wt-branch", &removal("wt", &path, false));

        assert_eq!(result, Ok(()));
        ctx.assert_branch_not_exists("wt-branch");
        assert_eq!(worktree_names(&ctx), Vec::<String>::new());
        assert!(!path.exists());
    }

    #[test]
    fn offers_to_remove_a_clean_worktree() {
        let ctx = repo_with_branch("wt-branch");
        let path = ctx.add_linked_worktree("wt", "wt-branch");

        let hold = ctx.branch_hold("wt-branch").unwrap();

        assert_eq!(
            hold,
            BranchHold::Offer {
                name: "wt".into(),
                path: path.display().to_string(),
            }
        );
    }

    #[test]
    fn reports_an_unheld_branch() {
        let ctx = repo_with_branch("lonely");

        assert_eq!(ctx.branch_hold("lonely").unwrap(), BranchHold::NotHeld);
    }

    fn admin_dir(ctx: &TestContext, name: &str) -> std::path::PathBuf {
        ctx.repo().commondir().join("worktrees").join(name)
    }

    /// Generates, for one way a worktree may hold work: the preflight warns with
    /// `$reasons`, a delete without the go-ahead changes nothing, and a delete with it
    /// removes the worktree and the branch.
    macro_rules! warns_then_removes_on_the_go_ahead {
        ($case:ident, $arrange:expr, $reasons:expr) => {
            mod $case {
                use super::*;

                fn arranged() -> (TestContext, std::path::PathBuf) {
                    let ctx = repo_with_branch("wt-branch");
                    let path = ctx.add_linked_worktree("wt", "wt-branch");
                    let arrange: fn(&TestContext, &std::path::Path) = $arrange;
                    arrange(&ctx, &path);
                    (ctx, path)
                }

                #[test]
                fn warns_with_the_reasons() {
                    let (ctx, path) = arranged();

                    let hold = ctx.branch_hold("wt-branch").unwrap();

                    assert_eq!(
                        hold,
                        BranchHold::Warn {
                            name: "wt".into(),
                            path: path.display().to_string(),
                            reasons: $reasons,
                        }
                    );
                }

                #[test]
                fn refuses_without_the_go_ahead_and_changes_nothing() {
                    let (mut ctx, path) = arranged();
                    let before = snapshot(&ctx, &path);

                    let result =
                        ctx.delete_branch_removing("wt-branch", &removal("wt", &path, false));

                    assert_eq!(result.unwrap_err().code, "worktree_at_risk");
                    ctx.assert_branch_exists("wt-branch");
                    assert_eq!(snapshot(&ctx, &path), before);
                }

                #[test]
                fn removes_the_worktree_and_the_branch_on_the_go_ahead() {
                    let (mut ctx, path) = arranged();

                    let result =
                        ctx.delete_branch_removing("wt-branch", &removal("wt", &path, true));

                    assert_eq!(result, Ok(()));
                    ctx.assert_branch_not_exists("wt-branch");
                    assert_eq!(worktree_names(&ctx), Vec::<String>::new());
                    assert!(!path.exists());
                }
            }
        };
    }

    /// Every path under the worktree and its admin entry, with each file's bytes.
    fn snapshot(ctx: &TestContext, path: &std::path::Path) -> Vec<(std::path::PathBuf, Vec<u8>)> {
        fn walk(dir: &std::path::Path, out: &mut Vec<(std::path::PathBuf, Vec<u8>)>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                out.push((dir.to_path_buf(), b"<unreadable>".to_vec()));
                return;
            };
            for entry in entries.flatten() {
                let entry_path = entry.path();
                if entry_path.is_dir() {
                    out.push((entry_path.clone(), Vec::new()));
                    walk(&entry_path, out);
                } else {
                    let bytes =
                        std::fs::read(&entry_path).unwrap_or_else(|_| b"<unreadable>".to_vec());
                    out.push((entry_path, bytes));
                }
            }
        }

        let mut out = Vec::new();
        walk(path, &mut out);
        walk(&admin_dir(ctx, "wt"), &mut out);
        out.sort();
        out
    }

    warns_then_removes_on_the_go_ahead!(
        when_a_tracked_file_is_modified,
        |_, path| std::fs::write(path.join("README.md"), "edited").unwrap(),
        vec![RemovalRisk::Changes]
    );

    warns_then_removes_on_the_go_ahead!(
        when_an_untracked_file_is_present,
        |_, path| {
            std::fs::create_dir(path.join("notes")).unwrap();
            std::fs::write(path.join("notes/todo.txt"), "new").unwrap();
        },
        vec![RemovalRisk::Changes]
    );

    warns_then_removes_on_the_go_ahead!(
        when_the_status_cannot_be_read,
        |ctx, _| std::fs::write(admin_dir(ctx, "wt").join("index"), "not an index").unwrap(),
        vec![RemovalRisk::Unchecked]
    );

    warns_then_removes_on_the_go_ahead!(
        when_the_worktree_is_locked_with_a_reason,
        |ctx, _| std::fs::write(admin_dir(ctx, "wt").join("locked"), "on a usb stick\n").unwrap(),
        vec![RemovalRisk::Locked {
            reason: Some("on a usb stick".into())
        }]
    );

    warns_then_removes_on_the_go_ahead!(
        when_the_worktree_is_locked_without_a_reason,
        |ctx, _| std::fs::write(admin_dir(ctx, "wt").join("locked"), "").unwrap(),
        vec![RemovalRisk::Locked { reason: None }]
    );

    warns_then_removes_on_the_go_ahead!(
        when_the_lock_cannot_be_read,
        |ctx, _| {
            use std::os::unix::fs::PermissionsExt;

            let lock = admin_dir(ctx, "wt").join("locked");
            std::fs::write(&lock, "secret").unwrap();
            std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o000)).unwrap();
        },
        vec![RemovalRisk::Locked { reason: None }]
    );

    warns_then_removes_on_the_go_ahead!(
        when_a_submodule_keeps_its_git_dir_in_the_admin_entry,
        |ctx, _| {
            let modules = admin_dir(ctx, "wt").join("modules/lib");
            std::fs::create_dir_all(&modules).unwrap();
            std::fs::write(modules.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        },
        vec![RemovalRisk::Submodules]
    );

    warns_then_removes_on_the_go_ahead!(
        when_a_locked_worktree_has_submodules_in_both_places,
        |ctx, path| {
            add_embedded_repository(path, "inner");
            std::fs::create_dir_all(admin_dir(ctx, "wt").join("modules/lib")).unwrap();
            std::fs::write(admin_dir(ctx, "wt").join("locked"), "").unwrap();
        },
        vec![
            RemovalRisk::Submodules,
            RemovalRisk::Locked { reason: None }
        ]
    );

    warns_then_removes_on_the_go_ahead!(
        when_an_embedded_repository_is_added_as_a_gitlink,
        |_, path| add_embedded_repository(path, "inner"),
        vec![RemovalRisk::Submodules]
    );

    /// A repository inside the worktree with a commit of its own, staged and committed
    /// in the worktree as a gitlink, which leaves the worktree's status clean.
    fn add_embedded_repository(worktree: &std::path::Path, name: &str) {
        let inner = git2::Repository::init(worktree.join(name)).unwrap();
        std::fs::write(worktree.join(name).join("only-here.txt"), "precious").unwrap();
        commit_all(&inner, "inner commit");

        let outer = git2::Repository::open(worktree).unwrap();
        let mut index = outer.index().unwrap();
        index.add_path(std::path::Path::new(name)).unwrap();
        index.write().unwrap();
        commit_all(&outer, "add inner");
    }

    fn commit_all(repo: &git2::Repository, message: &str) {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Test User", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
        let parents: Vec<&git2::Commit<'_>> = parent.iter().collect();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .unwrap();
    }

    mod when_an_unpopulated_gitlink_is_in_the_index {
        use super::*;

        #[test]
        fn offers_without_a_warning() {
            let ctx = repo_with_branch("wt-branch");
            let path = ctx.add_linked_worktree("wt", "wt-branch");
            add_embedded_repository(&path, "inner");
            std::fs::remove_dir_all(path.join("inner")).unwrap();
            std::fs::create_dir(path.join("inner")).unwrap();

            let hold = ctx.branch_hold("wt-branch").unwrap();

            assert_eq!(
                hold,
                BranchHold::Offer {
                    name: "wt".into(),
                    path: path.display().to_string(),
                }
            );
        }
    }

    mod when_a_directory_cannot_be_read {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        /// Restores search permission so the temporary directory can be cleaned up.
        struct Unreadable(std::path::PathBuf);

        impl Drop for Unreadable {
            fn drop(&mut self) {
                let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
            }
        }

        fn with_unreadable_directory(path: &std::path::Path) -> Unreadable {
            let secret = path.join("secret");
            std::fs::create_dir(&secret).unwrap();
            std::fs::write(secret.join("key.txt"), "hidden").unwrap();
            std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();
            Unreadable(secret)
        }

        #[test]
        fn going_ahead_from_the_warning_unregisters_the_worktree_names_what_is_left_and_keeps_the_branch()
         {
            let mut ctx = repo_with_branch("wt-branch");
            let path = ctx.add_linked_worktree("wt", "wt-branch");
            std::fs::write(path.join("README.md"), "edited").unwrap();
            let _guard = with_unreadable_directory(&path);

            let error = ctx
                .delete_branch_removing("wt-branch", &removal("wt", &path, true))
                .unwrap_err();

            assert_eq!(error.code, "worktree_partly_removed");
            assert!(
                error
                    .message
                    .contains(&path.join("secret").display().to_string())
            );
            ctx.assert_branch_exists("wt-branch");
            assert_eq!(worktree_names(&ctx), Vec::<String>::new());
            assert!(!path.join("README.md").exists());
        }

        #[test]
        fn accepting_the_offer_ends_in_the_same_partial_removal() {
            let mut ctx = repo_with_branch("wt-branch");
            let path = ctx.add_linked_worktree("wt", "wt-branch");
            let _guard = with_unreadable_directory(&path);

            let error = ctx
                .delete_branch_removing("wt-branch", &removal("wt", &path, false))
                .unwrap_err();

            assert_eq!(error.code, "worktree_partly_removed");
            ctx.assert_branch_exists("wt-branch");
        }
    }

    fn set_admin_head(ctx: &TestContext, name: &str, branch: &str) {
        std::fs::write(
            admin_dir(ctx, name).join("HEAD"),
            format!("ref: refs/heads/{branch}\n"),
        )
        .unwrap();
    }

    fn assert_refused_and_unchanged(
        ctx: &mut TestContext,
        path: &std::path::Path,
        expected: BranchHold,
    ) {
        let before = snapshot(ctx, path);

        let hold = ctx.branch_hold("wt-branch").unwrap();
        let result = ctx.delete_branch_removing("wt-branch", &removal("wt", path, true));

        assert_eq!(hold, expected);
        assert_eq!(result.unwrap_err().code, "worktree_refused");
        ctx.assert_branch_exists("wt-branch");
        assert_eq!(snapshot(ctx, path), before);
    }

    mod refuses_and_changes_nothing {
        use super::*;

        #[test]
        fn when_the_worktree_does_not_point_back_at_its_admin_entry() {
            let mut ctx = repo_with_branch("wt-branch");
            ctx.create_branch("other", None).unwrap();
            ctx.checkout_branch("main").unwrap();
            let path = ctx.add_linked_worktree("wt", "wt-branch");
            let other = ctx.add_linked_worktree("wt2", "other");
            std::fs::copy(other.join(".git"), path.join(".git")).unwrap();

            assert_refused_and_unchanged(
                &mut ctx,
                &path,
                BranchHold::Refuse {
                    paths: vec![path.display().to_string()],
                    reason: Refusal::Mismatched,
                },
            );
        }

        #[test]
        fn when_the_admin_entry_records_something_other_than_a_git_file() {
            let mut ctx = repo_with_branch("wt-branch");
            let path = ctx.add_linked_worktree("wt", "wt-branch");
            std::fs::write(
                admin_dir(&ctx, "wt").join("gitdir"),
                format!("{}\n", path.join("README.md").display()),
            )
            .unwrap();

            assert_refused_and_unchanged(
                &mut ctx,
                &path,
                BranchHold::Refuse {
                    paths: vec![path.display().to_string()],
                    reason: Refusal::Mismatched,
                },
            );
        }

        #[test]
        fn when_two_linked_worktrees_hold_the_branch() {
            let mut ctx = repo_with_branch("wt-branch");
            ctx.create_branch("other", None).unwrap();
            ctx.checkout_branch("main").unwrap();
            let path = ctx.add_linked_worktree("wt", "wt-branch");
            let second = ctx.add_linked_worktree("wt2", "other");
            set_admin_head(&ctx, "wt2", "wt-branch");

            assert_refused_and_unchanged(
                &mut ctx,
                &path,
                BranchHold::Refuse {
                    paths: vec![path.display().to_string(), second.display().to_string()],
                    reason: Refusal::SeveralHolders,
                },
            );
        }

        #[test]
        fn when_the_worktree_is_open_in_a_tab() {
            let mut ctx = repo_with_branch("wt-branch");
            let path = ctx.add_linked_worktree("wt", "wt-branch");
            ctx.open_in_tab(&path);

            assert_refused_and_unchanged(
                &mut ctx,
                &path,
                BranchHold::Refuse {
                    paths: vec![path.display().to_string()],
                    reason: Refusal::OpenInTab,
                },
            );
        }

        #[test]
        fn when_a_repository_inside_the_worktree_is_open_in_a_tab() {
            let mut ctx = repo_with_branch("wt-branch");
            let path = ctx.add_linked_worktree("wt", "wt-branch");
            git2::Repository::init(path.join("inner")).unwrap();
            std::fs::write(path.join(".git/info/exclude"), "").ok();
            ctx.open_in_tab(&path.join("inner"));

            let hold = ctx.branch_hold("wt-branch").unwrap();

            assert_eq!(
                hold,
                BranchHold::Refuse {
                    paths: vec![path.display().to_string()],
                    reason: Refusal::OpenInTab,
                }
            );
        }
    }

    #[test]
    fn leaves_the_worktree_when_the_main_worktree_holds_the_branch_too() {
        let mut ctx = repo_with_branch("wt-branch");
        let path = ctx.add_linked_worktree("wt", "wt-branch");
        set_admin_head(&ctx, "wt", "main");

        let hold = ctx.branch_hold("main").unwrap();
        let result = ctx.delete_branch_removing("main", &removal("wt", &path, true));

        assert_eq!(hold, BranchHold::HeldByMain);
        assert_eq!(result.unwrap_err().code, "cannot_delete_head");
        assert_eq!(worktree_names(&ctx), ["wt"]);
    }

    #[test]
    fn removes_nothing_when_another_worktree_took_the_branch_after_the_offer() {
        let mut ctx = repo_with_branch("wt-branch");
        let path = ctx.add_linked_worktree("wt", "wt-branch");
        let offered = removal("wt", &path, false);
        set_admin_head(&ctx, "wt", "main");
        ctx.add_linked_worktree("wt2", "wt-branch");

        let result = ctx.delete_branch_removing("wt-branch", &offered);

        assert_eq!(result.unwrap_err().code, "worktree_changed");
        assert_eq!(worktree_names(&ctx), ["wt", "wt2"]);
        assert!(path.join("README.md").exists());
    }

    #[test]
    fn removes_nothing_when_the_branch_is_already_gone() {
        let mut ctx = repo_with_branch("wt-branch");
        let path = ctx.add_linked_worktree("wt", "wt-branch");
        ctx.repo()
            .find_reference("refs/heads/wt-branch")
            .unwrap()
            .delete()
            .unwrap();

        let result = ctx.delete_branch_removing("wt-branch", &removal("wt", &path, true));

        assert_eq!(result.unwrap_err().code, "git_not_found");
        assert_eq!(worktree_names(&ctx), ["wt"]);
    }

    #[test]
    fn says_the_worktree_went_when_the_branch_will_not_delete() {
        let mut ctx = repo_with_branch("wt-branch");
        let path = ctx.add_linked_worktree("wt", "wt-branch");
        std::fs::write(ctx.repo().path().join("refs/heads/wt-branch.lock"), "").unwrap();

        let error = ctx
            .delete_branch_removing("wt-branch", &removal("wt", &path, false))
            .unwrap_err();

        assert_eq!(error.code, "branch_not_deleted");
        assert!(!path.exists());
        ctx.assert_branch_exists("wt-branch");
    }

    mod offers_without_a_warning {
        use super::*;

        fn assert_offered(ctx: &TestContext, path: &std::path::Path) {
            assert_eq!(
                ctx.branch_hold("wt-branch").unwrap(),
                BranchHold::Offer {
                    name: "wt".into(),
                    path: path.display().to_string(),
                }
            );
        }

        #[test]
        fn when_the_gitfiles_are_relative() {
            let mut ctx = repo_with_branch("wt-branch");
            let path = ctx.add_linked_worktree("wt", "wt-branch");
            let admin = admin_dir(&ctx, "wt").canonicalize().unwrap();
            std::fs::write(
                admin.join("gitdir"),
                format!("{}\n", relative(&admin, &path.join(".git")).display()),
            )
            .unwrap();
            std::fs::write(
                path.join(".git"),
                format!("gitdir: {}\n", relative(&path, &admin).display()),
            )
            .unwrap();

            assert_offered(&ctx, &path);
            ctx.delete_branch_removing("wt-branch", &removal("wt", &path, false))
                .unwrap();
            assert!(!path.exists());
        }

        #[test]
        fn when_a_clean_worktree_is_sparse() {
            let ctx = repo_with_branch("wt-branch");
            let path = ctx.add_linked_worktree("wt", "wt-branch");
            let sparse = std::process::Command::new("git")
                .args(["sparse-checkout", "set", "keep"])
                .current_dir(&path)
                .output()
                .unwrap();
            assert!(sparse.status.success(), "{sparse:?}");

            assert_offered(&ctx, &path);
        }
    }

    /// `to` relative to directory `from`, both absolute and canonical.
    fn relative(from: &std::path::Path, to: &std::path::Path) -> std::path::PathBuf {
        let from: Vec<_> = from.components().collect();
        let to: Vec<_> = to.components().collect();
        let shared = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
        let mut path = std::path::PathBuf::new();
        for _ in shared..from.len() {
            path.push("..");
        }
        for component in &to[shared..] {
            path.push(component);
        }
        path
    }
}

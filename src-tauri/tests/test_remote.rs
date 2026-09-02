mod common;

use common::context::TestContext;
use std::path::Path;
use trunk_lib::commands::remote::{
    FORCE_PUSH_ARGS, classify_git_error, get_push_target_inner, resolve_push_target,
};
use trunk_lib::git::repository::has_unmerged_paths;

fn set_config(ctx: &TestContext, pairs: &[(&str, &str)]) {
    let repo = ctx.repo();
    let mut cfg = repo.config().unwrap();
    for (key, value) in pairs {
        cfg.set_str(key, value).unwrap();
    }
}

/// Point `branch` at the remote so a bare `git pull`/`git push` has a target.
/// `with_remote` registers the remote but configures no tracking.
fn track_upstream(ctx: &TestContext, remote: &str, branch: &str) {
    set_config(
        ctx,
        &[
            (&format!("branch.{branch}.remote"), remote),
            (
                &format!("branch.{branch}.merge"),
                &format!("refs/heads/{branch}"),
            ),
        ],
    );
}

fn bare_remote(ctx: &TestContext, remote: &str) -> std::path::PathBuf {
    ctx.repo_path().join(format!("{remote}.git"))
}

/// Commit straight into the bare remote, standing in for another clone pushing to it.
fn commit_on_remote(bare: &Path, branch: &str, file: &str, content: &str, message: &str) {
    let repo = git2::Repository::open(bare).unwrap();
    let tip = repo
        .find_reference(&format!("refs/heads/{branch}"))
        .unwrap()
        .peel_to_commit()
        .unwrap();
    let blob = repo.blob(content.as_bytes()).unwrap();
    let mut builder = repo.treebuilder(Some(&tip.tree().unwrap())).unwrap();
    builder
        .insert(file, blob, git2::FileMode::Blob.into())
        .unwrap();
    let tree = repo.find_tree(builder.write().unwrap()).unwrap();
    let sig =
        git2::Signature::new("Test User", "test@example.com", &git2::Time::new(0, 0)).unwrap();
    repo.commit(
        Some(&format!("refs/heads/{branch}")),
        &sig,
        &sig,
        message,
        &tree,
        &[&tip],
    )
    .unwrap();
}

// --- classify_git_error tests ---
// classify_git_error is a pure function (string -> TrunkError). No TestContext needed.

#[test]
fn classify_auth_failure_password() {
    let err =
        classify_git_error("fatal: Authentication failed for 'https://github.com/user/repo.git'");
    assert_eq!(err.code, "auth_failure");
}

#[test]
fn classify_auth_failure_ssh() {
    let err = classify_git_error("permission denied (publickey).");
    assert_eq!(err.code, "auth_failure");
}

#[test]
fn classify_auth_failure_remote_read() {
    let err = classify_git_error("fatal: could not read from remote repository.");
    assert_eq!(err.code, "auth_failure");
}

#[test]
fn classify_auth_failure_host_key() {
    let err = classify_git_error("Host key verification failed.");
    assert_eq!(err.code, "auth_failure");
}

#[test]
fn classify_auth_failure_connection_refused() {
    let err = classify_git_error("ssh: connect to host github.com port 22: Connection refused");
    assert_eq!(err.code, "auth_failure");
}

#[test]
fn classify_non_fast_forward() {
    let err = classify_git_error("! [rejected] main -> main (non-fast-forward)");
    assert_eq!(err.code, "non_fast_forward");
}

#[test]
fn classify_non_fast_forward_fetch_first() {
    let err = classify_git_error(
        "hint: Updates were rejected because the remote contains work that you do not have locally. Fetch first.",
    );
    assert_eq!(err.code, "non_fast_forward");
}

#[test]
fn classify_non_fast_forward_failed_push() {
    let err = classify_git_error("error: failed to push some refs to 'origin'");
    assert_eq!(err.code, "non_fast_forward");
}

#[test]
fn classify_remote_ref_updated_is_a_lease_refusal() {
    let err = classify_git_error(
        "! [rejected] main -> main (remote ref updated since checkout)\nerror: failed to push some refs",
    );
    assert_eq!(err.code, "push_lease_refused");
}

#[test]
fn classify_stale_info_is_a_lease_refusal() {
    let err = classify_git_error(
        "! [rejected] main -> main (stale info)\nerror: failed to push some refs",
    );
    assert_eq!(err.code, "push_lease_refused");
}

#[test]
fn classify_plain_divergence_is_not_a_lease_refusal() {
    let err = classify_git_error("! [rejected] main -> main (fetch first)");
    assert_eq!(err.code, "non_fast_forward");
}

#[test]
fn classify_hook_forged_lease_markers_are_not_a_lease_refusal() {
    // A remote can print either marker on its own lines. Unscoped, that would make an
    // ordinary divergence render as a refusal and withhold the force-push remedy.
    let err = classify_git_error(
        "remote: error: your push contains stale info, please retry\nremote: error: remote ref updated since checkout\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'origin'",
    );
    assert_eq!(err.code, "non_fast_forward");
}

#[test]
fn classify_hook_decline_is_not_non_fast_forward() {
    // Verbatim git 2.55 output for a pre-receive decline. It carries "failed to push
    // some refs" like every failed push, so the divergence arm captures it unless the
    // decline is tested first — and a force push cannot fix a declined hook.
    let err = classify_git_error(
        "remote: error: pushing to a protected branch is not allowed\n! [remote rejected] HEAD -> master (pre-receive hook declined)\nerror: failed to push some refs to '/tmp/hookprobe/remote.git'",
    );
    assert_eq!(err.code, "push_declined");
}

#[test]
fn classify_no_upstream() {
    let err = classify_git_error("fatal: The current branch feature has no upstream branch.");
    assert_eq!(err.code, "no_upstream");
}

#[test]
fn classify_generic_error() {
    let err = classify_git_error("some random error that doesn't match any pattern");
    assert_eq!(err.code, "remote_error");
}

#[test]
fn classify_mixed_case_auth() {
    let err = classify_git_error("FATAL: AUTHENTICATION FAILED");
    assert_eq!(err.code, "auth_failure");
}

#[test]
fn classify_combined_stderr_with_progress_and_error() {
    let stderr = "Counting objects: 100% (3/3), done.\nfatal: Authentication failed for 'https://github.com/user/repo.git'";
    let err = classify_git_error(stderr);
    assert_eq!(err.code, "auth_failure");
}

// --- FORCE_PUSH_ARGS tests ---

#[test]
fn force_push_never_issues_bare_force() {
    // Criterion 11: Trunk never issues a bare `--force`.
    assert!(!FORCE_PUSH_ARGS.contains(&"--force"));
}

// --- live remote operations ---

#[test]
fn clean_pull_returns_ok() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_remote("origin")
        .build();
    track_upstream(&ctx, "origin", "main");
    let remote = ctx.remote();
    remote.push().unwrap();
    commit_on_remote(
        &bare_remote(&ctx, "origin"),
        "main",
        "upstream.txt",
        "from the remote",
        "Remote commit",
    );

    remote.pull(None).unwrap();

    let summaries: Vec<String> = remote
        .cached_graph()
        .expect("pull refreshes the cached graph")
        .commits
        .iter()
        .map(|c| c.summary.clone())
        .collect();
    assert!(
        summaries.contains(&"Remote commit".to_string()),
        "pull should bring the remote commit into the graph; got {summaries:?}"
    );
}

/// One commit adding `count` files, so the merge diffstat `git pull` writes to
/// stdout runs `count` lines long.
fn commit_many_on_remote(bare: &Path, branch: &str, count: usize, message: &str) {
    let repo = git2::Repository::open(bare).unwrap();
    let tip = repo
        .find_reference(&format!("refs/heads/{branch}"))
        .unwrap()
        .peel_to_commit()
        .unwrap();
    let mut builder = repo.treebuilder(Some(&tip.tree().unwrap())).unwrap();
    for i in 0..count {
        let blob = repo.blob(format!("line {i}\n").as_bytes()).unwrap();
        builder
            .insert(
                format!("bulk-{i:05}.txt"),
                blob,
                git2::FileMode::Blob.into(),
            )
            .unwrap();
    }
    let tree = repo.find_tree(builder.write().unwrap()).unwrap();
    let sig =
        git2::Signature::new("Test User", "test@example.com", &git2::Time::new(0, 0)).unwrap();
    repo.commit(
        Some(&format!("refs/heads/{branch}")),
        &sig,
        &sig,
        message,
        &tree,
        &[&tip],
    )
    .unwrap();
}

#[test]
fn pull_completes_when_the_diffstat_outgrows_the_stdout_pipe_buffer() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_remote("origin")
        .build();
    track_upstream(&ctx, "origin", "main");
    let remote = ctx.remote();
    remote.push().unwrap();
    commit_many_on_remote(&bare_remote(&ctx, "origin"), "main", 4000, "Bulk import");

    remote.pull(None).unwrap();

    assert!(ctx.repo_path().join("bulk-03999.txt").exists());
}

#[test]
fn push_is_refused_while_the_same_repo_has_an_op_running() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_remote("origin")
        .build();
    track_upstream(&ctx, "origin", "main");
    let remote = ctx.remote();
    remote.seed_running_op(ctx.path(), 4242);

    let err = remote.push().unwrap_err();

    assert_eq!(err.code, "op_in_progress");
}

#[test]
fn push_proceeds_while_a_different_repo_has_an_op_running() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_remote("origin")
        .build();
    track_upstream(&ctx, "origin", "main");
    let remote = ctx.remote();
    remote.seed_running_op("/another/repo", 4242);

    remote.push().unwrap();

    assert_eq!(
        remote_tip(&bare_remote(&ctx, "origin"), "main"),
        ctx.repo().head().unwrap().target().unwrap(),
        "one repo's running op must not hold another repo's push"
    );
}

#[test]
fn pull_reports_autostash_conflict() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_remote("origin")
        .build();
    track_upstream(&ctx, "origin", "main");
    ctx.repo()
        .config()
        .unwrap()
        .set_bool("rebase.autostash", true)
        .unwrap();
    let remote = ctx.remote();
    remote.push().unwrap();
    commit_on_remote(
        &bare_remote(&ctx, "origin"),
        "main",
        "file.txt",
        "remote content",
        "Remote commit",
    );
    std::fs::write(ctx.repo_path().join("file.txt"), "local content").unwrap();

    let err = remote.pull(Some("rebase")).unwrap_err();

    assert_eq!(err.code, "autostash_conflict");
    let summaries: Vec<String> = remote
        .cached_graph()
        .expect("the graph is refreshed before the conflict is reported")
        .commits
        .iter()
        .map(|c| c.summary.clone())
        .collect();
    assert!(
        summaries.contains(&"Remote commit".to_string()),
        "the cache must already hold the post-pull graph when the Err arrives; got {summaries:?}"
    );
}

#[test]
fn pull_over_a_preexisting_stash_pop_conflict_is_not_blamed_as_an_autostash_conflict() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "base")
        .with_commit("Initial commit")
        .with_remote("origin")
        .build();
    track_upstream(&ctx, "origin", "main");
    let remote = ctx.remote();
    remote.push().unwrap();
    std::fs::write(ctx.repo_path().join("file.txt"), "stashed content").unwrap();
    ctx.stash_save("wip").unwrap();
    std::fs::write(ctx.repo_path().join("file.txt"), "committed content").unwrap();
    ctx.stage_file("file.txt").unwrap();
    ctx.create_commit("Diverging commit", None).unwrap();
    ctx.stash_pop(&ctx.top_stash_oid()).unwrap_err();
    assert!(
        has_unmerged_paths(&ctx.repo()).unwrap(),
        "setup precondition: the pop leaves conflicted paths behind"
    );

    let err = remote.pull(None).unwrap_err();

    assert_eq!(
        err.code, "remote_error",
        "git refuses to pull at all over an unmerged index"
    );
    assert_ne!(
        err.code, "autostash_conflict",
        "a conflict the pull did not cause must never be reported as one it did"
    );
}

/// Replace `branch`'s tip with a fresh commit on the same parent, as an amend or
/// an interactive rebase would.
fn rewrite_tip(ctx: &TestContext, branch: &str, content: &str) {
    let repo = ctx.repo();
    let tip = repo
        .find_branch(branch, git2::BranchType::Local)
        .unwrap()
        .get()
        .peel_to_commit()
        .unwrap();
    let parent = tip.parent(0).unwrap();
    let blob = repo.blob(content.as_bytes()).unwrap();
    let mut builder = repo.treebuilder(Some(&parent.tree().unwrap())).unwrap();
    builder
        .insert("rewritten.txt", blob, git2::FileMode::Blob.into())
        .unwrap();
    let tree = repo.find_tree(builder.write().unwrap()).unwrap();
    let sig =
        git2::Signature::new("Test User", "test@example.com", &git2::Time::new(0, 0)).unwrap();
    let rewritten = repo
        .commit(
            None,
            &sig,
            &sig,
            &format!("Rewritten {branch}"),
            &tree,
            &[&parent],
        )
        .unwrap();
    repo.reference(
        &format!("refs/heads/{branch}"),
        rewritten,
        true,
        "rewrite tip",
    )
    .unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
        .unwrap();
}

fn checkout_branch(ctx: &TestContext, branch: &str) {
    let repo = ctx.repo();
    repo.set_head(&format!("refs/heads/{branch}")).unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::default().force()))
        .unwrap();
}

fn remote_tip(bare: &Path, branch: &str) -> git2::Oid {
    git2::Repository::open(bare)
        .unwrap()
        .find_reference(&format!("refs/heads/{branch}"))
        .unwrap()
        .target()
        .unwrap()
}

#[test]
fn force_push_targets_only_the_current_branch() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("release")
        .checkout("release")
        .with_file("release.txt", "release work")
        .with_commit("Release commit")
        .checkout("main")
        .with_file("main.txt", "main work")
        .with_commit("Main commit")
        .with_remote("origin")
        .build();
    track_upstream(&ctx, "origin", "main");
    // Exactly the fan-out trigger finding 1 reproduces: git derives the ref set from
    // config, not from the branch the confirmation named.
    ctx.repo()
        .config()
        .unwrap()
        .set_str("remote.origin.push", "refs/heads/*:refs/heads/*")
        .unwrap();
    let remote = ctx.remote();
    remote.push().unwrap();
    let bare = bare_remote(&ctx, "origin");
    let release_before = remote_tip(&bare, "release");
    rewrite_tip(&ctx, "release", "rewritten release");
    rewrite_tip(&ctx, "main", "rewritten main");

    remote.push_force("origin", "main").unwrap();

    assert_eq!(
        remote_tip(&bare, "release"),
        release_before,
        "force-pushing main must not move a branch the caller never named"
    );
    assert_eq!(
        remote_tip(&bare, "main"),
        ctx.repo().head().unwrap().target().unwrap(),
        "force-pushing main must move main"
    );
}

#[test]
fn force_push_refuses_when_the_repo_left_the_confirmed_branch() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("release")
        .checkout("release")
        .with_file("release.txt", "release work")
        .with_commit("Release commit")
        .checkout("main")
        .with_file("main.txt", "main work")
        .with_commit("Main commit")
        .with_remote("origin")
        .build();
    track_upstream(&ctx, "origin", "main");
    ctx.repo()
        .config()
        .unwrap()
        .set_str("remote.origin.push", "refs/heads/*:refs/heads/*")
        .unwrap();
    let remote = ctx.remote();
    remote.push().unwrap();
    let bare = bare_remote(&ctx, "origin");
    let release_before = remote_tip(&bare, "release");
    let main_before = remote_tip(&bare, "main");
    rewrite_tip(&ctx, "release", "rewritten release");
    checkout_branch(&ctx, "release");

    let result = remote.push_force("origin", "main");

    assert_eq!(
        remote_tip(&bare, "release"),
        release_before,
        "a force push confirmed for main must not rewrite the branch checked out since"
    );
    assert_eq!(
        remote_tip(&bare, "main"),
        main_before,
        "a force push confirmed for main must not put another branch's commits on it"
    );
    assert_eq!(result.unwrap_err().code, "push_target_changed");
}

#[test]
fn force_push_refuses_mid_merge() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("file.txt", "feature content")
        .with_commit("Feature commit")
        .checkout("main")
        .with_file("file.txt", "main content")
        .with_commit("Main commit")
        .with_remote("origin")
        .with_conflict("feature")
        .build();
    track_upstream(&ctx, "origin", "main");
    let remote = ctx.remote();
    remote.push().unwrap();
    let bare = bare_remote(&ctx, "origin");
    commit_on_remote(&bare, "main", "remote.txt", "ahead", "Remote commit");
    let before = remote_tip(&bare, "main");

    let err = remote.push_force("origin", "main").unwrap_err();

    assert_eq!(err.code, "op_in_progress_local");
    assert_eq!(
        remote_tip(&bare, "main"),
        before,
        "a refused force push must not reach the remote at all"
    );
}

#[test]
fn force_push_lease_refuses_a_remote_tip_we_never_fetched() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_file("main.txt", "main work")
        .with_commit("Main commit")
        .with_remote("origin")
        .build();
    track_upstream(&ctx, "origin", "main");
    let remote = ctx.remote();
    remote.push().unwrap();
    let bare = bare_remote(&ctx, "origin");
    commit_on_remote(
        &bare,
        "main",
        "upstream.txt",
        "from a colleague",
        "Remote commit",
    );
    let before = remote_tip(&bare, "main");
    rewrite_tip(&ctx, "main", "rewritten main");

    let err = remote.push_force("origin", "main").unwrap_err();

    assert_eq!(err.code, "push_lease_refused");
    assert_eq!(
        remote_tip(&bare, "main"),
        before,
        "the lease must keep a rewrite off a remote tip this clone never saw"
    );
}

#[test]
fn force_push_refuses_a_worktree_with_unresolved_conflicts() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "base")
        .with_commit("Initial commit")
        .with_remote("origin")
        .build();
    track_upstream(&ctx, "origin", "main");
    let remote = ctx.remote();
    remote.push().unwrap();
    let bare = bare_remote(&ctx, "origin");
    let before = remote_tip(&bare, "main");
    std::fs::write(ctx.repo_path().join("file.txt"), "stashed content").unwrap();
    ctx.stash_save("wip").unwrap();
    std::fs::write(ctx.repo_path().join("file.txt"), "committed content").unwrap();
    ctx.stage_file("file.txt").unwrap();
    ctx.create_commit("Diverging commit", None).unwrap();
    ctx.stash_pop(&ctx.top_stash_oid()).unwrap_err();
    assert!(
        has_unmerged_paths(&ctx.repo()).unwrap(),
        "setup precondition: the pop leaves conflicted paths behind"
    );
    assert_eq!(
        ctx.repo().state(),
        git2::RepositoryState::Clean,
        "setup precondition: repo.state() alone cannot see this conflict, which is the gap under test"
    );

    let err = remote.push_force("origin", "main").unwrap_err();

    assert_eq!(err.code, "op_in_progress_local");
    assert_eq!(
        remote_tip(&bare, "main"),
        before,
        "a refused force push must not reach the remote at all"
    );
}

// --- resolve_push_target tests ---
// The four-step chain git itself walks: branch.<n>.pushRemote -> remote.pushDefault
// -> branch.<n>.remote -> origin-by-name.

fn repo_on_main() -> TestContext {
    TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_remote("origin")
        .build()
}

#[test]
fn push_target_prefers_the_branch_push_remote() {
    let ctx = repo_on_main();
    set_config(
        &ctx,
        &[
            ("branch.main.pushRemote", "mirror"),
            ("remote.pushDefault", "fallback"),
            ("branch.main.remote", "origin"),
        ],
    );

    let target = resolve_push_target(&ctx.repo()).unwrap();

    assert_eq!(target.remote.as_deref(), Some("mirror"));
    assert_eq!(target.branch.as_deref(), Some("main"));
}

#[test]
fn push_target_falls_back_to_the_push_default() {
    let ctx = repo_on_main();
    set_config(
        &ctx,
        &[
            ("remote.pushDefault", "mirror"),
            ("branch.main.remote", "origin"),
        ],
    );

    let target = resolve_push_target(&ctx.repo()).unwrap();

    assert_eq!(target.remote.as_deref(), Some("mirror"));
}

#[test]
fn push_target_falls_back_to_the_branch_remote() {
    let ctx = repo_on_main();
    set_config(&ctx, &[("branch.main.remote", "upstream")]);

    let target = resolve_push_target(&ctx.repo()).unwrap();

    assert_eq!(target.remote.as_deref(), Some("upstream"));
}

#[test]
fn push_target_falls_back_to_origin() {
    let ctx = repo_on_main();

    let target = resolve_push_target(&ctx.repo()).unwrap();

    assert_eq!(target.remote.as_deref(), Some("origin"));
}

#[test]
fn push_target_has_no_remote_when_none_is_named_origin() {
    let ctx = TestContext::builder()
        .with_file("file.txt", "hello")
        .with_commit("Initial commit")
        .with_remote("upstream")
        .build();

    let target = resolve_push_target(&ctx.repo()).unwrap();

    assert_eq!(
        target.remote, None,
        "a sole non-origin remote is not a target"
    );
    assert_eq!(target.branch.as_deref(), Some("main"));
}

#[test]
fn push_target_has_no_branch_on_a_detached_head() {
    let ctx = repo_on_main();
    let repo = ctx.repo();
    let head = repo.head().unwrap().target().unwrap();
    repo.set_head_detached(head).unwrap();

    let target = resolve_push_target(&repo).unwrap();

    assert_eq!(target.branch, None);
}

// --- get_push_target tests ---

#[test]
fn get_push_target_resolves_the_open_repo() {
    let ctx = repo_on_main();

    let target = get_push_target_inner(ctx.path(), ctx.state_map()).unwrap();

    assert_eq!(target.remote.as_deref(), Some("origin"));
    assert_eq!(target.branch.as_deref(), Some("main"));
}

#[test]
fn get_push_target_reports_not_open_for_an_unregistered_repo() {
    let ctx = repo_on_main();

    let err = get_push_target_inner("/not/a/registered/repo", ctx.state_map()).unwrap_err();

    assert_eq!(err.code, "not_open");
}

/// A pull with rebase that stops on a conflict is an expected outcome, not a
/// remote failure. Falling through to `remote_error` puts git's whole stderr,
/// hints included, on screen as the message.
#[test]
fn classify_a_pull_that_stopped_on_a_conflict() {
    let err = classify_git_error(
        "Rebasing (1/1)\nerror: could not apply a3d06e5... Mine\n\
         hint: Resolve all conflicts manually, mark them as resolved with\n\
         hint: \"git add/rm <conflicted_files>\", then run \"git rebase --continue\".\n\
         Could not apply a3d06e5... Mine",
    );

    assert_eq!(err.code, "rebase_conflict");
}

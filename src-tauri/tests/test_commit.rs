mod common;

use common::context::TestContext;

fn stage_new_file(ctx: &TestContext, name: &str) {
    std::fs::write(ctx.repo_path().join(name), name).unwrap();
    let repo = ctx.repo();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new(name)).unwrap();
    index.write().unwrap();
}

fn head_oid(ctx: &TestContext) -> git2::Oid {
    ctx.repo().head().unwrap().target().unwrap()
}

fn head_message(ctx: &TestContext) -> String {
    let repo = ctx.repo();
    let commit = repo.head().unwrap().peel_to_commit().unwrap();
    commit.message().unwrap().to_owned()
}

fn head_author_name(ctx: &TestContext) -> String {
    let repo = ctx.repo();
    let commit = repo.head().unwrap().peel_to_commit().unwrap();
    commit.author().name().unwrap().to_owned()
}

fn set_config(ctx: &TestContext, key: &str, value: &str) {
    ctx.repo().config().unwrap().set_str(key, value).unwrap();
}

/// Configures the repository to sign with a fresh SSH key and to trust that
/// key when verifying. The returned directory holds the key and must outlive
/// the commits it signs.
fn sign_with_a_fresh_ssh_key(ctx: &TestContext) -> tempfile::TempDir {
    let keys = tempfile::tempdir().unwrap();
    let key = keys.path().join("id_ed25519");
    let status = std::process::Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f"])
        .arg(&key)
        .status()
        .unwrap();
    assert!(status.success(), "ssh-keygen failed");

    let public_key = std::fs::read_to_string(key.with_extension("pub")).unwrap();
    let allowed_signers = keys.path().join("allowed_signers");
    std::fs::write(&allowed_signers, format!("test@example.com {public_key}")).unwrap();

    set_config(ctx, "commit.gpgsign", "true");
    set_config(ctx, "gpg.format", "ssh");
    set_config(ctx, "user.signingkey", key.to_str().unwrap());
    set_config(
        ctx,
        "gpg.ssh.allowedSignersFile",
        allowed_signers.to_str().unwrap(),
    );
    keys
}

fn verify_head_signature(ctx: &TestContext) -> std::process::Output {
    std::process::Command::new("git")
        .args(["verify-commit", "HEAD"])
        .current_dir(ctx.repo_path())
        .output()
        .unwrap()
}

fn assert_head_signature_verifies(ctx: &TestContext) {
    let verify = verify_head_signature(ctx);
    assert!(
        verify.status.success(),
        "git verify-commit HEAD failed: {}",
        String::from_utf8_lossy(&verify.stderr)
    );
}

const TRAILER_HOOK: &str = "printf '\\nHook-Ran: yes\\n' >> \"$1\"";

// -- create_commit tests --

#[test]
fn create_commit_creates_new_commit() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Stage a new file
    std::fs::write(ctx.repo_path().join("new_file.txt"), "content").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index
            .add_path(std::path::Path::new("new_file.txt"))
            .unwrap();
        index.write().unwrap();
    }

    ctx.create_commit("New commit", None)
        .expect("create_commit failed");

    let repo = ctx.repo();
    let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head_commit.summary().unwrap().unwrap(), "New commit");
}

#[test]
fn create_commit_works_on_unborn_head() {
    let ctx = TestContext::new_empty();

    std::fs::write(ctx.repo_path().join("first.txt"), "first content").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("first.txt")).unwrap();
        index.write().unwrap();
    }

    let result = ctx.create_commit("Initial commit", None);
    assert!(
        result.is_ok(),
        "expected Ok for unborn HEAD, got: {result:?}"
    );

    let repo = ctx.repo();
    let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head_commit.summary().unwrap().unwrap(), "Initial commit");
}

#[test]
fn create_commit_uses_configured_signature() {
    let ctx = TestContext::new_empty();

    // Override default user config with a specific identity
    {
        let repo = ctx.repo();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Jane Doe").unwrap();
        cfg.set_str("user.email", "jane@example.com").unwrap();
    }

    std::fs::write(ctx.repo_path().join("file.txt"), "hello").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
    }

    ctx.create_commit("Signed commit", None)
        .expect("create_commit failed");

    let repo = ctx.repo();
    let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head_commit.author().name().unwrap(), "Jane Doe");
}

#[test]
fn create_commit_is_refused_by_a_failing_pre_commit_hook() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    let before = head_oid(&ctx);
    ctx.install_hook("pre-commit", "echo 'refused by pre-commit'\nexit 1");
    stage_new_file(&ctx, "new_file.txt");

    let err = ctx.create_commit("New commit", None).unwrap_err();

    assert!(
        err.message.contains("refused by pre-commit"),
        "got: {err:?}"
    );
    assert_eq!(head_oid(&ctx), before);
}

#[test]
fn create_commit_is_signed_as_the_repository_config_asks() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    let _keys = sign_with_a_fresh_ssh_key(&ctx);
    stage_new_file(&ctx, "new_file.txt");

    ctx.create_commit("Signed commit", None).unwrap();

    assert_head_signature_verifies(&ctx);
}

#[test]
fn create_commit_keeps_the_trailer_a_commit_msg_hook_adds() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    ctx.install_hook("commit-msg", TRAILER_HOOK);
    stage_new_file(&ctx, "new_file.txt");

    ctx.create_commit("New commit", None).unwrap();

    assert!(
        head_message(&ctx).contains("Hook-Ran: yes"),
        "got: {:?}",
        head_message(&ctx)
    );
}

#[test]
fn create_commit_with_nothing_staged_reports_gits_reason() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let err = ctx.create_commit("Nothing", None).unwrap_err();

    assert!(err.message.contains("nothing to commit"), "got: {err:?}");
}

#[test]
fn create_commit_refused_by_a_silent_hook_still_explains_the_refusal() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    ctx.install_hook("pre-commit", "exit 1");
    stage_new_file(&ctx, "new_file.txt");

    let err = ctx.create_commit("New commit", None).unwrap_err();

    assert_eq!(
        err.message,
        "git exited with code 1 and printed no reason. A hook may have refused it."
    );
}

#[test]
fn create_commit_returns_while_a_process_its_hook_started_still_runs() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    let left_running = ctx.install_hook_leaving_a_process_running("post-commit");
    stage_new_file(&ctx, "new_file.txt");

    let result = ctx.create_commit("New commit", None);

    left_running.release();
    result.unwrap();
    assert_eq!(head_message(&ctx).trim_end(), "New commit");
}

#[test]
fn create_commit_during_a_revert_concludes_it() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_file("second.txt", "second")
        .with_commit("Second commit")
        .build();
    ctx.revert_commit_begin(&head_oid(&ctx).to_string())
        .unwrap();

    ctx.create_commit("Revert \"Second commit\"", None).unwrap();

    assert!(!ctx.repo_path().join(".git").join("REVERT_HEAD").exists());
}

// -- amend_commit tests --

#[test]
fn amend_commit_updates_message() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    ctx.amend_commit("Amended subject", None)
        .expect("amend_commit failed");

    let repo = ctx.repo();
    let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head_commit.summary().unwrap().unwrap(), "Amended subject");
}

#[test]
fn amend_commit_refuses_when_head_is_not_the_commit_chosen() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_file("second.txt", "content")
        .with_commit("Second commit")
        .build();
    let second = head_oid(&ctx);
    let first = ctx.resolve_ref("HEAD~1").unwrap();

    let err = ctx
        .amend_commit_on(&first, "Amended subject", None)
        .unwrap_err();

    assert_eq!(err.code, "amend_stale");
    assert_eq!(head_oid(&ctx), second);
    assert_eq!(head_message(&ctx).trim_end(), "Second commit");
}

#[test]
fn amend_commit_reports_a_head_that_will_not_read_rather_than_a_moved_one() {
    let ctx = TestContext::builder().build();

    let err = ctx
        .amend_commit_on("0000000000000000000000000000000000000000", "Subject", None)
        .unwrap_err();

    assert_eq!(err.code, "git_unborn_branch");
}

#[test]
fn amend_commit_includes_newly_staged_files() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    // Stage a new file before amending
    std::fs::write(ctx.repo_path().join("staged_file.txt"), "staged content").unwrap();
    {
        let repo = ctx.repo();
        let mut index = repo.index().unwrap();
        index
            .add_path(std::path::Path::new("staged_file.txt"))
            .unwrap();
        index.write().unwrap();
    }

    ctx.amend_commit("Amended with staged", None)
        .expect("amend_commit failed");

    let repo = ctx.repo();
    let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
    let tree = head_commit.tree().unwrap();
    assert!(
        tree.get_name("staged_file.txt").is_some(),
        "expected staged_file.txt in amended commit tree"
    );
}

#[test]
fn amend_commit_keeps_the_original_author() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    let original_author = head_author_name(&ctx);
    set_config(&ctx, "user.name", "Someone Else");

    ctx.amend_commit("Amended subject", None).unwrap();

    assert_eq!(head_author_name(&ctx), original_author);
}

#[test]
fn amend_commit_is_refused_by_a_failing_pre_commit_hook() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    let before = head_oid(&ctx);
    ctx.install_hook("pre-commit", "echo 'refused by pre-commit'\nexit 1");

    let err = ctx.amend_commit("Amended subject", None).unwrap_err();

    assert!(
        err.message.contains("refused by pre-commit"),
        "got: {err:?}"
    );
    assert_eq!(head_oid(&ctx), before);
}

#[test]
fn amend_commit_is_signed_as_the_repository_config_asks() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    let _keys = sign_with_a_fresh_ssh_key(&ctx);

    ctx.amend_commit("Amended subject", None).unwrap();

    assert_head_signature_verifies(&ctx);
}

#[test]
fn amend_commit_keeps_the_trailer_a_commit_msg_hook_adds() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    ctx.install_hook("commit-msg", TRAILER_HOOK);

    ctx.amend_commit("Amended subject", None).unwrap();

    assert!(
        head_message(&ctx).contains("Hook-Ran: yes"),
        "got: {:?}",
        head_message(&ctx)
    );
}

#[test]
fn amend_commit_runs_the_post_rewrite_hook() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    ctx.install_hook("post-rewrite", "echo \"$1\" > .git/post-rewrite-ran");

    ctx.amend_commit("Amended subject", None).unwrap();

    let ran = std::fs::read_to_string(ctx.repo_path().join(".git").join("post-rewrite-ran"));
    assert_eq!(ran.unwrap().trim(), "amend");
}

// -- get_user_name tests --

#[test]
fn get_user_name_reads_the_name_commits_are_signed_with() {
    let ctx = TestContext::new_empty();
    ctx.repo()
        .config()
        .unwrap()
        .set_str("user.name", "Ada Lovelace")
        .unwrap();

    assert_eq!(
        ctx.get_user_name().unwrap().as_deref(),
        Some("Ada Lovelace")
    );
}

// -- get_head_commit_message tests --

#[test]
fn get_head_commit_message_returns_subject_and_body() {
    let ctx = TestContext::new_empty();

    // Create a commit with subject and body
    {
        let repo = ctx.repo();
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        std::fs::write(ctx.repo_path().join("file.txt"), "hello").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "Subject\n\nBody text", &tree, &[])
            .unwrap();
    }

    let msg = ctx
        .get_head_commit_message()
        .expect("get_head_commit_message failed");
    assert_eq!(msg.subject, "Subject");
    assert_eq!(msg.body, Some("Body text".to_owned()));
}

mod when_another_writer_runs_meanwhile {
    use super::*;
    use common::drivers::commit::commit_what_is_staged;
    use common::drivers::staging::stage_path;
    use trunk_git::error::TrunkError;

    /// A `pre-commit` hook that says it has started, then waits to be let go.
    struct PausedHook {
        fifos: tempfile::TempDir,
    }

    impl PausedHook {
        fn install(ctx: &TestContext) -> Self {
            let fifos = tempfile::tempdir().unwrap();
            for name in ["started", "go"] {
                let made = std::process::Command::new("mkfifo")
                    .arg(fifos.path().join(name))
                    .status()
                    .unwrap();
                assert!(made.success(), "mkfifo failed");
            }
            let hook = Self { fifos };
            ctx.install_hook(
                "pre-commit",
                &format!(
                    "echo started > '{}'\nread line < '{}'",
                    hook.fifo("started").display(),
                    hook.fifo("go").display()
                ),
            );

            hook
        }

        fn fifo(&self, name: &str) -> std::path::PathBuf {
            self.fifos.path().join(name)
        }

        fn wait_until_started(&self) {
            std::fs::read_to_string(self.fifo("started")).unwrap();
        }

        fn let_go(&self) {
            std::fs::write(self.fifo("go"), "go\n").unwrap();
        }
    }

    /// Runs `create_commit` and, once its pre-commit hook has started, another writer
    /// that stages `file_path`. The hook is let go once that writer waits or ends.
    fn commit_while_another_writer_stages_during_the_hook(
        ctx: &TestContext,
        file_path: &str,
    ) -> Result<(), TrunkError> {
        std::fs::write(ctx.repo_path().join(file_path), file_path).unwrap();
        let repo = ctx.repo();
        let hook = PausedHook::install(ctx);
        let (queued, waits_or_ends) = std::sync::mpsc::channel();
        let ended = queued.clone();

        std::thread::scope(|scope| {
            let committed = scope.spawn(|| ctx.create_commit("Commit b", None));
            hook.wait_until_started();
            trunk_git::write_gate::on_next_wait(&repo, move || queued.send(()).unwrap());
            scope.spawn(move || {
                trunk_git::write_gate::hold(&repo, |repo| {
                    stage_path(repo, file_path);
                    Ok(())
                })
                .unwrap();
                let _ = ended.send(());
            });
            waits_or_ends.recv().unwrap();
            hook.let_go();

            committed.join().expect("create_commit panicked")
        })
    }

    #[test]
    fn create_commit_leaves_a_file_staged_while_its_hook_runs_for_the_next_commit() {
        let ctx = TestContext::builder()
            .with_file("README.md", "hello")
            .with_commit("Initial commit")
            .build();
        stage_new_file(&ctx, "b.txt");

        commit_while_another_writer_stages_during_the_hook(&ctx, "a.txt")
            .expect("create_commit failed");

        assert_eq!(ctx.paths_staged_over_head(), ["a.txt"]);
    }

    #[test]
    fn amend_commit_includes_the_file_the_other_writer_staged_first() {
        let mut ctx = TestContext::builder()
            .with_file("README.md", "hello")
            .with_commit("Initial commit")
            .build();

        ctx.act_while_another_writer_stages("a.txt", |ctx| ctx.amend_commit("Amended", None))
            .expect("amend_commit failed");

        ctx.assert_head_has_file("a.txt");
        assert_eq!(ctx.paths_staged_over_head(), Vec::<String>::new());
    }

    #[test]
    fn amend_commit_refuses_once_the_other_writer_committed() {
        let mut ctx = TestContext::builder()
            .with_file("README.md", "hello")
            .with_commit("Initial commit")
            .build();
        let chosen = head_oid(&ctx);

        let err = ctx
            .act_while_another_writer(
                |_| (),
                |repo, ()| commit_what_is_staged(repo),
                |ctx| ctx.amend_commit("Amended", None),
            )
            .expect_err("amend_commit replaced the commit made while it waited");

        assert_eq!(err.code, "amend_stale");
        assert_eq!(head_message(&ctx).trim_end(), "Committed meanwhile");
        assert_eq!(
            ctx.repo()
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .parent_id(0)
                .unwrap(),
            chosen
        );
    }
}

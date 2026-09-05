mod common;

use common::context::TestContext;

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

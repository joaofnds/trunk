//! Commits a thread can anchor to without Trunk minting them, and a `git gc`
//! that collects an anchor, for the tests about what makes an oid a snapshot
//! and what a thread reads once its anchor is gone.

use super::context::TestContext;

/// An outside actor's `git gc`: drop any keepalive ref Trunk holds the commit
/// with, then prune, and assert the object really is unreachable, since a gc
/// that kept it would make the caller's test vacuous.
///
/// git2 0.21 exposes no gc or prune API, so this shells out, as the other gc
/// tests in this suite do.
pub fn collect_the_object(ctx: &TestContext, oid: &str) {
    let repo = git2::Repository::open(ctx.path()).unwrap();
    let parsed = git2::Oid::from_str(oid).unwrap();
    trunk_review::snapshot::prune_snapshot_ref(&repo, parsed).unwrap();

    let gc = std::process::Command::new("git")
        .args(["gc", "--prune=now"])
        .current_dir(ctx.path())
        .output()
        .unwrap();
    assert!(gc.status.success(), "git gc failed: {gc:?}");

    let fresh = git2::Repository::open(ctx.path()).unwrap();
    assert!(
        fresh.find_commit(parsed).is_err(),
        "the test needs the object gone, and gc kept {oid}",
    );
}

/// A commit off HEAD that claims the author every review snapshot carries,
/// `Trunk <review@trunk.local>` at epoch 0, as a fetched commit can. Trunk never
/// minted it. Its `a.txt` matches neither the index nor the worktree, the way a
/// commit fetched from elsewhere would, so a reader that took it for a snapshot
/// would find it superseded.
pub fn a_commit_impersonating_a_snapshot(ctx: &TestContext) -> String {
    let impostor =
        git2::Signature::new("Trunk", "review@trunk.local", &git2::Time::new(0, 0)).unwrap();
    commit_on_head(
        ctx,
        Some("refs/remotes/origin/impostor"),
        &impostor,
        b"what the fetched commit says\n",
        "fetched from elsewhere",
    )
}

/// A commit by an ordinary author that no ref reaches, as a commit rebased away
/// leaves behind. Trunk never minted it, and `collect_the_object` can collect it.
pub fn a_commit_off_every_branch(ctx: &TestContext) -> String {
    let author = git2::Signature::new("Ada", "ada@example.com", &git2::Time::new(1, 0)).unwrap();
    commit_on_head(
        ctx,
        None,
        &author,
        b"what the rebase dropped\n",
        "rebased away",
    )
}

/// A child of HEAD that replaces `a.txt` with `a_txt`, written under `update_ref`
/// or under no ref at all.
fn commit_on_head(
    ctx: &TestContext,
    update_ref: Option<&str>,
    author: &git2::Signature,
    a_txt: &[u8],
    message: &str,
) -> String {
    let repo = git2::Repository::open(ctx.path()).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let blob = repo.blob(a_txt).unwrap();
    let mut tree = repo.treebuilder(Some(&head.tree().unwrap())).unwrap();
    tree.insert("a.txt", blob, 0o100_644).unwrap();
    let tree = repo.find_tree(tree.write().unwrap()).unwrap();

    repo.commit(update_ref, author, author, message, &tree, &[&head])
        .unwrap()
        .to_string()
}

/// Overwrite the loose object `oid` with bytes that are not a git object, as a
/// torn write or a failing disk leaves it. The object is still there, so a read
/// fails with something other than not-found.
pub fn make_the_object_unreadable(ctx: &TestContext, oid: &str) {
    let loose = ctx
        .repo_path()
        .join(".git/objects")
        .join(&oid[..2])
        .join(&oid[2..]);
    std::fs::remove_file(&loose).unwrap();
    std::fs::write(&loose, b"not a git object").unwrap();

    let fresh = git2::Repository::open(ctx.path()).unwrap();
    let error = fresh
        .find_commit(git2::Oid::from_str(oid).unwrap())
        .expect_err("the test needs the read to fail");
    assert_ne!(
        error.code(),
        git2::ErrorCode::NotFound,
        "the test needs a failure that is not an absence: {error}",
    );
}

//! Driving `git gc` over a review snapshot, for the tests about what a thread
//! reads once its anchor is gone.

use super::context::TestContext;

/// An outside actor's `git gc`: drop the keepalive ref Trunk holds the snapshot
/// with, then prune, and assert the object really is unreachable — a gc that
/// kept it would make the caller's test vacuous.
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
    let repo = git2::Repository::open(ctx.path()).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let blob = repo.blob(b"what the fetched commit says\n").unwrap();
    let mut tree = repo.treebuilder(Some(&head.tree().unwrap())).unwrap();
    tree.insert("a.txt", blob, 0o100_644).unwrap();
    let tree = repo.find_tree(tree.write().unwrap()).unwrap();
    let impostor =
        git2::Signature::new("Trunk", "review@trunk.local", &git2::Time::new(0, 0)).unwrap();

    repo.commit(
        Some("refs/remotes/origin/impostor"),
        &impostor,
        &impostor,
        "fetched from elsewhere",
        &tree,
        &[&head],
    )
    .unwrap()
    .to_string()
}

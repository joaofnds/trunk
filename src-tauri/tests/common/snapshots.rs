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
    trunk_lib::git::workdir_snapshot::prune_snapshot_ref(&repo, parsed).unwrap();

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

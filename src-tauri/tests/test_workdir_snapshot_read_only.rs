mod common;

use common::context::TestContext;
use common::repository_manifest::repository_manifest;
use std::path::Path;
use trunk_lib::git::workdir_snapshot::{
    in_memory_workdir_tree_oid, tree_matches_index, workdir_tree_oid,
};

const REGULAR_FILE: i32 = 0o100_644;
#[cfg(unix)]
const EXECUTABLE_FILE: i32 = 0o100_755;
#[cfg(unix)]
const SYMLINK: i32 = 0o120_000;
const TREE: i32 = 0o040_000;

fn write_tree(repo: &git2::Repository, entries: &[(&str, git2::Oid, i32)]) -> git2::Oid {
    let mut tree = repo.treebuilder(None).unwrap();
    for (name, oid, mode) in entries {
        tree.insert(name, *oid, *mode).unwrap();
    }

    tree.write().unwrap()
}

fn assert_in_memory_capture_matches_persistent_capture(ctx: &TestContext) -> git2::Oid {
    let capture_repo = ctx.repo();
    let expected = workdir_tree_oid(&capture_repo).unwrap();
    drop(capture_repo);
    let before = repository_manifest(ctx.repo_path());

    let first = in_memory_workdir_tree_oid(ctx.repo_path()).unwrap();
    let second = in_memory_workdir_tree_oid(ctx.repo_path()).unwrap();

    assert_eq!((first, second), (expected, expected));
    assert_eq!(repository_manifest(ctx.repo_path()), before);
    first
}

#[test]
fn in_memory_capture_matches_file_changes_deletions_and_nested_untracked_paths() {
    let ctx = TestContext::builder()
        .with_file("changed.txt", "before")
        .with_file("deleted.txt", "delete me")
        .with_commit("base")
        .build();
    std::fs::write(ctx.repo_path().join("changed.txt"), "after").unwrap();
    std::fs::remove_file(ctx.repo_path().join("deleted.txt")).unwrap();
    std::fs::create_dir(ctx.repo_path().join("nested")).unwrap();
    std::fs::write(ctx.repo_path().join("nested/untracked.txt"), "new").unwrap();
    let repo = ctx.repo();
    let changed = repo.blob(b"after").unwrap();
    let untracked = repo.blob(b"new").unwrap();
    let nested = write_tree(&repo, &[("untracked.txt", untracked, REGULAR_FILE)]);
    let expected = write_tree(
        &repo,
        &[
            ("changed.txt", changed, REGULAR_FILE),
            ("nested", nested, TREE),
        ],
    );
    drop(repo);

    let captured = assert_in_memory_capture_matches_persistent_capture(&ctx);

    assert_eq!(captured, expected);
}

#[test]
fn in_memory_capture_observes_a_new_ignore_rule() {
    let ctx = TestContext::builder()
        .with_file("tracked.txt", "tracked")
        .with_commit("base")
        .build();
    std::fs::write(ctx.repo_path().join("candidate.txt"), "candidate").unwrap();
    let before_ignore = workdir_tree_oid(&ctx.repo()).unwrap();
    std::fs::write(ctx.repo_path().join(".git/info/exclude"), "candidate.txt\n").unwrap();
    let repo = ctx.repo();
    let tracked = repo.blob(b"tracked").unwrap();
    let expected = write_tree(&repo, &[("tracked.txt", tracked, REGULAR_FILE)]);
    drop(repo);

    let after_ignore = assert_in_memory_capture_matches_persistent_capture(&ctx);

    assert_ne!(after_ignore, before_ignore);
    assert_eq!(after_ignore, expected);
}

#[cfg(unix)]
#[test]
fn in_memory_capture_keeps_executable_modes_when_filemode_is_disabled() {
    use std::os::unix::fs::PermissionsExt as _;

    let ctx = TestContext::builder()
        .with_file("script.sh", "echo hello\n")
        .with_commit("base")
        .build();
    ctx.repo()
        .config()
        .unwrap()
        .set_bool("core.filemode", false)
        .unwrap();
    std::fs::set_permissions(
        ctx.repo_path().join("script.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let repo = ctx.repo();
    let script = repo.blob(b"echo hello\n").unwrap();
    let expected = write_tree(&repo, &[("script.sh", script, EXECUTABLE_FILE)]);
    drop(repo);

    let captured = assert_in_memory_capture_matches_persistent_capture(&ctx);

    assert_eq!(captured, expected);
}

#[cfg(unix)]
#[test]
fn in_memory_capture_matches_a_regular_file_replaced_by_a_symlink() {
    let ctx = TestContext::builder()
        .with_file("target.txt", "target")
        .with_file("path", "regular")
        .with_commit("base")
        .build();
    std::fs::remove_file(ctx.repo_path().join("path")).unwrap();
    std::os::unix::fs::symlink("target.txt", ctx.repo_path().join("path")).unwrap();
    let repo = ctx.repo();
    let link = repo.blob(b"target.txt").unwrap();
    let target = repo.blob(b"target").unwrap();
    let expected = write_tree(
        &repo,
        &[
            ("path", link, SYMLINK),
            ("target.txt", target, REGULAR_FILE),
        ],
    );
    drop(repo);

    let captured = assert_in_memory_capture_matches_persistent_capture(&ctx);

    assert_eq!(captured, expected);
}

#[test]
fn in_memory_capture_matches_attribute_driven_crlf_normalization() {
    let ctx = TestContext::builder()
        .with_file("tracked.txt", "tracked")
        .with_commit("base")
        .build();
    std::fs::write(
        ctx.repo_path().join(".gitattributes"),
        "*.txt text eol=lf\n",
    )
    .unwrap();
    std::fs::write(ctx.repo_path().join("crlf.txt"), b"one\r\ntwo\r\n").unwrap();
    let repo = ctx.repo();
    let attributes = repo.blob(b"*.txt text eol=lf\n").unwrap();
    let crlf = repo.blob(b"one\ntwo\n").unwrap();
    let tracked = repo.blob(b"tracked").unwrap();
    let expected = write_tree(
        &repo,
        &[
            (".gitattributes", attributes, REGULAR_FILE),
            ("crlf.txt", crlf, REGULAR_FILE),
            ("tracked.txt", tracked, REGULAR_FILE),
        ],
    );
    drop(repo);

    let captured = assert_in_memory_capture_matches_persistent_capture(&ctx);

    assert_eq!(captured, expected);
}

#[cfg(unix)]
#[test]
fn index_comparison_observes_a_staged_mode_change_when_filemode_is_disabled() {
    let ctx = TestContext::builder()
        .with_file("script.sh", "echo hello\n")
        .with_commit("base")
        .build();
    let repo = ctx.repo();
    repo.config()
        .unwrap()
        .set_bool("core.filemode", false)
        .unwrap();
    let head_tree = repo.head().unwrap().peel_to_tree().unwrap();
    let mut index = repo.index().unwrap();
    let mut entry = index.get_path(Path::new("script.sh"), 0).unwrap();
    entry.mode = 0o100_755;
    index.add(&entry).unwrap();
    index.write().unwrap();

    let matches = tree_matches_index(&repo, &head_tree).unwrap();

    assert!(!matches);
}

#[test]
fn index_comparison_refuses_a_conflicted_index() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "base")
        .with_commit("base")
        .with_branch("topic")
        .with_file("a.txt", "main")
        .with_commit("main")
        .checkout("topic")
        .with_file("a.txt", "topic")
        .with_commit("topic")
        .checkout("main")
        .with_conflict("topic")
        .build();
    let repo = ctx.repo();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();

    let matches = tree_matches_index(&repo, &tree).unwrap();

    assert!(repo.index().unwrap().has_conflicts());
    assert!(!matches);
}

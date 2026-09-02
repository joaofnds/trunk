mod common;

use common::context::TestContext;

#[test]
fn get_merge_sides_returns_conflict_content() {
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
        .with_conflict("feature")
        .build();

    let sides = ctx.get_merge_sides("file.txt").unwrap();
    assert_eq!(sides.ours, "main content", "ours should be main content");
    assert_eq!(
        sides.theirs, "feature content",
        "theirs should be feature content"
    );
    assert_eq!(sides.base, "hello", "base should be original content");
}

#[test]
fn get_merge_sides_no_ancestor_returns_empty_base() {
    // Both branches add a new file with the same name (no common ancestor for that file)
    let ctx = TestContext::builder()
        .with_file("placeholder.txt", "init")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("new_file.txt", "feature version")
        .with_commit("Add new_file on feature")
        .checkout("main")
        .with_file("new_file.txt", "main version")
        .with_commit("Add new_file on main")
        .with_conflict("feature")
        .build();

    let sides = ctx.get_merge_sides("new_file.txt").unwrap();
    assert_eq!(
        sides.base, "",
        "base should be empty for file added on both sides"
    );
    assert_eq!(sides.ours, "main version", "ours should be main version");
    assert_eq!(
        sides.theirs, "feature version",
        "theirs should be feature version"
    );
}

#[test]
fn save_merge_result_writes_and_stages() {
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
        .with_conflict("feature")
        .build();

    let result = ctx.save_merge_result("file.txt", "resolved content");
    assert!(result.is_ok(), "expected Ok, got: {:?}", result);

    // Assert the file on disk contains "resolved content"
    let content = std::fs::read_to_string(ctx.repo_path().join("file.txt")).unwrap();
    assert_eq!(
        content, "resolved content",
        "file on disk should contain resolved content"
    );

    // Assert the file is staged in the index (no longer in conflict entries)
    let repo = ctx.repo();
    let index = repo.index().unwrap();
    assert!(
        !index.has_conflicts(),
        "index should have no conflicts after staging"
    );
}

/// A PNG carries no text sides. Reading it through `String::from_utf8_lossy`
/// replaces every invalid byte with U+FFFD, and saving that back writes the
/// replacement characters over the file with both original sides already gone.
#[test]
fn get_merge_sides_refuses_a_binary_conflict() {
    let ours: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\xff\xfeOURS";
    let theirs: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\xff\xfeTHEM";
    let ctx = TestContext::builder()
        .with_binary_file("image.png", b"\x89PNG\r\n\x1a\n\x00\x00\xff\xfeBASE")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_binary_file("image.png", theirs)
        .with_commit("Feature commit")
        .checkout("main")
        .with_binary_file("image.png", ours)
        .with_commit("Main commit")
        .with_conflict("feature")
        .build();

    let err = ctx.get_merge_sides("image.png").unwrap_err();

    assert_eq!(err.code, "binary_conflict");
}

/// The editor stays on screen after the operation it belongs to ends, and its
/// Save button stays live. Writing then would put the merged text over the file
/// the abort just restored and stage it, destroying content that was never
/// committed and cannot be recovered from the repository.
#[test]
fn save_merge_result_refuses_once_the_conflict_is_gone() {
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
        .with_conflict("feature")
        .build();

    ctx.merge_abort().unwrap();

    let err = ctx
        .save_merge_result("file.txt", "resolved content")
        .unwrap_err();

    assert_eq!(err.code, "not_conflicted");
    let restored = std::fs::read_to_string(ctx.repo_path().join("file.txt")).unwrap();
    assert_eq!(
        restored, "main content",
        "the abort's restored content must survive a stale save"
    );
}

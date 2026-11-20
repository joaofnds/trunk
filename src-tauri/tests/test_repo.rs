mod common;

use common::context::TestContext;

#[test]
fn open_invalid_path_returns_error() {
    let dir = tempfile::tempdir().unwrap();
    // dir is a real directory but NOT a git repo
    let result = trunk_git::repository::validate_and_open(dir.path());
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code, "not_a_git_repo");
}

#[test]
fn open_valid_repo_succeeds() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let result = ctx.validate_and_open();
    assert!(result.is_ok());
}

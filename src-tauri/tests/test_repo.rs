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

#[test]
fn a_folder_inside_a_repository_names_the_repository_above_it() {
    let ctx = TestContext::builder()
        .with_file("src/main.rs", "fn main() {}\n")
        .with_commit("Initial commit")
        .build();

    let enclosing = trunk_git::repository::enclosing_repository(&ctx.repo_path().join("src"));

    assert_eq!(enclosing, Some(ctx.repo_path().canonicalize().unwrap()));
}

#[test]
fn a_repository_root_has_no_repository_above_it() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    assert_eq!(
        trunk_git::repository::enclosing_repository(ctx.repo_path()),
        None
    );
}

#[test]
fn a_folder_outside_every_repository_has_no_repository_above_it() {
    let dir = tempfile::tempdir().unwrap();

    assert_eq!(
        trunk_git::repository::enclosing_repository(dir.path()),
        None
    );
}

#![cfg(windows)]

use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::TempDir;
use trunk_lib::commands::diff::current_file_diff;

fn repo_with_tracked_file(path: &str) -> (TempDir, git2::Repository) {
    let directory = TempDir::new().unwrap();
    let repo = git2::Repository::init(directory.path()).unwrap();
    let file = directory.path().join(path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, "tracked\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(Path::new(path)).unwrap();
    index.write().unwrap();
    drop(index);
    (directory, repo)
}

fn assert_current_file_is_refused(repo: &git2::Repository, path: &str) {
    let error = current_file_diff(repo, path).unwrap_err();

    assert_eq!(error.code, "not_found");
    assert!(!error.message.contains("DUMMY_SECRET"));
}

#[test]
fn a_final_file_symlink_is_refused() {
    let (directory, repo) = repo_with_tracked_file("leak.txt");
    fs::write(directory.path().join("secret.env"), "DUMMY_SECRET\n").unwrap();
    fs::remove_file(directory.path().join("leak.txt")).unwrap();
    std::os::windows::fs::symlink_file("secret.env", directory.path().join("leak.txt")).unwrap();

    assert_current_file_is_refused(&repo, "leak.txt");
}

#[test]
fn a_parent_directory_symlink_is_refused() {
    let (directory, repo) = repo_with_tracked_file("alias/private");
    fs::remove_file(directory.path().join("alias/private")).unwrap();
    fs::remove_dir(directory.path().join("alias")).unwrap();
    fs::create_dir(directory.path().join("protected")).unwrap();
    fs::write(directory.path().join("protected/private"), "DUMMY_SECRET\n").unwrap();
    std::os::windows::fs::symlink_dir("protected", directory.path().join("alias")).unwrap();

    assert_current_file_is_refused(&repo, "alias/private");
}

#[test]
fn a_parent_directory_junction_is_refused() {
    let (directory, repo) = repo_with_tracked_file("alias/private");
    fs::remove_file(directory.path().join("alias/private")).unwrap();
    fs::remove_dir(directory.path().join("alias")).unwrap();
    fs::create_dir(directory.path().join("protected")).unwrap();
    fs::write(directory.path().join("protected/private"), "DUMMY_SECRET\n").unwrap();
    let status = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(directory.path().join("alias"))
        .arg(directory.path().join("protected"))
        .status()
        .unwrap();
    assert!(status.success(), "mklink /J must create the test junction");

    assert_current_file_is_refused(&repo, "alias/private");
}

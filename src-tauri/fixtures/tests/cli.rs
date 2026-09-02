//! The `fixtures` binary's contract: what a script or a recipe can rely on.

use std::path::Path;

use trunk_fixtures::cases::CASES;
use trunk_fixtures::fingerprint;

use common::fixtures;

mod common;

/// `fixtures build <case> --out <out>`.
fn build(case: &str, out: &Path) -> std::process::Output {
    fixtures(&[
        "build".as_ref(),
        case.as_ref(),
        "--out".as_ref(),
        out.as_os_str(),
    ])
}

#[test]
fn build_writes_the_named_case_under_out_and_lists_each_repository() {
    let out = tempfile::tempdir().unwrap();

    let output = build("04-graph-lanes", out.path());

    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("graph-lanes/01-behind-only\n"), "{stdout}");
    assert!(
        out.path().join("graph-lanes/13-tall-linear/.git").is_dir(),
        "the case was not built under --out"
    );
    assert!(
        !out.path().join("stash-lanes").exists(),
        "a case that was not named was built"
    );
}

#[test]
fn build_refuses_a_name_that_matches_no_case() {
    let out = tempfile::tempdir().unwrap();

    let output = build("nope", out.path());

    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr).unwrap().contains("nope"),
        "the error does not name the argument"
    );
}

#[test]
fn build_over_a_previous_build_produces_the_same_repositories() {
    trunk_fixtures::isolate();
    let out = tempfile::tempdir().unwrap();
    let repos = [
        "graph-lanes/01-behind-only",
        "graph-lanes/.remotes/01-behind-only-origin.git",
    ];
    assert!(build("04-graph-lanes", out.path()).status.success());
    let first = fingerprint::fingerprint(out.path(), &repos).unwrap();

    assert!(build("04-graph-lanes", out.path()).status.success());

    let second = fingerprint::fingerprint(out.path(), &repos).unwrap();
    assert_eq!(second, first);
}

#[test]
fn list_prints_every_case_with_its_summary() {
    let output = fixtures(&["list".as_ref()]);

    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let rows: Vec<&str> = stdout.lines().collect();
    assert_eq!(rows.len(), CASES.len());
    for (case, row) in CASES.iter().zip(&rows) {
        assert!(
            row.starts_with(case.name) && row.contains(case.summary),
            "{}: {row}",
            case.name
        );
    }
}

#[test]
fn build_names_the_case_that_failed() {
    let out = tempfile::tempdir().unwrap();
    let not_a_directory = out.path().join("file");
    std::fs::write(&not_a_directory, "").unwrap();

    let output = build("04-graph-lanes", &not_a_directory);

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("04-graph-lanes"), "{stderr}");
}

#[test]
fn the_default_output_root_is_the_checkouts_repos_directory() {
    let out = trunk_fixtures::cases::default_out();

    assert_eq!(out.file_name().unwrap(), "repos");
    assert!(
        out.parent()
            .unwrap()
            .join("src-tauri/fixtures/Cargo.toml")
            .is_file(),
        "{}",
        out.display()
    );
}

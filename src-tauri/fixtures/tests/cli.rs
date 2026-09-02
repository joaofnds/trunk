//! The `fixtures` binary's contract: what a script or a recipe can rely on.

use std::path::Path;
use std::process::Command;

use trunk_fixtures::fingerprint;

fn fixtures(args: &[&str], out: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_fixtures"))
        .args(args)
        .args(["--out"])
        .arg(out)
        .output()
        .unwrap()
}

#[test]
fn build_writes_the_named_case_under_out_and_lists_each_repository() {
    let out = tempfile::tempdir().unwrap();

    let output = fixtures(&["build", "04-graph-lanes"], out.path());

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

    let output = fixtures(&["build", "nope"], out.path());

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
    assert!(
        fixtures(&["build", "04-graph-lanes"], out.path())
            .status
            .success()
    );
    let first = fingerprint::fingerprint(out.path(), &repos).unwrap();

    assert!(
        fixtures(&["build", "04-graph-lanes"], out.path())
            .status
            .success()
    );

    let second = fingerprint::fingerprint(out.path(), &repos).unwrap();
    assert_eq!(second, first);
}

#[test]
fn build_refuses_to_run_without_out() {
    let output = Command::new(env!("CARGO_BIN_EXE_fixtures"))
        .args(["build", "04-graph-lanes"])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(String::from_utf8(output.stderr).unwrap().contains("--out"));
}

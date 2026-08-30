//! Built-binary probes for the `trunk review` CLI (milestone 3). The CLI is
//! the argv branch of the app binary itself, so these tests drive the real
//! executable via `CARGO_BIN_EXE_trunk` — `cargo test` builds it. Every
//! invocation sets `TRUNK_DATA_DIR` to a scratch dir: the test-built binary
//! carries the *prod* identifier, and without the override it would read the
//! developer's real store.

use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

/// Wait for the child with a Rust-side deadline (macOS ships no `timeout`
/// binary). A hang here means the argv branch fell through to the GUI, which
/// would block forever — kill it and fail loudly rather than wedge the suite.
fn wait_or_kill(mut child: Child, deadline: Duration) -> Output {
    let started = Instant::now();
    loop {
        match child.try_wait().expect("try_wait failed") {
            Some(_) => return child.wait_with_output().expect("wait_with_output failed"),
            None if started.elapsed() > deadline => {
                child.kill().expect("kill failed");
                let _ = child.wait();
                panic!("the process did not exit — the review branch fell through to the GUI");
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn trunk_review(args: &[&str], data_dir: &std::path::Path) -> Output {
    let child = Command::new(env!("CARGO_BIN_EXE_trunk"))
        .arg("review")
        .args(args)
        .env("TRUNK_DATA_DIR", data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn the trunk binary");
    wait_or_kill(child, Duration::from_secs(10))
}

/// One store, two discoverers: the app resolves its data dir through Tauri's
/// path resolver, the CLI derives it from the compiled-in identifier alone.
/// The two must name the same directory or app and CLI silently run two
/// stores. (`TRUNK_DATA_DIR` overrides both sides; the built-binary tests
/// cover that per-process, since env mutation races parallel tests here.)
#[test]
fn data_dir_matches_the_app_handles() {
    use tauri::Manager;
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let identifier = app.config().identifier.clone();

    let derived = trunk_lib::reviewdb::data_dir_for(&identifier);

    assert_eq!(
        derived,
        app.path().app_data_dir().unwrap(),
        "the CLI's derivation must name the exact dir the app resolves",
    );
}

#[test]
fn the_review_subcommand_exits_without_a_window() {
    let scratch = tempfile::TempDir::new().unwrap();

    let out = trunk_review(&[], scratch.path());

    assert_eq!(
        out.status.code(),
        Some(2),
        "a bare `trunk review` must exit with a usage error, not start the GUI",
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("usage: trunk review"),
        "stderr must teach the verbs, got {stderr:?}",
    );
}

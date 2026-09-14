//! Integration tests: Filesystem watcher with real notify events
//! Per D-05, uses real filesystem events with generous timeouts.
//! Per D-06, uses `tauri::test::mock_app()` for `AppHandle` instances.

mod common;

use std::sync::mpsc::{self, Receiver};
use std::time::Duration;
use tauri::Listener;
use trunk_lib::watcher::{RepoChanged, WatcherState, start_watcher};

/// How long a test waits for an event before calling it absent. Generous per
/// D-05: it bounds a failure, never a pass.
const EVENT_TIMEOUT: Duration = Duration::from_secs(2);

/// Listen for `repo-changed` on `handle`, returning the receiving half of a
/// channel the listener sends to. The test blocks on that channel, so the
/// event itself decides the outcome; the timeout only bounds a failure.
fn repo_changed_events<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> Receiver<String> {
    let (tx, rx) = mpsc::channel();
    handle.listen("repo-changed", move |event| {
        let _ = tx.send(event.payload().to_owned());
    });

    rx
}

#[test]
fn watcher_names_the_repository_for_rapid_nested_writes() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let events = repo_changed_events(&handle);
    let dir = tempfile::tempdir().unwrap();
    git2::Repository::init(dir.path()).unwrap();
    let nested_dir = dir.path().join("nested");
    std::fs::create_dir(&nested_dir).unwrap();
    let watcher_state = WatcherState::default();
    let path = dir.path().to_string_lossy().to_string();

    start_watcher(dir.path(), handle, &watcher_state);
    for index in 0..5 {
        std::fs::write(
            nested_dir.join(format!("rapid-{index}.txt")),
            format!("content {index}"),
        )
        .unwrap();
    }
    let payload = events
        .recv_timeout(EVENT_TIMEOUT)
        .expect("repo-changed should fire once the debounce window closes");
    let emitted: RepoChanged = serde_json::from_str(&payload).unwrap();

    assert_eq!(emitted.repo, path);
}

/// The event carries what changed, so a subscriber showing one file can tell a
/// write to it from a write to anything else under the repository (TRUNK-232).
#[test]
fn watcher_names_the_written_file_relative_to_the_repository() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();
    let events = repo_changed_events(&handle);
    let dir = tempfile::tempdir().unwrap();
    git2::Repository::init(dir.path()).unwrap();
    let nested_dir = dir.path().join("nested");
    std::fs::create_dir(&nested_dir).unwrap();
    let watcher_state = WatcherState::default();

    start_watcher(dir.path(), handle, &watcher_state);
    std::fs::write(nested_dir.join("only.txt"), "content").unwrap();
    let payload = events
        .recv_timeout(EVENT_TIMEOUT)
        .expect("repo-changed should fire once the debounce window closes");
    let emitted: RepoChanged = serde_json::from_str(&payload).unwrap();

    assert!(
        emitted.paths.contains(&"nested/only.txt".to_string()),
        "expected the written file among {:?}",
        emitted.paths
    );
}

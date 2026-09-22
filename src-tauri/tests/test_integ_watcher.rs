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

fn await_event_naming(events: &Receiver<String>, relative_path: &str) -> RepoChanged {
    let deadline = std::time::Instant::now() + EVENT_TIMEOUT;
    let mut seen: Vec<Vec<String>> = Vec::new();

    while let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) {
        let Ok(payload) = events.recv_timeout(remaining) else {
            break;
        };
        let emitted: RepoChanged = serde_json::from_str(&payload).unwrap();

        if emitted.paths.iter().any(|path| path == relative_path) {
            return emitted;
        }

        seen.push(emitted.paths);
    }

    panic!("no repo-changed event named {relative_path}; saw {seen:?}");
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
    let emitted = await_event_naming(&events, "nested/only.txt");

    assert_eq!(emitted.repo, dir.path().to_string_lossy());
}

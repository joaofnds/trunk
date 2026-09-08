//! Integration tests: Filesystem watcher with real notify events
//! Per D-05, uses real filesystem events with generous timeouts.
//! Per D-06, uses `tauri::test::mock_app()` for `AppHandle` instances.

mod common;

use std::sync::mpsc::{self, Receiver};
use std::time::Duration;
use tauri::Listener;
use trunk_lib::watcher::{WatcherState, start_watcher, stop_watcher};

/// How long a test waits for an event before calling it absent. Generous per
/// D-05: it bounds a failure, never a pass.
const EVENT_TIMEOUT: Duration = Duration::from_secs(2);

/// Listen for `repo-changed` on `handle`, returning the receiving half of a
/// channel the listener sends to. The test blocks on that channel, so the
/// event itself decides the outcome; the timeout only bounds a failure.
fn repo_changed_events<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> Receiver<()> {
    let (tx, rx) = mpsc::channel();
    handle.listen("repo-changed", move |_event| {
        let _ = tx.send(());
    });

    rx
}

// -- Test 1: Watcher emits repo-changed on file write --

#[test]
fn watcher_emits_event_on_file_write() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let events = repo_changed_events(&handle);

    let dir = tempfile::tempdir().unwrap();
    git2::Repository::init(dir.path()).unwrap();
    let watcher_state = WatcherState::default();
    let path_str = dir.path().to_string_lossy().to_string();

    start_watcher(dir.path(), handle, &watcher_state);

    // Verify watcher is registered
    assert!(
        watcher_state
            .watchers
            .lock()
            .unwrap()
            .contains_key(&path_str),
        "watcher should be registered in state after start_watcher"
    );

    // Trigger a file change
    std::fs::write(dir.path().join("test.txt"), "hello").unwrap();

    events
        .recv_timeout(EVENT_TIMEOUT)
        .expect("repo-changed should fire after a file write");
}

// -- Test 2: Watcher stop removes watcher --

#[test]
fn watcher_stop_removes_watcher() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let dir = tempfile::tempdir().unwrap();
    git2::Repository::init(dir.path()).unwrap();
    let watcher_state = WatcherState::default();
    let path_str = dir.path().to_string_lossy().to_string();

    start_watcher(dir.path(), handle, &watcher_state);

    // Verify watcher is registered
    assert!(
        watcher_state
            .watchers
            .lock()
            .unwrap()
            .contains_key(&path_str),
        "watcher should be registered after start_watcher"
    );

    // Stop the watcher
    stop_watcher(&path_str, &watcher_state);

    // Verify watcher is removed
    assert!(
        !watcher_state
            .watchers
            .lock()
            .unwrap()
            .contains_key(&path_str),
        "watcher should be removed after stop_watcher"
    );
}

// -- Test 3: Multiple watchers are independent (per Research Pitfall 5) --

#[test]
fn watcher_multiple_repos_independent() {
    let app1 = tauri::test::mock_app();
    let handle1 = app1.handle().clone();
    let app2 = tauri::test::mock_app();
    let handle2 = app2.handle().clone();

    let dir1 = tempfile::tempdir().unwrap();
    let dir2 = tempfile::tempdir().unwrap();
    git2::Repository::init(dir1.path()).unwrap();
    git2::Repository::init(dir2.path()).unwrap();

    let watcher_state = WatcherState::default();
    let path_str1 = dir1.path().to_string_lossy().to_string();
    let path_str2 = dir2.path().to_string_lossy().to_string();

    // Start watchers for both repos
    start_watcher(dir1.path(), handle1, &watcher_state);
    start_watcher(dir2.path(), handle2, &watcher_state);

    // Verify both are registered
    {
        let map = watcher_state.watchers.lock().unwrap();
        assert!(
            map.contains_key(&path_str1),
            "repo1 watcher should be registered"
        );
        assert!(
            map.contains_key(&path_str2),
            "repo2 watcher should be registered"
        );
        assert_eq!(map.len(), 2, "should have exactly 2 watchers");
    }

    // Stop watcher on repo1 only
    stop_watcher(&path_str1, &watcher_state);

    // Verify repo1's watcher is gone, repo2's still active
    {
        let map = watcher_state.watchers.lock().unwrap();
        assert!(
            !map.contains_key(&path_str1),
            "repo1 watcher should be removed after stop"
        );
        assert!(
            map.contains_key(&path_str2),
            "repo2 watcher should still be active"
        );
        assert_eq!(map.len(), 1, "should have exactly 1 watcher remaining");
    }
}

// -- Test 4: Watcher handles rapid file changes (debounce behavior) --

#[test]
fn watcher_debounces_rapid_changes() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let events = repo_changed_events(&handle);

    let dir = tempfile::tempdir().unwrap();
    git2::Repository::init(dir.path()).unwrap();
    let watcher_state = WatcherState::default();
    let path_str = dir.path().to_string_lossy().to_string();

    start_watcher(dir.path(), handle, &watcher_state);

    // Write 5 files in rapid succession (no sleep between writes)
    for i in 0..5 {
        std::fs::write(
            dir.path().join(format!("rapid_{i}.txt")),
            format!("content {i}"),
        )
        .unwrap();
    }

    events
        .recv_timeout(EVENT_TIMEOUT)
        .expect("repo-changed should fire once the debounce window closes");

    assert!(
        watcher_state
            .watchers
            .lock()
            .unwrap()
            .contains_key(&path_str),
        "watcher should still be registered after rapid changes (debouncer should not crash)"
    );
}

// -- Test 5: A disabled watcher state registers nothing --

#[test]
fn a_disabled_watcher_state_registers_no_watcher() {
    let app = tauri::test::mock_app();
    let handle = app.handle().clone();

    let dir = tempfile::tempdir().unwrap();
    git2::Repository::init(dir.path()).unwrap();
    let watcher_state = WatcherState::disabled();

    start_watcher(dir.path(), handle, &watcher_state);

    assert!(
        watcher_state.watchers.lock().unwrap().is_empty(),
        "a disabled watcher state should register no watcher"
    );
}

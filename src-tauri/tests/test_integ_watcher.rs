//! Integration tests: Filesystem watcher with real notify events
//! Per D-05, uses real filesystem events with generous timeouts.
//! Per D-06, uses `tauri::test::mock_app()` for `AppHandle` instances.

mod common;

use std::sync::Mutex;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;
use tauri::{Listener, Manager};
use trunk_lib::state::{
    CommitCache, GraphCache, GraphRebuild, RefVisibilityState, RemoteOps, RunningOp,
};
use trunk_lib::watcher::{RepoChanged, WatcherState, start_watcher};

/// How long a test waits for an event before calling it absent. Generous per
/// D-05: it bounds a failure, never a pass.
const EVENT_TIMEOUT: Duration = Duration::from_secs(2);

fn watcher_app() -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_app();
    app.manage(CommitCache::new(GraphCache::default()));
    app.manage(RunningOp(Mutex::new(RemoteOps::default())));
    app.manage(RefVisibilityState::default());
    app
}

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
    let app = watcher_app();
    let handle = app.handle().clone();
    let events = repo_changed_events(&handle);
    let dir = tempfile::tempdir().unwrap();
    git2::Repository::init(dir.path()).unwrap();
    let nested_dir = dir.path().join("nested");
    std::fs::create_dir(&nested_dir).unwrap();
    let watcher_state = WatcherState::default();
    let path = dir.path().to_string_lossy().to_string();

    start_watcher(dir.path(), handle, &watcher_state).unwrap();
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
    let app = watcher_app();
    let handle = app.handle().clone();
    let events = repo_changed_events(&handle);
    let dir = tempfile::tempdir().unwrap();
    git2::Repository::init(dir.path()).unwrap();
    let nested_dir = dir.path().join("nested");
    std::fs::create_dir(&nested_dir).unwrap();
    let watcher_state = WatcherState::default();

    start_watcher(dir.path(), handle, &watcher_state).unwrap();
    std::fs::write(nested_dir.join("only.txt"), "content").unwrap();
    let emitted = await_event_naming(&events, "nested/only.txt");

    assert_eq!(emitted.repo, dir.path().to_string_lossy());
}

#[test]
fn ignored_untracked_writes_emit_no_repository_change() {
    let dir = tempfile::tempdir().unwrap();
    git2::Repository::init(dir.path()).unwrap();
    std::fs::write(dir.path().join(".gitignore"), "artifacts/\n").unwrap();
    std::fs::create_dir(dir.path().join("artifacts")).unwrap();
    let artifact = dir.path().join("artifacts/probe.txt");
    std::fs::write(&artifact, "ignored output").unwrap();
    let app = watcher_app();
    let events = repo_changed_events(app.handle());

    let cache = app.state::<CommitCache>();
    let visibility = app.state::<RefVisibilityState>();
    let path = dir.path().to_path_buf();
    let key = path.to_string_lossy().to_string();
    tauri::async_runtime::block_on(
        GraphRebuild::new(&cache, &visibility).rebuild(key.clone(), move || {
            trunk_lib::state::read_graph(&mut git2::Repository::open(path)?)
        }),
    )
    .unwrap();

    tauri::async_runtime::block_on(WatcherState::disabled().deliver_changes(
        dir.path(),
        vec![artifact],
        app.handle(),
    ))
    .unwrap();

    assert!(events.try_iter().next().is_none());
    assert!(
        tauri::async_runtime::block_on(
            GraphRebuild::new(&cache, &visibility).reconcile_refs(key, dir.path().to_path_buf())
        )
        .unwrap()
        .is_none()
    );
}

#[test]
fn unreadable_index_preserves_ignored_notifications_and_invalidates_the_capture() {
    let context = common::context::TestContext::builder()
        .with_file("tracked.txt", "tracked")
        .with_commit("initial")
        .build();
    std::fs::write(context.repo_path().join(".gitignore"), "artifacts/\n").unwrap();
    std::fs::create_dir(context.repo_path().join("artifacts")).unwrap();
    let artifact = context.repo_path().join("artifacts/probe.txt");
    std::fs::write(&artifact, "ignored output").unwrap();
    assert!(
        context
            .repo()
            .is_path_ignored("artifacts/probe.txt")
            .unwrap()
    );
    let app = watcher_app();
    let events = repo_changed_events(app.handle());
    let cache = app.state::<CommitCache>();
    let visibility = app.state::<RefVisibilityState>();
    let path = context.repo_path().to_path_buf();
    let key = path.to_string_lossy().to_string();
    tauri::async_runtime::block_on(
        GraphRebuild::new(&cache, &visibility).rebuild(key.clone(), move || {
            trunk_lib::state::read_graph(&mut git2::Repository::open(path)?)
        }),
    )
    .unwrap();
    let index_path = context.repo().path().join("index");
    let index_bytes = std::fs::read(&index_path).unwrap();
    std::fs::write(&index_path, "unreadable index").unwrap();
    assert!(
        git2::Repository::open(context.repo_path())
            .unwrap()
            .index()
            .is_err()
    );

    tauri::async_runtime::block_on(WatcherState::disabled().deliver_changes(
        context.repo_path(),
        vec![artifact],
        app.handle(),
    ))
    .unwrap();

    let emitted: RepoChanged = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
    assert_eq!(emitted.paths, ["artifacts/probe.txt"]);
    std::fs::write(index_path, index_bytes).unwrap();
    assert!(
        tauri::async_runtime::block_on(
            GraphRebuild::new(&cache, &visibility)
                .reconcile_refs(key, context.repo_path().to_path_buf())
        )
        .unwrap()
        .is_some()
    );
}

#[test]
fn ignored_batch_preserves_tracked_paths_and_directory_notifications() {
    let context = common::context::TestContext::builder()
        .with_file("artifacts/tracked.txt", "tracked")
        .with_commit("initial")
        .build();
    let repo = context.repo();
    std::fs::write(context.repo_path().join(".gitignore"), "artifacts/\n").unwrap();
    std::fs::write(
        context.repo_path().join("artifacts/untracked.txt"),
        "ignored",
    )
    .unwrap();
    assert!(repo.is_path_ignored("artifacts/tracked.txt").unwrap());
    let app = watcher_app();
    let events = repo_changed_events(app.handle());

    tauri::async_runtime::block_on(
        WatcherState::disabled().deliver_changes(
            context.repo_path(),
            [
                "artifacts/tracked.txt",
                "artifacts/untracked.txt",
                "artifacts",
            ]
            .map(|path| context.repo_path().join(path))
            .to_vec(),
            app.handle(),
        ),
    )
    .unwrap();

    let emitted: RepoChanged = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
    assert_eq!(emitted.paths, ["artifacts", "artifacts/tracked.txt"]);
}

#[test]
fn ignored_conflict_paths_and_ignore_rules_remain_observable() {
    let context = common::context::TestContext::builder()
        .with_file("artifacts/conflict.txt", "tracked")
        .with_commit("initial")
        .build();
    let repo = context.repo();
    let mut index = repo.index().unwrap();
    let mut conflicted = index
        .get_path(std::path::Path::new("artifacts/conflict.txt"), 0)
        .unwrap();
    index
        .remove_path(std::path::Path::new("artifacts/conflict.txt"))
        .unwrap();
    conflicted.flags |= 1 << 12;
    index.add(&conflicted).unwrap();
    index.write().unwrap();
    std::fs::write(context.repo_path().join(".gitignore"), "artifacts/\n").unwrap();
    std::fs::write(context.repo_path().join("artifacts/.gitignore"), "*.log\n").unwrap();
    let app = watcher_app();
    let events = repo_changed_events(app.handle());

    tauri::async_runtime::block_on(
        WatcherState::disabled().deliver_changes(
            context.repo_path(),
            ["artifacts/conflict.txt", "artifacts/.gitignore"]
                .map(|path| context.repo_path().join(path))
                .to_vec(),
            app.handle(),
        ),
    )
    .unwrap();

    let emitted: RepoChanged = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
    assert_eq!(
        emitted.paths,
        ["artifacts/.gitignore", "artifacts/conflict.txt"]
    );
}

#[test]
fn ignored_submodule_children_still_report_parent_dirtiness() {
    let child = common::context::TestContext::builder()
        .with_file("src/a.rs", "original")
        .with_commit("initial")
        .build();
    let parent = common::context::TestContext::new_empty();
    let repo = parent.repo();
    let mut submodule = repo
        .submodule(child.path(), std::path::Path::new("vendor/lib"), true)
        .unwrap();
    let nested = submodule.clone(None).unwrap();
    submodule.add_finalize().unwrap();
    let mut index = repo.index().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    let signature = git2::Signature::new(
        "Fixture",
        "fixture@example.invalid",
        &git2::Time::new(1000, 0),
    )
    .unwrap();
    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        "submodule",
        &tree,
        &[],
    )
    .unwrap();
    std::fs::write(parent.repo_path().join(".gitignore"), "vendor/\n").unwrap();
    std::fs::write(nested.workdir().unwrap().join("src/a.rs"), "modified").unwrap();
    let statuses = repo.statuses(None).unwrap();
    assert!(
        statuses
            .iter()
            .any(|entry| entry.path().ok() == Some("vendor/lib")
                && entry.status().contains(git2::Status::WT_MODIFIED))
    );
    assert!(repo.is_path_ignored("vendor/lib/src/a.rs").unwrap());
    let app = watcher_app();
    let events = repo_changed_events(app.handle());

    tauri::async_runtime::block_on(WatcherState::disabled().deliver_changes(
        parent.repo_path(),
        vec![parent.repo_path().join("vendor/lib/src/a.rs")],
        app.handle(),
    ))
    .unwrap();

    let emitted: RepoChanged = serde_json::from_str(&events.try_recv().unwrap()).unwrap();
    assert_eq!(emitted.paths, ["vendor/lib/src/a.rs"]);
}

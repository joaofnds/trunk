//! Integration tests: the real Trunk application, built on `tauri::test::MockRuntime`
//! and driven through the IPC boundary rather than through the `_inner` seams.

mod common;

use common::context::TestContext;
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{App, Listener, Manager, WebviewWindow};
use trunk_lib::state::{CommitCache, RepoState, TrafficLights};
use trunk_lib::watcher::WatcherState;

/// Invariant 2: `http://tauri.localhost` is refused by the real capability set, and
/// the refusal reads like a missing plugin.
const WEBVIEW_URL: &str = "tauri://localhost";

fn request(cmd: &str, args: Value) -> InvokeRequest {
    InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: WEBVIEW_URL.parse().unwrap(),
        body: InvokeBody::Json(args),
        headers: tauri::http::HeaderMap::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

fn invoke(webview: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
    get_ipc_response(webview, request(cmd, args)).map(|body| {
        body.deserialize::<Value>()
            .expect("deserialize the response")
    })
}

struct CloseRepoOnDrop<'a> {
    webview: &'a WebviewWindow<MockRuntime>,
    path: &'a str,
}

impl Drop for CloseRepoOnDrop<'_> {
    fn drop(&mut self) {
        let _ = invoke(self.webview, "close_repo", json!({ "path": self.path }));
    }
}

/// The real application on `MockRuntime`, with the real capability set: the host
/// builds what `run()` builds, minus the runtime and the two plugins `configure`
/// leaves to `run()`.
fn boot(watcher: WatcherState) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    boot_with_releases(watcher, trunk_lib::ReleaseSource::default())
}

fn boot_with_releases(
    watcher: WatcherState,
    releases: trunk_lib::ReleaseSource,
) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = trunk_lib::configure_with_fetch_worker(
        mock_builder(),
        watcher,
        TrafficLights::disabled(),
        trunk_lib::background_fetch::BackgroundFetch::new(std::path::PathBuf::from(env!(
            "CARGO_BIN_EXE_trunk"
        ))),
        releases,
    )
    .build(trunk_lib::context())
    .expect("build the app on MockRuntime");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .expect("create the main webview");

    (app, webview)
}

#[test]
fn a_manual_installation_checks_the_injected_release_through_real_ipc() {
    let releases = trunk_lib::ReleaseSource::new(|| async {
        Ok(
            br#"{"tag_name":"v999.0.0","draft":false,"prerelease":false,"body":"A new release"}"#
                .to_vec(),
        )
    });
    let (_app, webview) = boot_with_releases(WatcherState::disabled(), releases);

    let checked = invoke(&webview, "updates_check", json!({})).unwrap();

    assert_eq!(checked["phase"], "available");
    assert_eq!(checked["version"], "999.0.0");
    assert_eq!(checked["notes"], "A new release");
    assert_eq!(checked["eligible"], false);
    assert_eq!(
        invoke(&webview, "updates_status", json!({})).unwrap(),
        checked
    );
}

#[test]
fn the_real_handler_list_registers_on_a_mock_runtime() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let (app, webview) = boot(WatcherState::disabled());

    let response = invoke(&webview, "open_repo", json!({ "path": ctx.path() }));

    assert_eq!(response, Ok(Value::Null));
    assert!(
        app.state::<RepoState>()
            .0
            .lock()
            .unwrap()
            .is_open(ctx.path()),
        "open_repo should register the repository in RepoState"
    );
}

#[test]
fn an_unchanged_background_fetch_preserves_the_cached_capture() {
    let source = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    let remote_dir = tempfile::tempdir().unwrap();
    git2::Repository::init_bare(remote_dir.path()).unwrap();
    source
        .repo()
        .remote_anonymous(remote_dir.path().to_str().unwrap())
        .unwrap()
        .push(&["refs/heads/main:refs/heads/main"], None)
        .unwrap();
    let clone_dir = tempfile::tempdir().unwrap();
    git2::Repository::clone(remote_dir.path().to_str().unwrap(), clone_dir.path()).unwrap();
    let path = clone_dir.path().to_str().unwrap();
    let (app, webview) = boot(WatcherState::default());
    invoke(&webview, "open_repo", json!({ "path": path })).unwrap();
    let _close = CloseRepoOnDrop {
        webview: &webview,
        path,
    };
    let before = app.state::<CommitCache>().snapshot(path).unwrap();
    let (sentinel, drained) = std::sync::mpsc::channel();
    let changes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = std::sync::Arc::clone(&changes);
    app.listen_any("repo-changed", move |event| {
        let change: trunk_lib::watcher::RepoChanged =
            serde_json::from_str(event.payload()).unwrap();
        let is_sentinel = change
            .paths
            .iter()
            .any(|path| path == "watcher-drain-marker");
        recorded.lock().unwrap().push(change);
        if is_sentinel {
            sentinel.send(()).unwrap();
        }
    });

    let outcome = invoke(&webview, "git_fetch_background", json!({ "path": path })).unwrap();
    assert_eq!(outcome["outcome"], "unchanged");
    assert!(outcome["remotes"][0]["last_success_ms"].is_u64());
    // Observe the watcher's delivery after the fetch writes, rather than sleeping
    // longer than its debounce. The marker itself is an intentional local change.
    std::fs::write(clone_dir.path().join("watcher-drain-marker"), "marker").unwrap();
    drained
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("watcher must deliver the marker; timeout only bounds a stalled test");
    assert_eq!(
        *changes.lock().unwrap(),
        vec![trunk_lib::watcher::RepoChanged {
            repo: path.to_owned(),
            paths: vec!["watcher-drain-marker".to_owned()],
            graph_revision: None,
            refs_only: false,
            command_completed: false,
        }],
        "unchanged fetch bookkeeping must leave only the deliberate watcher marker"
    );

    let after = app.state::<CommitCache>().snapshot(path).unwrap();
    assert!(
        after.same_capture_as(&before),
        "an unchanged fetch must not recapture or lay out repository history"
    );
}

#[test]
fn get_rebase_todo_returns_the_wrapper_shape_over_ipc() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "a")
        .with_commit_at("First", 1_700_000_000)
        .with_file("b.txt", "b")
        .with_commit_at("Second", 1_700_086_400)
        .with_file("c.txt", "c")
        .with_commit_at("Third", 1_700_172_800)
        .with_file("d.txt", "d")
        .with_commit_at("Fourth", 1_700_259_200)
        .build();
    let root = oldest_commit_oid(&ctx);
    let (_app, webview) = boot(WatcherState::disabled());
    invoke(&webview, "open_repo", json!({ "path": ctx.path() })).expect("open the repository");

    let todo = invoke(
        &webview,
        "get_rebase_todo",
        json!({ "path": ctx.path(), "baseOid": root, "inclusive": false }),
    )
    .expect("list the rebase todo");

    assert_eq!(todo["base_oid"], json!(root));
    let summaries: Vec<&str> = todo["items"]
        .as_array()
        .expect("items is an array")
        .iter()
        .map(|item| item["summary"].as_str().expect("a summary"))
        .collect();
    assert_eq!(summaries, vec!["Second", "Third", "Fourth"]);
}

/// The root commit, which is the base a four-commit listing rebases onto.
fn oldest_commit_oid(ctx: &TestContext) -> String {
    let repo = ctx.repo();
    let mut walk = repo.revwalk().unwrap();
    walk.push_head().unwrap();

    walk.last().unwrap().unwrap().to_string()
}

/// The harness fakes the clipboard on the JavaScript side (doc-20 §Scope), and the
/// plugin's `setup` calls `arboard::Clipboard::new()` inside `Builder::build()`,
/// which costs 9-17 s per process. `run()` adds it; `configure` must not.
#[test]
fn the_host_carries_no_clipboard_plugin() {
    let (app, _webview) = boot(WatcherState::disabled());

    assert!(
        app.try_state::<tauri_plugin_clipboard_manager::Clipboard<MockRuntime>>()
            .is_none(),
        "configure should leave the clipboard plugin to run()"
    );
}

/// `MockRuntime::window_handle()` returns an `AppKit` handle built from a dangling
/// `NSView*` (`tauri-2.11.5/src/test/mock_runtime.rs:846`), and
/// `WebviewWindow::ns_window()` dereferences it (`window/mod.rs:1639`). The
/// application asks for this command in a mount effect, so a host that
/// repositions the traffic lights segfaults on the boot path.
#[test]
fn set_traffic_light_zoom_survives_a_window_with_no_native_chrome() {
    let (_app, webview) = boot(WatcherState::disabled());

    let response = invoke(&webview, "set_traffic_light_zoom", json!({ "zoom": 1.25 }));

    assert_eq!(response, Ok(Value::Null));
}

/// `create_commit` inserts the rebuilt graph into `CommitCache` at
/// `commit.rs:109`, outside the blocking `_inner`, and `get_commit_graph` reads
/// only that cache. Reading the graph straight after the commit, with no
/// `repo-changed` refresh in between, is the one place the insert is the only
/// thing that could have delivered the new row.
#[test]
fn create_commit_puts_its_own_commit_in_the_graph_cache() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit_at("First", 1_700_000_000)
        .build();
    std::fs::write(ctx.repo_path().join("b.txt"), "b").expect("write an untracked file");
    let (_app, webview) = boot(WatcherState::disabled());
    invoke(&webview, "open_repo", json!({ "path": ctx.path() })).expect("open the repository");
    invoke(&webview, "stage_all", json!({ "path": ctx.path() })).expect("stage everything");

    invoke(
        &webview,
        "create_commit",
        json!({ "path": ctx.path(), "subject": "Add b", "body": null }),
    )
    .expect("commit the staged change");

    let graph = invoke(
        &webview,
        "get_commit_graph",
        json!({ "path": ctx.path(), "offset": 0 }),
    )
    .expect("read the graph");
    let summaries: Vec<&str> = graph["commits"]
        .as_array()
        .expect("commits is an array")
        .iter()
        .map(|commit| commit["summary"].as_str().expect("a summary"))
        .collect();
    assert_eq!(summaries, vec!["Add b", "First"]);
}

/// The compare surface end to end over IPC (TRUNK-1): camelCase args map onto
/// the commands, the file listing crosses divergent branches with no ancestry,
/// and the single-file diff carries hunks in Base → Target direction.
#[test]
fn compare_commands_answer_over_ipc() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one\n")
        .with_commit_at("root", 1_700_000_000)
        .with_branch("feature")
        .checkout("feature")
        .with_file("f.txt", "feat\n")
        .with_commit_at("feature adds f.txt", 1_700_086_400)
        .checkout("main")
        .with_file("a.txt", "two\n")
        .with_commit_at("main edits a.txt", 1_700_172_800)
        .build();
    let (main_tip, feature_tip) = {
        let repo = ctx.repo();
        let tip = |name: &str| {
            repo.revparse_single(name)
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .id()
                .to_string()
        };
        (tip("main"), tip("feature"))
    };
    let (_app, webview) = boot(WatcherState::disabled());
    invoke(&webview, "open_repo", json!({ "path": ctx.path() })).expect("open the repository");

    let files = invoke(
        &webview,
        "list_compare_files",
        json!({ "path": ctx.path(), "baseOid": main_tip, "targetOid": feature_tip }),
    )
    .expect("list the compare files");
    let mut paths: Vec<&str> = files
        .as_array()
        .expect("files is an array")
        .iter()
        .map(|f| f["path"].as_str().expect("a path"))
        .collect();
    paths.sort_unstable();
    assert_eq!(paths, vec!["a.txt", "f.txt"]);

    let diff = invoke(
        &webview,
        "diff_compare_file",
        json!({
            "path": ctx.path(),
            "baseOid": main_tip,
            "targetOid": feature_tip,
            "filePath": "a.txt",
            "options": { "contextLines": 3, "ignoreWhitespace": false, "showFullFile": false },
        }),
    )
    .expect("diff one compared file");
    let lines = &diff[0]["hunks"][0]["lines"];
    let contents: Vec<(&str, &str)> = lines
        .as_array()
        .expect("lines is an array")
        .iter()
        .map(|l| {
            (
                l["origin"].as_str().expect("an origin"),
                l["content"].as_str().expect("content"),
            )
        })
        .collect();
    assert!(contents.contains(&("Delete", "two\n")), "{contents:?}");
    assert!(contents.contains(&("Add", "one\n")), "{contents:?}");
}

#[test]
fn update_preparation_rejects_ordinary_ipc_even_with_a_flush_permit() {
    let (app, webview) = boot(WatcherState::disabled());
    let token = app
        .state::<trunk_lib::activity::ActivityState>()
        .begin_prepare()
        .unwrap();

    let response = invoke(
        &webview,
        "render_comment_preview",
        json!({ "text": "hello", "__updatePermit": token }),
    );

    assert_eq!(response.unwrap_err()["code"], "update_busy");
}

#[test]
fn update_preparation_admits_only_the_matching_flush_permit_through_ipc() {
    let (app, webview) = boot(WatcherState::disabled());
    let state = app.state::<trunk_lib::activity::ActivityState>();
    let token = state.begin_prepare().unwrap();

    let blocked = invoke(
        &webview,
        "get_draft",
        json!({ "path": "/closed", "__updatePermit": "stale" }),
    );
    let admitted = invoke(
        &webview,
        "get_draft",
        json!({ "path": "/closed", "__updatePermit": token }),
    );

    assert_eq!(blocked.unwrap_err()["code"], "update_busy");
    let command_error: Value =
        serde_json::from_str(admitted.unwrap_err().as_str().unwrap()).unwrap();
    assert_eq!(command_error["code"], "not_open");
    assert!(state.cancel_prepare(&token).is_ok());
}

#[cfg(not(feature = "drive"))]
#[test]
fn the_webview_cannot_bypass_preparation_through_window_state_persistence() {
    let (_app, webview) = boot(WatcherState::disabled());

    let response = invoke(
        &webview,
        "plugin:window-state|save_window_state",
        json!({ "flags": "invalid flags prevent a write if authorization regresses" }),
    );

    assert!(
        response
            .unwrap_err()
            .as_str()
            .unwrap()
            .contains("not allowed")
    );
}

#[test]
fn reopening_after_preparation_invalidates_graphs_and_refreshes_reviews() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();
    let (app, webview) = boot(WatcherState::disabled());
    invoke(&webview, "open_repo", json!({ "path": ctx.path() })).unwrap();
    let activity = app.state::<trunk_lib::activity::ActivityState>();
    // The open leaves the other worktree state's layout running, and preparation
    // is refused until it settles.
    activity.wait_until_settled();
    let token = activity.begin_prepare().unwrap();
    let cache = app.state::<CommitCache>();
    assert!(
        trunk_lib::watcher::RepoChanged::completed(ctx.path(), &cache)
            .graph_revision
            .is_some()
    );
    let (repo_events, repositories) = std::sync::mpsc::channel();
    app.listen_any("repo-changed", move |event| {
        repo_events
            .send(serde_json::from_str::<trunk_lib::watcher::RepoChanged>(event.payload()).unwrap())
            .unwrap();
    });
    let (review_events, reviews) = std::sync::mpsc::channel();
    app.listen_any("reviews-changed", move |_| {
        review_events.send(()).unwrap();
    });

    assert!(trunk_lib::activity::resume_after_update(app.handle()).is_err());
    activity.cancel_prepare(&token).unwrap();
    trunk_lib::activity::resume_after_update(app.handle()).unwrap();

    assert_eq!(
        trunk_lib::watcher::RepoChanged::completed(ctx.path(), &cache).graph_revision,
        None
    );
    assert_eq!(
        repositories.try_recv().unwrap(),
        trunk_lib::watcher::RepoChanged::whole_repo(ctx.path())
    );
    assert_eq!(reviews.try_recv(), Ok(()));
}

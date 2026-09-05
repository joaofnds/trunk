//! Integration tests: the real Trunk application, built on `tauri::test::MockRuntime`
//! and driven through the IPC boundary rather than through the `_inner` seams.

mod common;

use common::context::TestContext;
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow};
use trunk_lib::state::{RepoState, TrafficLights};
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

/// The real application on `MockRuntime`, with the real capability set: the host
/// builds what `run()` builds, minus the runtime and the two plugins `configure`
/// leaves to `run()`.
fn boot(watcher: WatcherState) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = trunk_lib::configure(mock_builder(), watcher, TrafficLights::disabled())
        .build(trunk_lib::context())
        .expect("build the app on MockRuntime");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
        .build()
        .expect("create the main webview");

    (app, webview)
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

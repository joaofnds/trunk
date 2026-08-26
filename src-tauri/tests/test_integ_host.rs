//! Integration tests: the real Trunk application, built on `tauri::test::MockRuntime`
//! and driven through the IPC boundary rather than through the `_inner` seams.

mod common;

use common::context::TestContext;
use serde_json::{Value, json};
use tauri::Manager;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use trunk_lib::state::RepoState;
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
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

fn invoke(
    webview: &tauri::WebviewWindow<MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<Value, Value> {
    get_ipc_response(webview, request(cmd, args)).map(|body| {
        body.deserialize::<Value>()
            .expect("deserialize the response")
    })
}

#[test]
fn the_real_handler_list_registers_on_a_mock_runtime() {
    let ctx = TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .build();

    let app = trunk_lib::configure(mock_builder(), WatcherState::disabled())
        .build(tauri::generate_context!("tauri.conf.json"))
        .expect("build the app on MockRuntime");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("create the main webview");

    let response = invoke(&webview, "open_repo", json!({ "path": ctx.path() }));

    assert_eq!(response, Ok(Value::Null));
    assert!(
        app.state::<RepoState>()
            .0
            .lock()
            .unwrap()
            .contains_key(ctx.path()),
        "open_repo should register the repository in RepoState"
    );
}

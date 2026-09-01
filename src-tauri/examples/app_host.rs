//! The application test harness's host.
//!
//! Builds the real Trunk application on `tauri::test::MockRuntime` with the real
//! capability set, then speaks newline-delimited JSON over stdio so a JavaScript
//! test runner can drive `#[tauri::command]` functions against a real git
//! repository. One host process is one application is one test: the harness gives
//! each process a fresh tempdir `HOME`, so every managed state and the resolved
//! `app_data_dir` isolate for free.
//!
//! The host never calls `run()` or `run_iteration()`: that executes `.setup()`,
//! which dereferences a dangling `NSView*` under `MockRuntime` on macOS.

#[path = "../tests/common/mod.rs"]
mod common;

use common::context::TestContext;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{App, Emitter, Listener, Manager, WebviewWindow};
use trunk_lib::state::TrafficLights;
use trunk_lib::watcher::WatcherState;

/// Invariant 2: `http://tauri.localhost` is refused by the real capability set,
/// and the refusal reads like a missing plugin.
const WEBVIEW_URL: &str = "tauri://localhost";

const LISTEN_COMMAND: &str = "plugin:event|listen";

#[derive(Deserialize)]
#[serde(tag = "verb", rename_all = "camelCase")]
enum Request {
    SeedRepo {
        id: u64,
        spec: RepoSpec,
    },
    Invoke {
        id: u64,
        cmd: String,
        args: Value,
    },
    Emit {
        id: u64,
        event: String,
        payload: Value,
    },
    WatcherCount {
        id: u64,
    },
    Shutdown {
        id: u64,
    },
}

impl Request {
    fn id(&self) -> u64 {
        match self {
            Request::SeedRepo { id, .. }
            | Request::Invoke { id, .. }
            | Request::Emit { id, .. }
            | Request::WatcherCount { id }
            | Request::Shutdown { id } => *id,
        }
    }
}

#[derive(Deserialize)]
struct RepoSpec {
    steps: Vec<SpecStep>,
}

/// The builder vocabulary the protocol exposes, one variant per
/// `TestContextBuilder` verb the suite needs.
#[derive(Deserialize)]
#[serde(tag = "step", rename_all = "camelCase")]
enum SpecStep {
    File {
        path: String,
        content: String,
    },
    /// Delete a tracked file. Paired with a `File` step under a new name, this
    /// is how a spec states a rename for git to detect by content similarity.
    RemoveFile {
        path: String,
    },
    /// `at` pins the commit's timestamp; without it the builder's own day
    /// spacing applies, which is what keeps the graph's `TOPOLOGICAL | TIME`
    /// sort from resolving by tie-break.
    Commit {
        message: String,
        at: Option<i64>,
    },
    Branch {
        name: String,
    },
    Checkout {
        name: String,
    },
    Remote {
        name: String,
    },
    TrackUpstream {
        remote: String,
        branch: String,
    },
    Push {
        remote: String,
        branch: String,
    },
    RemoteCommit {
        remote: String,
        branch: String,
        path: String,
        content: String,
        message: String,
    },
}

/// Serializes every line the host writes: `listen_any` handlers run on the
/// emitting thread, so pushes and replies race for stdout otherwise.
#[derive(Clone)]
struct Output(Arc<Mutex<std::io::Stdout>>);

impl Output {
    fn new() -> Self {
        Output(Arc::new(Mutex::new(std::io::stdout())))
    }

    fn send(&self, line: &Value) {
        let mut out = self.0.lock().expect("the stdout lock");
        writeln!(out, "{line}").expect("write a protocol line");
        out.flush().expect("flush a protocol line");
    }
}

fn main() {
    let output = Output::new();
    let (app, webview) = boot();
    let mut repos: Vec<TestContext> = Vec::new();
    let mut forwarded_events: HashSet<String> = HashSet::new();

    output.send(&json!({ "ready": true }));

    for line in std::io::stdin().lock().lines() {
        let line = line.expect("read a protocol line");
        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(e) => {
                let failure = Err(format!("unreadable request: {e}"));
                output.send(&reply_line(request_id(&line), failure));
                continue;
            }
        };

        let id = request.id();
        let stop = matches!(request, Request::Shutdown { .. });
        let reply = serve(
            request,
            &app,
            &webview,
            &output,
            &mut repos,
            &mut forwarded_events,
        );

        output.send(&reply_line(id, reply));
        if stop {
            return;
        }
    }
}

/// The real application on `MockRuntime`, with the watcher off: `open_repo` runs
/// unchanged while no filesystem watch is created (D2).
fn boot() -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = trunk_lib::configure(
        mock_builder(),
        WatcherState::disabled(),
        TrafficLights::disabled(),
    )
    .build(trunk_lib::context())
    .expect("build the app on MockRuntime");
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .expect("create the main webview");

    (app, webview)
}

/// `Ok` carries the verb's answer, `Err` a command's rejection forwarded
/// verbatim, and a panic-free host failure travels as `hostError`.
type Reply = Result<Result<Value, Value>, String>;

fn serve(
    request: Request,
    app: &App<MockRuntime>,
    webview: &WebviewWindow<MockRuntime>,
    output: &Output,
    repos: &mut Vec<TestContext>,
    forwarded_events: &mut HashSet<String>,
) -> Reply {
    match request {
        Request::SeedRepo { spec, .. } => {
            let ctx = seed(spec);
            let path = json!(ctx.path());
            repos.push(ctx);
            Ok(Ok(path))
        }

        Request::Invoke { cmd, args, .. } => {
            if cmd == LISTEN_COMMAND {
                forward_event(app, output, forwarded_events, &args)?;
            }
            Ok(invoke(webview, &cmd, args))
        }

        Request::Emit { event, payload, .. } => {
            app.emit(&event, payload)
                .map_err(|e| format!("emit {event}: {e}"))?;
            Ok(Ok(Value::Null))
        }

        Request::WatcherCount { .. } => {
            let count = app.state::<WatcherState>().watchers.lock().unwrap().len();
            Ok(Ok(json!(count)))
        }

        Request::Shutdown { .. } => Ok(Ok(Value::Null)),
    }
}

/// The `id` of a line the typed parse rejected, read back off the raw JSON. The client
/// matches every reply by id, so a reply without one leaves the call pending for as long
/// as the test's timeout rather than failing with the parse error.
fn request_id(line: &str) -> u64 {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value["id"].as_u64())
        .unwrap_or_default()
}

fn reply_line(id: u64, reply: Reply) -> Value {
    match reply {
        Ok(Ok(value)) => json!({ "id": id, "ok": value }),
        Ok(Err(error)) => json!({ "id": id, "err": error }),
        Err(message) => json!({ "id": id, "hostError": message }),
    }
}

fn seed(spec: RepoSpec) -> TestContext {
    let mut builder = TestContext::builder();

    for step in spec.steps {
        match step {
            SpecStep::File { path, content } => builder.with_file(&path, &content),
            SpecStep::RemoveFile { path } => builder.with_removed_file(&path),
            SpecStep::Commit {
                message,
                at: Some(secs),
            } => builder.with_commit_at(&message, secs),
            SpecStep::Commit { message, at: None } => builder.with_commit(&message),
            SpecStep::Branch { name } => builder.with_branch(&name),
            SpecStep::Checkout { name } => builder.checkout(&name),
            SpecStep::Remote { name } => builder.with_remote(&name),
            SpecStep::TrackUpstream { remote, branch } => builder.with_tracking(&remote, &branch),
            SpecStep::Push { remote, branch } => builder.with_pushed(&remote, &branch),
            SpecStep::RemoteCommit {
                remote,
                branch,
                path,
                content,
                message,
            } => builder.with_remote_commit(&remote, &branch, &path, &content, &message),
        };
    }

    builder.build()
}

fn invoke(webview: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: WEBVIEW_URL.parse().expect("a valid webview URL"),
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };

    get_ipc_response(webview, request).map(|body| {
        body.deserialize::<Value>()
            .expect("deserialize the response")
    })
}

/// Tauri delivers an event to a webview by evaluating a script the harness
/// cannot observe, so the host mirrors each listened-to event onto stdout and the
/// harness dispatches from its own id map (D5). The registration itself stays
/// real: `plugin:event|listen` still reaches the command.
fn forward_event(
    app: &App<MockRuntime>,
    output: &Output,
    forwarded_events: &mut HashSet<String>,
    args: &Value,
) -> Result<(), String> {
    let event = args["event"]
        .as_str()
        .ok_or_else(|| format!("{LISTEN_COMMAND} without an event name"))?
        .to_string();

    if !forwarded_events.insert(event.clone()) {
        return Ok(());
    }

    let output = output.clone();
    let pushed = event.clone();
    app.listen_any(event, move |received| {
        output.send(&json!({
            "push": "event",
            "event": pushed,
            "payload": received.payload(),
        }));
    });

    Ok(())
}

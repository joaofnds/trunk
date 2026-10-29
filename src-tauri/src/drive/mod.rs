//! The drive route: a socket an agent's commands reach the running app through,
//! compiled only into the drive build (`just drive-build`) and never shipped.
//!
//! The instance owns one directory, named by `TRUNK_DRIVE_DIR`, which must be
//! private to the user. The socket lives there, and a peer whose uid is not the
//! user's is refused. Each connection carries one JSON request line and gets one
//! JSON reply, then closes. The page half, `src/drive.ts`, answers evaluations
//! and says when it is ready.

mod native;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Listener, Manager, Runtime};

const SOCKET: &str = "drive.sock";
/// Created once the socket accepts connections. A socket's own creation raises
/// no file event the launcher's watcher sees, and a renamed file does.
const LISTENING: &str = "listening";
const READY_EVENT: &str = "trunk-drive:ready";
const REPLY_EVENT: &str = "trunk-drive:reply";
/// How long an evaluation may wait, once for the page to say it is ready and once
/// for its answer, before it is answered with a failure. Both waits together stay
/// under the client's 60s (scripts/drive/drive.ts), so the page never runs an
/// evaluation whose caller was already told it failed.
const PAGE_DEADLINE: Duration = Duration::from_secs(25);

/// The main window's `WKWebView`, recorded once tauri creates it.
static WEBVIEW: OnceLock<native::WebViewAddress> = OnceLock::new();

/// The drive route's plugin: it opens the socket at setup and keeps the window
/// behind every other one, so a launch never covers the user's work.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("trunk-drive")
        .setup(|app, _api| {
            let dir = instance_dir()?;
            // Without it the prefs and review store fall back to the app data dir
            // under HOME, which every drive instance would share.
            if std::env::var_os("TRUNK_DATA_DIR").is_none() {
                return Err(
                    "the drive build needs TRUNK_DATA_DIR, the instance's own data directory"
                        .into(),
                );
            }
            let page = Arc::new(Page::default());
            listen_to_page(app, &page);
            serve(app.clone(), &dir, page)?;
            Ok(())
        })
        .on_webview_ready(|webview| {
            let recorded = webview.with_webview(|platform| {
                let _ = WEBVIEW.set(native::WebViewAddress(platform.inner() as usize));
            });
            if let Err(e) = recorded {
                eprintln!("drive: the webview could not be recorded, so snapshots will fail: {e}");
            }
        })
        .on_window_ready(|window| {
            let target = window.clone();
            let ordered = window.run_on_main_thread(move || match target.ns_window() {
                Ok(ptr) => {
                    // SAFETY: tauri hands out the window's live NSWindow, and this
                    // closure runs on the main thread AppKit requires.
                    let ns_window: &objc2_app_kit::NSWindow = unsafe { &*ptr.cast() };
                    ns_window.orderBack(None);
                }
                Err(e) => eprintln!("drive: the window could not be ordered back: {e}"),
            });
            if let Err(e) = ordered {
                eprintln!("drive: the window could not be ordered back: {e}");
            }
        })
        .build()
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
enum Request {
    Ping,
    Eval { js: String },
    Snapshot { path: PathBuf },
    Alert,
    Press { button: String },
    Quit,
}

#[derive(Deserialize)]
struct PageReply {
    id: u64,
    ok: bool,
    #[serde(default)]
    value: Value,
    #[serde(default)]
    error: String,
}

/// What the server knows of the page: whether it has said it is ready, and the
/// evaluations still waiting on its answer.
#[derive(Default)]
struct Page {
    ready: Mutex<bool>,
    became_ready: Condvar,
    pending: Mutex<HashMap<u64, mpsc::Sender<PageReply>>>,
    next_id: AtomicU64,
}

impl Page {
    fn mark_ready(&self) {
        *self.ready.lock().expect("the ready lock") = true;
        self.became_ready.notify_all();
    }

    fn wait_ready(&self) -> Result<(), String> {
        let ready = *self
            .became_ready
            .wait_timeout_while(
                self.ready.lock().expect("the ready lock"),
                PAGE_DEADLINE,
                |ready| !*ready,
            )
            .expect("the ready lock")
            .0;

        if ready {
            Ok(())
        } else {
            Err("the page never said it was ready".into())
        }
    }

    fn expect_reply(&self) -> (u64, mpsc::Receiver<PageReply>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .expect("the pending lock")
            .insert(id, sender);
        (id, receiver)
    }

    fn forget(&self, id: u64) {
        self.pending.lock().expect("the pending lock").remove(&id);
    }

    fn deliver(&self, reply: PageReply) {
        let sender = self
            .pending
            .lock()
            .expect("the pending lock")
            .remove(&reply.id);
        if let Some(sender) = sender {
            let _ = sender.send(reply);
        }
    }
}

/// The instance's directory, refused unless the user owns it and nobody else
/// can enter it, because whoever reaches the socket drives the app.
fn instance_dir() -> Result<PathBuf, String> {
    let dir = std::env::var_os("TRUNK_DRIVE_DIR")
        .map(PathBuf::from)
        .ok_or("the drive build needs TRUNK_DRIVE_DIR, the instance's private directory")?;
    let meta = std::fs::metadata(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;

    if meta.uid() != effective_uid() || meta.permissions().mode() & 0o077 != 0 {
        return Err(format!(
            "{} must belong to the user and be closed to everyone else (0700)",
            dir.display()
        ));
    }
    Ok(dir)
}

fn listen_to_page<R: Runtime>(app: &AppHandle<R>, page: &Arc<Page>) {
    let ready = Arc::clone(page);
    app.listen_any(READY_EVENT, move |_| ready.mark_ready());

    let replies = Arc::clone(page);
    app.listen_any(REPLY_EVENT, move |event| {
        match serde_json::from_str::<PageReply>(event.payload()) {
            Ok(reply) => replies.deliver(reply),
            Err(e) => eprintln!("drive: an unreadable page reply: {e}"),
        }
    });
}

fn serve<R: Runtime>(app: AppHandle<R>, dir: &Path, page: Arc<Page>) -> Result<(), String> {
    let listener =
        UnixListener::bind(dir.join(SOCKET)).map_err(|e| format!("bind the drive socket: {e}"))?;
    announce_listening(dir)?;

    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            if peer_uid(&stream) != Some(effective_uid()) {
                continue;
            }
            let app = app.clone();
            let page = Arc::clone(&page);
            std::thread::spawn(move || answer(&app, &page, stream));
        }
    });
    Ok(())
}

fn announce_listening(dir: &Path) -> Result<(), String> {
    let staged = dir.join(format!("{LISTENING}.tmp"));
    std::fs::write(&staged, std::process::id().to_string())
        .and_then(|()| std::fs::rename(&staged, dir.join(LISTENING)))
        .map_err(|e| format!("announce the drive socket: {e}"))
}

fn answer<R: Runtime>(app: &AppHandle<R>, page: &Page, mut stream: UnixStream) {
    // A peer that never finishes its line would otherwise hold this thread forever.
    if stream.set_read_timeout(Some(PAGE_DEADLINE)).is_err() {
        return;
    }
    let mut line = String::new();
    if BufReader::new(&stream).read_line(&mut line).is_err() {
        return;
    }

    let request = serde_json::from_str::<Request>(&line);
    let quit = matches!(request, Ok(Request::Quit));
    let reply = match request {
        Ok(request) => handle(app, page, request),
        Err(e) => Err(format!("unreadable request: {e}")),
    };
    let body = match reply {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    };

    let _ = writeln!(stream, "{body}");
    drop(stream);
    if quit {
        app.exit(0);
    }
}

fn handle<R: Runtime>(app: &AppHandle<R>, page: &Page, request: Request) -> Result<Value, String> {
    match request {
        Request::Ping | Request::Quit => Ok(Value::Null),
        Request::Eval { js } => evaluate(app, page, &js),
        Request::Snapshot { path } => {
            let webview = *WEBVIEW.get().ok_or("the webview is not created yet")?;
            native::snapshot(webview, &path)
        }
        Request::Alert => native::alert(),
        Request::Press { button } => native::press(button),
    }
}

/// Runs `js`, an expression, in the page and waits for the page to report its
/// awaited value, since the webview's own completion handler cannot carry a
/// Promise's result.
fn evaluate<R: Runtime>(app: &AppHandle<R>, page: &Page, js: &str) -> Result<Value, String> {
    page.wait_ready()?;
    let webview = app
        .get_webview_window("main")
        .ok_or("the main window is gone")?;

    let (id, reply) = page.expect_reply();
    let source = serde_json::to_string(js).expect("a string serializes");
    if let Err(e) = webview.eval(format!("window.__trunkDrive.run({id}, {source})")) {
        page.forget(id);
        return Err(format!("eval: {e}"));
    }

    let reply = reply.recv_timeout(PAGE_DEADLINE).map_err(|_| {
        page.forget(id);
        format!("the page did not answer in {}s", PAGE_DEADLINE.as_secs())
    })?;
    if reply.ok {
        Ok(reply.value)
    } else {
        Err(reply.error)
    }
}

fn effective_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() }
}

fn peer_uid(stream: &UnixStream) -> Option<u32> {
    let mut uid = 0;
    let mut gid = 0;
    // SAFETY: the descriptor is the live socket `stream` owns, and both out
    // pointers are valid for the call.
    let status = unsafe { libc::getpeereid(stream.as_raw_fd(), &raw mut uid, &raw mut gid) };
    (status == 0).then_some(uid)
}

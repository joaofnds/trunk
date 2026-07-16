use notify_debouncer_mini::notify::RecommendedWatcher;
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer, notify::RecursiveMode};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

pub type WatcherMap = HashMap<String, Debouncer<RecommendedWatcher>>;
pub struct WatcherState(pub Mutex<WatcherMap>);

impl Default for WatcherState {
    fn default() -> Self {
        WatcherState(Mutex::new(HashMap::new()))
    }
}

pub fn start_watcher<R: Runtime>(path: PathBuf, app: AppHandle<R>, state: &WatcherState) {
    let path_clone = path.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        move |res: DebounceEventResult| {
            if res.is_ok() {
                let _ = app.emit("repo-changed", path_clone.to_string_lossy().to_string());
            }
        },
    )
    .expect("failed to create debouncer");

    debouncer
        .watcher()
        .watch(&path, RecursiveMode::Recursive)
        .expect("failed to watch path");

    state
        .0
        .lock()
        .unwrap()
        .insert(path.to_string_lossy().to_string(), debouncer);
}

pub fn stop_watcher(path: &str, state: &WatcherState) {
    state.0.lock().unwrap().remove(path);
}

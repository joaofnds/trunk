use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

pub type WatcherMap = HashMap<String, Debouncer<RecommendedWatcher>>;
pub struct WatcherState {
    pub watchers: Mutex<WatcherMap>,
    pub enabled: bool,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
            enabled: true,
        }
    }
}

impl WatcherState {
    /// A state that refuses to watch. The application test harness manages one of
    /// these, so `open_repo` runs unchanged while no filesystem watch is created.
    #[must_use]
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            ..Default::default()
        }
    }
}

/// Watch `path` and emit `repo-changed` when it changes. A disabled state
/// watches nothing.
///
/// # Panics
///
/// Panics when the debouncer cannot be created, the path cannot be watched, or
/// the watcher lock is poisoned.
pub fn start_watcher<R: Runtime>(path: &Path, app: AppHandle<R>, state: &WatcherState) {
    start_watcher_with_registration(path, app, state, |debouncer, path| {
        debouncer.watcher().watch(path, RecursiveMode::Recursive)
    });
}

fn start_watcher_with_registration<R, F>(
    path: &Path,
    app: AppHandle<R>,
    state: &WatcherState,
    register: F,
) where
    R: Runtime,
    F: FnOnce(
        &mut Debouncer<RecommendedWatcher>,
        &Path,
    ) -> notify_debouncer_mini::notify::Result<()>,
{
    if !state.enabled {
        return;
    }

    let path_clone = path.to_path_buf();

    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        move |res: DebounceEventResult| {
            if res.is_ok() {
                let _ = app.emit("repo-changed", path_clone.to_string_lossy().to_string());
            }
        },
    )
    .expect("failed to create debouncer");

    register(&mut debouncer, path).expect("failed to watch path");

    state
        .watchers
        .lock()
        .unwrap()
        .insert(path.to_string_lossy().to_string(), debouncer);
}

/// Stop watching `path`. A path with no watcher is not an error.
///
/// # Panics
///
/// Panics when the watcher lock is poisoned.
pub fn stop_watcher(path: &str, state: &WatcherState) {
    state.watchers.lock().unwrap().remove(path);
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    #[test]
    fn an_enabled_start_records_the_path() {
        let app = tauri::test::mock_app();
        let state = WatcherState::default();

        start_watcher_with_registration(Path::new("repo"), app.handle().clone(), &state, |_, _| {
            Ok(())
        });

        assert!(state.watchers.lock().unwrap().contains_key("repo"));
    }

    #[test]
    fn stopping_one_path_leaves_the_other_registered() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let state = WatcherState::default();

        start_watcher_with_registration(Path::new("repo-one"), handle.clone(), &state, |_, _| {
            Ok(())
        });
        start_watcher_with_registration(Path::new("repo-two"), handle, &state, |_, _| Ok(()));
        stop_watcher("repo-one", &state);

        assert_eq!(
            state.watchers.lock().unwrap().keys().collect::<Vec<_>>(),
            vec!["repo-two"]
        );
    }

    #[test]
    fn a_disabled_state_skips_registration_and_records_nothing() {
        let app = tauri::test::mock_app();
        let state = WatcherState::disabled();
        let registration_called = Cell::new(false);

        start_watcher_with_registration(Path::new("repo"), app.handle().clone(), &state, |_, _| {
            registration_called.set(true);
            Ok(())
        });

        assert!(!registration_called.get());
        assert!(state.watchers.lock().unwrap().is_empty());
    }

    #[test]
    fn a_registration_error_panics_before_recording_the_path() {
        let app = tauri::test::mock_app();
        let state = WatcherState::default();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            start_watcher_with_registration(
                Path::new("repo"),
                app.handle().clone(),
                &state,
                |_, _| {
                    Err(notify_debouncer_mini::notify::Error::generic(
                        "registration failed",
                    ))
                },
            );
        }));

        assert!(result.is_err());
        assert!(state.watchers.lock().unwrap().is_empty());
    }
}

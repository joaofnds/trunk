use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

/// The `repo-changed` payload.
///
/// `paths` names the files the change touched, relative to the repository root
/// and sorted, so a subscriber can tell whether a write concerns what it is
/// showing. An empty `paths` means the writer could not say, and every
/// subscriber refreshes: that is what the command sites emit, since a commit or
/// a checkout changes more than any list they could give (TRUNK-232).
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct RepoChanged {
    pub repo: String,
    pub paths: Vec<String>,
}

impl RepoChanged {
    /// A change whose extent is unknown, so every subscriber refreshes.
    #[must_use]
    pub fn whole_repo(repo: impl Into<String>) -> Self {
        Self {
            repo: repo.into(),
            paths: Vec::new(),
        }
    }

    /// A change confined to `changed`. A path outside `repo`, or one that cannot
    /// be made relative to it, leaves the payload unscoped rather than naming a
    /// file no subscriber can match.
    ///
    /// `roots` are the forms of the repository root a reported path may carry.
    /// The watcher passes the watched path and its canonical form, because
    /// `notify` reports through resolved symlinks: on macOS a repository under
    /// `/var/...` is reported under `/private/var/...`, and stripping only the
    /// watched path would leave every event unscoped (TRUNK-232).
    #[must_use]
    pub fn scoped_to(repo: &Path, roots: &[PathBuf], changed: &[PathBuf]) -> Self {
        let repo_string = repo.to_string_lossy().to_string();
        let mut paths = Vec::with_capacity(changed.len());

        for path in changed {
            let Some(relative) = roots.iter().find_map(|root| path.strip_prefix(root).ok()) else {
                return Self::whole_repo(repo_string);
            };

            // The root stripped against itself, so the report names the whole
            // repository rather than a file in it.
            if relative.as_os_str().is_empty() {
                return Self::whole_repo(repo_string);
            }

            paths.push(relative.to_string_lossy().replace('\\', "/"));
        }

        paths.sort_unstable();
        paths.dedup();

        Self {
            repo: repo_string,
            paths,
        }
    }
}

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

    let watched = path.to_path_buf();
    let roots = root_forms(path);

    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        move |res: DebounceEventResult| {
            let Ok(events) = res else { return };

            let changed: Vec<PathBuf> = events.into_iter().map(|event| event.path).collect();

            let _ = app.emit(
                "repo-changed",
                RepoChanged::scoped_to(&watched, &roots, &changed),
            );
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

/// The forms of `path` a reported event may carry: the path itself, and its
/// canonical form when resolving symlinks yields a different one.
fn root_forms(path: &Path) -> Vec<PathBuf> {
    let mut roots = vec![path.to_path_buf()];

    if let Ok(canonical) = path.canonicalize()
        && canonical != path
    {
        roots.push(canonical);
    }

    roots
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
    fn an_unscoped_change_names_no_path() {
        let payload = RepoChanged::whole_repo("/repo");

        assert_eq!(payload.repo, "/repo");
        assert!(payload.paths.is_empty());
    }

    #[test]
    fn a_scoped_change_names_each_path_relative_to_the_repository() {
        let payload = RepoChanged::scoped_to(
            Path::new("/repo"),
            &[PathBuf::from("/repo")],
            &[
                PathBuf::from("/repo/src/main.rs"),
                PathBuf::from("/repo/README.md"),
            ],
        );

        assert_eq!(payload.paths, vec!["README.md", "src/main.rs"]);
    }

    #[test]
    fn a_path_repeated_in_one_batch_is_named_once() {
        let payload = RepoChanged::scoped_to(
            Path::new("/repo"),
            &[PathBuf::from("/repo")],
            &[PathBuf::from("/repo/a.txt"), PathBuf::from("/repo/a.txt")],
        );

        assert_eq!(payload.paths, vec!["a.txt"]);
    }

    #[test]
    fn a_path_outside_the_repository_leaves_the_change_unscoped() {
        let payload = RepoChanged::scoped_to(
            Path::new("/repo"),
            &[PathBuf::from("/repo")],
            &[
                PathBuf::from("/repo/a.txt"),
                PathBuf::from("/elsewhere/b.txt"),
            ],
        );

        assert_eq!(payload, RepoChanged::whole_repo("/repo"));
    }

    // `notify` reports through resolved symlinks, so a repository opened under
    // a symlinked path sees every event arrive under the resolved one.
    #[test]
    fn a_path_reported_under_the_resolved_root_is_still_named() {
        let payload = RepoChanged::scoped_to(
            Path::new("/var/repo"),
            &[
                PathBuf::from("/var/repo"),
                PathBuf::from("/private/var/repo"),
            ],
            &[PathBuf::from("/private/var/repo/a.txt")],
        );

        assert_eq!(payload.repo, "/var/repo");
        assert_eq!(payload.paths, vec!["a.txt"]);
    }

    // Stripping the root against itself yields an empty relative path, which
    // names no file any subscriber can match. It is the same "could not say"
    // condition an empty batch is, so it takes the same answer.
    #[test]
    fn the_repository_root_itself_leaves_the_change_unscoped() {
        let payload = RepoChanged::scoped_to(
            Path::new("/repo"),
            &[PathBuf::from("/repo")],
            &[PathBuf::from("/repo")],
        );

        assert_eq!(payload, RepoChanged::whole_repo("/repo"));
    }

    #[test]
    fn an_empty_batch_leaves_the_change_unscoped() {
        let payload = RepoChanged::scoped_to(Path::new("/repo"), &[PathBuf::from("/repo")], &[]);

        assert_eq!(payload, RepoChanged::whole_repo("/repo"));
    }

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

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use trunk_git::error::TrunkError;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub refs_only: bool,
}

impl RepoChanged {
    /// A change whose extent is unknown, so every subscriber refreshes.
    #[must_use]
    pub fn whole_repo(repo: impl Into<String>) -> Self {
        Self {
            repo: repo.into(),
            paths: Vec::new(),
            graph_revision: None,
            refs_only: false,
        }
    }

    #[must_use]
    pub fn reconciled(repo: impl Into<String>, graph: &crate::state::ReconciledGraph) -> Self {
        Self {
            repo: repo.into(),
            paths: Vec::new(),
            graph_revision: Some(graph.revision),
            refs_only: !graph.worktree_context_changed,
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
            graph_revision: None,
            refs_only: false,
        }
    }
}

#[derive(Clone)]
struct GitDirectories {
    private: PathBuf,
    common: PathBuf,
}

impl GitDirectories {
    fn open(path: &Path) -> Option<Self> {
        let repo = git2::Repository::open(path).ok()?;
        Some(Self {
            private: repo.path().canonicalize().ok()?,
            common: repo.commondir().canonicalize().ok()?,
        })
    }

    fn classify(&self, path: &Path) -> GitChange {
        if self.private != self.common
            && !path.starts_with(&self.private)
            && let Ok(relative) = path.strip_prefix(&self.common)
        {
            let relative = relative.to_string_lossy().replace('\\', "/");
            if matches!(
                relative.as_str(),
                "HEAD"
                    | "index"
                    | "MERGE_HEAD"
                    | "MERGE_MSG"
                    | "MERGE_MODE"
                    | "AUTO_MERGE"
                    | "COMMIT_EDITMSG"
                    | "REBASE_HEAD"
                    | "CHERRY_PICK_HEAD"
                    | "REVERT_HEAD"
                    | "BISECT_LOG"
                    | "BISECT_START"
                    | "SQUASH_MSG"
            ) || relative.starts_with("rebase-merge/")
                || relative == "rebase-merge"
                || relative.starts_with("rebase-apply/")
                || relative == "rebase-apply"
                || relative.starts_with("sequencer/")
                || relative == "sequencer"
                || relative.starts_with("refs/bisect/")
                || relative.starts_with("refs/worktree/")
                || relative.starts_with("refs/rewritten/")
            {
                return GitChange::Bookkeeping;
            }
        }
        let relative = path
            .strip_prefix(&self.private)
            .or_else(|_| path.strip_prefix(&self.common));
        let Ok(relative) = relative else {
            return GitChange::Worktree;
        };
        let relative = relative.to_string_lossy().replace('\\', "/");
        // Stashes change the worktree's graph placement and WIP context. They
        // must remain observable while remote authentication is still blocked.
        if relative == "refs/stash" || relative == "logs/refs/stash" {
            return GitChange::Worktree;
        }
        if relative == "FETCH_HEAD"
            || relative == "ORIG_HEAD"
            || relative == "objects"
            || relative.starts_with("objects/")
            || relative == "logs"
            || relative.starts_with("logs/")
            || std::path::Path::new(&relative).extension() == Some(std::ffi::OsStr::new("lock"))
        {
            return GitChange::Bookkeeping;
        }
        if relative == "refs" || relative.starts_with("refs/") || relative == "packed-refs" {
            return GitChange::Refs;
        }
        // Another worktree's private files do not describe this worktree.
        if relative == "worktrees" || relative.starts_with("worktrees/") {
            return GitChange::Bookkeeping;
        }
        GitChange::Worktree
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GitChange {
    Bookkeeping,
    Refs,
    Worktree,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RefRefresh {
    Running,
    Pending,
}

fn route_changes<R: Runtime>(
    watched: &Path,
    roots: &[PathBuf],
    git: Option<&GitDirectories>,
    changed: Vec<PathBuf>,
    app: &AppHandle<R>,
    pending: &Arc<Mutex<HashMap<String, RefRefresh>>>,
) -> Option<tauri::async_runtime::JoinHandle<()>> {
    let mut relevant = Vec::new();
    let mut worktree = changed.is_empty();
    for path in changed {
        match git.map_or(GitChange::Worktree, |git| git.classify(&path)) {
            GitChange::Bookkeeping => {}
            GitChange::Refs => relevant.push(path),
            GitChange::Worktree => {
                worktree = true;
                relevant.push(path);
            }
        }
    }
    if relevant.is_empty() && !worktree {
        return None;
    }
    let repo = watched.to_string_lossy().to_string();
    let cache = app.state::<crate::state::CommitCache>();
    if worktree {
        cache.invalidate(&repo);
        let _ = app.emit(
            "repo-changed",
            RepoChanged::scoped_to(watched, roots, &relevant),
        );
        return None;
    }
    {
        let mut pending = pending.lock().unwrap();
        if let Some(refresh) = pending.get_mut(&repo) {
            *refresh = RefRefresh::Pending;
            return None;
        }
        pending.insert(repo.clone(), RefRefresh::Running);
    }
    let common = git.map(|git| git.common.to_string_lossy().to_string());
    let pending = Arc::clone(pending);
    let app = app.clone();
    let location = watched.to_path_buf();
    Some(tauri::async_runtime::spawn(async move {
        loop {
            let running = app.state::<crate::state::RunningOp>();
            let _reconciliation = match &common {
                Some(common) => {
                    Some(crate::remote_ops::wait_background_idle(&running.0, common).await)
                }
                None => None,
            };
            pending
                .lock()
                .unwrap()
                .insert(repo.clone(), RefRefresh::Running);
            let cache = app.state::<crate::state::CommitCache>();
            let visibility = app.state::<crate::state::RefVisibilityState>();
            match crate::state::GraphRebuild::new(&cache, &visibility)
                .reconcile_refs(repo.clone(), location.clone())
                .await
            {
                Ok(Some(graph)) => {
                    let _ = app.emit(
                        "repo-changed",
                        RepoChanged::reconciled(repo.clone(), &graph),
                    );
                }
                Ok(None) => {}
                Err(error) if error.code == "not_open" => {}
                Err(_) => {
                    let _ = app.emit("repo-changed", RepoChanged::whole_repo(repo.clone()));
                }
            }
            let mut pending = pending.lock().unwrap();
            if pending.get(&repo) != Some(&RefRefresh::Pending) {
                pending.remove(&repo);
                drop(pending);
                break;
            }
        }
    }))
}

pub type WatcherMap = HashMap<String, Debouncer<RecommendedWatcher>>;
pub struct WatcherState {
    pub watchers: Mutex<WatcherMap>,
    pub enabled: bool,
    pending_refs: Arc<Mutex<HashMap<String, RefRefresh>>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
            enabled: true,
            pending_refs: Arc::default(),
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

    /// Deliver an observed batch and join its ref reconciliation without an OS debounce.
    /// # Errors
    /// Returns `spawn_error` if the reconciliation task fails to join.
    #[cfg(feature = "test-util")]
    pub async fn deliver_changes<R: Runtime>(
        &self,
        path: &Path,
        changed: Vec<PathBuf>,
        app: &AppHandle<R>,
    ) -> Result<(), TrunkError> {
        let git = GitDirectories::open(path);
        if let Some(task) = route_changes(
            path,
            &root_forms(path),
            git.as_ref(),
            changed,
            app,
            &self.pending_refs,
        ) {
            task.await
                .map_err(|error| TrunkError::new("spawn_error", error.to_string()))?;
        }

        Ok(())
    }
}

/// Watch `path` and emit `repo-changed` when it changes. A disabled state
/// watches nothing.
///
/// # Errors
/// Returns `watcher_unavailable` if a watcher or required registration fails.
///
/// # Panics
///
/// Panics when the watcher lock is poisoned.
pub fn start_watcher<R: Runtime>(
    path: &Path,
    app: AppHandle<R>,
    state: &WatcherState,
) -> Result<(), TrunkError> {
    start_watcher_with_registration(path, app, state, |debouncer, path| {
        debouncer.watcher().watch(path, RecursiveMode::Recursive)
    })
}

fn start_watcher_with_registration<R, F>(
    path: &Path,
    app: AppHandle<R>,
    state: &WatcherState,
    mut register: F,
) -> Result<(), TrunkError>
where
    R: Runtime,
    F: FnMut(
        &mut Debouncer<RecommendedWatcher>,
        &Path,
    ) -> notify_debouncer_mini::notify::Result<()>,
{
    if !state.enabled {
        return Ok(());
    }

    let watched = path.to_path_buf();
    let roots = root_forms(path);
    let git = GitDirectories::open(path);
    let callback_git = git.clone();
    let pending = Arc::clone(&state.pending_refs);

    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        move |res: DebounceEventResult| {
            let Ok(events) = res else { return };

            let changed: Vec<PathBuf> = events.into_iter().map(|event| event.path).collect();

            drop(route_changes(
                &watched,
                &roots,
                callback_git.as_ref(),
                changed,
                &app,
                &pending,
            ));
        },
    )
    .map_err(|_| TrunkError::new("watcher_unavailable", "Repository watcher could not start"))?;

    register(&mut debouncer, path).map_err(|_| {
        TrunkError::new(
            "watcher_unavailable",
            "Repository path could not be watched",
        )
    })?;
    if let Some(git) = git {
        let canonical_root = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if !git.common.starts_with(&canonical_root) {
            register(&mut debouncer, &git.common).map_err(|_| {
                TrunkError::new(
                    "watcher_unavailable",
                    "Shared Git directory could not be watched",
                )
            })?;
        }
        if !git.private.starts_with(&canonical_root) && !git.private.starts_with(&git.common) {
            register(&mut debouncer, &git.private).map_err(|_| {
                TrunkError::new(
                    "watcher_unavailable",
                    "Worktree Git directory could not be watched",
                )
            })?;
        }
    }

    state
        .watchers
        .lock()
        .unwrap()
        .insert(path.to_string_lossy().to_string(), debouncer);
    Ok(())
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
    fn linked_worktrees_ignore_the_primary_worktrees_private_metadata() {
        let git = GitDirectories {
            private: PathBuf::from("/repo/.git/worktrees/linked"),
            common: PathBuf::from("/repo/.git"),
        };
        for path in [
            "HEAD",
            "index",
            "MERGE_HEAD",
            "COMMIT_EDITMSG",
            "rebase-merge/head-name",
        ] {
            assert_eq!(
                git.classify(&git.common.join(path)),
                GitChange::Bookkeeping,
                "{path}"
            );
        }
        assert_eq!(git.classify(&git.private.join("HEAD")), GitChange::Worktree);
        assert_eq!(
            git.classify(&git.private.join("index")),
            GitChange::Worktree
        );
        assert_eq!(
            git.classify(&git.common.join("config")),
            GitChange::Worktree
        );
        assert_eq!(
            git.classify(&git.common.join("refs/heads/main")),
            GitChange::Refs
        );
        assert_eq!(
            git.classify(&git.common.join("refs/stash")),
            GitChange::Worktree
        );
    }

    #[test]
    fn fetch_bookkeeping_never_emits_a_repository_change() {
        let app = tauri::test::mock_builder()
            .manage(crate::state::CommitCache::new(
                crate::state::GraphCache::default(),
            ))
            .manage(crate::state::RunningOp(Mutex::new(
                crate::state::RemoteOps::default(),
            )))
            .manage(crate::state::RefVisibilityState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&events);
        tauri::Listener::listen(app.handle(), "repo-changed", move |event| {
            observed.lock().unwrap().push(event.payload().to_owned());
        });
        let git = GitDirectories {
            private: PathBuf::from("/repo/.git"),
            common: PathBuf::from("/repo/.git"),
        };
        for path in [
            "FETCH_HEAD",
            "ORIG_HEAD",
            "objects",
            "objects/aa/pack",
            "logs/refs/remotes/origin/main",
            "refs/remotes/origin/main.lock",
            "worktrees/other/index",
        ] {
            route_changes(
                Path::new("/repo"),
                &[PathBuf::from("/repo")],
                Some(&git),
                vec![git.common.join(path)],
                app.handle(),
                &Arc::default(),
            );
        }
        assert!(events.lock().unwrap().is_empty());
    }

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
        })
        .unwrap();

        assert!(state.watchers.lock().unwrap().contains_key("repo"));
    }

    #[test]
    fn stopping_one_path_leaves_the_other_registered() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let state = WatcherState::default();

        start_watcher_with_registration(Path::new("repo-one"), handle.clone(), &state, |_, _| {
            Ok(())
        })
        .unwrap();
        start_watcher_with_registration(Path::new("repo-two"), handle, &state, |_, _| Ok(()))
            .unwrap();
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
        })
        .unwrap();

        assert!(!registration_called.get());
        assert!(state.watchers.lock().unwrap().is_empty());
    }

    #[test]
    fn a_registration_error_is_reported_without_recording_the_path() {
        let app = tauri::test::mock_app();
        let state = WatcherState::default();

        let result = start_watcher_with_registration(
            Path::new("repo"),
            app.handle().clone(),
            &state,
            |_, _| {
                Err(notify_debouncer_mini::notify::Error::generic(
                    "registration failed",
                ))
            },
        );

        assert_eq!(result.unwrap_err().code, "watcher_unavailable");
        assert!(state.watchers.lock().unwrap().is_empty());
    }

    #[test]
    fn a_shared_directory_registration_failure_leaves_no_partial_worktree_watch() {
        let directory = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(directory.path().join("primary")).unwrap();
        let signature = git2::Signature::now("Fixture", "fixture@example.com").unwrap();
        let tree_id = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let commit_id = repo
            .commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
        let commit = repo.find_commit(commit_id).unwrap();
        repo.branch("linked", &commit, false).unwrap();
        let branch = repo.find_reference("refs/heads/linked").unwrap();
        let mut options = git2::WorktreeAddOptions::new();
        options.reference(Some(&branch));
        let linked = directory.path().join("linked");
        repo.worktree("linked", &linked, Some(&options)).unwrap();
        let app = tauri::test::mock_app();
        let state = WatcherState::default();

        let result =
            start_watcher_with_registration(&linked, app.handle().clone(), &state, |_, path| {
                if path == linked {
                    Ok(())
                } else {
                    Err(notify_debouncer_mini::notify::Error::generic(
                        "shared registration failed",
                    ))
                }
            });

        assert_eq!(result.unwrap_err().code, "watcher_unavailable");
        assert!(state.watchers.lock().unwrap().is_empty());
    }
}

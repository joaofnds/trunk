use notify::event::{AccessKind, AccessMode};
use notify::{Event, EventHandler, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::cell::OnceCell;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use trunk_git::error::TrunkError;
use trunk_git::write_gate::GateKey;

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
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub command_completed: bool,
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
            command_completed: false,
        }
    }

    /// A finished command requests immediate reads and advertises only a checked graph.
    #[must_use]
    pub fn completed(repo: impl Into<String>, cache: &crate::state::CommitCache) -> Self {
        let repo = repo.into();
        let graph_revision = cache.checked_revision(&repo);
        Self {
            graph_revision,
            command_completed: true,
            ..Self::whole_repo(repo)
        }
    }

    #[must_use]
    pub fn reconciled(repo: impl Into<String>, graph: &crate::state::ReconciledGraph) -> Self {
        Self {
            repo: repo.into(),
            paths: Vec::new(),
            graph_revision: Some(graph.revision),
            refs_only: !graph.worktree_context_changed,
            command_completed: false,
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
            command_completed: false,
        }
    }
}

#[derive(Clone)]
struct GitDirectories {
    private: PathBuf,
    common: PathBuf,
}

impl GitDirectories {
    fn of(repo: &git2::Repository) -> Option<Self> {
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

fn ignored_worktree_path(
    path: &Path,
    roots: &[PathBuf],
    repo: &git2::Repository,
    index: &git2::Index,
) -> bool {
    let Some(relative) = roots.iter().find_map(|root| path.strip_prefix(root).ok()) else {
        return false;
    };

    if relative.as_os_str().is_empty()
        || relative.file_name() == Some(std::ffi::OsStr::new(".gitignore"))
        || relative.starts_with(".git")
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return false;
    }

    // Include conflict stages. Directory notifications and paths inside
    // tracked submodules can describe tracked changes without an exact entry.
    if (0..=3).any(|stage| index.get_path(relative, stage).is_some()) {
        return false;
    }

    let mut directory_prefix = relative.as_os_str().to_os_string();
    directory_prefix.push("/");

    match index.find_prefix(directory_prefix) {
        Err(error) if error.code() == git2::ErrorCode::NotFound => {}
        Ok(_) | Err(_) => return false,
    }

    for parent in relative
        .ancestors()
        .skip(1)
        .take_while(|parent| !parent.as_os_str().is_empty())
    {
        if (0..=3).any(|stage| {
            index
                .get_path(parent, stage)
                .is_some_and(|entry| entry.mode == 0o160_000)
        }) {
            return false;
        }
    }

    repo.is_path_ignored(relative).unwrap_or(false)
}

/// What routing a batch did.
enum Routed {
    /// Nothing in the batch concerned a subscriber.
    Nothing,
    /// Subscribers were told, or will be once the ref reconciliation this
    /// holds, or one already running, ends.
    Published(Option<tauri::async_runtime::JoinHandle<()>>),
}

fn route_changes<R: Runtime>(
    watched: &Path,
    roots: &[PathBuf],
    git: Option<&GitDirectories>,
    changed: Vec<PathBuf>,
    app: &AppHandle<R>,
    pending: &Arc<Mutex<HashMap<String, RefRefresh>>>,
) -> Routed {
    let Ok(activity) = crate::activity::Activity::for_app(app) else {
        return Routed::Nothing;
    };
    let mut relevant = Vec::new();
    let mut worktree = changed.is_empty();
    let ignore_context = OnceCell::new();

    for path in changed {
        match git.map_or(GitChange::Worktree, |git| git.classify(&path)) {
            GitChange::Bookkeeping => {}
            GitChange::Refs => relevant.push(path),
            GitChange::Worktree => {
                let metadata = git.is_some_and(|git| {
                    path.starts_with(&git.private) || path.starts_with(&git.common)
                });
                if !metadata {
                    let context = ignore_context.get_or_init(|| {
                        let repo = git2::Repository::open(watched).ok()?;
                        let index = repo.index().ok()?;
                        Some((repo, index))
                    });
                    if context.as_ref().is_some_and(|(repo, index)| {
                        ignored_worktree_path(&path, roots, repo, index)
                    }) {
                        continue;
                    }
                }
                worktree = true;
                relevant.push(path);
            }
        }
    }
    if relevant.is_empty() && !worktree {
        return Routed::Nothing;
    }
    let repo = watched.to_string_lossy().to_string();
    let cache = app.state::<crate::state::CommitCache>();
    if worktree {
        cache.invalidate(&repo);
        let _ = app.emit(
            "repo-changed",
            RepoChanged::scoped_to(watched, roots, &relevant),
        );
        return Routed::Published(None);
    }
    {
        let mut pending = pending.lock().unwrap();
        if let Some(refresh) = pending.get_mut(&repo) {
            *refresh = RefRefresh::Pending;
            return Routed::Published(None);
        }
        pending.insert(repo.clone(), RefRefresh::Running);
    }
    let common = git.map(|git| git.common.to_string_lossy().to_string());
    let pending = Arc::clone(pending);
    let app = app.clone();
    Routed::Published(Some(tauri::async_runtime::spawn(async move {
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
            let reconciled = match app.state::<crate::state::RepoState>().repository(&repo) {
                Some(repository) => {
                    crate::state::GraphRebuild::new(activity.clone(), &cache, &visibility)
                        .reconcile_refs(repo.clone(), repository)
                        .await
                }
                None => Err(TrunkError::new("not_open", "Repository closed")),
            };
            match reconciled {
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
    })))
}

struct FileChangeEvents<F>(F);

fn is_nonmutating_access(event: &Event) -> bool {
    matches!(event.kind, EventKind::Access(kind) if kind != AccessKind::Close(AccessMode::Write))
        && !event.need_rescan()
}

impl<F: EventHandler> EventHandler for FileChangeEvents<F> {
    fn handle_event(&mut self, event: notify::Result<Event>) {
        if let Ok(event) = &event
            && is_nonmutating_access(event)
        {
            return;
        }

        self.0.handle_event(event);
    }
}

/// How long the first change after a quiet spell waits for the writes that come
/// with it, such as an editor's rename over the file it saved.
const GATHER_WINDOW: Duration = Duration::from_millis(25);

/// The least time between two deliveries, which bounds the refreshes a burst of
/// writes such as a checkout or a build can cause.
const PACING_INTERVAL: Duration = Duration::from_millis(300);

/// How long a due batch waits for Git to release the index lock, so an
/// operation run outside the app, such as a checkout, shows its result rather
/// than a state halfway through it. A lock left behind by a crashed Git still
/// lets changes through after this.
const LOCK_PATIENCE: Duration = Duration::from_secs(1);

/// How often a batch held for one of the app's own writes checks whether the write
/// has ended. Nothing else wakes the pacer then, since the run's last writes may
/// already have been reported.
const APP_WRITE_RECHECK: Duration = Duration::from_millis(20);

/// Who is midway through writing the repository when a batch falls due.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Writer {
    Nobody,
    /// A git process holds the index lock. It may be one run outside the app, or one
    /// left behind by a crash.
    Git,
    /// A writer in this app holds the repository, such as a pull running git. Its
    /// writes are shown once it ends rather than halfway through. No patience
    /// bounds this wait, so while a git run that never ends holds the repository,
    /// such as one whose commit hook hangs, no change is shown.
    App,
}

#[derive(Debug, PartialEq, Eq)]
enum Changes {
    Paths(BTreeSet<PathBuf>),
    /// The backend lost track of what changed, so every subscriber refreshes.
    Unscoped,
}

impl Changes {
    fn of(event: notify::Result<Event>) -> Option<Self> {
        let Ok(event) = event else {
            return Some(Self::Unscoped);
        };

        if event.need_rescan() {
            return Some(Self::Unscoped);
        }

        if event.paths.is_empty() {
            return None;
        }

        Some(Self::Paths(event.paths.into_iter().collect()))
    }

    fn absorb(&mut self, more: Self) {
        match (self, more) {
            (Self::Unscoped, _) => {}
            (held, Self::Unscoped) => *held = Self::Unscoped,
            (Self::Paths(held), Self::Paths(more)) => held.extend(more),
        }
    }

    /// The batch in `route_changes`'s terms, where no path means unscoped.
    fn into_paths(self) -> Vec<PathBuf> {
        match self {
            Self::Paths(paths) => paths.into_iter().collect(),
            Self::Unscoped => Vec::new(),
        }
    }
}

/// What a held batch waits for once it is due.
#[derive(Clone, Copy)]
enum Wait {
    /// Nothing yet: it goes out at its due time unless someone is writing then.
    Nothing,
    /// Git has held the index lock since this instant.
    IndexLock { since: Instant },
    /// The app was writing the repository, so the batch looks again at this instant.
    AppWrite { look_again: Instant },
}

struct Held {
    due: Instant,
    changes: Changes,
    wait: Wait,
}

/// Releases filesystem changes in batches. The first change after a quiet spell
/// goes out when its gather window closes, and a change that follows a refresh
/// waits until the pacing interval since that refresh has passed. A change
/// never moves the deadline already set.
#[derive(Default)]
struct Pacer {
    held: Option<Held>,
    delivered_at: Option<Instant>,
}

impl Pacer {
    fn record(&mut self, now: Instant, changes: Changes) {
        if let Some(held) = &mut self.held {
            held.changes.absorb(changes);
            return;
        }

        let gathered = now + GATHER_WINDOW;
        let due = self.delivered_at.map_or(gathered, |delivered| {
            gathered.max(delivered + PACING_INTERVAL)
        });

        self.held = Some(Held {
            due,
            changes,
            wait: Wait::Nothing,
        });
    }

    fn deadline(&self) -> Option<Instant> {
        self.held.as_ref().map(|held| match held.wait {
            Wait::Nothing => held.due,
            Wait::IndexLock { since } => since + LOCK_PATIENCE,
            Wait::AppWrite { look_again } => look_again,
        })
    }

    /// The held batch once it is due, unless the app is writing the repository,
    /// or the index is locked and has not been for `LOCK_PATIENCE` yet.
    fn release(&mut self, now: Instant, writer: impl FnOnce() -> Writer) -> Option<Vec<PathBuf>> {
        let held = self.held.as_mut()?;
        if now < held.due {
            return None;
        }

        match writer() {
            Writer::App => {
                held.wait = Wait::AppWrite {
                    look_again: now + APP_WRITE_RECHECK,
                };
                return None;
            }
            Writer::Git => {
                let since = match held.wait {
                    Wait::IndexLock { since } => since,
                    Wait::Nothing | Wait::AppWrite { .. } => now,
                };
                if now < since + LOCK_PATIENCE {
                    held.wait = Wait::IndexLock { since };
                    return None;
                }
            }
            Writer::Nobody => {}
        }

        self.held.take().map(|held| held.changes.into_paths())
    }

    /// Starts the pacing interval: a released batch reached a subscriber at `at`.
    const fn refreshed(&mut self, at: Instant) {
        self.delivered_at = Some(at);
    }
}

/// The git directories of the worktree at `path`, and where to look for a writer
/// midway through it, read from one open of the repository.
fn open_for_watching(path: &Path) -> Option<(GitDirectories, Writers)> {
    let repo = git2::Repository::open(path).ok()?;
    let git = GitDirectories::of(&repo)?;
    let writers = Writers::of(&repo, &git);
    Some((git, writers))
}

/// Where to look for a writer midway through a worktree.
struct Writers {
    /// The lock git holds on this worktree's index while it writes it.
    index_lock: PathBuf,
    gate: GateKey,
}

impl Writers {
    fn of(repo: &git2::Repository, git: &GitDirectories) -> Self {
        Self {
            index_lock: git.private.join("index.lock"),
            gate: GateKey::of(repo),
        }
    }

    fn current(&self) -> Writer {
        if trunk_git::write_gate::is_held(&self.gate) {
            Writer::App
        } else if self.index_lock.exists() {
            Writer::Git
        } else {
            Writer::Nobody
        }
    }
}

enum Message {
    Event(notify::Result<Event>),
    Stop,
}

/// A repository's filesystem watch and the thread that paces what it reports.
/// Dropping it stops both.
pub struct RepoWatcher {
    watcher: RecommendedWatcher,
    outbox: Sender<Message>,
}

impl RepoWatcher {
    /// `deliver` routes a released batch and answers whether it refreshed a
    /// subscriber. `writers` tells who is midway through writing the repository,
    /// and without them a batch never waits for a writer.
    fn start(
        writers: Option<Writers>,
        deliver: impl FnMut(Vec<PathBuf>) -> bool + Send + 'static,
    ) -> notify::Result<Self> {
        let (outbox, inbox) = mpsc::channel();

        std::thread::Builder::new()
            .name("trunk repo watcher".to_string())
            .spawn(move || pace(&inbox, writers.as_ref(), deliver))?;

        let forward = outbox.clone();
        let watcher = RecommendedWatcher::new(
            FileChangeEvents(move |event| drop(forward.send(Message::Event(event)))),
            notify::Config::default(),
        )?;

        Ok(Self { watcher, outbox })
    }
}

impl Drop for RepoWatcher {
    fn drop(&mut self) {
        drop(self.outbox.send(Message::Stop));
    }
}

fn pace(
    inbox: &Receiver<Message>,
    writers: Option<&Writers>,
    mut deliver: impl FnMut(Vec<PathBuf>) -> bool,
) {
    let mut pacer = Pacer::default();

    loop {
        let message = pacer.deadline().map_or_else(
            || inbox.recv().map_err(RecvTimeoutError::from),
            |deadline| inbox.recv_timeout(deadline.saturating_duration_since(Instant::now())),
        );

        match message {
            Ok(Message::Event(event)) => {
                if let Some(changes) = Changes::of(event) {
                    pacer.record(Instant::now(), changes);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Ok(Message::Stop) | Err(RecvTimeoutError::Disconnected) => return,
        }

        if let Some(batch) = pacer.release(Instant::now(), || {
            writers.map_or(Writer::Nobody, Writers::current)
        }) && deliver(batch)
        {
            pacer.refreshed(Instant::now());
        }
    }
}

pub type WatcherMap = HashMap<String, RepoWatcher>;
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

    /// Deliver an observed batch and join its ref reconciliation without waiting on the pacer.
    /// # Errors
    /// Returns `spawn_error` if the reconciliation task fails to join.
    #[cfg(feature = "test-util")]
    pub async fn deliver_changes<R: Runtime>(
        &self,
        path: &Path,
        changed: Vec<PathBuf>,
        app: &AppHandle<R>,
    ) -> Result<(), TrunkError> {
        let git = open_for_watching(path).map(|(git, _)| git);
        if let Routed::Published(Some(task)) = route_changes(
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
    start_watcher_with_registration(path, app, state, |watcher, path| {
        watcher.watch(path, RecursiveMode::Recursive)
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
    F: FnMut(&mut RecommendedWatcher, &Path) -> notify::Result<()>,
{
    if !state.enabled {
        return Ok(());
    }

    let watched = path.to_path_buf();
    let roots = root_forms(path);
    let (git, writers) = open_for_watching(path).unzip();
    let callback_git = git.clone();
    let pending = Arc::clone(&state.pending_refs);

    let mut repo_watcher = RepoWatcher::start(writers, move |changed| {
        match route_changes(
            &watched,
            &roots,
            callback_git.as_ref(),
            changed,
            &app,
            &pending,
        ) {
            Routed::Nothing => false,
            // The reconciliation runs detached; the next batch must not wait on it.
            Routed::Published(reconcile) => {
                drop(reconcile);
                true
            }
        }
    })
    .map_err(|_| TrunkError::new("watcher_unavailable", "Repository watcher could not start"))?;

    register(&mut repo_watcher.watcher, path).map_err(|_| {
        TrunkError::new(
            "watcher_unavailable",
            "Repository path could not be watched",
        )
    })?;
    if let Some(git) = git {
        let canonical_root = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if !git.common.starts_with(&canonical_root) {
            register(&mut repo_watcher.watcher, &git.common).map_err(|_| {
                TrunkError::new(
                    "watcher_unavailable",
                    "Shared Git directory could not be watched",
                )
            })?;
        }
        if !git.private.starts_with(&canonical_root) && !git.private.starts_with(&git.common) {
            register(&mut repo_watcher.watcher, &git.private).map_err(|_| {
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
        .insert(path.to_string_lossy().to_string(), repo_watcher);
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
    use notify::event::{CreateKind, ModifyKind, RemoveKind};
    use std::cell::Cell;

    use super::*;

    fn forwarded(event: notify::Result<Event>) -> Vec<notify::Result<Event>> {
        let (send, received) = std::sync::mpsc::channel();
        let mut handler = FileChangeEvents(move |event| send.send(event).unwrap());

        handler.handle_event(event);

        received.try_iter().collect()
    }

    macro_rules! ignored_access {
        ($($name:ident => $kind:expr;)*) => {$(
            #[test]
            fn $name() {
                let event = Event::new(EventKind::Access($kind)).add_path("/repo/file.txt".into());

                let delivered = forwarded(Ok(event));

                assert!(delivered.is_empty());
            }
        )*};
    }

    ignored_access!(
        opening_a_file_emits_no_change => AccessKind::Open(AccessMode::Any);
        reading_a_file_emits_no_change => AccessKind::Read;
        closing_a_read_handle_emits_no_change => AccessKind::Close(AccessMode::Read);
    );

    macro_rules! preserved_change {
        ($($name:ident => $event:expr;)*) => {$(
            #[test]
            fn $name() {
                let event = $event.add_path("/repo/file.txt".into());

                let delivered = forwarded(Ok(event.clone()));

                assert_eq!(
                    delivered
                        .into_iter()
                        .map(Result::unwrap)
                        .collect::<Vec<_>>(),
                    vec![event]
                );
            }
        )*};
    }

    preserved_change!(
        closing_a_write_handle_preserves_the_change =>
            Event::new(EventKind::Access(AccessKind::Close(AccessMode::Write)));
        creating_a_file_preserves_the_change => Event::new(EventKind::Create(CreateKind::File));
        modifying_a_file_preserves_the_change => Event::new(EventKind::Modify(ModifyKind::Any));
        removing_a_file_preserves_the_change => Event::new(EventKind::Remove(RemoveKind::File));
        an_unknown_event_preserves_the_change => Event::new(EventKind::Any);
        a_rescan_flag_exempts_an_access_event_from_filtering =>
            Event::new(EventKind::Access(AccessKind::Open(AccessMode::Any)))
                .set_flag(notify::event::Flag::Rescan);
    );

    #[test]
    fn a_backend_error_reaches_the_handler() {
        let error = notify::Error::path_not_found().add_path("/repo".into());

        let delivered = forwarded(Err(error));

        let error = delivered.into_iter().next().unwrap().unwrap_err();
        assert!(matches!(error.kind, notify::ErrorKind::PathNotFound));
        assert_eq!(error.paths, vec![PathBuf::from("/repo")]);
    }

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
            .manage(crate::activity::ActivityState::default())
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
            let routed = route_changes(
                Path::new("/repo"),
                &[PathBuf::from("/repo")],
                Some(&git),
                vec![git.common.join(path)],
                app.handle(),
                &Arc::default(),
            );
            assert!(matches!(routed, Routed::Nothing), "{path}");
        }
        assert!(events.lock().unwrap().is_empty());
    }

    #[test]
    fn an_unscoped_change_names_no_path() {
        let payload = RepoChanged::whole_repo("/repo");

        assert_eq!(payload.repo, "/repo");
        assert_eq!(payload.paths, [] as [String; 0]);
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
            |_, _| Err(notify::Error::generic("registration failed")),
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
                    Err(notify::Error::generic("shared registration failed"))
                }
            });

        assert_eq!(result.unwrap_err().code, "watcher_unavailable");
        assert!(state.watchers.lock().unwrap().is_empty());
    }

    mod writers {
        use super::*;

        /// The writers a watcher started on `path` looks for. A temporary directory on
        /// macOS sits under `/var`, whose canonical form is `/private/var`, so these
        /// tests also pin that the watcher names the repository as the gate does.
        fn watching(path: &Path) -> Writers {
            open_for_watching(path).unwrap().1
        }

        #[test]
        fn names_the_app_while_a_turn_on_the_watched_path_holds_it() {
            let dir = tempfile::tempdir().unwrap();
            git2::Repository::init(dir.path()).unwrap();
            let writers = watching(dir.path());

            let repo = git2::Repository::open(dir.path()).unwrap();
            let turn = trunk_git::write_gate::wait_for_turn(&repo);
            let during = writers.current();
            drop(turn);

            assert_eq!((during, writers.current()), (Writer::App, Writer::Nobody));
        }

        #[test]
        fn names_the_app_over_the_index_lock_its_own_git_run_takes() {
            let dir = tempfile::tempdir().unwrap();
            let repo = git2::Repository::init(dir.path()).unwrap();
            std::fs::write(repo.path().join("index.lock"), "").unwrap();
            let writers = watching(dir.path());

            let turn = trunk_git::write_gate::wait_for_turn(&repo);
            let during = writers.current();
            drop(turn);

            assert_eq!((during, writers.current()), (Writer::App, Writer::Git));
        }
    }

    mod pacer {
        use super::*;

        fn paths(names: &[&str]) -> Changes {
            Changes::Paths(names.iter().map(PathBuf::from).collect())
        }

        fn batch(names: &[&str]) -> Vec<PathBuf> {
            names.iter().map(PathBuf::from).collect()
        }

        fn millis(count: u64) -> Duration {
            Duration::from_millis(count)
        }

        const fn unlocked() -> Writer {
            Writer::Nobody
        }

        const fn locked() -> Writer {
            Writer::Git
        }

        const fn app_writing() -> Writer {
            Writer::App
        }

        /// A pacer that released a batch at the returned instant and refreshed
        /// a subscriber with it.
        fn refreshed_once(start: Instant) -> (Pacer, Instant) {
            let delivered = start + GATHER_WINDOW;
            let mut pacer = Pacer::default();
            pacer.record(start, paths(&["a"]));
            pacer.release(delivered, unlocked);
            pacer.refreshed(delivered);
            (pacer, delivered)
        }

        #[test]
        fn has_no_deadline_while_nothing_is_held() {
            assert_eq!(Pacer::default().deadline(), None);
        }

        #[test]
        fn holds_an_isolated_change_until_the_gather_window_closes() {
            let start = Instant::now();
            let mut pacer = Pacer::default();

            pacer.record(start, paths(&["a"]));

            assert_eq!(
                pacer.release(start + GATHER_WINDOW.saturating_sub(millis(1)), unlocked),
                None
            );
        }

        #[test]
        fn releases_an_isolated_change_when_the_gather_window_closes() {
            let start = Instant::now();
            let mut pacer = Pacer::default();
            pacer.record(start, paths(&["a"]));

            let released = pacer.release(start + GATHER_WINDOW, unlocked);

            assert_eq!(released, Some(batch(&["a"])));
            assert_eq!(pacer.deadline(), None);
        }

        #[test]
        fn releases_changes_inside_the_gather_window_as_one_batch() {
            let start = Instant::now();
            let mut pacer = Pacer::default();
            pacer.record(start, paths(&["b"]));
            pacer.record(start + millis(10), paths(&["a", "b"]));

            let released = pacer.release(start + GATHER_WINDOW, unlocked);

            assert_eq!(released, Some(batch(&["a", "b"])));
        }

        #[test]
        fn keeps_the_first_changes_deadline_while_changes_continue() {
            let start = Instant::now();
            let mut pacer = Pacer::default();
            pacer.record(start, paths(&["a"]));

            pacer.record(
                start + GATHER_WINDOW.saturating_sub(millis(1)),
                paths(&["b"]),
            );

            assert_eq!(pacer.deadline(), Some(start + GATHER_WINDOW));
        }

        #[test]
        fn holds_a_change_after_a_refresh_until_the_pacing_interval_ends() {
            let (mut pacer, delivered) = refreshed_once(Instant::now());

            pacer.record(delivered + millis(1), paths(&["b"]));

            assert_eq!(pacer.deadline(), Some(delivered + PACING_INTERVAL));
        }

        #[test]
        fn releases_every_change_held_during_the_pacing_interval_together() {
            let (mut pacer, delivered) = refreshed_once(Instant::now());
            pacer.record(delivered + millis(50), paths(&["c"]));
            pacer.record(delivered + millis(100), paths(&["b"]));
            pacer.record(delivered + millis(200), paths(&["c"]));

            let released = pacer.release(delivered + PACING_INTERVAL, unlocked);

            assert_eq!(released, Some(batch(&["b", "c"])));
        }

        #[test]
        fn gives_a_change_after_a_quiet_interval_the_gather_window_again() {
            let (mut pacer, delivered) = refreshed_once(Instant::now());
            let quiet = delivered + PACING_INTERVAL + millis(1);

            pacer.record(quiet, paths(&["b"]));

            assert_eq!(pacer.deadline(), Some(quiet + GATHER_WINDOW));
        }

        #[test]
        fn gives_a_change_after_a_release_that_refreshed_nothing_the_gather_window() {
            let start = Instant::now();
            let released = start + GATHER_WINDOW;
            let mut pacer = Pacer::default();
            pacer.record(start, paths(&["target/out.o"]));
            pacer.release(released, unlocked);

            pacer.record(released + millis(1), paths(&["a"]));

            assert_eq!(pacer.deadline(), Some(released + millis(1) + GATHER_WINDOW));
        }

        #[test]
        fn an_unscoped_change_leaves_the_whole_batch_unscoped() {
            let start = Instant::now();
            let mut pacer = Pacer::default();
            pacer.record(start, paths(&["a"]));
            pacer.record(start, Changes::Unscoped);
            pacer.record(start, paths(&["b"]));

            let released = pacer.release(start + GATHER_WINDOW, unlocked);

            assert_eq!(released, Some(batch(&[])));
        }

        /// Trunk's own git run, such as a pull that rebases, writes the repository
        /// for seconds. Released midway, its batches showed each step of the run.
        mod when_the_app_is_writing_the_repository {
            use super::*;

            #[test]
            fn holds_a_due_batch_past_the_lock_patience() {
                let start = Instant::now();
                let due = start + GATHER_WINDOW;
                let mut pacer = Pacer::default();
                pacer.record(start, paths(&["a"]));
                pacer.release(due, app_writing);

                assert_eq!(pacer.release(due + LOCK_PATIENCE, app_writing), None);
            }

            #[test]
            fn checks_again_a_recheck_interval_after_it_last_looked() {
                let start = Instant::now();
                let due = start + GATHER_WINDOW;
                let mut pacer = Pacer::default();
                pacer.record(start, paths(&["a"]));
                pacer.release(due, app_writing);
                let looked = due + APP_WRITE_RECHECK + millis(3);

                pacer.release(looked, app_writing);

                assert_eq!(pacer.deadline(), Some(looked + APP_WRITE_RECHECK));
            }

            #[test]
            fn waits_out_the_lock_patience_when_git_locks_the_index_as_the_write_ends() {
                let start = Instant::now();
                let due = start + GATHER_WINDOW;
                let mut pacer = Pacer::default();
                pacer.record(start, paths(&["a"]));
                pacer.release(due, app_writing);
                let ended = due + APP_WRITE_RECHECK;

                pacer.release(ended, locked);

                assert_eq!(pacer.deadline(), Some(ended + LOCK_PATIENCE));
            }

            #[test]
            fn gives_a_lock_seen_before_the_write_its_patience_again_after_it() {
                let start = Instant::now();
                let due = start + GATHER_WINDOW;
                let mut pacer = Pacer::default();
                pacer.record(start, paths(&["a"]));
                pacer.release(due, locked);
                pacer.release(due + LOCK_PATIENCE * 2, app_writing);
                let ended = due + LOCK_PATIENCE * 2 + APP_WRITE_RECHECK;

                let released = pacer.release(ended, locked);

                assert_eq!(
                    (released, pacer.deadline()),
                    (None, Some(ended + LOCK_PATIENCE))
                );
            }

            #[test]
            fn releases_every_change_it_held_once_the_write_ends() {
                let start = Instant::now();
                let due = start + GATHER_WINDOW;
                let mut pacer = Pacer::default();
                pacer.record(start, paths(&["a"]));
                pacer.release(due, app_writing);
                let midway = due + millis(500);
                pacer.record(midway, paths(&["b"]));
                pacer.release(midway, app_writing);

                let released = pacer.release(midway + APP_WRITE_RECHECK, unlocked);

                assert_eq!(released, Some(batch(&["a", "b"])));
            }
        }

        mod when_the_index_is_locked {
            use super::*;

            #[test]
            fn holds_a_due_batch() {
                let start = Instant::now();
                let mut pacer = Pacer::default();
                pacer.record(start, paths(&["a"]));

                assert_eq!(pacer.release(start + GATHER_WINDOW, locked), None);
            }

            #[test]
            fn waits_out_the_lock_patience_from_when_the_batch_fell_due() {
                let start = Instant::now();
                let due = start + GATHER_WINDOW;
                let mut pacer = Pacer::default();
                pacer.record(start, paths(&["a"]));

                pacer.release(due, locked);

                assert_eq!(pacer.deadline(), Some(due + LOCK_PATIENCE));
            }

            #[test]
            fn releases_the_batch_once_the_lock_clears() {
                let start = Instant::now();
                let due = start + GATHER_WINDOW;
                let mut pacer = Pacer::default();
                pacer.record(start, paths(&["a"]));
                pacer.release(due, locked);
                pacer.record(due + millis(40), paths(&["index"]));

                let released = pacer.release(due + millis(40), unlocked);

                assert_eq!(released, Some(batch(&["a", "index"])));
            }

            #[test]
            fn releases_the_batch_when_a_lock_outlasts_the_patience() {
                let start = Instant::now();
                let due = start + GATHER_WINDOW;
                let mut pacer = Pacer::default();
                pacer.record(start, paths(&["a"]));
                pacer.release(due, locked);

                let released = pacer.release(due + LOCK_PATIENCE, locked);

                assert_eq!(released, Some(batch(&["a"])));
            }
        }

        #[test]
        fn a_rescan_is_an_unscoped_change() {
            let event = Event::new(EventKind::Any)
                .add_path("/repo/a".into())
                .set_flag(notify::event::Flag::Rescan);

            assert_eq!(Changes::of(Ok(event)), Some(Changes::Unscoped));
        }

        #[test]
        fn a_rescan_naming_no_path_is_an_unscoped_change() {
            let event = Event::new(EventKind::Any).set_flag(notify::event::Flag::Rescan);

            assert_eq!(Changes::of(Ok(event)), Some(Changes::Unscoped));
        }

        #[test]
        fn a_backend_error_is_an_unscoped_change() {
            let error = notify::Error::generic("events were lost");

            assert_eq!(Changes::of(Err(error)), Some(Changes::Unscoped));
        }

        #[test]
        fn an_event_names_the_paths_it_changed() {
            let event = Event::new(EventKind::Modify(ModifyKind::Any))
                .add_path("/repo/a".into())
                .add_path("/repo/b".into());

            assert_eq!(Changes::of(Ok(event)), Some(paths(&["/repo/a", "/repo/b"])));
        }

        #[test]
        fn an_event_without_paths_is_no_change() {
            let event = Event::new(EventKind::Modify(ModifyKind::Any));

            assert_eq!(Changes::of(Ok(event)), None);
        }
    }
}

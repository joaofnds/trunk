use notify::event::{AccessKind, AccessMode};
use notify::{Event, EventHandler, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
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

/// The index one watcher answers ignore questions from, kept across batches because
/// parsing it is what an answer costs. libgit2 rereads a kept index only when its file
/// changed. Each batch opens the repository afresh, so config and ignore files read as
/// they are now, and the index is parsed again whenever the case setting it was parsed
/// under changed or its file is gone.
#[derive(Default)]
struct WorktreeIgnores(Option<KeptIndex>);

struct KeptIndex {
    index: git2::Index,
    ignore_case: bool,
}

/// One batch's ignore answers: the repository and its index as they are on disk now.
struct IgnoreView<'a> {
    repo: git2::Repository,
    index: &'a git2::Index,
}

impl WorktreeIgnores {
    /// `None` when the repository or its index will not read, and then no path is ignored.
    fn current(&mut self, watched: &Path) -> Option<IgnoreView<'_>> {
        let repo = git2::Repository::open(watched).ok()?;
        let ignore_case = repo
            .config()
            .and_then(|config| config.get_bool("core.ignoreCase"))
            .unwrap_or(false);
        let reusable = self.0.take().filter(|kept| {
            kept.ignore_case == ignore_case && kept.index.path().is_some_and(Path::exists)
        });
        let mut kept = match reusable {
            Some(kept) => kept,
            None => KeptIndex {
                index: repo.index().ok()?,
                ignore_case,
            },
        };

        kept.index.read(false).ok()?;
        let kept = self.0.insert(kept);
        Some(IgnoreView {
            repo,
            index: &kept.index,
        })
    }
}

impl IgnoreView<'_> {
    fn ignores(&self, path: &Path, roots: &[PathBuf]) -> bool {
        ignored_worktree_path(path, roots, &self.repo, self.index)
    }
}

/// Marks the cached graph unchecked, then tells subscribers the working tree changed.
/// # Errors
/// Returns the emit failure. The cache is already marked unchecked by then.
pub fn publish_worktree_change<R: Runtime>(
    app: &AppHandle<R>,
    change: RepoChanged,
) -> tauri::Result<()> {
    app.state::<crate::state::CommitCache>()
        .invalidate(&change.repo);
    app.emit("repo-changed", change)
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
    ignores: &mut WorktreeIgnores,
    app: &AppHandle<R>,
    pending: &Arc<Mutex<HashMap<String, RefRefresh>>>,
) -> Routed {
    let Ok(activity) = crate::activity::Activity::for_app(app) else {
        return Routed::Nothing;
    };
    let mut relevant = Vec::new();
    let mut worktree = changed.is_empty();
    let ignores = ignores.current(watched);

    for path in changed {
        match git.map_or(GitChange::Worktree, |git| git.classify(&path)) {
            GitChange::Bookkeeping => {}
            GitChange::Refs => relevant.push(path),
            GitChange::Worktree => {
                let metadata = git.is_some_and(|git| {
                    path.starts_with(&git.private) || path.starts_with(&git.common)
                });
                if !metadata
                    && ignores
                        .as_ref()
                        .is_some_and(|ignores| ignores.ignores(&path, roots))
                {
                    continue;
                }
                worktree = true;
                relevant.push(path);
            }
        }
    }
    if relevant.is_empty() && !worktree {
        return Routed::Nothing;
    }
    if worktree {
        let _ = publish_worktree_change(app, RepoChanged::scoped_to(watched, roots, &relevant));
        return Routed::Published(None);
    }
    let repo = watched.to_string_lossy().to_string();
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
    CatchUp,
    Stop,
}

/// A value that drops on a thread of its own, so dropping its owner returns at once.
struct DetachedDrop<T: Send + 'static>(Option<T>);

impl<T: Send + 'static> DetachedDrop<T> {
    const fn new(value: T) -> Self {
        Self(Some(value))
    }
}

impl<T: Send + 'static> Drop for DetachedDrop<T> {
    fn drop(&mut self) {
        let value = self.0.take();
        drop(
            std::thread::Builder::new()
                .name("trunk detached drop".to_string())
                .spawn(move || drop(value)),
        );
    }
}

impl<T: Send + 'static> std::ops::Deref for DetachedDrop<T> {
    type Target = T;

    fn deref(&self) -> &T {
        self.0
            .as_ref()
            .expect("the value is present until the drop")
    }
}

impl<T: Send + 'static> std::ops::DerefMut for DetachedDrop<T> {
    fn deref_mut(&mut self) -> &mut T {
        self.0
            .as_mut()
            .expect("the value is present until the drop")
    }
}

/// A repository's filesystem watch and the thread that paces what it reports.
///
/// Dropping it stops the pacer before it returns. The watch stops on a thread of its
/// own, because notify's macOS watcher waits on fseventsd to unregister its stream,
/// which takes tens of seconds while fseventsd is busy.
pub struct RepoWatcher {
    watcher: DetachedDrop<RecommendedWatcher>,
    outbox: Sender<Message>,
}

impl RepoWatcher {
    /// `deliver` makes, on the watcher's own thread, what routes a released batch and
    /// answers whether it refreshed a subscriber. `writers` tells who is midway through
    /// writing the repository, and without them a batch never waits for a writer.
    fn start<D>(
        writers: Option<Writers>,
        deliver: impl FnOnce() -> D + Send + 'static,
    ) -> notify::Result<Self>
    where
        D: FnMut(Vec<PathBuf>) -> bool,
    {
        let (outbox, inbox) = mpsc::channel();

        std::thread::Builder::new()
            .name("trunk repo watcher".to_string())
            .spawn(move || pace(&inbox, writers.as_ref(), deliver()))?;

        let forward = outbox.clone();
        let watcher = RecommendedWatcher::new(
            FileChangeEvents(move |event| drop(forward.send(Message::Event(event)))),
            notify::Config::default(),
        )?;

        Ok(Self {
            watcher: DetachedDrop::new(watcher),
            outbox,
        })
    }

    /// Report the whole repository as changed, for what changed before the watch began.
    fn catch_up(&self) {
        drop(self.outbox.send(Message::CatchUp));
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
            Ok(Message::CatchUp) => pacer.record(Instant::now(), Changes::Unscoped),
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

/// The repositories being watched, and the watch starts not yet finished.
#[derive(Default)]
pub struct Watches {
    live: HashMap<String, RepoWatcher>,
    starting: HashMap<String, u64>,
    started: u64,
}

impl Watches {
    /// How many repositories have a live watch.
    #[cfg(feature = "test-util")]
    #[must_use]
    pub fn live_count(&self) -> usize {
        self.live.len()
    }

    fn begin(&mut self, repo: String) -> u64 {
        self.started += 1;
        self.starting.insert(repo, self.started);

        self.started
    }

    /// Whether `start` is still the start of `repo` that a watch may finish, which
    /// it stops being once the repository is closed or opened again.
    fn finish(&mut self, repo: &str, start: u64) -> bool {
        let current = self.starting.get(repo) == Some(&start);

        if current {
            self.starting.remove(repo);
        }

        current
    }

    fn stop(&mut self, repo: &str) {
        self.starting.remove(repo);
        self.live.remove(repo);
    }
}

pub struct WatcherState {
    pub watches: Mutex<Watches>,
    pub enabled: bool,
    pending_refs: Arc<Mutex<HashMap<String, RefRefresh>>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self {
            watches: Mutex::default(),
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
        let routed = route_changes(
            path,
            &root_forms(path),
            git.as_ref(),
            changed,
            &mut WorktreeIgnores::default(),
            app,
            &self.pending_refs,
        );

        if let Routed::Published(Some(task)) = routed {
            task.await
                .map_err(|error| TrunkError::new("spawn_error", error.to_string()))?;
        }

        Ok(())
    }
}

/// The event that tells the frontend a repository is open but unwatched.
pub const WATCH_UNAVAILABLE: &str = "watch-unavailable";

/// The `watch-unavailable` payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WatchUnavailable {
    pub repo: String,
}

/// Watch `path` from a thread of its own.
///
/// The caller never waits on the platform registering the watch, which on macOS
/// waits on fseventsd and can take tens of seconds. A `stop_watcher` after this call
/// cancels the start, so call it under the lock that registers the repository as open,
/// which `close_repo` holds while it stops the watch. Once recorded, the watch reports
/// the whole repository as changed, since nothing changed before it began is reported.
/// A watch that cannot register emits `watch-unavailable`.
///
/// # Errors
///
/// Returns the error from spawning the thread, after which nothing is watched.
///
/// # Panics
///
/// Panics when the watcher lock is poisoned.
pub fn watch_in_background<R: Runtime>(path: PathBuf, app: AppHandle<R>) -> std::io::Result<()> {
    watch_in_background_with_registration(path, app, watch_all).map(drop)
}

fn watch_in_background_with_registration<R, F>(
    path: PathBuf,
    app: AppHandle<R>,
    register: F,
) -> std::io::Result<Option<std::thread::JoinHandle<()>>>
where
    R: Runtime,
    F: FnOnce(&mut RecommendedWatcher, &[PathBuf]) -> notify::Result<()> + Send + 'static,
{
    let state = app.state::<WatcherState>();
    if !state.enabled {
        return Ok(None);
    }

    let repo = path.to_string_lossy().to_string();
    let start = state.watches.lock().unwrap().begin(repo.clone());
    let watching = app.clone();
    let started = std::thread::Builder::new()
        .name("trunk watch start".to_string())
        .spawn(move || finish_watch(&path, &watching, start, register));

    if started.is_err() {
        state.watches.lock().unwrap().finish(&repo, start);
    }
    started.map(Some)
}

/// Register the watch on `path` and record it, unless its start `start` was cancelled.
fn finish_watch<R, F>(path: &Path, app: &AppHandle<R>, start: u64, register: F)
where
    R: Runtime,
    F: FnOnce(&mut RecommendedWatcher, &[PathBuf]) -> notify::Result<()>,
{
    let state = app.state::<WatcherState>();
    let repo = path.to_string_lossy().to_string();
    let registered = watch_repository(path, app.clone(), &state, register);
    let mut watches = state.watches.lock().unwrap();
    if !watches.finish(&repo, start) {
        return;
    }

    match registered {
        Ok(repo_watcher) => {
            repo_watcher.catch_up();
            watches.live.insert(repo, repo_watcher);
        }
        Err(error) => {
            drop(watches);
            eprintln!("{repo} is not watched: {}", error.message);
            let _ = app.emit(WATCH_UNAVAILABLE, WatchUnavailable { repo });
        }
    }
}

/// A started watch on `path` and, where they lie outside it, its Git directories.
fn watch_repository<R, F>(
    path: &Path,
    app: AppHandle<R>,
    state: &WatcherState,
    register: F,
) -> Result<RepoWatcher, TrunkError>
where
    R: Runtime,
    F: FnOnce(&mut RecommendedWatcher, &[PathBuf]) -> notify::Result<()>,
{
    let watched = path.to_path_buf();
    let roots = root_forms(path);
    let (git, writers) = open_for_watching(path).unzip();
    let paths = watched_paths(path, git.as_ref());
    let pending = Arc::clone(&state.pending_refs);

    let mut repo_watcher = RepoWatcher::start(writers, move || {
        let mut ignores = WorktreeIgnores::default();
        move |changed| match route_changes(
            &watched,
            &roots,
            git.as_ref(),
            changed,
            &mut ignores,
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

    register(&mut repo_watcher.watcher, &paths).map_err(|error| {
        TrunkError::new(
            "watcher_unavailable",
            format!("Repository could not be watched: {error}"),
        )
    })?;
    Ok(repo_watcher)
}

/// `path` and, where they lie outside it, its Git directories.
fn watched_paths(path: &Path, git: Option<&GitDirectories>) -> Vec<PathBuf> {
    let mut paths = vec![path.to_path_buf()];

    if let Some(git) = git {
        let canonical_root = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        if !git.common.starts_with(&canonical_root) {
            paths.push(git.common.clone());
        }
        if !git.private.starts_with(&canonical_root) && !git.private.starts_with(&git.common) {
            paths.push(git.private.clone());
        }
    }

    paths
}

/// Watch every one of `paths` with one start of the platform's watch.
///
/// Each separate registration of notify's macOS watcher stops and restarts its stream,
/// and each of those waits on fseventsd.
fn watch_all(watcher: &mut RecommendedWatcher, paths: &[PathBuf]) -> notify::Result<()> {
    let mut batch = watcher.paths_mut();

    for path in paths {
        batch.add(path, RecursiveMode::Recursive)?;
    }

    batch.commit()
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

/// Stop watching `path`, or cancel its watch's start. A path with no watch is not an error.
///
/// # Panics
///
/// Panics when the watcher lock is poisoned.
pub fn stop_watcher(path: &str, state: &WatcherState) {
    state.watches.lock().unwrap().stop(path);
}

#[cfg(test)]
mod tests {
    use notify::event::{CreateKind, ModifyKind, RemoveKind};

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
                &mut WorktreeIgnores::default(),
                app.handle(),
                &Arc::default(),
            );
            assert!(matches!(routed, Routed::Nothing), "{path}");
        }
        assert!(events.lock().unwrap().is_empty());
    }

    mod worktree_ignores {
        use super::*;

        const ARTIFACT: &str = "artifacts/probe.txt";

        /// A repository ignoring `artifacts/`, holding one untracked file there.
        fn repository_with_an_ignored_artifact() -> tempfile::TempDir {
            let dir = tempfile::tempdir().unwrap();
            git2::Repository::init(dir.path()).unwrap();
            std::fs::write(dir.path().join(".gitignore"), "artifacts/\n").unwrap();
            std::fs::create_dir(dir.path().join("artifacts")).unwrap();
            std::fs::write(dir.path().join(ARTIFACT), "ignored output").unwrap();
            dir
        }

        fn ignored_now(ignores: &mut WorktreeIgnores, dir: &Path) -> bool {
            ignored_at(ignores, dir, ARTIFACT)
        }

        fn ignored_at(ignores: &mut WorktreeIgnores, dir: &Path, relative: &str) -> bool {
            ignores
                .current(dir)
                .is_some_and(|view| view.ignores(&dir.join(relative), &[dir.to_path_buf()]))
        }

        /// Ignore answers for `dir` that have already read it once, so a later answer
        /// comes from what the first one kept.
        fn watching(dir: &Path) -> WorktreeIgnores {
            let mut ignores = WorktreeIgnores::default();
            ignored_now(&mut ignores, dir);
            ignores
        }

        fn track_the_artifact(dir: &Path) {
            let repo = git2::Repository::open(dir).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new(ARTIFACT)).unwrap();
            index.write().unwrap();
        }

        fn set_config(dir: &Path, name: &str, value: &str) {
            let repo = git2::Repository::open(dir).unwrap();
            repo.config().unwrap().set_str(name, value).unwrap();
        }

        #[test]
        fn an_untracked_path_under_an_ignore_rule_is_ignored() {
            let dir = repository_with_an_ignored_artifact();

            assert!(ignored_now(&mut WorktreeIgnores::default(), dir.path()));
        }

        #[test]
        fn a_path_stops_being_ignored_once_the_index_tracks_it() {
            let dir = repository_with_an_ignored_artifact();
            let mut ignores = watching(dir.path());

            track_the_artifact(dir.path());

            assert!(!ignored_now(&mut ignores, dir.path()));
        }

        #[test]
        fn a_tracked_path_is_ignored_again_once_the_index_file_is_gone() {
            let dir = repository_with_an_ignored_artifact();
            track_the_artifact(dir.path());
            let mut ignores = watching(dir.path());
            assert!(!ignored_now(&mut ignores, dir.path()));

            std::fs::remove_file(dir.path().join(".git/index")).unwrap();

            assert!(ignored_now(&mut ignores, dir.path()));
        }

        #[test]
        fn a_path_stops_being_ignored_once_its_rule_is_removed() {
            let dir = repository_with_an_ignored_artifact();
            let mut ignores = watching(dir.path());

            std::fs::write(dir.path().join(".gitignore"), "other/\n").unwrap();

            assert!(!ignored_now(&mut ignores, dir.path()));
        }

        #[test]
        fn a_path_stops_being_ignored_once_the_excludes_file_setting_names_another_file() {
            let dir = repository_with_an_ignored_artifact();
            let excludes = tempfile::tempdir().unwrap();
            std::fs::write(excludes.path().join("ignoring"), "notes/\n").unwrap();
            std::fs::write(excludes.path().join("empty"), "").unwrap();
            let setting = |file: &str| excludes.path().join(file).to_string_lossy().into_owned();
            set_config(dir.path(), "core.excludesFile", &setting("ignoring"));
            let mut ignores = watching(dir.path());
            assert!(ignored_at(&mut ignores, dir.path(), "notes/scratch.txt"));

            set_config(dir.path(), "core.excludesFile", &setting("empty"));

            assert!(!ignored_at(&mut ignores, dir.path(), "notes/scratch.txt"));
        }

        #[test]
        fn a_path_differing_from_a_tracked_one_only_in_case_is_tracked_once_case_is_ignored() {
            let dir = repository_with_an_ignored_artifact();
            set_config(dir.path(), "core.ignoreCase", "false");
            track_the_artifact(dir.path());
            let mut ignores = watching(dir.path());
            assert!(ignored_at(&mut ignores, dir.path(), "artifacts/PROBE.txt"));

            set_config(dir.path(), "core.ignoreCase", "true");

            assert!(!ignored_at(&mut ignores, dir.path(), "artifacts/PROBE.txt"));
        }

        #[test]
        fn no_path_is_ignored_while_the_index_will_not_read() {
            let dir = repository_with_an_ignored_artifact();
            track_the_artifact(dir.path());
            let mut ignores = watching(dir.path());

            std::fs::write(
                dir.path().join(".git/index"),
                "an index file longer than its checksum that no parser accepts",
            )
            .unwrap();

            assert!(!ignored_at(
                &mut ignores,
                dir.path(),
                "artifacts/untracked.txt"
            ));
        }
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

    mod starting {
        use super::*;
        use std::sync::atomic::{AtomicBool, Ordering};

        /// How long a held registration waits for its release. It bounds a stalled
        /// test and never decides a pass.
        const STALL: Duration = Duration::from_secs(10);

        trait Registration:
            FnOnce(&mut RecommendedWatcher, &[PathBuf]) -> notify::Result<()> + Send + 'static
        {
        }

        impl<F> Registration for F where
            F: FnOnce(&mut RecommendedWatcher, &[PathBuf]) -> notify::Result<()> + Send + 'static
        {
        }

        fn app_with(state: WatcherState) -> tauri::App<tauri::test::MockRuntime> {
            let app = tauri::test::mock_app();
            app.manage(state);
            app
        }

        fn recorded(app: &tauri::App<tauri::test::MockRuntime>) -> Vec<String> {
            let mut repos: Vec<String> = app
                .state::<WatcherState>()
                .watches
                .lock()
                .unwrap()
                .live
                .keys()
                .cloned()
                .collect();

            repos.sort();
            repos
        }

        fn unwatched_reports(
            app: &tauri::App<tauri::test::MockRuntime>,
        ) -> Arc<Mutex<Vec<WatchUnavailable>>> {
            let reports = Arc::new(Mutex::new(Vec::new()));
            let reported = Arc::clone(&reports);
            tauri::Listener::listen(app.handle(), WATCH_UNAVAILABLE, move |event| {
                reported
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(event.payload()).unwrap());
            });

            reports
        }

        fn start(
            app: &tauri::App<tauri::test::MockRuntime>,
            repo: &str,
            register: impl Registration,
        ) -> Option<std::thread::JoinHandle<()>> {
            watch_in_background_with_registration(
                PathBuf::from(repo),
                app.handle().clone(),
                register,
            )
            .unwrap()
        }

        fn started(
            app: &tauri::App<tauri::test::MockRuntime>,
            repo: &str,
            register: impl Registration,
        ) {
            start(app, repo, register).unwrap().join().unwrap();
        }

        /// A registration that returns `result` once the returned sender is sent to.
        fn held(result: notify::Result<()>) -> (Sender<()>, impl Registration) {
            let (release, released) = mpsc::channel::<()>();

            (release, move |_: &mut RecommendedWatcher, _: &[PathBuf]| {
                let _ = released.recv_timeout(STALL);
                result
            })
        }

        fn failing(_: &mut RecommendedWatcher, _: &[PathBuf]) -> notify::Result<()> {
            Err(notify::Error::generic("registration failed"))
        }

        fn registering() -> impl Registration {
            |_: &mut RecommendedWatcher, _: &[PathBuf]| Ok(())
        }

        #[test]
        fn an_enabled_start_records_the_path() {
            let app = app_with(WatcherState::default());

            started(&app, "repo", registering());

            assert_eq!(recorded(&app), ["repo"]);
        }

        #[test]
        fn stopping_one_path_leaves_the_other_registered() {
            let app = app_with(WatcherState::default());
            started(&app, "repo-one", registering());
            started(&app, "repo-two", registering());

            stop_watcher("repo-one", &app.state::<WatcherState>());

            assert_eq!(recorded(&app), ["repo-two"]);
        }

        #[test]
        fn the_start_returns_before_the_registration_does() {
            let app = app_with(WatcherState::default());
            let (release, registration) = held(Ok(()));

            let watching = start(&app, "repo", registration).unwrap();
            let while_registering = recorded(&app);
            release.send(()).unwrap();
            watching.join().unwrap();

            assert_eq!(while_registering, Vec::<String>::new());
            assert_eq!(recorded(&app), ["repo"]);
        }

        #[test]
        fn a_linked_worktree_registers_its_shared_git_directory_with_it_in_one_registration() {
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
            let app = app_with(WatcherState::default());
            let registrations = Arc::new(Mutex::new(Vec::new()));
            let registered = Arc::clone(&registrations);

            started(&app, &linked.to_string_lossy(), move |_, paths| {
                registered.lock().unwrap().push(paths.to_vec());
                Ok(())
            });

            assert_eq!(
                *registrations.lock().unwrap(),
                [vec![
                    linked,
                    directory
                        .path()
                        .join("primary/.git")
                        .canonicalize()
                        .unwrap()
                ]]
            );
        }

        #[test]
        fn a_disabled_state_skips_registration_and_records_nothing() {
            let app = app_with(WatcherState::disabled());
            let registration_called = Arc::new(AtomicBool::new(false));
            let called = Arc::clone(&registration_called);

            let watching = start(&app, "repo", move |_, _| {
                called.store(true, Ordering::SeqCst);
                Ok(())
            });

            assert!(watching.is_none());
            assert!(!registration_called.load(Ordering::SeqCst));
            assert_eq!(recorded(&app), Vec::<String>::new());
        }

        #[test]
        fn a_failed_registration_reports_the_repository_as_unwatched() {
            let app = app_with(WatcherState::default());
            let reports = unwatched_reports(&app);

            started(&app, "repo", failing);

            assert_eq!(
                *reports.lock().unwrap(),
                [WatchUnavailable {
                    repo: "repo".to_owned()
                }]
            );
            assert_eq!(recorded(&app), Vec::<String>::new());
        }

        mod when_the_repository_closes_during_the_start {
            use super::*;

            #[test]
            fn the_repository_is_never_watched() {
                let app = app_with(WatcherState::default());
                let (release, registration) = held(Ok(()));
                let watching = start(&app, "repo", registration).unwrap();

                stop_watcher("repo", &app.state::<WatcherState>());
                release.send(()).unwrap();
                watching.join().unwrap();

                assert_eq!(recorded(&app), Vec::<String>::new());
            }

            #[test]
            fn a_failed_registration_reports_nothing() {
                let app = app_with(WatcherState::default());
                let reports = unwatched_reports(&app);
                let (release, registration) =
                    held(Err(notify::Error::generic("registration failed")));
                let watching = start(&app, "repo", registration).unwrap();

                stop_watcher("repo", &app.state::<WatcherState>());
                release.send(()).unwrap();
                watching.join().unwrap();

                assert_eq!(*reports.lock().unwrap(), Vec::<WatchUnavailable>::new());
            }
        }

        mod when_the_repository_opens_again_during_the_start {
            use super::*;

            #[test]
            fn the_earlier_start_neither_reports_nor_disturbs_the_later_watch() {
                let app = app_with(WatcherState::default());
                let reports = unwatched_reports(&app);
                let (release, registration) =
                    held(Err(notify::Error::generic("registration failed")));
                let earlier = start(&app, "repo", registration).unwrap();
                started(&app, "repo", registering());

                release.send(()).unwrap();
                earlier.join().unwrap();

                assert_eq!(*reports.lock().unwrap(), Vec::<WatchUnavailable>::new());
                assert_eq!(recorded(&app), ["repo"]);
            }
        }
    }

    mod detached_drop {
        use super::*;
        use std::thread::ThreadId;

        struct RecordsItsDroppingThread(Sender<ThreadId>);

        impl Drop for RecordsItsDroppingThread {
            fn drop(&mut self) {
                self.0.send(std::thread::current().id()).unwrap();
            }
        }

        #[test]
        fn its_value_drops_on_a_thread_other_than_the_owners() {
            let (dropping_thread, dropped_on) = mpsc::channel();

            drop(DetachedDrop::new(RecordsItsDroppingThread(dropping_thread)));

            assert_ne!(dropped_on.recv().unwrap(), std::thread::current().id());
        }
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

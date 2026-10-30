use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use trunk_git::error::TrunkError;
use trunk_git::graph_input::{GraphSnapshot, GraphSource, RefVisibility};

/// The repositories the app currently has open, keyed by the path the frontend
/// addresses them with.
///
/// Commands take a clone of this rather than holding the lock across their work,
/// so it is a snapshot: a repository closed after the clone still resolves here.
/// The window is the command's own duration, and the repository it names is the
/// one the user was looking at when they acted.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenRepos(HashMap<String, PathBuf>);

impl OpenRepos {
    /// Where `path` lives on disk, or `not_open` when the app has no such
    /// repository open.
    ///
    /// # Errors
    ///
    /// Returns `not_open` when `path` names no open repository.
    pub fn path_for(&self, path: &str) -> Result<&Path, TrunkError> {
        self.location_of(path).ok_or_else(|| {
            // The message reaches the user as a toast, so it names the
            // repository rather than spelling out where it lives on disk.
            let name = Path::new(path)
                .file_name()
                .map_or(path, |n| n.to_str().unwrap_or(path));

            TrunkError::new("not_open", format!("Repository not open: {name}"))
        })
    }

    /// Open the git repository registered for `path`.
    ///
    /// # Errors
    ///
    /// Returns `not_open` when `path` names no open repository, and the
    /// underlying git error when the repository will not open.
    pub fn open(&self, path: &str) -> Result<git2::Repository, TrunkError> {
        git2::Repository::open(self.path_for(path)?).map_err(TrunkError::from)
    }

    /// Where `path` lives on disk, or `None` when no such repository is open.
    ///
    /// For callers that treat a closed repository as nothing to do rather than
    /// as an error, such as the background fetch.
    #[must_use]
    pub fn location_of(&self, path: &str) -> Option<&Path> {
        self.0.get(path).map(PathBuf::as_path)
    }

    /// Whether the frontend's `path` names a repository this app has open.
    #[must_use]
    pub fn is_open(&self, path: &str) -> bool {
        self.0.contains_key(path)
    }

    /// Record `location` as the repository the frontend addresses as `path`.
    pub fn register(&mut self, path: String, location: PathBuf) {
        self.0.insert(path, location);
    }

    /// Drop the repository the frontend addresses as `path`.
    pub fn forget(&mut self, path: &str) {
        self.0.remove(path);
    }

    pub fn locations(&self) -> impl Iterator<Item = (&str, &Path)> {
        self.0
            .iter()
            .map(|(path, location)| (path.as_str(), location.as_path()))
    }
}

impl FromIterator<(String, PathBuf)> for OpenRepos {
    fn from_iter<T: IntoIterator<Item = (String, PathBuf)>>(entries: T) -> Self {
        Self(entries.into_iter().collect())
    }
}

// CRITICAL: Store PathBuf ONLY — git2::Repository is not Sync.
// Each Tauri command opens a fresh Repository::open(path) inside spawn_blocking.
// Storing Repository handles here would cause cargo build to fail with "not Sync".
pub struct RepoState(pub Mutex<OpenRepos>);

impl RepoState {
    /// A snapshot of the open repositories, taken without holding the lock past
    /// the clone.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned, matching every other reader of it.
    #[must_use]
    pub fn snapshot(&self) -> OpenRepos {
        self.0.lock().unwrap().clone()
    }

    /// Record `location` as the repository the frontend addresses as `path`.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned, matching every other writer of it.
    pub fn register(&self, path: String, location: PathBuf) {
        self.0.lock().unwrap().register(path, location);
    }

    /// Drop the repository the frontend addresses as `path`.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned, matching every other writer of it.
    pub fn forget(&self, path: &str) {
        self.0.lock().unwrap().forget(path);
    }
}

pub use crate::remote_ops::RemoteOps;

/// Remote reservations span execution and graph publication, exclude aliases and
/// linked worktrees sharing a common Git directory, and own cancellation.
pub struct RunningOp(pub Mutex<RemoteOps>);

/// The cached graph for each open repository, keyed by the frontend's path.
///
/// A rebuild writes a whole entry rather than mutating one, so a reader either
/// sees the graph as it was or the graph as it now is, never a half-updated one.
#[derive(Clone, Debug, Default)]
pub struct GraphCache {
    graphs: HashMap<String, GraphSnapshot>,
    sessions: HashMap<String, u64>,
    generations: HashMap<String, u64>,
    revisions: HashMap<String, u64>,
    inputs: HashMap<String, crate::ref_state::RefState>,
    input_epochs: HashMap<String, u64>,
    closed: HashSet<String>,
    sequence: u64,
}

#[derive(Clone, Copy)]
pub struct GraphTicket {
    session: u64,
    generation: u64,
    input_epoch: u64,
}

pub struct ReconciledGraph {
    pub revision: u64,
    pub worktree_context_changed: bool,
}

/// A capture and the inexpensive input state it was checked against.
#[derive(Debug)]
pub struct GraphRead {
    pub source: GraphSource,
    inputs: Option<crate::ref_state::RefState>,
    changed: bool,
}

impl GraphRead {
    fn checked(
        source: GraphSource,
        before: crate::ref_state::RefState,
        after: crate::ref_state::RefState,
    ) -> Self {
        let changed = before != after;
        Self {
            source,
            inputs: (!changed).then_some(after),
            changed,
        }
    }
}

#[cfg(any(test, feature = "test-util"))]
impl From<GraphSource> for GraphRead {
    fn from(source: GraphSource) -> Self {
        Self {
            source,
            inputs: None,
            changed: false,
        }
    }
}

impl std::ops::Deref for GraphRead {
    type Target = GraphSource;

    fn deref(&self) -> &Self::Target {
        &self.source
    }
}

/// Capture after a command's mutation, retrying concurrent input changes.
///
/// # Errors
///
/// Returns repository read errors. A repeatedly superseded capture is returned as
/// changed so publication can preserve the command's outcome without caching it.
pub fn read_graph(repo: &mut git2::Repository) -> Result<GraphRead, TrunkError> {
    read_graph_with_capture(repo, trunk_git::graph::capture)
}

fn read_graph_with_capture(
    repo: &mut git2::Repository,
    mut capture: impl FnMut(&mut git2::Repository) -> Result<GraphSource, TrunkError>,
) -> Result<GraphRead, TrunkError> {
    const CAPTURE_ATTEMPTS: usize = 3;
    let mut remaining = CAPTURE_ATTEMPTS;
    loop {
        let before = crate::ref_state::RefState::read(repo)?;
        let source = capture(repo)?;
        let after = crate::ref_state::RefState::read(repo)?;
        let read = GraphRead::checked(source, before, after);
        remaining -= 1;
        if !read.changed || remaining == 0 {
            return Ok(read);
        }
    }
}

impl GraphCache {
    /// The cached graph for `path`, or `None` when nothing has been built yet.
    #[must_use]
    pub fn get(&self, path: &str) -> Option<&trunk_git::graph_input::GraphSnapshot> {
        self.graphs.get(path)
    }

    /// Store `snapshot` as the graph for `path`, replacing any earlier one.
    fn insert(&mut self, path: String, snapshot: trunk_git::graph_input::GraphSnapshot) {
        self.sequence += 1;
        self.sessions.entry(path.clone()).or_insert(self.sequence);
        self.generations.insert(path.clone(), self.sequence);
        self.revisions.insert(path.clone(), self.sequence);
        self.inputs.remove(&path);
        self.graphs.insert(path, snapshot);
    }

    /// Seed a fixture cache without passing through application publication.
    #[cfg(feature = "test-util")]
    pub fn seed(&mut self, path: String, snapshot: GraphSnapshot) {
        self.insert(path, snapshot);
    }

    /// Whether a graph has been cached for `path`.
    #[must_use]
    pub fn holds(&self, path: &str) -> bool {
        self.graphs.contains_key(path)
    }

    /// Drop the cached graph for `path`.
    fn forget(&mut self, path: &str) {
        self.graphs.remove(path);
        self.sessions.remove(path);
        self.generations.remove(path);
        self.revisions.remove(path);
        self.inputs.remove(path);
        self.input_epochs.remove(path);
        self.closed.insert(path.to_owned());
    }

    fn capture_session(&mut self, path: &str) -> Result<u64, TrunkError> {
        if self.closed.contains(path) {
            return Err(TrunkError::new("not_open", "Repository closed"));
        }
        if let Some(session) = self.sessions.get(path) {
            return Ok(*session);
        }
        self.sequence += 1;
        self.sessions.insert(path.to_owned(), self.sequence);
        Ok(self.sequence)
    }

    fn begin(&mut self, path: &str) -> Result<GraphTicket, TrunkError> {
        if self.closed.contains(path) {
            return Err(TrunkError::new("not_open", "Repository closed"));
        }
        self.sequence += 1;
        let session = *self
            .sessions
            .entry(path.to_owned())
            .or_insert(self.sequence);
        self.generations.insert(path.to_owned(), self.sequence);
        Ok(GraphTicket {
            session,
            generation: self.sequence,
            input_epoch: self.input_epochs.get(path).copied().unwrap_or_default(),
        })
    }

    fn publish(
        &mut self,
        path: String,
        ticket: GraphTicket,
        snapshot: GraphSnapshot,
        inputs: Option<crate::ref_state::RefState>,
    ) -> Result<GraphSnapshot, TrunkError> {
        if self.sessions.get(&path) != Some(&ticket.session) {
            return Err(TrunkError::new("not_open", "Repository session closed"));
        }
        if self.generations.get(&path) != Some(&ticket.generation) {
            return self.get(&path).cloned().ok_or_else(|| {
                TrunkError::new("graph_changed", "A newer graph read superseded this result")
            });
        }
        let input_epoch = self.input_epochs.get(&path).copied().unwrap_or_default();
        self.insert(path.clone(), snapshot.clone());
        if let Some(inputs) = inputs.filter(|_| input_epoch == ticket.input_epoch) {
            self.inputs.insert(path, inputs);
        }
        Ok(snapshot)
    }

    /// Add a coherent capture to a command's local publication delta. Concurrently
    /// superseded captures leave the prior shared graph for the next refresh.
    pub(crate) fn insert_read(&mut self, path: String, read: GraphRead, visibility: RefVisibility) {
        if read.changed {
            return;
        }
        self.insert(path.clone(), GraphSnapshot::new(read.source, visibility));
        if let Some(inputs) = read.inputs {
            self.inputs.insert(path, inputs);
        }
    }

    fn retain_current(
        &mut self,
        path: &str,
        ticket: GraphTicket,
    ) -> Result<GraphSnapshot, TrunkError> {
        if self.sessions.get(path) != Some(&ticket.session) {
            return Err(TrunkError::new("not_open", "Repository session closed"));
        }
        self.inputs.remove(path);
        self.get(path).cloned().ok_or_else(|| {
            TrunkError::new(
                "graph_changed",
                "Repository changed while reading its first graph",
            )
        })
    }
}

// Caches the full commit graph per open repo path.
// Populated on open_repo, cleared on close_repo, sliced by get_commit_graph.
pub struct CommitCache(
    Mutex<GraphCache>,
    Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
);

pub(crate) struct CachedGraphRead<T> {
    pub value: T,
    pub revision: u64,
    pub session: u64,
}

impl CommitCache {
    #[must_use]
    pub fn new(cache: GraphCache) -> Self {
        Self(Mutex::new(cache), Mutex::new(HashMap::new()))
    }

    /// Start a new opening session, fencing any earlier close/reopen completion.
    ///
    /// # Panics
    ///
    /// Panics when the cache lock is poisoned.
    pub fn open_session(&self, path: &str) {
        let mut cache = self.0.lock().unwrap();
        cache.forget(path);
        cache.closed.remove(path);
        let _ = cache.begin(path);
    }

    /// Serialize capture and visibility publication for one worktree.
    ///
    /// # Panics
    ///
    /// Panics when the gate lock is poisoned.
    async fn lock_rebuild(&self, path: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let gate = self
            .1
            .lock()
            .unwrap()
            .entry(path.to_owned())
            .or_default()
            .clone();
        gate.lock_owned().await
    }

    /// Capture the opening session before queueing work, including a first graph read.
    ///
    /// # Errors
    ///
    /// Returns `not_open` when the repository closed.
    ///
    /// # Panics
    ///
    /// Panics when the cache lock is poisoned.
    pub(crate) fn capture_session(&self, path: &str) -> Result<u64, TrunkError> {
        self.0.lock().unwrap().capture_session(path)
    }

    /// Reserve publication after the prior capture finishes, within the session
    /// that queued this work. Waiting work cannot enter a reopened repository.
    ///
    /// # Errors
    ///
    /// Returns `not_open` when the captured opening session closed.
    ///
    /// # Panics
    ///
    /// Panics when a cache or gate lock is poisoned.
    pub(crate) async fn begin_rebuild(
        &self,
        path: &str,
        session: u64,
    ) -> Result<(tokio::sync::OwnedMutexGuard<()>, GraphTicket), TrunkError> {
        let gate = self.lock_rebuild(path).await;
        let ticket = {
            let mut cache = self.0.lock().unwrap();
            if cache.sessions.get(path) != Some(&session) {
                return Err(TrunkError::new("not_open", "Repository session closed"));
            }
            cache.begin(path)?
        };
        Ok((gate, ticket))
    }

    /// Mark a local watcher input change before notifying frontend readers.
    ///
    /// # Panics
    ///
    /// Panics when the cache lock is poisoned.
    pub fn invalidate(&self, path: &str) {
        let mut cache = self.0.lock().unwrap();
        if cache.sessions.contains_key(path) {
            cache.sequence += 1;
            let epoch = cache.sequence;
            cache.input_epochs.insert(path.to_owned(), epoch);
            cache.inputs.remove(path);
        }
    }

    /// Reserve a publication directly for tests that exercise publication fencing.
    ///
    /// # Errors
    ///
    /// Returns `not_open` when the session closed.
    ///
    /// # Panics
    ///
    /// Panics when the cache lock is poisoned.
    #[cfg(feature = "test-util")]
    pub fn begin_write(&self, path: &str) -> Result<GraphTicket, TrunkError> {
        self.0.lock().unwrap().begin(path)
    }

    /// # Panics
    ///
    /// Panics when the cache lock is poisoned.
    #[must_use]
    pub fn session_id(&self, path: &str) -> Option<u64> {
        self.0.lock().unwrap().sessions.get(path).copied()
    }

    /// Read one consistent graph revision, rejecting stale page/stat requests.
    ///
    /// # Errors
    ///
    /// Returns `not_open` for an absent graph and `graph_changed` for a stale revision.
    ///
    /// # Panics
    ///
    /// Panics when the cache lock is poisoned.
    pub(crate) fn read_versioned<T>(
        &self,
        path: &str,
        expected: Option<u64>,
        render: impl FnOnce(&GraphSnapshot, u64) -> T,
    ) -> Result<T, TrunkError> {
        self.read_versioned_with_session(path, expected, render)
            .map(|read| read.value)
    }

    /// Read a graph revision and its opening session atomically.
    ///
    /// # Errors
    ///
    /// Returns `not_open` for an absent graph and `graph_changed` for a stale revision.
    ///
    /// # Panics
    ///
    /// Panics when the cache lock is poisoned.
    pub(crate) fn read_versioned_with_session<T>(
        &self,
        path: &str,
        expected: Option<u64>,
        render: impl FnOnce(&GraphSnapshot, u64) -> T,
    ) -> Result<CachedGraphRead<T>, TrunkError> {
        let cache = self.0.lock().unwrap();
        let graph = cache
            .get(path)
            .ok_or_else(|| TrunkError::new("not_open", "Repository not open"))?;
        let revision = cache.revisions[path];
        if expected.is_some_and(|expected| expected != revision) {
            return Err(TrunkError::new(
                "graph_changed",
                "The graph revision changed",
            ));
        }
        let result = render(graph, revision);
        let session = cache.sessions[path];
        drop(cache);
        Ok(CachedGraphRead {
            value: result,
            revision,
            session,
        })
    }

    /// Reject a response whose graph revision changed while its data was computed.
    pub(crate) fn require_revision(&self, path: &str, revision: u64) -> Result<(), TrunkError> {
        self.read_versioned(path, Some(revision), |_, _| ())
    }

    /// Keep immutable per-commit statistics across graph revisions, while fencing
    /// work completed after its repository's opening session closed.
    ///
    /// The cache lock remains held through insertion, in the same Cache→Stats
    /// order used by versioned readers, so close cannot race the session check.
    ///
    /// # Errors
    ///
    /// Returns `not_open` when the captured opening session closed.
    ///
    /// # Panics
    ///
    /// Panics when a cache lock is poisoned.
    pub(crate) fn store_stats_in_session(
        &self,
        path: &str,
        session: u64,
        commit_stats: &CommitStatsCache,
        stats: impl IntoIterator<Item = (String, crate::types::DiffStat)>,
    ) -> Result<(), TrunkError> {
        let cache = self.0.lock().unwrap();
        if cache.sessions.get(path) != Some(&session) {
            return Err(TrunkError::new("not_open", "Repository session closed"));
        }
        commit_stats
            .0
            .lock()
            .unwrap()
            .extend(path.to_owned(), stats);
        drop(cache);
        Ok(())
    }

    /// The cached graph for `path`, or `None` when nothing has been built yet.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned.
    #[must_use]
    pub fn snapshot(&self, path: &str) -> Option<GraphSnapshot> {
        self.0.lock().unwrap().get(path).cloned()
    }

    /// The page of `path`'s cached graph `render` names, or `None` when nothing has been
    /// built for `path` yet. Takes a closure rather than returning the snapshot so a caller
    /// that only needs one page never clones the whole layout.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned.
    pub fn read<T>(&self, path: &str, render: impl FnOnce(&GraphSnapshot) -> T) -> Option<T> {
        self.0.lock().unwrap().get(path).map(render)
    }

    /// Whether a graph has been cached for `path`.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned.
    #[must_use]
    pub fn holds(&self, path: &str) -> bool {
        self.0.lock().unwrap().holds(path)
    }

    /// Drop the cached graph for `path`.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned.
    pub fn forget(&self, path: &str) {
        self.0.lock().unwrap().forget(path);
    }
}

/// The diff stat computed for each commit, per repository.
///
/// A commit's diff never changes, so an entry is never invalidated, only
/// dropped wholesale when its repository closes. Filled lazily by the Diff
/// column and only while that column is visible.
#[derive(Debug, Default)]
pub struct StatsCache(HashMap<String, HashMap<String, crate::types::DiffStat>>);

impl StatsCache {
    /// The stat held for `oid` in `path`, if one has been computed.
    #[must_use]
    pub fn get(&self, path: &str, oid: &str) -> Option<&crate::types::DiffStat> {
        self.0.get(path)?.get(oid)
    }

    /// Store every stat in `stats` against `path`, keeping what is already there.
    pub fn extend(
        &mut self,
        path: String,
        stats: impl IntoIterator<Item = (String, crate::types::DiffStat)>,
    ) {
        self.0.entry(path).or_default().extend(stats);
    }

    /// Drop every stat held for `path`.
    pub fn forget(&mut self, path: &str) {
        self.0.remove(path);
    }
}

// Lazy per-commit diff-stats for the graph's Diff column.
pub struct CommitStatsCache(pub Mutex<StatsCache>);

/// Whether the application repositions the macOS traffic-light buttons.
///
/// The application test harness manages a disabled one. `WebviewWindow::ns_window()`
/// on `tauri::test::MockRuntime` builds its answer from a dangling `NSView*`, so
/// asking for the native window there segfaults the process — and the frontend asks
/// for the zoom on its very first render. Off, the command still runs; only the
/// `AppKit` call is skipped.
pub struct TrafficLights {
    pub enabled: bool,
}

impl Default for TrafficLights {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl TrafficLights {
    #[must_use]
    pub const fn disabled() -> Self {
        Self { enabled: false }
    }
}

/// The persistent review store, opened once on first use.
///
/// Opening is fallible — a store newer than this build is refused, an unreadable
/// one is quarantined — and there is no window to report into during `setup()`,
/// so the open is deferred to the first command that needs it.
pub struct ReviewStoreState(pub StoreSlot);

/// The store handle, shared so the open can run on the blocking pool rather than
/// the async runtime.
#[derive(Default)]
pub struct StoreSlot(std::sync::Arc<Mutex<Option<std::sync::Arc<trunk_review::reviewdb::Store>>>>);

impl StoreSlot {
    #[must_use]
    pub fn clone_handle(
        &self,
    ) -> std::sync::Arc<Mutex<Option<std::sync::Arc<trunk_review::reviewdb::Store>>>> {
        std::sync::Arc::clone(&self.0)
    }
}

/// The repos whose snapshot pins have been swept in this process.
///
/// The sweep belongs at app start, but the review store is opened lazily and
/// per repo, so "start" here means the first review command to touch a repo.
/// Once per process is the whole point: sweeping on every command would put
/// ref I/O on the comment gesture's path, which is what TRUNK-61 removed.
#[derive(Default)]
pub struct SweptRepos(Arc<Mutex<HashSet<PathBuf>>>);

impl SweptRepos {
    /// A handle the blocking pool can own, mirroring `StoreSlot`.
    #[must_use]
    pub fn clone_handle(&self) -> Self {
        Self(Arc::clone(&self.0))
    }

    /// True the first time it is asked about a repo, false forever after.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned.
    #[must_use]
    pub fn claim(&self, canonical: &Path) -> bool {
        self.0.lock().unwrap().insert(canonical.to_path_buf())
    }
}

/// The refs each open repository has hidden from its graph.
///
/// Keyed by the repo path the frontend uses, mirroring `CommitCache`. The frontend loads the
/// stored value from prefs when it opens a repository and pushes it here; every rebuild site
/// then reads it, so a graph rebuilt after a commit, a checkout or a stash keeps the same
/// refs hidden as the one on screen.
///
/// A repository absent from the map has hidden nothing, which is what an unopened one and
/// one with no stored preference both get.
#[derive(Default)]
pub struct RefVisibilityState(Arc<Mutex<HashMap<String, trunk_git::graph_input::RefVisibility>>>);

impl RefVisibilityState {
    /// The refs `path` has hidden. A repository with none gets the empty set.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned.
    #[must_use]
    pub fn get(&self, path: &str) -> trunk_git::graph_input::RefVisibility {
        self.0
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .unwrap_or_default()
    }

    /// Record the refs `path` has hidden, replacing any earlier set.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned.
    pub fn set(&self, path: String, visibility: trunk_git::graph_input::RefVisibility) {
        self.0.lock().unwrap().insert(path, visibility);
    }

    /// Drop what `path` had hidden.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned.
    pub fn forget(&self, path: &str) {
        self.0.lock().unwrap().remove(path);
    }
}

/// The owner of the read-visibility / walk-repository / write-cache triple every graph
/// rebuild performs.
///
/// `CommitCache` and `RefVisibilityState` stay independently managed and independently
/// reachable — `close_repo` forgets each on its own, and `set_ref_visibility` re-lays out
/// an existing capture rather than rebuilding — this struct only bundles the handles a
/// rebuild site needs so the triple has one call instead of three statements.
///
/// Production closures return a checked `GraphRead` containing a `GraphSource` — the capture, not a laid-out snapshot — so
/// it has no way to hand back a `GraphSnapshot` built under a visibility of its own choosing.
/// `rebuild` itself is the only place that turns a capture into a `GraphSnapshot`, always
/// under the value it looked up: the compiler, not a convention, is what stops a new site
/// from silently dropping or substituting the visibility (TRUNK-125, tightened after a
/// review-code probe found the prior `FnOnce(&RefVisibility) -> GraphSnapshot` shape let a
/// closure receive the visibility and build the snapshot from a different one anyway).
pub struct GraphRebuild<'a> {
    cache: &'a CommitCache,
    ref_visibility: &'a RefVisibilityState,
}

impl<'a> GraphRebuild<'a> {
    #[must_use]
    pub const fn new(cache: &'a CommitCache, ref_visibility: &'a RefVisibilityState) -> Self {
        Self {
            cache,
            ref_visibility,
        }
    }

    /// Look up the visibility set for `path`, run `walk` off the calling task to capture the
    /// repository, lay the capture out under the visibility just looked up, and write the
    /// resulting snapshot into the cache under `path`.
    ///
    /// Production `walk` closures use `read_graph` to capture and stamp ref inputs.
    /// The closure cannot choose the published visibility: this owner reads its latest
    /// value and checks the opening session and publication generation before writing.
    ///
    /// # Errors
    ///
    /// Returns whatever `walk` returns, and `spawn_error` when the blocking task cannot be
    /// joined. The cache is left untouched on either error.
    ///
    /// # Panics
    ///
    /// Panics when the cache's lock is poisoned.
    pub async fn rebuild<F, S>(&self, path: String, walk: F) -> Result<GraphSnapshot, TrunkError>
    where
        F: FnOnce() -> Result<S, TrunkError> + Send + 'static,
        S: Into<GraphRead> + Send + 'static,
    {
        self.rebuild_carrying(path, || walk().map(|source| (source, ())))
            .await
            .map(|(snapshot, ())| snapshot)
    }

    /// Rebuild for the opening session that owned a completed remote command.
    ///
    /// # Errors
    ///
    /// Returns `not_open` if that session closed, or capture and publication errors.
    ///
    /// # Panics
    ///
    /// Panics when the cache lock is poisoned.
    pub async fn rebuild_in_session<F, S>(
        &self,
        path: String,
        session: u64,
        walk: F,
    ) -> Result<GraphSnapshot, TrunkError>
    where
        F: FnOnce() -> Result<S, TrunkError> + Send + 'static,
        S: Into<GraphRead> + Send + 'static,
    {
        let (_gate, ticket) = self.cache.begin_rebuild(&path, session).await?;
        self.rebuild_locked(path, ticket, || walk().map(|read| (read, ())))
            .await
            .map(|(snapshot, ())| snapshot)
    }

    /// Refresh an open graph only when this read can replace its cached capture.
    /// A changed repository or visibility can cause publication to retain the old
    /// capture; the caller must retry rather than acknowledge that refresh.
    ///
    /// # Errors
    ///
    /// Returns `graph_changed` when the old capture was retained, `not_open` when
    /// the session closed, or capture and publication errors.
    ///
    /// # Panics
    ///
    /// Panics when the cache lock is poisoned.
    pub async fn refresh_in_session<F, S>(
        &self,
        path: String,
        session: u64,
        walk: F,
    ) -> Result<GraphSnapshot, TrunkError>
    where
        F: FnOnce() -> Result<S, TrunkError> + Send + 'static,
        S: Into<GraphRead> + Send + 'static,
    {
        let (_gate, ticket) = self.cache.begin_rebuild(&path, session).await?;
        let previous = self.cache.snapshot(&path);

        let (snapshot, ()) = self
            .rebuild_locked(path, ticket, || walk().map(|read| (read, ())))
            .await?;

        if previous
            .as_ref()
            .is_some_and(|previous| snapshot.same_capture_as(previous))
        {
            return Err(TrunkError::new(
                "graph_changed",
                "Repository changed while refreshing its graph",
            ));
        }

        Ok(snapshot)
    }

    /// `rebuild`, for a `walk` that carries extra data alongside the snapshot back to the
    /// caller (an editor's opening message, say). `walk` returns the capture and the extra
    /// value as a pair; the capture is laid out under the looked-up visibility and only that
    /// snapshot half is written into the cache.
    ///
    /// # Errors
    ///
    /// Returns whatever `walk` returns, and `spawn_error` when the blocking task cannot be
    /// joined. The cache is left untouched on either error.
    ///
    /// # Panics
    ///
    /// Panics when the cache's lock is poisoned.
    pub async fn rebuild_carrying<F, S, T>(
        &self,
        path: String,
        walk: F,
    ) -> Result<(GraphSnapshot, T), TrunkError>
    where
        F: FnOnce() -> Result<(S, T), TrunkError> + Send + 'static,
        S: Into<GraphRead> + Send + 'static,
        T: Send + 'static,
    {
        let session = self.cache.capture_session(&path)?;
        let (_gate, ticket) = self.cache.begin_rebuild(&path, session).await?;
        self.rebuild_locked(path, ticket, walk).await
    }

    async fn rebuild_locked<F, S, T>(
        &self,
        path: String,
        ticket: GraphTicket,
        walk: F,
    ) -> Result<(GraphSnapshot, T), TrunkError>
    where
        F: FnOnce() -> Result<(S, T), TrunkError> + Send + 'static,
        S: Into<GraphRead> + Send + 'static,
        T: Send + 'static,
    {
        let (read, extra) = tauri::async_runtime::spawn_blocking(walk)
            .await
            .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;
        let read: GraphRead = read.into();
        if read.changed {
            return self
                .cache
                .0
                .lock()
                .unwrap()
                .retain_current(&path, ticket)
                .map(|snapshot| (snapshot, extra));
        }
        let inputs = read.inputs;
        let visibility = self.ref_visibility.get(&path);
        let snapshot = tauri::async_runtime::spawn_blocking(move || {
            GraphSnapshot::new(read.source, visibility)
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()))?;
        let snapshot = self.publish(path, ticket, snapshot, inputs).await?;
        Ok((snapshot, extra))
    }

    /// Publish a cached capture under the latest visibility, retaining its checked
    /// inputs and fencing a concurrent capture or a closed opening session.
    ///
    /// # Errors
    ///
    /// Returns session or layout errors.
    ///
    /// # Panics
    ///
    /// Panics when a state lock is poisoned.
    pub async fn publish_relayout(
        &self,
        path: String,
        read: &GraphSnapshot,
        snapshot: GraphSnapshot,
        ticket: GraphTicket,
    ) -> Result<GraphSnapshot, TrunkError> {
        let inputs = {
            let cache = self.cache.0.lock().unwrap();
            if cache.sessions.get(&path) != Some(&ticket.session) {
                return Err(TrunkError::new("not_open", "Repository session closed"));
            }
            let current = cache
                .get(&path)
                .ok_or_else(|| TrunkError::new("not_open", "Repository closed"))?;
            if !current.same_capture_as(read) {
                return Ok(current.clone());
            }
            cache.inputs.get(&path).cloned()
        };
        self.publish(path, ticket, snapshot, inputs).await
    }

    async fn publish(
        &self,
        path: String,
        ticket: GraphTicket,
        mut snapshot: GraphSnapshot,
        inputs: Option<crate::ref_state::RefState>,
    ) -> Result<GraphSnapshot, TrunkError> {
        for _ in 0..3 {
            let visibility = self.ref_visibility.get(&path);
            if snapshot.visibility() != &visibility {
                snapshot = tauri::async_runtime::spawn_blocking(move || {
                    snapshot.with_visibility(visibility)
                })
                .await
                .map_err(|e| TrunkError::new("spawn_error", e.to_string()))?;
            }
            // Visibility cannot change between this comparison and publication.
            let visibility = self.ref_visibility.0.lock().unwrap();
            if visibility.get(&path).cloned().unwrap_or_default() == *snapshot.visibility() {
                return self
                    .cache
                    .0
                    .lock()
                    .unwrap()
                    .publish(path, ticket, snapshot, inputs);
            }
        }
        self.cache.0.lock().unwrap().retain_current(&path, ticket)
    }

    /// Reconcile a ref notification against the last checked capture, without recapturing
    /// duplicates from fetch and the filesystem watcher.
    ///
    /// # Errors
    ///
    /// Returns repository, capture or publication errors.
    ///
    /// # Panics
    ///
    /// Panics when the cache lock is poisoned.
    pub async fn reconcile_refs(
        &self,
        path: String,
        location: PathBuf,
    ) -> Result<Option<ReconciledGraph>, TrunkError> {
        let session = self.cache.capture_session(&path)?;
        self.reconcile_refs_in_session(path, location, session)
            .await
    }

    /// Reconcile only the opening session that admitted a remote job.
    ///
    /// # Errors
    /// Returns capture errors or `not_open` when that session has closed.
    ///
    /// # Panics
    /// Panics when a shared state lock is poisoned.
    pub async fn reconcile_refs_in_session(
        &self,
        path: String,
        location: PathBuf,
        session: u64,
    ) -> Result<Option<ReconciledGraph>, TrunkError> {
        let _gate = self.cache.lock_rebuild(&path).await;
        let probe = location.clone();
        let inputs = tauri::async_runtime::spawn_blocking(move || {
            let repo = git2::Repository::open(probe)?;
            crate::ref_state::RefState::read(&repo)
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;
        let (ticket, worktree_context_changed) = {
            let mut cache = self.cache.0.lock().unwrap();
            if cache.sessions.get(&path) != Some(&session) {
                return Err(TrunkError::new("not_open", "Repository session closed"));
            }
            if cache.inputs.get(&path) == Some(&inputs) {
                return Ok(None);
            }
            let worktree_context_changed = cache
                .inputs
                .get(&path)
                .is_none_or(|previous| inputs.changes_worktree_context(previous));
            (cache.begin(&path)?, worktree_context_changed)
        };
        self.rebuild_locked(path.clone(), ticket, move || {
            let mut repo = git2::Repository::open(location)?;
            read_graph(&mut repo).map(|read| (read, ()))
        })
        .await?;
        let read = self
            .cache
            .read_versioned_with_session(&path, None, |_, revision| {
                Some(ReconciledGraph {
                    revision,
                    worktree_context_changed,
                })
            })?;
        if read.session != session {
            return Err(TrunkError::new("not_open", "Repository session closed"));
        }

        Ok(read.value)
    }

    /// Look up the visibility set for `path`, run `walk` under it off the calling task
    /// against a fresh `GraphCache`, and merge only the entries it produced into the shared
    /// cache. Merging rather than writing the whole map back is what keeps another repo's
    /// concurrently-refreshed entry from being rolled back by this operation's own snapshot
    /// of the cache, taken before it started.
    ///
    /// # Errors
    ///
    /// Returns whatever `walk` returns, and `spawn_error` when the blocking task cannot be
    /// joined. The cache is left untouched on either error.
    ///
    /// # Panics
    ///
    /// Panics when the cache's lock is poisoned.
    pub async fn rebuild_merging<F, T>(&self, path: String, walk: F) -> Result<T, TrunkError>
    where
        F: FnOnce(&RefVisibility, &mut GraphCache) -> Result<T, TrunkError> + Send + 'static,
        T: Send + 'static,
    {
        let session = self.cache.capture_session(&path)?;
        let (_gate, ticket) = self.cache.begin_rebuild(&path, session).await?;
        let visibility = self.ref_visibility.get(&path);

        let (value, mut rebuilt) = tauri::async_runtime::spawn_blocking(move || {
            let mut rebuilt = GraphCache::default();
            walk(&visibility, &mut rebuilt).map(|value| (value, rebuilt))
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;

        if let Some(snapshot) = rebuilt.graphs.remove(&path) {
            let inputs = rebuilt.inputs.remove(&path);
            self.publish(path, ticket, snapshot, inputs).await?;
        } else {
            self.cache.invalidate(&path);
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::{CommitCache, GraphCache, GraphRebuild, OpenRepos, RefVisibilityState};
    use std::collections::{HashMap, HashSet};
    use std::future::Future;
    use std::path::{Path, PathBuf};
    use std::pin::Pin;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use std::task::{Context, Poll, Waker};
    use trunk_git::error::TrunkError;
    use trunk_git::graph_input::{CommitFacts, GraphSnapshot, GraphSource, RefVisibility};
    use trunk_git::placement::PlacementInput;
    use trunk_git::types::{RefLabel, RefType};

    fn capture_repository() -> (tempfile::TempDir, git2::Repository) {
        let directory = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(directory.path()).unwrap();
        let config = git2::Config::open(&repo.path().join("config")).unwrap();
        repo.set_config(&config).unwrap();
        let tree_oid = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let signature = git2::Signature::new(
            "Fixture",
            "fixture@example.invalid",
            &git2::Time::new(1_000, 0),
        )
        .unwrap();
        repo.commit(
            Some("refs/heads/main"),
            &signature,
            &signature,
            "initial",
            &tree,
            &[],
        )
        .unwrap();
        drop(tree);
        repo.set_head("refs/heads/main").unwrap();

        (directory, repo)
    }

    #[test]
    fn a_capture_retries_until_refs_stop_changing() {
        let (_directory, mut repo) = capture_repository();
        let mut attempts = 0;

        let read = super::read_graph_with_capture(&mut repo, |repo| {
            attempts += 1;
            let source = trunk_git::graph::capture(repo)?;
            if attempts < 3 {
                repo.reference(
                    &format!("refs/heads/change-{attempts}"),
                    repo.head()?.target().unwrap(),
                    false,
                    "fixture",
                )?;
            }
            Ok(source)
        })
        .unwrap();

        assert_eq!(attempts, 3);
        assert!(!read.changed);
        assert!(read.inputs.is_some());
        assert!(
            read.refs
                .values()
                .flatten()
                .any(|label| label.name == "refs/heads/change-2")
        );
    }

    #[test]
    fn an_unstable_capture_retains_the_graph_after_a_completed_mutation() {
        let (_directory, mut repo) = capture_repository();
        let cache = CommitCache::new(GraphCache::default());
        let previous = graph(7);
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), previous.clone());
        let visibility = RefVisibilityState::default();
        let attempts = Arc::new(AtomicUsize::new(0));
        let observed_attempts = Arc::clone(&attempts);

        let outcome =
            tauri::async_runtime::block_on(GraphRebuild::new(&cache, &visibility).rebuild_merging(
                "/repo".to_owned(),
                move |visibility, delta| {
                    let read = super::read_graph_with_capture(&mut repo, |repo| {
                        let attempt = observed_attempts.fetch_add(1, Ordering::Relaxed) + 1;
                        let source = trunk_git::graph::capture(repo)?;
                        repo.reference(
                            &format!("refs/heads/change-{attempt}"),
                            repo.head()?.target().unwrap(),
                            false,
                            "fixture",
                        )?;
                        Ok(source)
                    })?;
                    delta.insert_read("/repo".to_owned(), read, visibility.clone());
                    Ok(())
                },
            ));

        assert!(outcome.is_ok());
        assert_eq!(attempts.load(Ordering::Relaxed), 3);
        assert!(cache.snapshot("/repo").unwrap().same_capture_as(&previous));
    }

    #[test]
    fn an_unstable_refresh_is_retryable_and_keeps_the_previous_capture() {
        let (_directory, mut repo) = capture_repository();
        let cache = CommitCache::new(GraphCache::default());
        let previous = graph(7);
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), previous.clone());
        let session = cache.capture_session("/repo").unwrap();
        let visibility = RefVisibilityState::default();
        let attempts = Arc::new(AtomicUsize::new(0));
        let observed_attempts = Arc::clone(&attempts);

        let error = tauri::async_runtime::block_on(
            GraphRebuild::new(&cache, &visibility).refresh_in_session(
                "/repo".to_owned(),
                session,
                move || {
                    super::read_graph_with_capture(&mut repo, |repo| {
                        let attempt = observed_attempts.fetch_add(1, Ordering::Relaxed) + 1;
                        let source = trunk_git::graph::capture(repo)?;
                        repo.reference(
                            &format!("refs/heads/change-{attempt}"),
                            repo.head()?.target().unwrap(),
                            false,
                            "fixture",
                        )?;
                        Ok(source)
                    })
                },
            ),
        )
        .unwrap_err();

        assert_eq!(error.code, "graph_changed");
        assert_eq!(attempts.load(Ordering::Relaxed), 3);
        assert!(cache.snapshot("/repo").unwrap().same_capture_as(&previous));
    }

    #[test]
    fn a_coherent_refresh_publishes_a_new_capture() {
        let (_directory, mut repo) = capture_repository();
        let cache = CommitCache::new(GraphCache::default());
        let previous = graph(7);
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), previous.clone());
        let session = cache.capture_session("/repo").unwrap();
        let visibility = RefVisibilityState::default();

        let refreshed = tauri::async_runtime::block_on(
            GraphRebuild::new(&cache, &visibility).refresh_in_session(
                "/repo".to_owned(),
                session,
                move || super::read_graph_with_capture(&mut repo, trunk_git::graph::capture),
            ),
        )
        .unwrap();

        assert!(!refreshed.same_capture_as(&previous));
        assert!(cache.snapshot("/repo").unwrap().same_capture_as(&refreshed));
    }

    #[test]
    fn a_late_ref_change_is_rechecked_after_the_worktree_observation() {
        let (_directory, mut repo) = capture_repository();
        let mut observations = 0;

        let read = super::read_graph_with_capture(&mut repo, |repo| {
            trunk_git::graph::capture_with_worktree_observation(repo, |repo| {
                observations += 1;
                if observations == 1 {
                    std::fs::write(repo.workdir().unwrap().join("late.txt"), "late work").unwrap();
                    repo.reference(
                        "refs/heads/late",
                        repo.head().unwrap().target().unwrap(),
                        false,
                        "fixture",
                    )
                    .unwrap();
                }
                trunk_git::status::worktree_dirty(repo)
            })
        })
        .unwrap();

        assert_eq!(observations, 2);
        assert!(!read.changed);
        assert!(read.inputs.is_some());
        assert!(read.placement.worktree_dirty);
        assert!(
            read.refs
                .values()
                .flatten()
                .any(|label| label.name == "refs/heads/late")
        );
    }

    #[test]
    fn a_changed_fetch_mapping_retries_with_the_current_upstream() {
        let (_directory, mut repo) = capture_repository();
        let initial = repo.head().unwrap().target().unwrap();
        let tree = repo.find_commit(initial).unwrap().tree().unwrap();
        let signature = git2::Signature::new(
            "Fixture",
            "fixture@example.invalid",
            &git2::Time::new(2_000, 0),
        )
        .unwrap();
        let upstream = repo
            .commit(
                None,
                &signature,
                &signature,
                "upstream",
                &tree,
                &[&repo.find_commit(initial).unwrap()],
            )
            .unwrap();
        drop(tree);
        repo.remote("origin", "file:///unused-fixture-remote")
            .unwrap();
        repo.reference("refs/remotes/origin/main", initial, false, "fixture")
            .unwrap();
        repo.reference("refs/remotes/alternate/main", upstream, false, "fixture")
            .unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("branch.main.remote", "origin").unwrap();
        config
            .set_str("branch.main.merge", "refs/heads/main")
            .unwrap();
        let mut attempts = 0;

        let read = super::read_graph_with_capture(&mut repo, |repo| {
            attempts += 1;
            let source = trunk_git::graph::capture(repo)?;
            config.set_str(
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/alternate/*",
            )?;
            Ok(source)
        })
        .unwrap();

        assert_eq!(attempts, 2);
        assert!(!read.changed);
        assert!(read.inputs.is_some());
        assert_eq!(read.placement.tracked_upstream, Some(upstream));
    }

    #[test]
    fn cancellation_does_not_admit_a_new_operation_before_exit() {
        let mut running = super::RemoteOps::default();
        running
            .reserve_background(crate::remote_ops::RemoteTarget {
                path: "/repo",
                common: "/common",
            })
            .unwrap();

        running.cancel("/repo");
        let next = running.reserve_foreground(crate::remote_ops::RemoteTarget {
            path: "/repo",
            common: "/common",
        });

        assert_eq!(next.unwrap_err().code, "op_in_progress");
    }

    fn oid(n: u8) -> git2::Oid {
        git2::Oid::from_str(&format!("{n:040x}")).expect("build a hex oid")
    }

    fn facts(summary: &str) -> CommitFacts {
        CommitFacts {
            summary: summary.to_owned(),
            body: None,
            author_name: "T".to_owned(),
            author_email: "t@t.com".to_owned(),
            author_timestamp: 1000,
        }
    }

    /// Two unrelated roots: `main`'s tip, always visible, and a second commit only
    /// `refs/heads/topic` reaches. Hiding `topic` leaves that second commit unreachable
    /// while `main`'s stays, so a rebuild that actually applies visibility (not just
    /// stores the value) drops exactly the one commit.
    fn two_root_source_with_topic_tip() -> GraphSource {
        let (main_tip, topic_tip) = (oid(1), oid(2));
        GraphSource {
            placement: PlacementInput {
                oids: vec![main_tip, topic_tip],
                parents: HashMap::from([(main_tip, vec![]), (topic_tip, vec![])]),
                stashes: HashSet::new(),
                head_tip: Some(main_tip),
                tracked_upstream: None,
                worktree_dirty: false,
            },
            commits: HashMap::from([
                (main_tip, facts("Main tip")),
                (topic_tip, facts("Topic tip")),
            ]),
            refs: HashMap::from([
                (
                    main_tip,
                    vec![RefLabel {
                        name: "refs/heads/main".to_owned(),
                        short_name: "main".to_owned(),
                        ref_type: RefType::LocalBranch,
                        is_head: true,
                        color_index: 0,
                    }],
                ),
                (
                    topic_tip,
                    vec![RefLabel {
                        name: "refs/heads/topic".to_owned(),
                        short_name: "topic".to_owned(),
                        ref_type: RefType::LocalBranch,
                        is_head: false,
                        color_index: 1,
                    }],
                ),
            ]),
            stash_order: vec![],
        }
    }

    #[test]
    fn a_rebuild_lays_out_under_the_visibility_set_for_the_path() {
        let cache = CommitCache::new(GraphCache::default());
        let ref_visibility = RefVisibilityState::default();
        let mut hidden = RefVisibility::default();
        hidden.hidden_refs.insert("refs/heads/topic".to_owned());
        ref_visibility.set("/repo".to_owned(), hidden.clone());
        let rebuild = GraphRebuild::new(&cache, &ref_visibility);

        tauri::async_runtime::block_on(
            rebuild.rebuild("/repo".to_owned(), || Ok(two_root_source_with_topic_tip())),
        )
        .unwrap();

        let snapshot = cache.0.lock().unwrap().get("/repo").unwrap().clone();
        assert_eq!(snapshot.visibility(), &hidden);
        // Not just the stored value: the hidden ref's tip must actually be excluded from
        // the laid-out graph, or a broken `apply_visibility` would pass this test too
        // (review-code finding, TRUNK-125).
        assert_eq!(
            snapshot.layout.commits.len(),
            1,
            "hiding topic's only ref must drop its unreachable commit from the layout"
        );
        assert_eq!(snapshot.layout.commits[0].oid, oid(1).to_string());
    }

    #[derive(Clone, Copy, Debug)]
    enum RebuildMode {
        Carrying,
        InSession,
        Merging,
    }

    fn queued_rebuild<'a>(
        mode: RebuildMode,
        cache: &'a CommitCache,
        visibility: &'a RefVisibilityState,
        ran: Arc<AtomicBool>,
    ) -> Pin<Box<dyn Future<Output = Result<(), TrunkError>> + 'a>> {
        Box::pin(async move {
            let rebuild = GraphRebuild::new(cache, visibility);
            let walk = move || {
                ran.store(true, Ordering::Release);
                Ok(GraphSource::default())
            };
            match mode {
                RebuildMode::Carrying => {
                    rebuild.rebuild("/repo".to_owned(), walk).await.map(|_| ())
                }
                RebuildMode::InSession => rebuild
                    .rebuild_in_session(
                        "/repo".to_owned(),
                        cache.session_id("/repo").unwrap(),
                        walk,
                    )
                    .await
                    .map(|_| ()),
                RebuildMode::Merging => {
                    rebuild
                        .rebuild_merging("/repo".to_owned(), move |visibility, delta| {
                            delta.insert(
                                "/repo".to_owned(),
                                GraphSnapshot::new(walk()?, visibility.clone()),
                            );
                            Ok(())
                        })
                        .await
                }
            }
        })
    }

    #[test]
    fn queued_rebuild_preserves_the_capture_holding_the_gate() {
        for mode in [
            RebuildMode::Carrying,
            RebuildMode::InSession,
            RebuildMode::Merging,
        ] {
            let cache = Arc::new(CommitCache::new(GraphCache::default()));
            cache.0.lock().unwrap().insert("/repo".to_owned(), graph(0));
            let pending_cache = Arc::clone(&cache);
            let (started, entered) = std::sync::mpsc::channel();
            let (release, resume) = std::sync::mpsc::channel();
            let pending = std::thread::spawn(move || {
                let visibility = RefVisibilityState::default();
                tauri::async_runtime::block_on(
                    GraphRebuild::new(&pending_cache, &visibility).rebuild(
                        "/repo".to_owned(),
                        move || {
                            started.send(()).unwrap();
                            resume.recv().unwrap();
                            Ok(two_root_source_with_topic_tip())
                        },
                    ),
                )
            });
            entered.recv().unwrap();
            let visibility = RefVisibilityState::default();
            let mut queued =
                queued_rebuild(mode, &cache, &visibility, Arc::new(AtomicBool::new(false)));
            assert!(matches!(
                queued
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop())),
                Poll::Pending
            ));

            release.send(()).unwrap();
            let published = pending.join().unwrap().unwrap();
            tauri::async_runtime::block_on(queued).unwrap();

            assert_eq!(
                published.layout.commits.len(),
                2,
                "the queued {mode:?} rebuild discarded the capture already in flight"
            );
            assert!(cache.snapshot("/repo").unwrap().layout.commits.is_empty());
        }
    }

    #[test]
    fn queued_rebuild_does_not_run_after_its_opening_session_reopens() {
        for mode in [
            RebuildMode::Carrying,
            RebuildMode::InSession,
            RebuildMode::Merging,
        ] {
            let cache = CommitCache::new(GraphCache::default());
            cache.open_session("/repo");
            let gate = tauri::async_runtime::block_on(cache.lock_rebuild("/repo"));
            let visibility = RefVisibilityState::default();
            let ran = Arc::new(AtomicBool::new(false));
            let mut queued = queued_rebuild(mode, &cache, &visibility, Arc::clone(&ran));
            assert!(matches!(
                queued
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop())),
                Poll::Pending
            ));

            cache.forget("/repo");
            cache.open_session("/repo");
            drop(gate);
            let error = tauri::async_runtime::block_on(queued).unwrap_err();

            assert_eq!(error.code, "not_open");
            assert!(
                !ran.load(Ordering::Acquire),
                "the closed session's queued {mode:?} closure ran in the reopened session"
            );
            assert!(!cache.holds("/repo"));
        }
    }

    #[test]
    fn a_closed_session_cannot_be_repopulated_by_a_blocked_capture() {
        assert_old_capture_is_fenced(false);
    }

    #[test]
    fn input_invalidation_does_not_supersede_a_capture_in_flight() {
        let cache = Arc::new(CommitCache::new(GraphCache::default()));
        cache.0.lock().unwrap().insert("/repo".to_owned(), graph(0));
        let pending_cache = Arc::clone(&cache);
        let (started, entered) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let pending = std::thread::spawn(move || {
            let visibility = RefVisibilityState::default();
            tauri::async_runtime::block_on(GraphRebuild::new(&pending_cache, &visibility).rebuild(
                "/repo".to_owned(),
                move || {
                    started.send(()).unwrap();
                    resume.recv().unwrap();
                    Ok(two_root_source_with_topic_tip())
                },
            ))
        });
        entered.recv().unwrap();

        cache.invalidate("/repo");
        release.send(()).unwrap();
        pending.join().unwrap().unwrap();

        assert_eq!(cache.snapshot("/repo").unwrap().layout.commits.len(), 2);
    }

    #[test]
    fn a_superseded_capture_preserves_the_completed_commands_outcome() {
        let cache = CommitCache::new(GraphCache::default());
        cache.0.lock().unwrap().insert("/repo".to_owned(), graph(0));
        let visibility = RefVisibilityState::default();
        let (_directory, repo) = capture_repository();
        let before = crate::ref_state::RefState::read(&repo).unwrap();
        repo.reference(
            "refs/heads/late",
            repo.head().unwrap().target().unwrap(),
            false,
            "fixture",
        )
        .unwrap();
        let after = crate::ref_state::RefState::read(&repo).unwrap();
        let result = tauri::async_runtime::block_on(
            GraphRebuild::new(&cache, &visibility).rebuild_carrying(
                "/repo".to_owned(),
                move || {
                    Ok((
                        super::GraphRead::checked(two_root_source_with_topic_tip(), before, after),
                        "commit succeeded",
                    ))
                },
            ),
        )
        .unwrap();

        assert_eq!(result.1, "commit succeeded");
        assert!(result.0.layout.commits.is_empty());
        assert!(cache.snapshot("/repo").unwrap().layout.commits.is_empty());
    }

    #[test]
    fn a_reference_change_during_capture_is_never_stamped_as_current() {
        let temp = tempfile::tempdir().unwrap();
        let mut repo = git2::Repository::init_bare(temp.path()).unwrap();
        let tree_oid = repo.treebuilder(None).unwrap().write().unwrap();
        let signature = git2::Signature::now("Test", "test@example.com").unwrap();
        let oid = repo
            .commit(
                Some("refs/heads/main"),
                &signature,
                &signature,
                "Initial",
                &repo.find_tree(tree_oid).unwrap(),
                &[],
            )
            .unwrap();
        repo.set_head("refs/heads/main").unwrap();
        let before = crate::ref_state::RefState::read(&repo).unwrap();
        let source = trunk_git::graph::capture(&mut repo).unwrap();
        repo.reference("refs/remotes/origin/main", oid, true, "fetch")
            .unwrap();
        let after = crate::ref_state::RefState::read(&repo).unwrap();

        let read = super::GraphRead::checked(source, before, after);

        assert!(read.changed);
        assert!(read.inputs.is_none());
    }

    #[test]
    fn a_visibility_change_during_a_blocked_capture_controls_publication() {
        let cache = Arc::new(CommitCache::new(GraphCache::default()));
        let visibility = Arc::new(RefVisibilityState::default());
        let pending_cache = Arc::clone(&cache);
        let pending_visibility = Arc::clone(&visibility);
        let (started, entered) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let pending = std::thread::spawn(move || {
            tauri::async_runtime::block_on(
                GraphRebuild::new(&pending_cache, &pending_visibility).rebuild(
                    "/repo".to_owned(),
                    move || {
                        let source = two_root_source_with_topic_tip();
                        started.send(()).unwrap();
                        resume.recv().unwrap();
                        Ok(source)
                    },
                ),
            )
        });
        entered.recv().unwrap();
        let mut hidden = RefVisibility::default();
        hidden.hidden_refs.insert("refs/heads/topic".to_owned());
        visibility.set("/repo".to_owned(), hidden.clone());
        release.send(()).unwrap();
        let published = pending.join().unwrap().unwrap();

        assert_eq!(published.visibility(), &hidden);
        assert_eq!(published.layout.commits.len(), 1);
        assert_eq!(published.layout.commits[0].oid, oid(1).to_string());
    }

    #[test]
    fn a_newer_publication_survives_an_older_blocked_capture() {
        let cache = Arc::new(CommitCache::new(GraphCache::default()));
        let pending_cache = Arc::clone(&cache);
        let (started, entered) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let pending = std::thread::spawn(move || {
            let visibility = RefVisibilityState::default();
            tauri::async_runtime::block_on(GraphRebuild::new(&pending_cache, &visibility).rebuild(
                "/repo".to_owned(),
                move || {
                    let source = two_root_source_with_topic_tip();
                    started.send(()).unwrap();
                    resume.recv().unwrap();
                    Ok(source)
                },
            ))
        });
        entered.recv().unwrap();
        let ticket = cache.begin_write("/repo").unwrap();
        let newer = graph(9);
        cache
            .0
            .lock()
            .unwrap()
            .publish("/repo".to_owned(), ticket, newer.clone(), None)
            .unwrap();
        release.send(()).unwrap();
        let returned = pending.join().unwrap().unwrap();

        assert!(returned.same_capture_as(&newer));
        assert!(cache.snapshot("/repo").unwrap().same_capture_as(&newer));
        assert_eq!(
            cache.snapshot("/repo").unwrap().visibility(),
            newer.visibility()
        );
    }

    #[test]
    fn an_old_remote_job_cannot_begin_ref_reconciliation_for_a_reopened_session() {
        let (_directory, repo) = capture_repository();
        let cache = CommitCache::new(GraphCache::default());
        cache.open_session("/repo");
        let old_session = cache.session_id("/repo").unwrap();
        cache.forget("/repo");
        cache.open_session("/repo");
        let previous = graph(7);
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), previous.clone());
        let visibility = RefVisibilityState::default();

        let result = tauri::async_runtime::block_on(
            GraphRebuild::new(&cache, &visibility).reconcile_refs_in_session(
                "/repo".to_owned(),
                repo.workdir().unwrap().to_path_buf(),
                old_session,
            ),
        );

        assert_eq!(result.err().unwrap().code, "not_open");
        assert!(cache.snapshot("/repo").unwrap().same_capture_as(&previous));
    }

    #[test]
    fn a_reopened_session_keeps_its_capture_when_the_old_one_finishes() {
        assert_old_capture_is_fenced(true);
    }

    fn assert_old_capture_is_fenced(reopened: bool) {
        let cache = Arc::new(CommitCache::new(GraphCache::default()));
        let pending_cache = Arc::clone(&cache);
        let (started, entered) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let pending = std::thread::spawn(move || {
            let visibility = RefVisibilityState::default();
            tauri::async_runtime::block_on(GraphRebuild::new(&pending_cache, &visibility).rebuild(
                "/repo".to_owned(),
                move || {
                    started.send(()).unwrap();
                    resume.recv().unwrap();
                    Ok(GraphSource::default())
                },
            ))
        });
        entered.recv().unwrap();

        cache.forget("/repo");
        let current = if reopened {
            cache.open_session("/repo");
            let ticket = cache.begin_write("/repo").unwrap();
            let current = tagged_graph("new-session");
            cache
                .0
                .lock()
                .unwrap()
                .publish("/repo".to_owned(), ticket, current.clone(), None)
                .unwrap();
            Some(current)
        } else {
            None
        };
        release.send(()).unwrap();
        let error = pending.join().unwrap().unwrap_err();
        assert_eq!(error.code, "not_open");
        if let Some(current) = current {
            assert!(cache.snapshot("/repo").unwrap().same_capture_as(&current));
        } else {
            assert!(
                !cache.holds("/repo"),
                "the closed session's capture was published"
            );
        }
    }

    /// An empty graph tagged by the ref it hides, so a test can tell two snapshots apart
    /// by their visibility while both carry an empty capture.
    fn tagged_graph(tag: &str) -> GraphSnapshot {
        let mut visibility = RefVisibility::default();
        visibility.hidden_refs.insert(format!("refs/tags/{tag}"));
        GraphSnapshot::new(GraphSource::default(), visibility)
    }

    #[test]
    fn a_toggle_does_not_overwrite_a_rebuild_that_landed_while_it_relaid_out() {
        let cache = CommitCache::new(GraphCache::default());
        let read = tagged_graph("pre-commit");
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), read.clone());
        let ticket = cache.begin_write("/repo").unwrap();

        // A commit's rebuild replaces the entry with a fresh capture while the toggle's
        // relayout of the stale one is still in flight off-thread.
        let fresher = tagged_graph("post-commit");
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), fresher.clone());

        let relaid_out = read.with_visibility(tagged_graph("toggled").visibility().clone());
        let visibility = RefVisibilityState::default();
        visibility.set("/repo".to_owned(), relaid_out.visibility().clone());
        tauri::async_runtime::block_on(GraphRebuild::new(&cache, &visibility).publish_relayout(
            "/repo".to_owned(),
            &read,
            relaid_out,
            ticket,
        ))
        .unwrap();

        let cached = cache.0.lock().unwrap();
        assert_eq!(
            cached.get("/repo").unwrap().visibility(),
            fresher.visibility(),
            "the toggle overwrote a rebuild that landed after it read the cache"
        );
    }

    #[test]
    fn a_toggle_writes_its_graph_when_nothing_landed_ahead_of_it() {
        let cache = CommitCache::new(GraphCache::default());
        let read = tagged_graph("pre-toggle");
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), read.clone());

        let relaid_out = read.with_visibility(tagged_graph("toggled").visibility().clone());
        let ticket = cache.begin_write("/repo").unwrap();
        let visibility = RefVisibilityState::default();
        visibility.set("/repo".to_owned(), relaid_out.visibility().clone());
        tauri::async_runtime::block_on(GraphRebuild::new(&cache, &visibility).publish_relayout(
            "/repo".to_owned(),
            &read,
            relaid_out.clone(),
            ticket,
        ))
        .unwrap();

        let cached = cache.0.lock().unwrap();
        assert_eq!(
            cached.get("/repo").unwrap().visibility(),
            relaid_out.visibility()
        );
    }

    fn graph(tag: usize) -> GraphSnapshot {
        let mut visibility = RefVisibility::default();
        visibility.hidden_refs.insert(format!("refs/tags/{tag}"));

        GraphSnapshot::new(GraphSource::default(), visibility)
    }

    #[test]
    fn another_repos_graph_refreshed_mid_rebuild_is_not_rolled_back() {
        let cache = Arc::new(CommitCache::new(GraphCache::default()));
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo/b".to_owned(), graph(1));
        let ref_visibility = RefVisibilityState::default();
        ref_visibility.set("/repo/a".to_owned(), graph(1).visibility().clone());
        let rebuild = GraphRebuild::new(&cache, &ref_visibility);
        let concurrent_cache = Arc::clone(&cache);

        tauri::async_runtime::block_on(rebuild.rebuild_merging(
            "/repo/a".to_owned(),
            move |_visibility, rebuilt| {
                concurrent_cache
                    .0
                    .lock()
                    .unwrap()
                    .insert("/repo/b".to_owned(), graph(9));
                rebuilt.insert("/repo/a".to_owned(), graph(1));
                Ok(())
            },
        ))
        .unwrap();

        let cached = cache.0.lock().unwrap();
        assert_eq!(
            cached.get("/repo/a").unwrap().visibility(),
            graph(1).visibility()
        );
        assert_eq!(
            cached.get("/repo/b").unwrap().visibility(),
            graph(9).visibility(),
            "/repo/b was reverted to the pre-rebuild snapshot"
        );
    }

    #[test]
    fn a_failed_rebuild_merge_leaves_the_cache_untouched() {
        let cache = CommitCache::new(GraphCache::default());
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo/b".to_owned(), graph(7));
        let ref_visibility = RefVisibilityState::default();
        let rebuild = GraphRebuild::new(&cache, &ref_visibility);

        let err = tauri::async_runtime::block_on(rebuild.rebuild_merging::<_, ()>(
            "/repo/a".to_owned(),
            |_visibility, rebuilt| {
                rebuilt.insert("/repo/a".to_owned(), graph(1));
                Err(TrunkError::new("boom", "no"))
            },
        ))
        .unwrap_err();

        assert_eq!(err.code, "boom");
        let cached = cache.0.lock().unwrap();
        assert!(!cached.holds("/repo/a"));
        assert_eq!(
            cached.get("/repo/b").unwrap().visibility(),
            graph(7).visibility()
        );
    }

    #[test]
    fn an_unregistered_path_is_not_open() {
        let open = OpenRepos::default();

        let err = open.path_for("/not/a/registered/repo").unwrap_err();

        assert_eq!(err.code, "not_open");
    }

    #[test]
    fn the_not_open_message_names_the_repository_not_its_location() {
        let open = OpenRepos::default();

        let err = open.path_for("/home/someone/code/trunk").unwrap_err();

        assert_eq!(err.message, "Repository not open: trunk");
    }

    #[test]
    fn a_key_with_no_final_component_names_itself() {
        let open = OpenRepos::default();

        let err = open.path_for("/").unwrap_err();

        assert_eq!(err.message, "Repository not open: /");
    }

    #[test]
    fn a_registered_path_resolves_to_its_location_on_disk() {
        let open = OpenRepos::from_iter([("key".to_string(), PathBuf::from("/on/disk"))]);

        assert_eq!(open.path_for("key").unwrap(), Path::new("/on/disk"));
    }
}

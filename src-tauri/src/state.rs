use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::error::TrunkError;
use crate::git::graph_input::{GraphSnapshot, GraphSource, RefVisibility};

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

/// The remote operation running for each repository, by process id.
///
/// It serves two purposes at once: the cancel button needs the pid to signal,
/// and the presence of an entry is what keeps a second remote operation off the
/// same repository.
#[derive(Debug, Default)]
pub struct RemoteOps(HashMap<String, u32>);

impl RemoteOps {
    /// Whether a remote operation is already running for `path`.
    #[must_use]
    pub fn busy(&self, path: &str) -> bool {
        self.0.contains_key(path)
    }

    /// Record `pid` as the operation running for `path`.
    pub fn start(&mut self, path: String, pid: u32) {
        self.0.insert(path, pid);
    }

    /// Forget the operation for `path`, answering the pid it was running under.
    pub fn finish(&mut self, path: &str) -> Option<u32> {
        self.0.remove(path)
    }
}

/// Stores the PID of the currently running remote operation per repo.
///
/// Used for: (a) cancel button kills the subprocess, (b) mutual exclusion prevents
/// concurrent ops on the SAME repo.
pub struct RunningOp(pub Mutex<RemoteOps>);

/// Terminate a process by PID. Uses SIGTERM on Unix and taskkill on Windows.
///
/// A pid that does not fit `i32` is ignored rather than wrapped: a wrapped value
/// is negative, and a negative pid signals a whole process group.
pub fn kill_process(pid: u32) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(pid) {
        // SAFETY: `kill` with a positive pid and a valid signal has no
        // preconditions this call can violate.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output();
    }
}

/// The cached graph for each open repository, keyed by the frontend's path.
///
/// A rebuild writes a whole entry rather than mutating one, so a reader either
/// sees the graph as it was or the graph as it now is, never a half-updated one.
#[derive(Clone, Debug, Default)]
pub struct GraphCache(HashMap<String, crate::git::graph_input::GraphSnapshot>);

impl GraphCache {
    /// The cached graph for `path`, or `None` when nothing has been built yet.
    #[must_use]
    pub fn get(&self, path: &str) -> Option<&crate::git::graph_input::GraphSnapshot> {
        self.0.get(path)
    }

    /// Store `snapshot` as the graph for `path`, replacing any earlier one.
    pub fn insert(&mut self, path: String, snapshot: crate::git::graph_input::GraphSnapshot) {
        self.0.insert(path, snapshot);
    }

    /// Whether a graph has been cached for `path`.
    #[must_use]
    pub fn holds(&self, path: &str) -> bool {
        self.0.contains_key(path)
    }

    /// Drop the cached graph for `path`.
    pub fn forget(&mut self, path: &str) {
        self.0.remove(path);
    }

    /// Take every entry of `other`, replacing any entry of the same name here.
    pub fn absorb(&mut self, other: Self) {
        self.0.extend(other.0);
    }
}

// Caches the full commit graph per open repo path.
// Populated on open_repo, cleared on close_repo, sliced by get_commit_graph.
pub struct CommitCache(Mutex<GraphCache>);

impl CommitCache {
    #[must_use]
    pub const fn new(cache: GraphCache) -> Self {
        Self(Mutex::new(cache))
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

    /// A snapshot of every cached graph, for a reader that scans across repositories rather
    /// than looking one up by path.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned.
    #[must_use]
    pub fn all(&self) -> GraphCache {
        self.0.lock().unwrap().clone()
    }

    /// Drop the cached graph for `path`.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned.
    pub fn forget(&self, path: &str) {
        self.0.lock().unwrap().forget(path);
    }

    /// Store a visibility toggle's re-laid-out graph, unless a fresher rebuild already
    /// replaced the entry this toggle read. That rebuild's capture is newer than the one
    /// this graph was re-laid out from, so writing over it would show a graph from before
    /// whatever it just did (TRUNK-129).
    ///
    /// This is the one legitimate cache write outside `GraphRebuild`: `set_ref_visibility`
    /// re-lays out an existing capture rather than walking the repository, so it has no
    /// visibility to look up here — it already carries the one it just set. Keep this the
    /// only door: a second general-purpose insert would let a future caller skip both this
    /// staleness guard and `GraphRebuild`'s visibility lookup.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned.
    pub fn write_relaid_out(
        &self,
        path: String,
        read: Option<&GraphSnapshot>,
        relaid_out: GraphSnapshot,
    ) {
        let mut cache = self.0.lock().unwrap();
        let still_current = match (cache.get(&path), read) {
            (Some(current), Some(read)) => current.same_capture_as(read),
            (None, None) => true,
            _ => false,
        };
        if still_current {
            cache.insert(path, relaid_out);
        }
    }
}

/// The diff stat computed for each commit, per repository.
///
/// A commit's diff never changes, so an entry is never invalidated, only
/// dropped wholesale when its repository closes. Filled lazily by the Diff
/// column and only while that column is visible.
#[derive(Debug, Default)]
pub struct StatsCache(HashMap<String, HashMap<String, crate::git::types::DiffStat>>);

impl StatsCache {
    /// The stat held for `oid` in `path`, if one has been computed.
    #[must_use]
    pub fn get(&self, path: &str, oid: &str) -> Option<&crate::git::types::DiffStat> {
        self.0.get(path)?.get(oid)
    }

    /// Store every stat in `stats` against `path`, keeping what is already there.
    pub fn extend(
        &mut self,
        path: String,
        stats: impl IntoIterator<Item = (String, crate::git::types::DiffStat)>,
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
pub struct StoreSlot(std::sync::Arc<Mutex<Option<std::sync::Arc<crate::reviewdb::Store>>>>);

impl StoreSlot {
    #[must_use]
    pub fn clone_handle(
        &self,
    ) -> std::sync::Arc<Mutex<Option<std::sync::Arc<crate::reviewdb::Store>>>> {
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
pub struct RefVisibilityState(Arc<Mutex<HashMap<String, crate::git::graph_input::RefVisibility>>>);

impl RefVisibilityState {
    /// The refs `path` has hidden. A repository with none gets the empty set.
    ///
    /// # Panics
    ///
    /// Panics when the lock is poisoned.
    #[must_use]
    pub fn get(&self, path: &str) -> crate::git::graph_input::RefVisibility {
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
    pub fn set(&self, path: String, visibility: crate::git::graph_input::RefVisibility) {
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
/// `rebuild`'s closure returns a `GraphSource` — the capture, not a laid-out snapshot — so
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
    /// `walk` returns a `GraphSource`, not a `GraphSnapshot`: it has no way to choose which
    /// visibility the cached snapshot is laid out under, because it never holds anything that
    /// can build one. Use `graph::capture` to produce it, the same repository read
    /// `graph::snapshot` does internally.
    ///
    /// # Errors
    ///
    /// Returns whatever `walk` returns, and `spawn_error` when the blocking task cannot be
    /// joined. The cache is left untouched on either error.
    ///
    /// # Panics
    ///
    /// Panics when the cache's lock is poisoned.
    pub async fn rebuild<F>(&self, path: String, walk: F) -> Result<GraphSnapshot, TrunkError>
    where
        F: FnOnce() -> Result<GraphSource, TrunkError> + Send + 'static,
    {
        self.rebuild_carrying(path, || walk().map(|source| (source, ())))
            .await
            .map(|(snapshot, ())| snapshot)
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
    pub async fn rebuild_carrying<F, T>(
        &self,
        path: String,
        walk: F,
    ) -> Result<(GraphSnapshot, T), TrunkError>
    where
        F: FnOnce() -> Result<(GraphSource, T), TrunkError> + Send + 'static,
        T: Send + 'static,
    {
        let visibility = self.ref_visibility.get(&path);

        let (source, extra) = tauri::async_runtime::spawn_blocking(walk)
            .await
            .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;
        let snapshot = GraphSnapshot::new(source, visibility);

        self.cache.0.lock().unwrap().insert(path, snapshot.clone());

        Ok((snapshot, extra))
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
    pub async fn rebuild_merging<F>(&self, path: String, walk: F) -> Result<(), TrunkError>
    where
        F: FnOnce(&RefVisibility, &mut GraphCache) -> Result<(), TrunkError> + Send + 'static,
    {
        let visibility = self.ref_visibility.get(&path);

        let rebuilt = tauri::async_runtime::spawn_blocking(move || {
            let mut rebuilt = GraphCache::default();
            walk(&visibility, &mut rebuilt).map(|()| rebuilt)
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()))??;

        self.cache.0.lock().unwrap().absorb(rebuilt);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{CommitCache, GraphCache, GraphRebuild, OpenRepos, RefVisibilityState};
    use crate::error::TrunkError;
    use crate::git::graph_input::{CommitFacts, GraphSnapshot, GraphSource, RefVisibility};
    use crate::git::placement::PlacementInput;
    use crate::git::types::{RefLabel, RefType};
    use std::collections::{HashMap, HashSet};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

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
        let cache = CommitCache(Mutex::new(GraphCache::default()));
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

    /// An empty graph tagged by the ref it hides, so a test can tell two snapshots apart
    /// by their visibility while both carry an empty capture.
    fn tagged_graph(tag: &str) -> GraphSnapshot {
        let mut visibility = RefVisibility::default();
        visibility.hidden_refs.insert(format!("refs/tags/{tag}"));
        GraphSnapshot::new(GraphSource::default(), visibility)
    }

    #[test]
    fn a_toggle_does_not_overwrite_a_rebuild_that_landed_while_it_relaid_out() {
        let cache = CommitCache(Mutex::new(GraphCache::default()));
        let read = tagged_graph("pre-commit");
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), read.clone());

        // A commit's rebuild replaces the entry with a fresh capture while the toggle's
        // relayout of the stale one is still in flight off-thread.
        let fresher = tagged_graph("post-commit");
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), fresher.clone());

        let relaid_out = read.with_visibility(tagged_graph("toggled").visibility().clone());
        cache.write_relaid_out("/repo".to_owned(), Some(&read), relaid_out);

        let cached = cache.0.lock().unwrap();
        assert_eq!(
            cached.get("/repo").unwrap().visibility(),
            fresher.visibility(),
            "the toggle overwrote a rebuild that landed after it read the cache"
        );
    }

    #[test]
    fn a_toggle_writes_its_graph_when_nothing_landed_ahead_of_it() {
        let cache = CommitCache(Mutex::new(GraphCache::default()));
        let read = tagged_graph("pre-toggle");
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), read.clone());

        let relaid_out = read.with_visibility(tagged_graph("toggled").visibility().clone());
        cache.write_relaid_out("/repo".to_owned(), Some(&read), relaid_out.clone());

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
        let cache = Arc::new(CommitCache(Mutex::new(GraphCache::default())));
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo/b".to_owned(), graph(1));
        let ref_visibility = RefVisibilityState::default();
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
        let cache = CommitCache(Mutex::new(GraphCache::default()));
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo/b".to_owned(), graph(7));
        let ref_visibility = RefVisibilityState::default();
        let rebuild = GraphRebuild::new(&cache, &ref_visibility);

        let err = tauri::async_runtime::block_on(rebuild.rebuild_merging(
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

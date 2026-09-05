use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::error::TrunkError;

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
pub struct CommitCache(pub Mutex<GraphCache>);

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

#[cfg(test)]
mod tests {
    use super::OpenRepos;
    use std::path::{Path, PathBuf};

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

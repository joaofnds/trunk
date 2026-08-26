use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

// CRITICAL: Store PathBuf ONLY — git2::Repository is not Sync.
// Each Tauri command opens a fresh Repository::open(path) inside spawn_blocking.
// Storing Repository handles here would cause cargo build to fail with "not Sync".
pub struct RepoState(pub Mutex<HashMap<String, PathBuf>>);

/// Stores the PID of the currently running remote operation per repo.
/// Key: repo path (String), Value: PID (u32).
/// Used for: (a) cancel button kills the subprocess, (b) mutual exclusion prevents
/// concurrent ops on the SAME repo.
pub struct RunningOp(pub Mutex<HashMap<String, u32>>);

/// Terminate a process by PID. Uses SIGTERM on Unix and taskkill on Windows.
pub fn kill_process(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output();
    }
}

// Caches the full commit graph per open repo path.
// Populated on open_repo, cleared on close_repo, sliced by get_commit_graph.
pub struct CommitCache(pub Mutex<HashMap<String, crate::git::types::GraphResult>>);

// Lazy per-commit diff-stats for the graph's Diff column.
// Outer key: repo path · inner key: commit oid · value: immutable per-oid stat.
// A commit's diff never changes, so entries are never invalidated — only cleared
// wholesale on close_repo. Populated lazily by get_commit_stats, gated on the
// column being visible.
pub struct CommitStatsCache(
    pub Mutex<HashMap<String, HashMap<String, crate::git::types::DiffStat>>>,
);

/// Whether the application repositions the macOS traffic-light buttons.
///
/// The application test harness manages a disabled one. `WebviewWindow::ns_window()`
/// on `tauri::test::MockRuntime` builds its answer from a dangling `NSView*`, so
/// asking for the native window there segfaults the process — and the frontend asks
/// for the zoom on its very first render. Off, the command still runs; only the
/// AppKit call is skipped.
pub struct TrafficLights {
    pub enabled: bool,
}

impl Default for TrafficLights {
    fn default() -> Self {
        TrafficLights { enabled: true }
    }
}

impl TrafficLights {
    pub fn disabled() -> Self {
        TrafficLights { enabled: false }
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
    pub fn clone_handle(
        &self,
    ) -> std::sync::Arc<Mutex<Option<std::sync::Arc<crate::reviewdb::Store>>>> {
        std::sync::Arc::clone(&self.0)
    }
}

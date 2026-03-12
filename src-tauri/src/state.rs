use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

// CRITICAL: Store PathBuf ONLY — git2::Repository is not Sync.
// Each Tauri command opens a fresh Repository::open(path) inside spawn_blocking.
// Storing Repository handles here would cause cargo build to fail with "not Sync".
pub struct RepoState(pub Mutex<HashMap<String, PathBuf>>);

/// Stores the PID of the currently running remote operation (fetch/pull/push).
/// Used for: (a) cancel button kills the subprocess, (b) mutual exclusion prevents concurrent ops.
/// Stores PID (u32), not Child, because tokio::process::Child is !Sync.
pub struct RunningOp(pub Mutex<Option<u32>>);

// Caches the full commit graph per open repo path.
// Populated on open_repo, cleared on close_repo, sliced by get_commit_graph.
pub struct CommitCache(pub Mutex<HashMap<String, crate::git::types::GraphResult>>);

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

// CRITICAL: Store PathBuf ONLY — git2::Repository is not Sync.
// Each Tauri command opens a fresh Repository::open(path) inside spawn_blocking.
// Storing Repository handles here would cause cargo build to fail with "not Sync".
pub struct RepoState(pub Mutex<HashMap<String, PathBuf>>);

// Caches the full commit graph per open repo path.
// Populated on open_repo, cleared on close_repo, sliced by get_commit_graph.
pub struct CommitCache(pub Mutex<HashMap<String, crate::git::types::GraphResult>>);

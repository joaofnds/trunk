use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

// CRITICAL: Store PathBuf ONLY — git2::Repository is not Sync.
// Each Tauri command opens a fresh Repository::open(path) inside spawn_blocking.
// Storing Repository handles here would cause cargo build to fail with "not Sync".
pub struct RepoState(pub Mutex<HashMap<String, PathBuf>>);

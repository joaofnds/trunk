use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use crate::error::TrunkError;
use crate::git::types::HeadCommitMessage;
use crate::state::{CommitCache, RepoState};

fn open_repo_from_state(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<git2::Repository, TrunkError> {
    let path_buf = state_map
        .get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;
    git2::Repository::open(path_buf).map_err(TrunkError::from)
}

fn build_message(subject: &str, body: Option<&str>) -> String {
    match body {
        Some(b) if !b.trim().is_empty() => format!("{}\n\n{}", subject, b),
        _ => subject.to_owned(),
    }
}

pub fn create_commit_inner(
    path: &str,
    subject: &str,
    body: Option<&str>,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let sig = repo.signature()?;
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let message = build_message(subject, body);

    let parents = match repo.head() {
        Ok(h) => vec![h.peel_to_commit()?],
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => vec![],
        Err(e) => return Err(TrunkError::from(e)),
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

    repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parent_refs)?;
    Ok(())
}

pub fn amend_commit_inner(
    path: &str,
    subject: &str,
    body: Option<&str>,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(), TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let head_commit = repo.head()?.peel_to_commit()?;
    let sig = repo.signature()?;
    let mut index = repo.index()?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let message = build_message(subject, body);

    head_commit.amend(
        Some("HEAD"),
        Some(&sig),
        Some(&sig),
        None,
        Some(&message),
        Some(&tree),
    )?;
    Ok(())
}

pub fn get_head_commit_message_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<HeadCommitMessage, TrunkError> {
    let repo = open_repo_from_state(path, state_map)?;
    let commit = repo.head()?.peel_to_commit()?;
    Ok(HeadCommitMessage {
        subject: commit.summary().unwrap_or("").to_owned(),
        body: commit.body().map(str::to_owned),
    })
}

#[tauri::command]
pub async fn create_commit(
    path: String,
    subject: String,
    body: Option<String>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        create_commit_inner(&path_clone, &subject, body.as_deref(), &state_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    cache.0.lock().unwrap().remove(&path);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[tauri::command]
pub async fn amend_commit(
    path: String,
    subject: String,
    body: Option<String>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        amend_commit_inner(&path_clone, &subject, body.as_deref(), &state_map)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    cache.0.lock().unwrap().remove(&path);
    let _ = app.emit("repo-changed", path);
    Ok(())
}

#[tauri::command]
pub async fn get_head_commit_message(
    path: String,
    state: State<'_, RepoState>,
) -> Result<HeadCommitMessage, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || get_head_commit_message_inner(&path, &state_map))
        .await
        .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
        .map_err(|e| serde_json::to_string(&e).unwrap())
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use crate::git::repository::tests::make_test_repo;

    fn make_state_map(path: &Path) -> std::collections::HashMap<String, std::path::PathBuf> {
        let mut map = std::collections::HashMap::new();
        map.insert(path.to_string_lossy().to_string(), path.to_path_buf());
        map
    }

    // Test 1 — create_commit_creates_commit
    #[test]
    fn create_commit_creates_commit() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Stage a new file
        std::fs::write(dir.path().join("new_file.txt"), "content").unwrap();
        let repo = git2::Repository::open(dir.path()).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("new_file.txt")).unwrap();
        index.write().unwrap();
        drop(index);
        drop(repo);

        super::create_commit_inner(&path, "New commit", None, &state_map)
            .expect("create_commit_inner failed");

        let repo = git2::Repository::open(dir.path()).unwrap();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head_commit.summary().unwrap(), "New commit");
    }

    // Test 2 — create_commit_unborn_head
    #[test]
    fn create_commit_unborn_head() {
        let dir = tempfile::tempdir().expect("failed to create tempdir");
        let repo = git2::Repository::init(dir.path()).expect("failed to init repo");
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Set user config so signature works
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Test User").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        drop(cfg);

        // Stage a new file (no prior commits — unborn HEAD)
        std::fs::write(dir.path().join("first.txt"), "first content").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("first.txt")).unwrap();
        index.write().unwrap();
        drop(index);
        drop(repo);

        let result = super::create_commit_inner(&path, "Initial commit", None, &state_map);
        assert!(result.is_ok(), "expected Ok for unborn HEAD, got: {:?}", result);

        let repo = git2::Repository::open(dir.path()).unwrap();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head_commit.summary().unwrap(), "Initial commit");
    }

    // Test 3 — create_commit_uses_signature
    #[test]
    fn create_commit_uses_signature() {
        let dir = tempfile::tempdir().expect("failed to create tempdir");
        let repo = git2::Repository::init(dir.path()).expect("failed to init repo");
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Set specific user.name / user.email
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Jane Doe").unwrap();
        cfg.set_str("user.email", "jane@example.com").unwrap();
        drop(cfg);

        // Stage a file
        std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        drop(index);
        drop(repo);

        super::create_commit_inner(&path, "Signed commit", None, &state_map)
            .expect("create_commit_inner failed");

        let repo = git2::Repository::open(dir.path()).unwrap();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head_commit.author().name().unwrap(), "Jane Doe");
    }

    // Test 4 — amend_commit_updates_message
    #[test]
    fn amend_commit_updates_message() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        super::amend_commit_inner(&path, "Amended subject", None, &state_map)
            .expect("amend_commit_inner failed");

        let repo = git2::Repository::open(dir.path()).unwrap();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head_commit.summary().unwrap(), "Amended subject");
    }

    // Test 5 — amend_commit_includes_staged
    #[test]
    fn amend_commit_includes_staged() {
        let dir = make_test_repo();
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        // Stage a new file before amending
        std::fs::write(dir.path().join("staged_file.txt"), "staged content").unwrap();
        let repo = git2::Repository::open(dir.path()).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("staged_file.txt")).unwrap();
        index.write().unwrap();
        drop(index);
        drop(repo);

        super::amend_commit_inner(&path, "Amended with staged", None, &state_map)
            .expect("amend_commit_inner failed");

        let repo = git2::Repository::open(dir.path()).unwrap();
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        let tree = head_commit.tree().unwrap();
        assert!(
            tree.get_name("staged_file.txt").is_some(),
            "expected staged_file.txt in amended commit tree"
        );
    }

    // Test 6 — get_head_commit_message_returns_message
    #[test]
    fn get_head_commit_message_returns_message() {
        let dir = tempfile::tempdir().expect("failed to create tempdir");
        let repo = git2::Repository::init(dir.path()).expect("failed to init repo");
        let path = dir.path().to_string_lossy().to_string();
        let state_map = make_state_map(dir.path());

        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Test User").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        drop(cfg);

        // Create a commit with subject and body
        let sig = git2::Signature::now("Test User", "test@example.com").unwrap();
        std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            "Subject\n\nBody text",
            &tree,
            &[],
        )
        .unwrap();

        let msg = super::get_head_commit_message_inner(&path, &state_map)
            .expect("get_head_commit_message_inner failed");
        assert_eq!(msg.subject, "Subject");
        assert_eq!(msg.body, Some("Body text".to_owned()));
    }
}

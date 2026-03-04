use tauri::State;
use crate::state::CommitCache;
use crate::error::TrunkError;
use crate::git::types::GraphCommit;

#[tauri::command]
pub async fn get_commit_graph(
    path: String,
    offset: usize,
    cache: State<'_, CommitCache>,
) -> Result<Vec<GraphCommit>, String> {
    let lock = cache.0.lock().unwrap();
    let commits = lock.get(&path).ok_or_else(|| {
        serde_json::to_string(&TrunkError::new("repo_not_open", "Repository not open")).unwrap()
    })?;

    let len = commits.len();
    let start = offset.min(len);
    let end = (offset + 200).min(len);
    Ok(commits[start..end].to_vec())
}

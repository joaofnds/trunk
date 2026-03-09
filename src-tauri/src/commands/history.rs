use serde::Serialize;
use tauri::State;
use crate::state::CommitCache;
use crate::error::TrunkError;
use crate::git::types::GraphCommit;

#[derive(Debug, Serialize, Clone)]
pub struct GraphResponse {
    pub commits: Vec<GraphCommit>,
    pub max_columns: usize,
}

#[tauri::command]
pub async fn get_commit_graph(
    path: String,
    offset: usize,
    cache: State<'_, CommitCache>,
) -> Result<GraphResponse, String> {
    let lock = cache.0.lock().unwrap();
    let graph_result = lock.get(&path).ok_or_else(|| {
        serde_json::to_string(&TrunkError::new("repo_not_open", "Repository not open")).unwrap()
    })?;

    let len = graph_result.commits.len();
    let start = offset.min(len);
    let end = (offset + 200).min(len);
    Ok(GraphResponse {
        commits: graph_result.commits[start..end].to_vec(),
        max_columns: graph_result.max_columns,
    })
}

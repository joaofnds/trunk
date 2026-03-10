use serde::Serialize;
use tauri::State;
use crate::state::{CommitCache, RepoState};
use crate::error::TrunkError;
use crate::git::{graph, types::GraphCommit};

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

#[tauri::command]
pub async fn refresh_commit_graph(
    path: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
) -> Result<GraphResponse, String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();

    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        let path_buf = state_map
            .get(&path_clone)
            .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path_clone)))?;
        let mut repo = git2::Repository::open(path_buf).map_err(TrunkError::from)?;
        graph::walk_commits(&mut repo, 0, usize::MAX)
    })
    .await
    .map_err(|e| serde_json::to_string(&TrunkError::new("spawn_error", e.to_string())).unwrap())?
    .map_err(|e| serde_json::to_string(&e).unwrap())?;

    let len = graph_result.commits.len();
    let end = 200.min(len);
    let response = GraphResponse {
        commits: graph_result.commits[..end].to_vec(),
        max_columns: graph_result.max_columns,
    };

    cache.0.lock().unwrap().insert(path, graph_result);

    Ok(response)
}

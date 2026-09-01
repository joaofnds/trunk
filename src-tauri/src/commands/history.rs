use crate::error::TrunkError;
use crate::git::{
    graph,
    types::{DiffStat, GraphCommit, GraphResult, MatchType, SearchResult},
};
use crate::state::{CommitCache, CommitStatsCache, RepoState};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::State;

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
    let graph_result = lock
        .get(&path)
        .ok_or_else(|| TrunkError::new("not_open", "Repository not open").to_json())?;

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
        let path_buf = crate::commands::repo_path_from_state(&path_clone, &state_map)?;
        let mut repo = git2::Repository::open(path_buf).map_err(TrunkError::from)?;
        graph::walk_commits(&mut repo, 0, usize::MAX)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    let len = graph_result.commits.len();
    let end = 200.min(len);
    let response = GraphResponse {
        commits: graph_result.commits[..end].to_vec(),
        max_columns: graph_result.max_columns,
    };

    cache.0.lock().unwrap().insert(path, graph_result);

    Ok(response)
}

/// Diff-stat (insertions/deletions/files_changed) for one commit against its
/// first parent — or the empty tree for the root commit. Renames are collapsed
/// via `find_similar` so a pure move reports 0/0. Uses the cheap `Diff::stats()`
/// path, never the line-walking enrichment in `walk_diff`.
fn commit_stat_from_repo(repo: &git2::Repository, oid: git2::Oid) -> Result<DiffStat, TrunkError> {
    let commit = repo.find_commit(oid)?;
    let mut opts = crate::commands::diff::new_diff_options();
    let diff = crate::commands::diff::commit_diff(repo, &commit, &mut opts)?;
    let stats = diff.stats()?;
    Ok(DiffStat {
        insertions: stats.insertions(),
        deletions: stats.deletions(),
        files_changed: stats.files_changed(),
    })
}

/// Single-commit diff-stat by oid string. Opens the repo once.
pub fn commit_stat_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<DiffStat, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let oid =
        git2::Oid::from_str(oid).map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
    commit_stat_from_repo(&repo, oid)
}

/// Compute diff-stats for a batch of oids against a single repo handle. A per-oid
/// failure (malformed/missing oid, unreadable tree) inserts no entry and is
/// skipped — one bad commit must never fail the whole page.
pub fn compute_commit_stats_batch(
    path: &str,
    oids: &[String],
    state_map: &HashMap<String, PathBuf>,
) -> HashMap<String, DiffStat> {
    let Ok(repo) = crate::commands::open_repo_from_state(path, state_map) else {
        return HashMap::new();
    };
    let mut out = HashMap::with_capacity(oids.len());
    for oid_str in oids {
        let Ok(oid) = git2::Oid::from_str(oid_str) else {
            continue;
        };
        if let Ok(stat) = commit_stat_from_repo(&repo, oid) {
            out.insert(oid_str.clone(), stat);
        }
    }
    out
}

/// Combined working-state diff-stat: staged (HEAD→index) plus unstaged
/// (index→workdir, untracked files counted as insertions). Renames collapsed on
/// each side. Never cached — the working tree changes constantly.
///
/// `files_changed` counts *distinct* paths across both diffs — a file that is
/// both staged and unstaged-modified (`MM` in `git status`) is one changed file,
/// not two — so the count matches the WIP row's `repo.statuses()` badges.
pub fn wip_diff_stats_inner(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<DiffStat, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

    let mut staged_opts = crate::commands::diff::new_diff_options();
    let staged = crate::commands::diff::staged_diff(&repo, &mut staged_opts)?;

    let mut unstaged_opts = crate::commands::diff::new_diff_options();
    unstaged_opts.include_untracked(true);
    unstaged_opts.recurse_untracked_dirs(true);
    unstaged_opts.show_untracked_content(true);
    let mut unstaged = repo.diff_index_to_workdir(None, Some(&mut unstaged_opts))?;
    crate::commands::diff::detect_renames(&mut unstaged)?;

    let mut changed_paths = std::collections::HashSet::new();
    for delta in staged.deltas().chain(unstaged.deltas()) {
        if let Some(p) = delta.new_file().path().or_else(|| delta.old_file().path()) {
            changed_paths.insert(p.to_path_buf());
        }
    }

    let staged_stats = staged.stats()?;
    let unstaged_stats = unstaged.stats()?;

    Ok(DiffStat {
        insertions: staged_stats.insertions() + unstaged_stats.insertions(),
        deletions: staged_stats.deletions() + unstaged_stats.deletions(),
        files_changed: changed_paths.len(),
    })
}

/// Lazy per-page diff-stats for the graph's Diff column. Reads the cached graph
/// to resolve the page's oids, returns already-cached stats immediately, and
/// computes only the uncached ones on a blocking thread — caching them
/// immutably (a commit's diff never changes). Gated on the column being visible
/// by the caller, so a hidden column does zero work.
#[tauri::command]
pub async fn get_commit_stats(
    path: String,
    offset: usize,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    stats: State<'_, CommitStatsCache>,
) -> Result<HashMap<String, DiffStat>, String> {
    // Resolve the page's oids from the topology cache (lock dropped immediately).
    let page_oids: Vec<String> = {
        let lock = cache.0.lock().unwrap();
        let graph_result = lock
            .get(&path)
            .ok_or_else(|| TrunkError::new("not_open", "Repository not open").to_json())?;
        let len = graph_result.commits.len();
        let start = offset.min(len);
        let end = (offset + 200).min(len);
        graph_result.commits[start..end]
            .iter()
            .map(|c| c.oid.clone())
            .collect()
    };

    // Partition into already-cached (return verbatim) and uncached (compute).
    let (uncached, mut result): (Vec<String>, HashMap<String, DiffStat>) = {
        let lock = stats.0.lock().unwrap();
        let existing = lock.get(&path);
        let mut uncached = Vec::new();
        let mut result = HashMap::new();
        for oid in page_oids {
            match existing.and_then(|m| m.get(&oid)) {
                Some(stat) => {
                    result.insert(oid, stat.clone());
                }
                None => uncached.push(oid),
            }
        }
        (uncached, result)
    };

    if uncached.is_empty() {
        return Ok(result);
    }

    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let computed = tauri::async_runtime::spawn_blocking(move || {
        compute_commit_stats_batch(&path_clone, &uncached, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?;

    // Merge the newly computed stats into the immutable per-oid cache.
    {
        let mut lock = stats.0.lock().unwrap();
        let entry = lock.entry(path).or_default();
        for (oid, stat) in &computed {
            entry.insert(oid.clone(), stat.clone());
        }
    }
    result.extend(computed);
    Ok(result)
}

/// Uncached diff-stat for the synthetic WIP row. Recomputed on every refresh,
/// gated on column visibility by the caller.
#[tauri::command]
pub async fn get_wip_diff_stats(
    path: String,
    state: State<'_, RepoState>,
) -> Result<DiffStat, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || wip_diff_stats_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

pub fn search_commits_inner(
    path: &str,
    query: &str,
    cache_map: &HashMap<String, GraphResult>,
) -> Result<Vec<SearchResult>, TrunkError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let q = query.to_lowercase();

    let graph_result = cache_map
        .get(path)
        .ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {}", path)))?;

    let mut results = Vec::new();
    for commit in &graph_result.commits {
        let mut match_types = Vec::new();

        // SHA prefix match
        if commit.oid.to_lowercase().starts_with(&q) {
            match_types.push(MatchType::Sha);
        }

        // Message match (summary + body)
        if commit.summary.to_lowercase().contains(&q) {
            match_types.push(MatchType::Message);
        } else if let Some(ref body) = commit.body
            && body.to_lowercase().contains(&q)
        {
            match_types.push(MatchType::Message);
        }

        // Ref match (short_name)
        if commit
            .refs
            .iter()
            .any(|r| r.short_name.to_lowercase().contains(&q))
        {
            match_types.push(MatchType::Ref);
        }

        // Author match
        if commit.author_name.to_lowercase().contains(&q) {
            match_types.push(MatchType::Author);
        }

        if !match_types.is_empty() {
            results.push(SearchResult {
                oid: commit.oid.clone(),
                match_types,
            });
        }
    }

    Ok(results)
}

#[tauri::command]
pub async fn search_commits(
    path: String,
    query: String,
    cache: State<'_, CommitCache>,
) -> Result<Vec<SearchResult>, String> {
    let cache_map = cache.0.lock().unwrap().clone();
    search_commits_inner(&path, &query, &cache_map).map_err(|e| e.to_json())
}

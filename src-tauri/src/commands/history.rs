use crate::error::TrunkError;
use crate::git::graph_input::GraphSnapshot;
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

/// Rows per page. The frontend's own BATCH must match: it decides there whether a
/// short response means the end of history.
const PAGE: usize = 200;

impl GraphResponse {
    /// The `PAGE`-row page of `layout` starting at `offset`, empty past the end.
    fn page(layout: &GraphResult, offset: usize) -> GraphResponse {
        Self::rows(layout, offset, offset + PAGE)
    }

    /// The first `loaded` rows of `layout`, or one page when the caller has none.
    ///
    /// A rebuild answers this way so the caller keeps the depth it had already paged
    /// in. Returning page one alone would drop every later page it holds, and it has
    /// no way to tell that loss from a history that genuinely shrank.
    pub fn head(layout: &GraphResult, loaded: usize) -> GraphResponse {
        Self::rows(layout, 0, loaded.max(PAGE))
    }

    fn rows(layout: &GraphResult, start: usize, end: usize) -> GraphResponse {
        let len = layout.commits.len();

        GraphResponse {
            commits: layout.commits[start.min(len)..end.min(len)].to_vec(),
            max_columns: layout.max_columns,
        }
    }
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

    Ok(GraphResponse::page(&graph_result.layout, offset))
}

#[tauri::command]
pub async fn refresh_commit_graph(
    path: String,
    loaded: usize,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
) -> Result<GraphResponse, String> {
    let visibility = ref_visibility.get(&path);
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();

    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        let path_buf = crate::commands::repo_path_from_state(&path_clone, &state_map)?;
        let mut repo = git2::Repository::open(path_buf).map_err(TrunkError::from)?;
        graph::snapshot(&mut repo, &visibility)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    let response = GraphResponse::head(&graph_result.layout, loaded);

    cache.0.lock().unwrap().insert(path, graph_result);

    Ok(response)
}

/// Record which refs the user has hidden for a repository and rebuild its graph.
///
/// The visibility is stored before the walk, so every later rebuild — a commit, a checkout,
/// a stash, the file watcher — sees the same set without the frontend having to resend it.
/// The frontend persists it to prefs in parallel with this call.
#[tauri::command]
pub async fn set_ref_visibility(
    path: String,
    visibility: crate::git::graph_input::RefVisibility,
    loaded: usize,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
) -> Result<GraphResponse, String> {
    ref_visibility.set(path.clone(), visibility.clone());

    let cached = cache.0.lock().unwrap().get(&path).cloned();
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();
    let read = cached.clone();

    let graph_result = tauri::async_runtime::spawn_blocking(move || {
        set_ref_visibility_inner(&path_clone, &visibility, cached.as_ref(), &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    let response = GraphResponse::head(&graph_result.layout, loaded);

    write_relaid_out_graph(&cache, path, read.as_ref(), graph_result);

    Ok(response)
}

/// Store a toggle's re-laid-out graph, unless a fresher rebuild already replaced the entry
/// this toggle read. That rebuild's capture is newer than the one this graph was re-laid out
/// from, so writing over it would show a graph from before whatever it just did (TRUNK-129).
fn write_relaid_out_graph(
    cache: &CommitCache,
    path: String,
    read: Option<&GraphSnapshot>,
    relaid_out: GraphSnapshot,
) {
    let mut cache = cache.0.lock().unwrap();
    let still_current = match (cache.get(&path), read) {
        (Some(current), Some(read)) => current.same_capture_as(read),
        (None, None) => true,
        _ => false,
    };
    if still_current {
        cache.insert(path, relaid_out);
    }
}

/// The graph under a new visibility. The cached snapshot answers without touching the
/// repository; only a repository whose first graph is still being built has none, and that
/// one is walked as it always was.
pub fn set_ref_visibility_inner(
    path: &str,
    visibility: &crate::git::graph_input::RefVisibility,
    cached: Option<&GraphSnapshot>,
    state_map: &HashMap<String, PathBuf>,
) -> Result<GraphSnapshot, TrunkError> {
    if let Some(snapshot) = cached {
        return Ok(snapshot.with_visibility(visibility.clone()));
    }

    let path_buf = crate::commands::repo_path_from_state(path, state_map)?;
    let mut repo = git2::Repository::open(path_buf).map_err(TrunkError::from)?;
    graph::snapshot(&mut repo, visibility)
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
        let len = graph_result.layout.commits.len();
        let start = offset.min(len);
        let end = (offset + 200).min(len);
        graph_result.layout.commits[start..end]
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
    cache_map: &HashMap<String, GraphSnapshot>,
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
    for commit in &graph_result.layout.commits {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::graph_input::{GraphSource, RefVisibility};
    use std::sync::Mutex;

    /// An empty graph tagged by the ref it hides, so a test can tell two snapshots apart
    /// by their visibility while both carry an empty capture.
    fn graph(tag: &str) -> GraphSnapshot {
        let mut visibility = RefVisibility::default();
        visibility.hidden_refs.insert(format!("refs/tags/{tag}"));
        GraphSnapshot::new(GraphSource::default(), visibility)
    }

    #[test]
    fn a_toggle_does_not_overwrite_a_rebuild_that_landed_while_it_relaid_out() {
        let cache = CommitCache(Mutex::new(HashMap::new()));
        let read = graph("pre-commit");
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), read.clone());

        // A commit's rebuild replaces the entry with a fresh capture while the toggle's
        // relayout of the stale one is still in flight off-thread.
        let fresher = graph("post-commit");
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), fresher.clone());

        let relaid_out = read.with_visibility(graph("toggled").visibility().clone());
        write_relaid_out_graph(&cache, "/repo".to_owned(), Some(&read), relaid_out);

        let cached = cache.0.lock().unwrap();
        assert_eq!(
            cached["/repo"].visibility(),
            fresher.visibility(),
            "the toggle overwrote a rebuild that landed after it read the cache"
        );
    }

    #[test]
    fn a_toggle_writes_its_graph_when_nothing_landed_ahead_of_it() {
        let cache = CommitCache(Mutex::new(HashMap::new()));
        let read = graph("pre-toggle");
        cache
            .0
            .lock()
            .unwrap()
            .insert("/repo".to_owned(), read.clone());

        let relaid_out = read.with_visibility(graph("toggled").visibility().clone());
        write_relaid_out_graph(&cache, "/repo".to_owned(), Some(&read), relaid_out.clone());

        let cached = cache.0.lock().unwrap();
        assert_eq!(cached["/repo"].visibility(), relaid_out.visibility());
    }
}

use crate::state::{CommitCache, CommitStatsCache, OpenRepos, RepoState};
use crate::types::{DiffStat, MatchType, SearchResult};
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;
use trunk_git::error::TrunkError;
use trunk_git::graph_input::GraphSnapshot;
use trunk_git::types::{GraphCommit, GraphResult};

#[derive(Debug, Serialize, Clone)]
pub struct GraphResponse {
    pub commits: Vec<GraphCommit>,
    pub max_columns: usize,
    pub revision: u64,
}

/// Rows per page. The frontend's own BATCH must match: it decides there whether a
/// short response means the end of history.
const PAGE: usize = 200;

/// The rows of `layout` in `[start, end)`, clamped to what the layout holds.
fn slice(layout: &GraphResult, start: usize, end: usize) -> &[GraphCommit] {
    let len = layout.commits.len();

    &layout.commits[start.min(len)..end.min(len)]
}

impl GraphResponse {
    /// The `PAGE`-row page of `layout` starting at `offset`, empty past the end.
    fn page(layout: &GraphResult, offset: usize, revision: u64) -> Self {
        Self::rows(layout, offset, offset.saturating_add(PAGE), revision)
    }

    /// The first `loaded` rows of `layout`, or one page when the caller has none.
    ///
    /// A rebuild answers this way so the caller keeps the depth it had already paged
    /// in. Returning page one alone would drop every later page it holds, and it has
    /// no way to tell that loss from a history that genuinely shrank.
    #[must_use]
    pub fn head(layout: &GraphResult, loaded: usize, revision: u64) -> Self {
        Self::rows(layout, 0, loaded.max(PAGE), revision)
    }

    fn rows(layout: &GraphResult, start: usize, end: usize, revision: u64) -> Self {
        Self {
            commits: slice(layout, start, end).to_vec(),
            max_columns: layout.max_columns,
            revision,
        }
    }
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn get_commit_graph(
    path: String,
    offset: usize,
    loaded: Option<usize>,
    revision: Option<u64>,
    cache: State<'_, CommitCache>,
) -> Result<GraphResponse, String> {
    cache
        .read_versioned(&path, revision, |graph, revision| {
            loaded.map_or_else(
                || GraphResponse::page(&graph.layout, offset, revision),
                |loaded| GraphResponse::head(&graph.layout, loaded, revision),
            )
        })
        .map_err(|e| e.to_json())
}

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn refresh_commit_graph(
    path: String,
    loaded: usize,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
) -> Result<GraphResponse, String> {
    let session = cache.capture_session(&path).map_err(|e| e.to_json())?;
    let state_map = state.snapshot();
    refresh_graph_in_session(&path, loaded, state_map, &cache, &ref_visibility, session)
        .await
        .map_err(|e| e.to_json())
}

async fn refresh_graph_in_session(
    path: &str,
    loaded: usize,
    state_map: OpenRepos,
    cache: &CommitCache,
    ref_visibility: &crate::state::RefVisibilityState,
    session: u64,
) -> Result<GraphResponse, TrunkError> {
    let rebuild = crate::state::GraphRebuild::new(cache, ref_visibility);
    let path_clone = path.to_owned();
    rebuild
        .rebuild_in_session(path.to_owned(), session, move || {
            let path_buf = state_map.path_for(&path_clone)?;
            let mut repo = git2::Repository::open(path_buf).map_err(TrunkError::from)?;
            crate::state::read_graph(&mut repo)
        })
        .await?;

    cache.read_versioned(path, None, |graph, revision| {
        GraphResponse::head(&graph.layout, loaded, revision)
    })
}

/// Record which refs the user has hidden for a repository and rebuild its graph.
///
/// The visibility is stored before the walk, so every later rebuild — a commit, a checkout,
/// a stash, the file watcher — sees the same set without the frontend having to resend it.
/// The frontend persists it to prefs in parallel with this call.
///
/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn set_ref_visibility(
    path: String,
    visibility: trunk_git::graph_input::RefVisibility,
    loaded: usize,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    ref_visibility: State<'_, crate::state::RefVisibilityState>,
) -> Result<GraphResponse, String> {
    let session = cache.capture_session(&path).map_err(|e| e.to_json())?;
    ref_visibility.set(path.clone(), visibility.clone());

    let (gate, ticket) = cache
        .begin_rebuild(&path, session)
        .await
        .map_err(|e| e.to_json())?;
    let visibility = ref_visibility.get(&path);

    let Some(cached) = cache.snapshot(&path) else {
        drop(gate);
        return refresh_graph_in_session(
            &path,
            loaded,
            state.snapshot(),
            &cache,
            &ref_visibility,
            session,
        )
        .await
        .map_err(|e| e.to_json());
    };
    let read = cached.clone();

    let graph_result =
        tauri::async_runtime::spawn_blocking(move || cached.with_visibility(visibility))
            .await
            .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?;

    crate::state::GraphRebuild::new(&cache, &ref_visibility)
        .publish_relayout(path.clone(), &read, graph_result, ticket)
        .await
        .map_err(|e| e.to_json())?;
    cache
        .read_versioned(&path, None, |graph, revision| {
            GraphResponse::head(&graph.layout, loaded, revision)
        })
        .map_err(|e| e.to_json())
}

/// Diff-stat (`insertions/deletions/files_changed`) for one commit against its
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

/// One commit's insertions, deletions and file count, by oid string.
///
/// Opens the repo once.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, `invalid_oid` when the oid will
/// not parse, and the git error when the commit is missing or its diff will
/// not build.
pub fn commit_stat_inner(
    path: &str,
    oid: &str,
    state_map: &OpenRepos,
) -> Result<DiffStat, TrunkError> {
    let repo = state_map.open(path)?;
    let oid =
        git2::Oid::from_str(oid).map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
    commit_stat_from_repo(&repo, oid)
}

/// Compute diff-stats for a batch of oids against a single repo handle.
///
/// A per-oid failure (malformed/missing oid, unreadable tree) inserts no entry and is
/// skipped — one bad commit must never fail the whole page.
#[must_use]
pub fn compute_commit_stats_batch(
    path: &str,
    oids: &[String],
    state_map: &OpenRepos,
) -> HashMap<String, DiffStat> {
    let Ok(repo) = state_map.open(path) else {
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

/// Combined working-state diff-stat: staged (HEAD→index) plus unstaged (index→workdir,
/// untracked files counted as insertions).
///
/// Renames collapsed on each side. Never cached — the working tree changes constantly.
///
/// `files_changed` counts *distinct* paths across both diffs — a file that is
/// both staged and unstaged-modified (`MM` in `git status`) is one changed file,
/// not two — so the count matches the WIP row's `repo.statuses()` badges.
/// The working tree's combined staged and unstaged stats, for the WIP row.
///
/// # Errors
///
/// Returns `not_open` when `path` names no open repository, and the git error when either
/// diff will not build.
pub fn wip_diff_stats_inner(path: &str, state_map: &OpenRepos) -> Result<DiffStat, TrunkError> {
    let repo = state_map.open(path)?;

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

/// Lazy per-page diff-stats for the graph's Diff column.
///
/// Reads the cached graph to resolve the page's oids, returns already-cached
/// stats immediately, and computes only the uncached ones on a blocking thread —
/// caching them immutably (a commit's diff never changes). Gated on the column
/// being visible by the caller, so a hidden column does zero work.
///
/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn get_commit_stats(
    path: String,
    offset: usize,
    revision: Option<u64>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    commit_stats: State<'_, CommitStatsCache>,
) -> Result<HashMap<String, DiffStat>, String> {
    let compute_path = path.clone();
    cached_commit_stats(
        &path,
        offset,
        revision,
        &cache,
        &commit_stats,
        |uncached| async move {
            let state_map = state.snapshot();
            tauri::async_runtime::spawn_blocking(move || {
                compute_commit_stats_batch(&compute_path, &uncached, &state_map)
            })
            .await
            .map_err(|error| TrunkError::new("spawn_error", error.to_string()))
        },
    )
    .await
    .map_err(|error| error.to_json())
}

async fn cached_commit_stats<F, C>(
    path: &str,
    offset: usize,
    revision: Option<u64>,
    cache: &CommitCache,
    commit_stats: &CommitStatsCache,
    compute: F,
) -> Result<HashMap<String, DiffStat>, TrunkError>
where
    F: FnOnce(Vec<String>) -> C,
    C: std::future::Future<Output = Result<HashMap<String, DiffStat>, TrunkError>>,
{
    // Resolve the page's oids from the topology cache (lock dropped immediately).
    let page = cache.read_versioned_with_session(path, revision, |graph, _| {
        slice(&graph.layout, offset, offset.saturating_add(PAGE))
            .iter()
            .map(|commit| commit.oid.clone())
            .collect::<Vec<_>>()
    })?;

    // Partition into already-cached (return verbatim) and uncached (compute).
    let (uncached, mut result): (Vec<String>, HashMap<String, DiffStat>) = {
        let cached = commit_stats.0.lock().unwrap();
        let mut uncached = Vec::new();
        let mut result = HashMap::new();
        for oid in page.value {
            match cached.get(path, &oid) {
                Some(stat) => {
                    result.insert(oid, stat.clone());
                }
                None => uncached.push(oid),
            }
        }
        drop(cached);
        (uncached, result)
    };

    if uncached.is_empty() {
        return Ok(result);
    }

    let computed = compute(uncached).await?;

    // The OID results stay useful after a revision change, but belong only to
    // the opening session that requested them. Keep them before rejecting a stale response.
    cache.store_stats_in_session(
        path,
        page.session,
        commit_stats,
        computed
            .iter()
            .map(|(oid, stat)| (oid.clone(), stat.clone())),
    )?;
    cache.require_revision(path, page.revision)?;
    result.extend(computed);
    Ok(result)
}

/// Uncached diff-stat for the synthetic WIP row. Recomputed on every refresh,
/// gated on column visibility by the caller.
///
/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn get_wip_diff_stats(
    path: String,
    state: State<'_, RepoState>,
) -> Result<DiffStat, String> {
    let state_map = state.snapshot();
    tauri::async_runtime::spawn_blocking(move || wip_diff_stats_inner(&path, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// One commit's diff-stat, for `CommitDetail`'s stats bar.
///
/// Reuses `commit_stats` when the graph's Diff column (or an earlier call here)
/// already computed this commit, and never depends on that column's
/// page/visibility gate.
///
/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses, or
/// `spawn_error` when the blocking task cannot be joined.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn commit_stat(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    commit_stats: State<'_, CommitStatsCache>,
) -> Result<DiffStat, String> {
    let path_clone = path.clone();
    let oid_clone = oid.clone();
    cached_commit_stat(&path, &oid, &cache, &commit_stats, || async move {
        let state_map = state.snapshot();
        tauri::async_runtime::spawn_blocking(move || {
            commit_stat_inner(&path_clone, &oid_clone, &state_map)
        })
        .await
        .map_err(|error| TrunkError::new("spawn_error", error.to_string()))?
    })
    .await
    .map_err(|e| e.to_json())
}

async fn cached_commit_stat<F, C>(
    path: &str,
    oid: &str,
    cache: &CommitCache,
    commit_stats: &CommitStatsCache,
    compute: F,
) -> Result<DiffStat, TrunkError>
where
    F: FnOnce() -> C,
    C: std::future::Future<Output = Result<DiffStat, TrunkError>>,
{
    let session = cache.capture_session(path)?;
    if let Some(stat) = commit_stats.0.lock().unwrap().get(path, oid) {
        return Ok(stat.clone());
    }
    let stat = compute().await?;
    cache.store_stats_in_session(
        path,
        session,
        commit_stats,
        [(oid.to_owned(), stat.clone())],
    )?;
    Ok(stat)
}

/// Commits in the cached graph whose subject or oid matches `query`.
///
/// # Errors
///
/// Returns `not_open` when `path` names no repository in the graph cache. An
/// empty query is not an error: it answers with no results.
pub fn search_commits_inner(
    path: &str,
    query: &str,
    graph: Option<&GraphSnapshot>,
) -> Result<Vec<SearchResult>, TrunkError> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let q = query.to_lowercase();

    let graph_result =
        graph.ok_or_else(|| TrunkError::new("not_open", format!("Repository not open: {path}")))?;

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

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
#[tauri::command]
pub async fn search_commits(
    path: String,
    query: String,
    cache: State<'_, CommitCache>,
) -> Result<Vec<SearchResult>, String> {
    let graph = cache.snapshot(&path);
    search_commits_inner(&path, &query, graph.as_ref()).map_err(|e| e.to_json())
}

#[cfg(test)]
mod tests {
    use super::{GraphResponse, cached_commit_stat, cached_commit_stats};
    use crate::state::{
        CommitCache, CommitStatsCache, GraphCache, GraphRebuild, RefVisibilityState, StatsCache,
    };
    use crate::types::DiffStat;
    use std::collections::{HashMap, HashSet};
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use trunk_git::graph_input::{CommitFacts, GraphSnapshot, GraphSource, RefVisibility};
    use trunk_git::placement::PlacementInput;
    use trunk_git::types::{RefLabel, RefType};

    fn source() -> GraphSource {
        let oid = git2::Oid::from_str("0000000000000000000000000000000000000001").unwrap();
        GraphSource {
            placement: PlacementInput {
                oids: vec![oid],
                parents: HashMap::from([(oid, vec![])]),
                stashes: HashSet::new(),
                head_tip: Some(oid),
                tracked_upstream: None,
                worktree_dirty: false,
            },
            commits: HashMap::from([(
                oid,
                CommitFacts {
                    summary: "one".into(),
                    body: None,
                    author_name: "T".into(),
                    author_email: "t@example.com".into(),
                    author_timestamp: 1000,
                },
            )]),
            refs: HashMap::from([(
                oid,
                vec![RefLabel {
                    name: "refs/heads/main".into(),
                    short_name: "main".into(),
                    ref_type: RefType::LocalBranch,
                    is_head: true,
                    color_index: 0,
                }],
            )]),
            stash_order: vec![],
        }
    }

    fn cache() -> CommitCache {
        let mut graphs = GraphCache::default();
        graphs.seed(
            "/repo".into(),
            GraphSnapshot::new(source(), RefVisibility::default()),
        );
        CommitCache::new(graphs)
    }

    fn stats(oid: String) -> HashMap<String, DiffStat> {
        HashMap::from([(
            oid,
            DiffStat {
                insertions: 7,
                deletions: 2,
                files_changed: 1,
            },
        )])
    }

    #[test]
    fn a_maximum_offset_returns_no_graph_rows_or_stats_and_keeps_the_cache_readable() {
        let cache = cache();
        let stored = CommitStatsCache(Mutex::new(StatsCache::default()));
        let graph = cache.snapshot("/repo").unwrap();
        let page = GraphResponse::page(&graph.layout, usize::MAX, 1);
        let result = tauri::async_runtime::block_on(cached_commit_stats(
            "/repo",
            usize::MAX,
            None,
            &cache,
            &stored,
            |_| async { panic!("an empty page must not compute stats") },
        ))
        .unwrap();

        assert!(page.commits.is_empty());
        assert!(result.is_empty());
        assert!(cache.snapshot("/repo").is_some());
    }

    #[test]
    fn stats_completed_across_a_revision_change_are_reused() {
        let cache = cache();
        let stored = CommitStatsCache(Mutex::new(StatsCache::default()));
        let visibility = RefVisibilityState::default();
        let computations = AtomicUsize::new(0);

        let stale = tauri::async_runtime::block_on(cached_commit_stats(
            "/repo",
            0,
            None,
            &cache,
            &stored,
            |oids| {
                let computed = stats(oids[0].clone());
                let cache = &cache;
                let visibility = &visibility;
                let computations = &computations;
                async move {
                    computations.fetch_add(1, Ordering::Relaxed);
                    GraphRebuild::new(cache, visibility)
                        .rebuild("/repo".into(), || Ok(source()))
                        .await?;
                    Ok(computed)
                }
            },
        ))
        .unwrap_err();
        let reused = tauri::async_runtime::block_on(cached_commit_stats(
            "/repo",
            0,
            None,
            &cache,
            &stored,
            |oids| {
                computations.fetch_add(1, Ordering::Relaxed);
                std::future::ready(Ok(stats(oids[0].clone())))
            },
        ))
        .unwrap();

        assert_eq!(stale.code, "graph_changed");
        assert_eq!(
            computations.load(Ordering::Relaxed),
            1,
            "immutable stats were recomputed after the graph revision changed"
        );
        assert_eq!(reused.values().next().unwrap().insertions, 7);
    }

    #[test]
    fn stats_from_a_closed_opening_session_are_discarded() {
        let cache = cache();
        let stored = CommitStatsCache(Mutex::new(StatsCache::default()));
        let visibility = RefVisibilityState::default();

        let stale = tauri::async_runtime::block_on(cached_commit_stats(
            "/repo",
            0,
            None,
            &cache,
            &stored,
            |oids| {
                let computed = stats(oids[0].clone());
                let cache = &cache;
                let stored = &stored;
                let visibility = &visibility;
                async move {
                    cache.forget("/repo");
                    stored.0.lock().unwrap().forget("/repo");
                    cache.open_session("/repo");
                    GraphRebuild::new(cache, visibility)
                        .rebuild("/repo".into(), || Ok(source()))
                        .await?;
                    Ok(computed)
                }
            },
        ))
        .unwrap_err();

        assert_eq!(stale.code, "not_open");
        assert!(
            stored
                .0
                .lock()
                .unwrap()
                .get("/repo", "0000000000000000000000000000000000000001")
                .is_none()
        );
    }

    #[test]
    fn detail_stats_from_a_closed_opening_session_are_discarded() {
        let cache = cache();
        let stored = CommitStatsCache(Mutex::new(StatsCache::default()));
        let oid = "0000000000000000000000000000000000000001";
        let computed = stats(oid.to_owned()).remove(oid).unwrap();

        let stale = tauri::async_runtime::block_on(cached_commit_stat(
            "/repo",
            oid,
            &cache,
            &stored,
            || async {
                cache.forget("/repo");
                stored.0.lock().unwrap().forget("/repo");
                cache.open_session("/repo");
                Ok(computed)
            },
        ));

        assert_eq!(stale.unwrap_err().code, "not_open");
        assert!(stored.0.lock().unwrap().get("/repo", oid).is_none());
    }
}

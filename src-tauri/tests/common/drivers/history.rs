use crate::common::context::TestContext;
use std::collections::HashMap;
use trunk_lib::commands::history;
use trunk_lib::error::TrunkError;
use trunk_lib::git::graph_input::RefVisibility;
use trunk_lib::git::types::{DiffStat, SearchResult};

impl TestContext {
    /// Search commits by query string (matches SHA, message, ref, author).
    /// Requires `cache_map` to be populated first via `populate_cache()`.
    pub fn search_commits(&self, query: &str) -> Result<Vec<SearchResult>, TrunkError> {
        history::search_commits_inner(self.path(), query, &self.cache_map)
    }

    /// Diff-stat for a single commit (insertions/deletions/files vs first parent,
    /// or empty tree for the root). Renames detected. Mirrors `get_commit_stats`'
    /// per-oid computation.
    pub fn commit_stat(&self, oid: &str) -> Result<DiffStat, TrunkError> {
        history::commit_stat_inner(self.path(), oid, self.state_map())
    }

    /// Batch diff-stats: bad/missing oids are skipped, not fatal. Mirrors the
    /// `spawn_blocking` body of `get_commit_stats`.
    pub fn commit_stats_batch(&self, oids: &[String]) -> HashMap<String, DiffStat> {
        history::compute_commit_stats_batch(self.path(), oids, self.state_map())
    }

    /// Combined working-state diff-stat (staged HEAD→index + unstaged index→workdir
    /// with untracked). Mirrors `get_wip_diff_stats`.
    pub fn wip_diff_stats(&self) -> Result<DiffStat, TrunkError> {
        history::wip_diff_stats_inner(self.path(), self.state_map())
    }

    /// Populate the graph cache by taking a graph snapshot of the test repo.
    /// Must be called before `search_commits` to have data to search.
    pub fn populate_cache(&mut self) {
        let mut repo = self.repo();
        let result = trunk_lib::git::graph::snapshot(&mut repo, &RefVisibility::default())
            .expect("snapshot failed");
        self.cache_map.insert(self.path.clone(), result);
    }
}

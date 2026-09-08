use crate::common::context::TestContext;
use trunk_lib::commands::stash;
use trunk_lib::error::TrunkError;
use trunk_lib::git::graph_input::{GraphSnapshot, GraphSource, RefVisibility};
use trunk_lib::git::types::StashEntry;

/// A driver method's contract predates `GraphRebuild`'s capture/lay-out split: it hands back
/// a laid-out `GraphSnapshot`, same as before. Laying the capture out under the default
/// (nothing hidden) visibility here is what keeps that contract, now that `*_inner` returns
/// the bare capture (TRUNK-125).
fn snapshot(source: Result<GraphSource, TrunkError>) -> Result<GraphSnapshot, TrunkError> {
    source.map(|source| GraphSnapshot::new(source, RefVisibility::default()))
}

impl TestContext {
    pub fn list_stashes(&self) -> Result<Vec<StashEntry>, TrunkError> {
        stash::list_stashes_inner(self.path(), self.state_map())
    }

    pub fn stash_save(&self, message: &str) -> Result<GraphSnapshot, TrunkError> {
        snapshot(stash::stash_save_inner(
            self.path(),
            message,
            self.state_map(),
        ))
    }

    /// The most recent stash, for tests whose subject is not which entry is picked.
    pub fn top_stash_oid(&self) -> String {
        self.list_stashes().unwrap()[0].oid.clone()
    }

    pub fn stash_pop(&self, oid: &str) -> Result<GraphSnapshot, TrunkError> {
        snapshot(stash::stash_pop_inner(self.path(), oid, self.state_map()))
    }

    pub fn stash_apply(&self, oid: &str) -> Result<GraphSnapshot, TrunkError> {
        snapshot(stash::stash_apply_inner(self.path(), oid, self.state_map()))
    }

    pub fn stash_drop(&self, oid: &str) -> Result<GraphSnapshot, TrunkError> {
        snapshot(stash::stash_drop_inner(self.path(), oid, self.state_map()))
    }
}

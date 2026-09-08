use crate::common::context::TestContext;
use trunk_lib::commands::commit_actions::{self, RevertBeginResult};
use trunk_lib::error::TrunkError;
use trunk_lib::git::graph_input::{GraphSnapshot, RefVisibility};
use trunk_lib::git::types::UndoResult;

/// A driver method's contract predates `GraphRebuild`'s capture/lay-out split: it hands back
/// a laid-out `GraphSnapshot`, same as before. Laying the capture out under the default
/// (nothing hidden) visibility here is what keeps that contract, now that `*_inner` returns
/// the bare capture (TRUNK-125).
fn snapshot(
    source: Result<trunk_lib::git::graph_input::GraphSource, TrunkError>,
) -> Result<GraphSnapshot, TrunkError> {
    source.map(|source| GraphSnapshot::new(source, RefVisibility::default()))
}

impl TestContext {
    /// Checkout (detach HEAD to) a specific commit by OID
    pub fn checkout_commit(&self, oid: &str) -> Result<GraphSnapshot, TrunkError> {
        snapshot(commit_actions::checkout_commit_inner(
            self.path(),
            oid,
            self.state_map(),
        ))
    }

    /// Create an annotated tag at a specific OID
    pub fn create_tag(
        &self,
        oid: &str,
        tag_name: &str,
        message: &str,
    ) -> Result<GraphSnapshot, TrunkError> {
        snapshot(commit_actions::create_tag_inner(
            self.path(),
            oid,
            tag_name,
            message,
            self.state_map(),
        ))
    }

    /// Delete a tag by name
    pub fn delete_tag(&self, tag_name: &str) -> Result<GraphSnapshot, TrunkError> {
        snapshot(commit_actions::delete_tag_inner(
            self.path(),
            tag_name,
            self.state_map(),
        ))
    }

    /// Cherry-pick a commit by OID onto the current branch (shells out to git CLI)
    pub fn cherry_pick(&self, oid: &str) -> Result<GraphSnapshot, TrunkError> {
        snapshot(commit_actions::cherry_pick_inner(
            self.path(),
            oid,
            self.state_map(),
        ))
    }

    /// Finish a conflicted cherry-pick with the given message.
    pub fn cherry_pick_continue(&self, message: &str) -> Result<GraphSnapshot, TrunkError> {
        snapshot(commit_actions::cherry_pick_continue_inner(
            self.path(),
            message,
            self.state_map(),
        ))
    }

    /// Abort an in-progress cherry-pick, restoring a clean tree.
    pub fn cherry_pick_abort(&self) -> Result<GraphSnapshot, TrunkError> {
        snapshot(commit_actions::cherry_pick_abort_inner(
            self.path(),
            self.state_map(),
        ))
    }

    /// Stage a revert without committing (two-step begin); shells out to git CLI.
    /// Returns the rebuilt graph + default message read from `MERGE_MSG`.
    pub fn revert_commit_begin(&self, oid: &str) -> Result<RevertBeginResult, TrunkError> {
        let (source, message) =
            commit_actions::revert_commit_begin_inner(self.path(), oid, self.state_map())?;
        Ok(RevertBeginResult {
            graph: GraphSnapshot::new(source, RefVisibility::default()),
            message,
        })
    }

    /// Finish a staged revert with the edited message (git commit -m --cleanup=strip).
    pub fn revert_continue(&self, message: &str) -> Result<GraphSnapshot, TrunkError> {
        snapshot(commit_actions::revert_continue_inner(
            self.path(),
            message,
            self.state_map(),
        ))
    }

    /// Abort a staged revert (git revert --abort), restoring a clean tree.
    pub fn revert_abort(&self) -> Result<GraphSnapshot, TrunkError> {
        snapshot(commit_actions::revert_abort_inner(
            self.path(),
            self.state_map(),
        ))
    }

    /// Reset HEAD to a commit by OID with the given mode (soft/mixed/hard)
    pub fn reset_to_commit(&self, oid: &str, mode: &str) -> Result<GraphSnapshot, TrunkError> {
        snapshot(commit_actions::reset_to_commit_inner(
            self.path(),
            oid,
            mode,
            self.state_map(),
        ))
    }

    /// Undo the last commit (soft reset HEAD~1), returning the undone commit message
    pub fn undo_commit(&self) -> Result<UndoResult, TrunkError> {
        commit_actions::undo_commit_inner(self.path(), self.state_map())
    }

    /// Redo a previously undone commit by creating a new commit with the given message,
    /// refusing unless HEAD is still at `expected_head_oid`
    pub fn redo_commit(
        &self,
        subject: &str,
        body: Option<&str>,
        expected_head_oid: &str,
    ) -> Result<(), TrunkError> {
        commit_actions::redo_commit_inner(
            self.path(),
            subject,
            body,
            expected_head_oid,
            self.path(),
            self.state_map(),
        )
    }

    /// Check whether the current HEAD commit can be undone
    pub fn check_undo_available(&self) -> Result<bool, TrunkError> {
        commit_actions::check_undo_available_inner(self.path(), self.state_map())
    }
}

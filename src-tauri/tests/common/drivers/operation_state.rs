use crate::common::context::TestContext;
use trunk_lib::commands::operation_state;
use trunk_lib::commands::operation_state::MergeBeginResult;
use trunk_lib::error::TrunkError;
use trunk_lib::git::graph_input::{GraphSnapshot, GraphSource, RefVisibility};
use trunk_lib::git::types::OperationInfo;

/// A driver method's contract predates `GraphRebuild`'s capture/lay-out split: it hands back
/// a laid-out `GraphSnapshot`, same as before. Laying the capture out under the default
/// (nothing hidden) visibility here is what keeps that contract, now that `*_inner` returns
/// the bare capture (TRUNK-125).
fn snapshot(source: Result<GraphSource, TrunkError>) -> Result<GraphSnapshot, TrunkError> {
    source.map(|source| GraphSnapshot::new(source, RefVisibility::default()))
}

impl TestContext {
    pub fn get_operation_state(&self) -> Result<OperationInfo, TrunkError> {
        operation_state::get_operation_state_inner(self.path(), self.state_map())
    }

    pub fn merge_continue(&self, message: Option<&str>) -> Result<GraphSnapshot, TrunkError> {
        snapshot(operation_state::merge_continue_inner(
            self.path(),
            message,
            self.state_map(),
        ))
    }

    pub fn merge_abort(&self) -> Result<GraphSnapshot, TrunkError> {
        snapshot(operation_state::merge_abort_inner(
            self.path(),
            self.state_map(),
        ))
    }

    pub fn rebase_continue(&self, message: Option<&str>) -> Result<GraphSnapshot, TrunkError> {
        snapshot(operation_state::rebase_continue_inner(
            self.path(),
            message,
            self.state_map(),
        ))
    }

    pub fn rebase_skip(&self) -> Result<GraphSnapshot, TrunkError> {
        snapshot(operation_state::rebase_skip_inner(
            self.path(),
            self.state_map(),
        ))
    }

    pub fn rebase_abort(&self) -> Result<GraphSnapshot, TrunkError> {
        snapshot(operation_state::rebase_abort_inner(
            self.path(),
            self.state_map(),
        ))
    }

    pub fn merge_branch_begin(&self, branch: &str) -> Result<MergeBeginResult, TrunkError> {
        let (source, outcome) =
            operation_state::merge_branch_begin_inner(self.path(), branch, self.state_map())?;
        let graph = GraphSnapshot::new(source, RefVisibility::default());
        Ok(match outcome {
            operation_state::MergeBeginOutcome::FastForwarded => {
                MergeBeginResult::FastForwarded { graph }
            }
            operation_state::MergeBeginOutcome::Conflicts => MergeBeginResult::Conflicts { graph },
            operation_state::MergeBeginOutcome::Ready { message } => {
                MergeBeginResult::Ready { graph, message }
            }
        })
    }

    pub fn rebase_branch(&self, branch: &str) -> Result<GraphSnapshot, TrunkError> {
        snapshot(operation_state::rebase_branch_inner(
            self.path(),
            branch,
            self.state_map(),
        ))
    }
}

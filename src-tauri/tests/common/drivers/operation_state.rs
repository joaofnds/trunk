use crate::common::context::TestContext;
use trunk_lib::commands::operation_state;
use trunk_lib::commands::operation_state::MergeBeginResult;
use trunk_lib::error::TrunkError;
use trunk_lib::git::types::{GraphResult, OperationInfo};

impl TestContext {
    pub fn get_operation_state(&self) -> Result<OperationInfo, TrunkError> {
        operation_state::get_operation_state_inner(self.path(), self.state_map())
    }

    pub fn merge_continue(&self, message: Option<&str>) -> Result<GraphResult, TrunkError> {
        operation_state::merge_continue_inner(
            self.path(),
            message,
            self.state_map(),
            &trunk_lib::git::graph_input::RefVisibility::default(),
        )
    }

    pub fn merge_abort(&self) -> Result<GraphResult, TrunkError> {
        operation_state::merge_abort_inner(
            self.path(),
            self.state_map(),
            &trunk_lib::git::graph_input::RefVisibility::default(),
        )
    }

    pub fn rebase_continue(&self, message: Option<&str>) -> Result<GraphResult, TrunkError> {
        operation_state::rebase_continue_inner(
            self.path(),
            message,
            self.state_map(),
            &trunk_lib::git::graph_input::RefVisibility::default(),
        )
    }

    pub fn rebase_skip(&self) -> Result<GraphResult, TrunkError> {
        operation_state::rebase_skip_inner(
            self.path(),
            self.state_map(),
            &trunk_lib::git::graph_input::RefVisibility::default(),
        )
    }

    pub fn rebase_abort(&self) -> Result<GraphResult, TrunkError> {
        operation_state::rebase_abort_inner(
            self.path(),
            self.state_map(),
            &trunk_lib::git::graph_input::RefVisibility::default(),
        )
    }

    pub fn merge_branch_begin(&self, branch: &str) -> Result<MergeBeginResult, TrunkError> {
        operation_state::merge_branch_begin_inner(
            self.path(),
            branch,
            self.state_map(),
            &trunk_lib::git::graph_input::RefVisibility::default(),
        )
    }

    pub fn rebase_branch(&self, branch: &str) -> Result<GraphResult, TrunkError> {
        operation_state::rebase_branch_inner(
            self.path(),
            branch,
            self.state_map(),
            &trunk_lib::git::graph_input::RefVisibility::default(),
        )
    }
}

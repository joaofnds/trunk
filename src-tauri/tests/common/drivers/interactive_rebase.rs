use crate::common::context::TestContext;
use trunk_lib::commands::interactive_rebase::{self, RebaseTodo, RebaseTodoAction};
use trunk_lib::error::TrunkError;
use trunk_lib::git::types::GraphResult;

impl TestContext {
    pub fn get_rebase_todo(
        &self,
        base_oid: &str,
        inclusive: bool,
    ) -> Result<RebaseTodo, TrunkError> {
        interactive_rebase::get_rebase_todo_inner(
            self.path(),
            base_oid,
            inclusive,
            self.state_map(),
        )
    }

    pub fn get_fork_point(&self, branch: &str) -> Result<String, TrunkError> {
        interactive_rebase::get_fork_point_inner(self.path(), branch, self.state_map())
    }

    /// Runs the real `git rebase -i`, editor scripts and all. The session dir drops
    /// when this returns, as it does in `start_interactive_rebase`.
    pub fn start_interactive_rebase(
        &self,
        base_oid: &str,
        todo_items: &[RebaseTodoAction],
    ) -> Result<GraphResult, TrunkError> {
        let session = tempfile::tempdir().expect("failed to create rebase session dir");
        interactive_rebase::start_interactive_rebase_blocking(
            self.path(),
            base_oid,
            todo_items,
            session.path(),
            self.state_map(),
        )
    }
}

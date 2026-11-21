use crate::common::context::TestContext;
use trunk_git::error::TrunkError;
use trunk_git::graph_input::{GraphSnapshot, RefVisibility};
use trunk_lib::commands::interactive_rebase::{
    self, RebasePreviewTarget, RebaseSource, RebaseStartResult, RebaseTodo, RebaseTodoAction,
};

impl TestContext {
    pub fn get_rebase_todo(
        &self,
        base_oid: &str,
        inclusive: bool,
    ) -> Result<RebaseTodo, TrunkError> {
        if inclusive {
            interactive_rebase::get_rebase_todo_inner(
                self.path(),
                &RebasePreviewTarget::Commit {
                    oid: base_oid.to_owned(),
                },
                self.state_map(),
            )
        } else {
            self.rebase_todo_from_branch(base_oid)
        }
    }

    pub fn rebase_todo_from_branch(&self, branch: &str) -> Result<RebaseTodo, TrunkError> {
        interactive_rebase::get_rebase_todo_inner(
            self.path(),
            &RebasePreviewTarget::Branch {
                ref_name: branch.to_owned(),
            },
            self.state_map(),
        )
    }

    /// Runs the real `git rebase -i`, editor scripts and all. The session dir drops
    /// when this returns, as it does in `start_interactive_rebase`.
    pub fn start_interactive_rebase(
        &self,
        base_oid: Option<&str>,
        todo_items: &[RebaseTodoAction],
    ) -> Result<(GraphSnapshot, RebaseStartResult), TrunkError> {
        let repo = self.repo();
        let head = repo.find_reference("HEAD")?;
        let source = RebaseSource {
            ref_name: head.symbolic_target()?.unwrap_or("HEAD").to_owned(),
            tip_oid: head.peel_to_commit()?.id().to_string(),
        };
        self.start_rebase(&source, base_oid, todo_items)
    }

    pub fn start_rebase_from_preview(
        &self,
        preview: &RebaseTodo,
        todo_items: &[RebaseTodoAction],
    ) -> Result<(GraphSnapshot, RebaseStartResult), TrunkError> {
        self.start_rebase(&preview.source, preview.base_oid.as_deref(), todo_items)
    }

    fn start_rebase(
        &self,
        source: &RebaseSource,
        base_oid: Option<&str>,
        todo_items: &[RebaseTodoAction],
    ) -> Result<(GraphSnapshot, RebaseStartResult), TrunkError> {
        let session = tempfile::tempdir().expect("failed to create rebase session dir");
        let (source, outcome) = interactive_rebase::start_interactive_rebase_blocking(
            self.path(),
            source,
            base_oid,
            todo_items,
            session.path(),
            self.state_map(),
        )?;
        Ok((
            GraphSnapshot::new(source.source, RefVisibility::default()),
            outcome,
        ))
    }
}

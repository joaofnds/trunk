use crate::common::context::TestContext;
use trunk_git::error::TrunkError;
use trunk_git::worktree::{BranchHold, WorktreeRemoval};
use trunk_lib::commands::branches;
use trunk_lib::types::RefsResponse;

impl TestContext {
    /// List all refs (branches, tags, stashes) in the test repo
    pub fn list_refs(&self) -> Result<RefsResponse, TrunkError> {
        branches::list_refs_inner(self.path(), self.state_map())
    }

    /// Resolve a ref name to its OID string
    pub fn resolve_ref(&self, ref_name: &str) -> Result<String, TrunkError> {
        branches::resolve_ref_inner(self.path(), ref_name, self.state_map())
    }

    /// Checkout a branch by name (needs &mut self for `cache_map`)
    pub fn checkout_branch(&mut self, name: &str) -> Result<(), TrunkError> {
        branches::checkout_branch_inner(
            &self.path,
            name,
            &self.state_map,
            &mut self.cache_map,
            &trunk_git::graph_input::RefVisibility::default(),
        )
    }

    /// Delete a local branch (needs &mut self for `cache_map`)
    pub fn delete_branch(&mut self, name: &str) -> Result<(), TrunkError> {
        branches::delete_branch_inner(
            &self.path,
            name,
            None,
            &self.state_map,
            &mut self.cache_map,
            &trunk_git::graph_input::RefVisibility::default(),
        )
    }

    /// Which worktree holds `name`, and what removing it would lose
    pub fn branch_hold(&self, name: &str) -> Result<BranchHold, TrunkError> {
        branches::branch_hold_inner(self.path(), name, self.state_map())
    }

    /// Open `location` in a tab of its own, as the frontend does for another repository
    pub fn open_in_tab(&mut self, location: &std::path::Path) {
        self.state_map
            .register(location.display().to_string(), location.to_path_buf());
    }

    /// Delete a local branch, removing the linked worktree the user agreed to remove
    pub fn delete_branch_removing(
        &mut self,
        name: &str,
        worktree: &WorktreeRemoval,
    ) -> Result<(), TrunkError> {
        branches::delete_branch_inner(
            &self.path,
            name,
            Some(worktree),
            &self.state_map,
            &mut self.cache_map,
            &trunk_git::graph_input::RefVisibility::default(),
        )
    }

    /// Add linked worktree `name` under `worktrees_dir`, checked out on existing `branch`
    pub fn add_linked_worktree(&self, name: &str, branch: &str) -> std::path::PathBuf {
        let repo = self.repo();
        let path = self.worktrees_dir().join(name);
        let reference = repo
            .find_branch(branch, git2::BranchType::Local)
            .expect("branch for the worktree")
            .into_reference();
        let mut options = git2::WorktreeAddOptions::new();
        options.reference(Some(&reference));
        repo.worktree(name, &path, Some(&options))
            .expect("failed to add worktree");
        path.canonicalize().expect("worktree path")
    }

    /// Rename a local branch (needs &mut self for `cache_map`)
    pub fn rename_branch(&mut self, old: &str, new: &str) -> Result<(), TrunkError> {
        branches::rename_branch_inner(
            &self.path,
            old,
            new,
            &self.state_map,
            &mut self.cache_map,
            &trunk_git::graph_input::RefVisibility::default(),
        )
    }

    /// Fast-forward merge to a target OID (needs &mut self for `cache_map`)
    pub fn fast_forward_to(&mut self, target_oid: &str) -> Result<(), TrunkError> {
        branches::fast_forward_to_inner(
            &self.path,
            target_oid,
            &self.state_map,
            &mut self.cache_map,
            &trunk_git::graph_input::RefVisibility::default(),
        )
    }

    /// Create a new branch, optionally from a specific OID (needs &mut self for `cache_map`)
    pub fn create_branch(&mut self, name: &str, from_oid: Option<&str>) -> Result<(), TrunkError> {
        branches::create_branch_inner(
            &self.path,
            name,
            from_oid,
            &self.state_map,
            &mut self.cache_map,
            &trunk_git::graph_input::RefVisibility::default(),
        )
    }
}

use crate::common::context::TestContext;
use trunk_lib::commands::branches;
use trunk_lib::error::TrunkError;
use trunk_lib::git::types::RefsResponse;

impl TestContext {
    /// List all refs (branches, tags, stashes) in the test repo
    pub fn list_refs(&self) -> Result<RefsResponse, TrunkError> {
        branches::list_refs_inner(self.path(), self.state_map())
    }

    /// Resolve a ref name to its OID string
    pub fn resolve_ref(&self, ref_name: &str) -> Result<String, TrunkError> {
        branches::resolve_ref_inner(self.path(), ref_name, self.state_map())
    }

    /// Checkout a branch by name (needs &mut self for cache_map)
    pub fn checkout_branch(&mut self, name: &str) -> Result<(), TrunkError> {
        branches::checkout_branch_inner(
            &self.path,
            name,
            &self.state_map,
            &mut self.cache_map,
            &trunk_lib::git::graph_input::RefVisibility::default(),
        )
    }

    /// Delete a local branch (needs &mut self for cache_map)
    pub fn delete_branch(&mut self, name: &str) -> Result<(), TrunkError> {
        branches::delete_branch_inner(
            &self.path,
            name,
            &self.state_map,
            &mut self.cache_map,
            &trunk_lib::git::graph_input::RefVisibility::default(),
        )
    }

    /// Rename a local branch (needs &mut self for cache_map)
    pub fn rename_branch(&mut self, old: &str, new: &str) -> Result<(), TrunkError> {
        branches::rename_branch_inner(
            &self.path,
            old,
            new,
            &self.state_map,
            &mut self.cache_map,
            &trunk_lib::git::graph_input::RefVisibility::default(),
        )
    }

    /// Fast-forward merge to a target OID (needs &mut self for cache_map)
    pub fn fast_forward_to(&mut self, target_oid: &str) -> Result<(), TrunkError> {
        branches::fast_forward_to_inner(
            &self.path,
            target_oid,
            &self.state_map,
            &mut self.cache_map,
            &trunk_lib::git::graph_input::RefVisibility::default(),
        )
    }

    /// Create a new branch, optionally from a specific OID (needs &mut self for cache_map)
    pub fn create_branch(&mut self, name: &str, from_oid: Option<&str>) -> Result<(), TrunkError> {
        branches::create_branch_inner(
            &self.path,
            name,
            from_oid,
            &self.state_map,
            &mut self.cache_map,
            &trunk_lib::git::graph_input::RefVisibility::default(),
        )
    }
}

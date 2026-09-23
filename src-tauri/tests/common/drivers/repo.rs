use crate::common::context::TestContext;
use trunk_git::error::TrunkError;
use trunk_git::repository;

impl TestContext {
    /// Validate that the repo path is a valid git repository
    pub fn validate_and_open(&self) -> Result<(), TrunkError> {
        repository::validate_and_open(self.repo_path())
    }
}

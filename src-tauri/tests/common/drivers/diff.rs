use crate::common::context::TestContext;
use trunk_lib::commands::diff;
use trunk_lib::error::TrunkError;
use trunk_lib::git::types::{CommitDetail, DiffRequestOptions, FileDiff};

impl TestContext {
    pub fn diff_unstaged(&self, file_path: &str) -> Result<Vec<FileDiff>, TrunkError> {
        diff::diff_unstaged_inner(
            self.path(),
            file_path,
            self.state_map(),
            &DiffRequestOptions::default(),
        )
    }

    pub fn diff_unstaged_with_options(
        &self,
        file_path: &str,
        options: &DiffRequestOptions,
    ) -> Result<Vec<FileDiff>, TrunkError> {
        diff::diff_unstaged_inner(self.path(), file_path, self.state_map(), options)
    }

    pub fn diff_staged(&self, file_path: &str) -> Result<Vec<FileDiff>, TrunkError> {
        diff::diff_staged_inner(
            self.path(),
            file_path,
            self.state_map(),
            &DiffRequestOptions::default(),
        )
    }

    pub fn diff_staged_with_options(
        &self,
        file_path: &str,
        options: &DiffRequestOptions,
    ) -> Result<Vec<FileDiff>, TrunkError> {
        diff::diff_staged_inner(self.path(), file_path, self.state_map(), options)
    }

    pub fn diff_commit(&self, oid: &str) -> Result<Vec<FileDiff>, TrunkError> {
        diff::diff_commit_inner(
            self.path(),
            oid,
            self.state_map(),
            &DiffRequestOptions::default(),
        )
    }

    pub fn diff_commit_with_options(
        &self,
        oid: &str,
        options: &DiffRequestOptions,
    ) -> Result<Vec<FileDiff>, TrunkError> {
        diff::diff_commit_inner(self.path(), oid, self.state_map(), options)
    }

    pub fn get_commit_detail(&self, oid: &str) -> Result<CommitDetail, TrunkError> {
        diff::get_commit_detail_inner(self.path(), oid, self.state_map())
    }

    pub fn list_commit_files(&self, oid: &str) -> Result<Vec<FileDiff>, TrunkError> {
        diff::list_commit_files_inner(self.path(), oid, self.state_map())
    }

    pub fn diff_commit_file(
        &self,
        oid: &str,
        file_path: &str,
    ) -> Result<Vec<FileDiff>, TrunkError> {
        diff::diff_commit_file_inner(
            self.path(),
            oid,
            file_path,
            self.state_map(),
            &DiffRequestOptions::default(),
        )
    }

    /// Diff with enrichment (syntax + word diff). `diff_unstaged_inner` already
    /// enriches its output, so this is an alias — kept for its ten call sites.
    pub fn diff_unstaged_enriched(&self, file_path: &str) -> Result<Vec<FileDiff>, TrunkError> {
        self.diff_unstaged(file_path)
    }
}

impl TestContext {
    pub fn list_compare_files(
        &self,
        base_oid: Option<&str>,
        target_oid: &str,
    ) -> Result<Vec<FileDiff>, TrunkError> {
        diff::list_compare_files_inner(self.path(), base_oid, target_oid, self.state_map())
    }

    pub fn diff_compare_file(
        &self,
        base_oid: Option<&str>,
        target_oid: &str,
        file_path: &str,
    ) -> Result<Vec<FileDiff>, TrunkError> {
        self.diff_compare_file_with_options(
            base_oid,
            target_oid,
            file_path,
            &DiffRequestOptions::default(),
        )
    }

    pub fn diff_compare_file_with_options(
        &self,
        base_oid: Option<&str>,
        target_oid: &str,
        file_path: &str,
        options: &DiffRequestOptions,
    ) -> Result<Vec<FileDiff>, TrunkError> {
        diff::diff_compare_file_inner(
            self.path(),
            base_oid,
            target_oid,
            file_path,
            self.state_map(),
            options,
        )
    }
}

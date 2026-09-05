use crate::common::context::TestContext;
use trunk_lib::commands::staging;
use trunk_lib::error::TrunkError;
use trunk_lib::git::types::{DiffRequestOptions, WorkingTreeStatus};

impl TestContext {
    pub fn get_status(&self) -> Result<WorkingTreeStatus, TrunkError> {
        staging::get_status_inner(self.path(), self.state_map())
    }

    pub fn stage_file(&self, file_path: &str) -> Result<(), TrunkError> {
        staging::stage_file_inner(self.path(), file_path, self.state_map())
    }

    pub fn unstage_file(&self, file_path: &str) -> Result<(), TrunkError> {
        staging::unstage_file_inner(self.path(), file_path, self.state_map())
    }

    pub fn discard_file(&self, file_path: &str) -> Result<(), TrunkError> {
        staging::discard_file_inner(self.path(), file_path, self.state_map())
    }

    pub fn discard_all(&self) -> Result<(), TrunkError> {
        staging::discard_all_inner(self.path(), self.state_map())
    }

    pub fn stage_all(&self) -> Result<(), TrunkError> {
        staging::stage_all_inner(self.path(), self.state_map())
    }

    pub fn stage_hunk(&self, file_path: &str, hunk_index: u32) -> Result<(), TrunkError> {
        self.stage_hunk_with_options(file_path, hunk_index, &DiffRequestOptions::default())
    }

    pub fn stage_hunk_with_options(
        &self,
        file_path: &str,
        hunk_index: u32,
        options: &DiffRequestOptions,
    ) -> Result<(), TrunkError> {
        staging::stage_hunk_inner(
            self.path(),
            file_path,
            hunk_index,
            self.state_map(),
            options,
        )
    }

    pub fn unstage_hunk(&self, file_path: &str, hunk_index: u32) -> Result<(), TrunkError> {
        self.unstage_hunk_with_options(file_path, hunk_index, &DiffRequestOptions::default())
    }

    pub fn unstage_hunk_with_options(
        &self,
        file_path: &str,
        hunk_index: u32,
        options: &DiffRequestOptions,
    ) -> Result<(), TrunkError> {
        staging::unstage_hunk_inner(
            self.path(),
            file_path,
            hunk_index,
            self.state_map(),
            options,
        )
    }

    pub fn discard_hunk(&self, file_path: &str, hunk_index: u32) -> Result<(), TrunkError> {
        self.discard_hunk_with_options(file_path, hunk_index, &DiffRequestOptions::default())
    }

    pub fn discard_hunk_with_options(
        &self,
        file_path: &str,
        hunk_index: u32,
        options: &DiffRequestOptions,
    ) -> Result<(), TrunkError> {
        staging::discard_hunk_inner(
            self.path(),
            file_path,
            hunk_index,
            self.state_map(),
            options,
        )
    }

    pub fn unstage_all(&self) -> Result<(), TrunkError> {
        staging::unstage_all_inner(self.path(), self.state_map())
    }

    pub fn stage_lines(
        &self,
        file_path: &str,
        hunk_index: u32,
        line_indices: Vec<u32>,
    ) -> Result<(), TrunkError> {
        self.stage_lines_with_options(
            file_path,
            hunk_index,
            line_indices,
            &DiffRequestOptions::default(),
        )
    }

    pub fn stage_lines_with_options(
        &self,
        file_path: &str,
        hunk_index: u32,
        line_indices: Vec<u32>,
        options: &DiffRequestOptions,
    ) -> Result<(), TrunkError> {
        staging::stage_lines_inner(
            self.path(),
            file_path,
            hunk_index,
            line_indices,
            self.state_map(),
            options,
        )
    }

    pub fn unstage_lines(
        &self,
        file_path: &str,
        hunk_index: u32,
        line_indices: Vec<u32>,
    ) -> Result<(), TrunkError> {
        self.unstage_lines_with_options(
            file_path,
            hunk_index,
            line_indices,
            &DiffRequestOptions::default(),
        )
    }

    pub fn unstage_lines_with_options(
        &self,
        file_path: &str,
        hunk_index: u32,
        line_indices: Vec<u32>,
        options: &DiffRequestOptions,
    ) -> Result<(), TrunkError> {
        staging::unstage_lines_inner(
            self.path(),
            file_path,
            hunk_index,
            line_indices,
            self.state_map(),
            options,
        )
    }

    pub fn discard_lines(
        &self,
        file_path: &str,
        hunk_index: u32,
        line_indices: Vec<u32>,
    ) -> Result<(), TrunkError> {
        self.discard_lines_with_options(
            file_path,
            hunk_index,
            line_indices,
            &DiffRequestOptions::default(),
        )
    }

    pub fn discard_lines_with_options(
        &self,
        file_path: &str,
        hunk_index: u32,
        line_indices: Vec<u32>,
        options: &DiffRequestOptions,
    ) -> Result<(), TrunkError> {
        staging::discard_lines_inner(
            self.path(),
            file_path,
            hunk_index,
            line_indices,
            self.state_map(),
            options,
        )
    }

    pub fn stage_files(&self, file_paths: &[&str]) -> Result<(), TrunkError> {
        let paths: Vec<String> = file_paths
            .iter()
            .map(std::string::ToString::to_string)
            .collect();
        staging::stage_files_inner(self.path(), &paths, self.state_map())
    }

    pub fn unstage_files(&self, file_paths: &[&str]) -> Result<(), TrunkError> {
        let paths: Vec<String> = file_paths
            .iter()
            .map(std::string::ToString::to_string)
            .collect();
        staging::unstage_files_inner(self.path(), &paths, self.state_map())
    }
}

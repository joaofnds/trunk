use crate::common::context::TestContext;
use trunk_git::error::TrunkError;
use trunk_lib::commands::staging;
use trunk_lib::types::{DiffRequestOptions, FileDiff, ShownHunk, ShownLine, WorkingTreeStatus};

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

    pub fn discard_files(&self, file_paths: &[&str]) -> Result<(), TrunkError> {
        let paths: Vec<String> = file_paths
            .iter()
            .map(std::string::ToString::to_string)
            .collect();
        staging::discard_files_inner(self.path(), &paths, self.state_map())
    }

    pub fn discard_all(&self) -> Result<(), TrunkError> {
        staging::discard_all_inner(self.path(), self.state_map())
    }

    pub fn stage_all(&self) -> Result<(), TrunkError> {
        staging::stage_all_inner(self.path(), self.state_map())
    }

    /// The hunk at `hunk_index` of the file's unstaged diff, as the view shows it now.
    pub fn shown_unstaged_hunk(&self, file_path: &str, hunk_index: u32) -> ShownHunk {
        self.shown_unstaged_hunk_with_options(file_path, hunk_index, &DiffRequestOptions::default())
    }

    pub fn shown_unstaged_hunk_with_options(
        &self,
        file_path: &str,
        hunk_index: u32,
        options: &DiffRequestOptions,
    ) -> ShownHunk {
        let diff = self
            .diff_unstaged_with_options(file_path, options)
            .expect("diff_unstaged failed");
        shown(&diff, hunk_index)
    }

    /// The hunk at `hunk_index` of the file's staged diff, as the view shows it now.
    pub fn shown_staged_hunk(&self, file_path: &str, hunk_index: u32) -> ShownHunk {
        self.shown_staged_hunk_with_options(file_path, hunk_index, &DiffRequestOptions::default())
    }

    pub fn shown_staged_hunk_with_options(
        &self,
        file_path: &str,
        hunk_index: u32,
        options: &DiffRequestOptions,
    ) -> ShownHunk {
        let diff = self
            .diff_staged_with_options(file_path, options)
            .expect("diff_staged failed");
        shown(&diff, hunk_index)
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
        let shown = self.shown_unstaged_hunk_with_options(file_path, hunk_index, options);
        staging::stage_hunk_inner(self.path(), file_path, &shown, self.state_map(), options)
    }

    pub fn stage_shown_hunk(&self, file_path: &str, shown: &ShownHunk) -> Result<(), TrunkError> {
        staging::stage_hunk_inner(
            self.path(),
            file_path,
            shown,
            self.state_map(),
            &DiffRequestOptions::default(),
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
        let shown = self.shown_staged_hunk_with_options(file_path, hunk_index, options);
        staging::unstage_hunk_inner(self.path(), file_path, &shown, self.state_map(), options)
    }

    pub fn unstage_shown_hunk(&self, file_path: &str, shown: &ShownHunk) -> Result<(), TrunkError> {
        staging::unstage_hunk_inner(
            self.path(),
            file_path,
            shown,
            self.state_map(),
            &DiffRequestOptions::default(),
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
        let shown = self.shown_unstaged_hunk_with_options(file_path, hunk_index, options);
        staging::discard_hunk_inner(self.path(), file_path, &shown, self.state_map(), options)
    }

    pub fn discard_shown_hunk(&self, file_path: &str, shown: &ShownHunk) -> Result<(), TrunkError> {
        staging::discard_hunk_inner(
            self.path(),
            file_path,
            shown,
            self.state_map(),
            &DiffRequestOptions::default(),
        )
    }

    pub fn unstage_all(&self) -> Result<(), TrunkError> {
        staging::unstage_all_inner(self.path(), self.state_map())
    }

    pub fn stage_lines(
        &self,
        file_path: &str,
        hunk_index: u32,
        line_indices: &[u32],
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
        line_indices: &[u32],
        options: &DiffRequestOptions,
    ) -> Result<(), TrunkError> {
        let shown = self.shown_unstaged_hunk_with_options(file_path, hunk_index, options);
        staging::stage_lines_inner(
            self.path(),
            file_path,
            &shown,
            line_indices,
            self.state_map(),
            options,
        )
    }

    pub fn stage_shown_lines(
        &self,
        file_path: &str,
        shown: &ShownHunk,
        line_indices: &[u32],
    ) -> Result<(), TrunkError> {
        staging::stage_lines_inner(
            self.path(),
            file_path,
            shown,
            line_indices,
            self.state_map(),
            &DiffRequestOptions::default(),
        )
    }

    pub fn unstage_lines(
        &self,
        file_path: &str,
        hunk_index: u32,
        line_indices: &[u32],
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
        line_indices: &[u32],
        options: &DiffRequestOptions,
    ) -> Result<(), TrunkError> {
        let shown = self.shown_staged_hunk_with_options(file_path, hunk_index, options);
        staging::unstage_lines_inner(
            self.path(),
            file_path,
            &shown,
            line_indices,
            self.state_map(),
            options,
        )
    }

    pub fn unstage_shown_lines(
        &self,
        file_path: &str,
        shown: &ShownHunk,
        line_indices: &[u32],
    ) -> Result<(), TrunkError> {
        staging::unstage_lines_inner(
            self.path(),
            file_path,
            shown,
            line_indices,
            self.state_map(),
            &DiffRequestOptions::default(),
        )
    }

    pub fn discard_lines(
        &self,
        file_path: &str,
        hunk_index: u32,
        line_indices: &[u32],
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
        line_indices: &[u32],
        options: &DiffRequestOptions,
    ) -> Result<(), TrunkError> {
        let shown = self.shown_unstaged_hunk_with_options(file_path, hunk_index, options);
        staging::discard_lines_inner(
            self.path(),
            file_path,
            &shown,
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

    /// The text a path holds in the index, as staging left it.
    pub fn staged_content(&self, file_path: &str) -> String {
        String::from_utf8_lossy(&self.staged_bytes(file_path)).into_owned()
    }

    /// The bytes a path holds in the index, as staging left them.
    pub fn staged_bytes(&self, file_path: &str) -> Vec<u8> {
        let repo = self.repo();
        let entry = self.staged_entry(file_path);
        let blob = repo.find_blob(entry.id).expect("failed to read blob");

        blob.content().to_vec()
    }

    /// The mode a path holds in the index, such as `0o100_755` for an executable.
    pub fn staged_mode(&self, file_path: &str) -> u32 {
        self.staged_entry(file_path).mode
    }

    fn staged_entry(&self, file_path: &str) -> git2::IndexEntry {
        let index = self.repo().index().expect("failed to read index");

        index
            .get_path(std::path::Path::new(file_path), 0)
            .unwrap_or_else(|| panic!("{file_path} is not in the index"))
    }
}

/// What the view sends for the hunk at `hunk_index` of a one-file diff.
fn shown(diff: &[FileDiff], hunk_index: u32) -> ShownHunk {
    let hunk = &diff[0].hunks[hunk_index as usize];

    ShownHunk {
        old_start: hunk.old_start,
        lines: hunk
            .lines
            .iter()
            .map(|line| ShownLine {
                origin: line.origin.clone(),
                content: line.content.clone(),
            })
            .collect(),
    }
}

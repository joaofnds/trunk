use crate::common::context::TestContext;
use trunk_git::error::TrunkError;
use trunk_lib::commands::merge_editor;
use trunk_lib::types::MergeSides;

impl TestContext {
    pub fn get_merge_sides(&self, file: &str) -> Result<MergeSides, TrunkError> {
        merge_editor::get_merge_sides_inner(self.path(), file, self.state_map())
    }

    pub fn save_merge_result(&self, file: &str, content: &str) -> Result<(), TrunkError> {
        merge_editor::save_merge_result_inner(self.path(), file, content, self.state_map())
    }

    pub fn conflict_marker_files(&self, files: &[&str]) -> Result<Vec<String>, TrunkError> {
        let files: Vec<String> = files.iter().map(|f| (*f).to_string()).collect();
        merge_editor::conflict_marker_files_inner(self.path(), &files, self.state_map())
    }
}

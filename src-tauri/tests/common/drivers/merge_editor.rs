use crate::common::context::TestContext;
use trunk_git::error::TrunkError;
use trunk_lib::commands::merge_editor;
use trunk_lib::types::MergeSides;

impl TestContext {
    pub fn get_merge_sides(&self, file: &str) -> Result<MergeSides, TrunkError> {
        merge_editor::get_merge_sides_inner(
            self.path(),
            file,
            merge_editor::MergeReadPurpose::Editor,
            self.state_map(),
        )
    }

    pub fn save_merge_result(&self, file: &str, content: &str) -> Result<(), TrunkError> {
        let expected = self
            .get_merge_sides(file)
            .map(|sides| sides.revision)
            .unwrap_or_default();
        self.save_merge_draft(file, content, &expected)
    }

    pub fn save_merge_draft(
        &self,
        file: &str,
        content: &str,
        revision: &str,
    ) -> Result<(), TrunkError> {
        merge_editor::save_merge_result_inner(
            self.path(),
            file,
            content,
            revision,
            self.state_map(),
        )
    }
}

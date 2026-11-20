use crate::common::context::TestContext;
use trunk_git::error::TrunkError;
use trunk_lib::commands::commit;
use trunk_lib::types::HeadCommitMessage;

impl TestContext {
    pub fn create_commit(&self, subject: &str, body: Option<&str>) -> Result<(), TrunkError> {
        commit::create_commit_inner(self.path(), subject, body, self.state_map())
    }

    /// Amend HEAD as it is when called, as a user who sees it and clicks Amend.
    pub fn amend_commit(&self, subject: &str, body: Option<&str>) -> Result<(), TrunkError> {
        let head = self.resolve_ref("HEAD").expect("HEAD did not resolve");
        self.amend_commit_on(&head, subject, body)
    }

    /// Amend as a user who chose to amend `expected_head`.
    pub fn amend_commit_on(
        &self,
        expected_head: &str,
        subject: &str,
        body: Option<&str>,
    ) -> Result<(), TrunkError> {
        commit::amend_commit_inner(
            self.path(),
            &commit::AmendRequest {
                message: commit::AmendMessage::Replace { subject, body },
                expected_head_oid: expected_head,
            },
            self.state_map(),
        )
    }

    /// Amend HEAD under the message it already has, as a user who leaves the
    /// amend's message untouched.
    pub fn amend_commit_keeping_message(&self) -> Result<(), TrunkError> {
        let head = self.resolve_ref("HEAD").expect("HEAD did not resolve");
        commit::amend_commit_inner(
            self.path(),
            &commit::AmendRequest {
                message: commit::AmendMessage::Keep,
                expected_head_oid: &head,
            },
            self.state_map(),
        )
    }

    pub fn get_head_commit_message(&self) -> Result<HeadCommitMessage, TrunkError> {
        commit::get_head_commit_message_inner(self.path(), self.state_map())
    }

    pub fn get_user_name(&self) -> Result<Option<String>, TrunkError> {
        commit::get_user_name_inner(self.path(), self.state_map())
    }
}

/// What a second writer's Commit leaves: HEAD one commit further, holding the index.
pub fn commit_what_is_staged(repo: &git2::Repository) {
    let tree = repo
        .find_tree(repo.index().unwrap().write_tree().unwrap())
        .unwrap();
    let parent = repo.head().unwrap().peel_to_commit().unwrap();
    let writer = git2::Signature::now("Other writer", "other@example.com").unwrap();
    repo.commit(
        Some("HEAD"),
        &writer,
        &writer,
        "Committed meanwhile",
        &tree,
        &[&parent],
    )
    .unwrap();
}

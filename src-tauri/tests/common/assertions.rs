use crate::common::context::TestContext;

impl TestContext {
    pub fn assert_file_staged(&self, file: &str) {
        let status = trunk_lib::commands::staging::get_status_inner(self.path(), self.state_map())
            .expect("get_status_inner failed");
        assert!(
            status.staged.iter().any(|f| f.path == file),
            "expected '{}' to be staged, but staged files are: {:?}",
            file,
            status.staged.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
    }

    pub fn assert_file_unstaged(&self, file: &str) {
        let status = trunk_lib::commands::staging::get_status_inner(self.path(), self.state_map())
            .expect("get_status_inner failed");
        assert!(
            status.unstaged.iter().any(|f| f.path == file),
            "expected '{}' to be unstaged, but unstaged files are: {:?}",
            file,
            status.unstaged.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
    }

    pub fn assert_status_clean(&self) {
        let status = trunk_lib::commands::staging::get_status_inner(self.path(), self.state_map())
            .expect("get_status_inner failed");
        assert!(
            status.staged.is_empty(),
            "expected no staged files, got: {:?}",
            status.staged.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
        assert!(
            status.unstaged.is_empty(),
            "expected no unstaged files, got: {:?}",
            status.unstaged.iter().map(|f| &f.path).collect::<Vec<_>>()
        );
        assert!(
            status.conflicted.is_empty(),
            "expected no conflicted files, got: {:?}",
            status
                .conflicted
                .iter()
                .map(|f| &f.path)
                .collect::<Vec<_>>()
        );
    }

    pub fn assert_branch_exists(&self, name: &str) {
        let repo = self.repo();
        assert!(
            repo.find_branch(name, git2::BranchType::Local).is_ok(),
            "expected local branch '{name}' to exist"
        );
    }

    pub fn assert_branch_not_exists(&self, name: &str) {
        let repo = self.repo();
        assert!(
            repo.find_branch(name, git2::BranchType::Local).is_err(),
            "expected local branch '{name}' to NOT exist"
        );
    }

    pub fn assert_head_at(&self, branch: &str) {
        let repo = self.repo();
        let head = repo.head().expect("no HEAD");
        let shorthand = head.shorthand().unwrap_or("(detached)");
        assert_eq!(
            shorthand, branch,
            "expected HEAD at '{branch}', got '{shorthand}'"
        );
    }

    pub fn assert_tag_exists(&self, name: &str) {
        let repo = self.repo();
        let refname = format!("refs/tags/{name}");
        assert!(
            repo.find_reference(&refname).is_ok(),
            "expected tag '{name}' to exist"
        );
    }

    pub fn assert_commit_count(&self, expected: usize) {
        let repo = self.repo();
        let mut revwalk = repo.revwalk().unwrap();
        revwalk.push_head().unwrap();
        let count = revwalk.count();
        assert_eq!(count, expected, "expected {expected} commits, got {count}");
    }

    pub fn assert_head_message(&self, expected: &str) {
        let repo = self.repo();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let msg = head.message().unwrap_or("");
        assert!(
            msg.contains(expected),
            "expected HEAD commit message to contain '{expected}', got '{msg}'"
        );
    }

    pub fn assert_file_content(&self, file: &str, expected: &str) {
        let content = std::fs::read_to_string(self.repo_path().join(file))
            .unwrap_or_else(|e| panic!("failed to read '{file}': {e}"));
        assert_eq!(
            content, expected,
            "expected '{file}' content to be '{expected}', got '{content}'"
        );
    }

    pub fn assert_conflict_state(&self) {
        let repo = self.repo();
        assert!(
            repo.find_reference("MERGE_HEAD").is_ok()
                || repo.state() != git2::RepositoryState::Clean,
            "expected repo to be in conflict/merge state, but state is {:?}",
            repo.state()
        );
    }
}

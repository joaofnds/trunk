use std::path::Path;
use trunk_lib::state::{GraphCache, OpenRepos};

pub struct TestContext {
    /// Held so the temporary directories outlive the context that names them.
    dir: tempfile::TempDir,
    data_dir: tempfile::TempDir,
    pub(crate) path: String,
    pub(crate) state_map: OpenRepos,
    pub(crate) cache_map: GraphCache,
}

impl TestContext {
    /// Entry point for building test fixtures (D-04)
    pub const fn builder() -> crate::common::builder::TestContextBuilder {
        crate::common::builder::TestContextBuilder::new()
    }

    /// Create a minimal context with an empty git repo (no commits)
    pub fn new_empty() -> Self {
        let dir = tempfile::tempdir().expect("failed to create tempdir");
        let data_dir = tempfile::tempdir().expect("failed to create data_dir tempdir");
        let repo = git2::Repository::init(dir.path()).expect("failed to init repo");

        let mut cfg = repo.config().expect("failed to get config");
        cfg.set_str("user.name", "Test User").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        drop(cfg);
        drop(repo);

        let path = dir.path().display().to_string();
        let state_map = OpenRepos::from_iter([(path.clone(), dir.path().to_path_buf())]);

        Self {
            dir,
            data_dir,
            path,
            state_map,
            cache_map: GraphCache::default(),
        }
    }

    /// String key used by all _inner functions
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Filesystem path to the temporary repo
    pub fn repo_path(&self) -> &Path {
        self.dir.path()
    }

    /// Temporary directory standing in for `app_data_dir` in persistence tests.
    /// Threaded into `review_store` / review _inner functions as the `data_dir` arg.
    pub fn data_dir(&self) -> &Path {
        self.data_dir.path()
    }

    /// Open a fresh `git2::Repository` handle
    pub fn repo(&self) -> git2::Repository {
        git2::Repository::open(self.dir.path()).unwrap()
    }

    /// Immutable borrow of the open repositories, for `_inner` functions.
    pub const fn state_map(&self) -> &OpenRepos {
        &self.state_map
    }

    /// Mutable borrow of the graph cache, for branch `_inner` functions.
    pub const fn cache_map(&mut self) -> &mut GraphCache {
        &mut self.cache_map
    }

    /// Internal constructor used by the builder
    pub(crate) fn from_parts(dir: tempfile::TempDir, path: String, state_map: OpenRepos) -> Self {
        let data_dir = tempfile::tempdir().expect("failed to create data_dir tempdir");
        Self {
            dir,
            data_dir,
            path,
            state_map,
            cache_map: GraphCache::default(),
        }
    }
}

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use trunk_lib::git::types::GraphResult;

pub struct TestContext {
    _dir: tempfile::TempDir,
    _data_dir: tempfile::TempDir,
    pub(crate) path: String,
    pub(crate) state_map: HashMap<String, PathBuf>,
    pub(crate) cache_map: HashMap<String, GraphResult>,
}

impl TestContext {
    /// Entry point for building test fixtures (D-04)
    pub fn builder() -> crate::common::builder::TestContextBuilder {
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
        let mut state_map = HashMap::new();
        state_map.insert(path.clone(), dir.path().to_path_buf());

        TestContext {
            _dir: dir,
            _data_dir: data_dir,
            path,
            state_map,
            cache_map: HashMap::new(),
        }
    }

    /// String key used by all _inner functions
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Filesystem path to the temporary repo
    pub fn repo_path(&self) -> &Path {
        self._dir.path()
    }

    /// Temporary directory standing in for app_data_dir in persistence tests.
    /// Threaded into review_store / review _inner functions as the `data_dir` arg.
    pub fn data_dir(&self) -> &Path {
        self._data_dir.path()
    }

    /// Open a fresh git2::Repository handle
    pub fn repo(&self) -> git2::Repository {
        git2::Repository::open(self._dir.path()).unwrap()
    }

    /// Immutable borrow of state_map (for _inner functions taking &HashMap)
    pub fn state_map(&self) -> &HashMap<String, PathBuf> {
        &self.state_map
    }

    /// Mutable borrow of cache_map (for branch _inner functions taking &mut HashMap)
    pub fn cache_map(&mut self) -> &mut HashMap<String, GraphResult> {
        &mut self.cache_map
    }

    /// Internal constructor used by the builder
    pub(crate) fn from_parts(
        dir: tempfile::TempDir,
        path: String,
        state_map: HashMap<String, PathBuf>,
    ) -> Self {
        let data_dir = tempfile::tempdir().expect("failed to create data_dir tempdir");
        TestContext {
            _dir: dir,
            _data_dir: data_dir,
            path,
            state_map,
            cache_map: HashMap::new(),
        }
    }
}

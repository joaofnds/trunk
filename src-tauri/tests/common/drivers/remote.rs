use crate::common::context::TestContext;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::test::MockRuntime;
use trunk_lib::commands::remote;
use trunk_lib::error::TrunkError;
use trunk_lib::git::types::GraphResult;
use trunk_lib::state::{CommitCache, RunningOp};

/// Drives the remote commands against a real `git` subprocess and a real bare
/// remote. Owns the Tauri state the commands write to, so a test can read the
/// `CommitCache` back at the moment a command returns.
pub struct RemoteDriver<'a> {
    ctx: &'a TestContext,
    app: tauri::App<MockRuntime>,
    cache: CommitCache,
    running: RunningOp,
}

impl TestContext {
    pub fn remote(&self) -> RemoteDriver<'_> {
        RemoteDriver {
            ctx: self,
            app: tauri::test::mock_app(),
            cache: CommitCache(Mutex::new(HashMap::new())),
            running: RunningOp(Mutex::new(HashMap::new())),
        }
    }
}

impl RemoteDriver<'_> {
    pub fn pull(&self, strategy: Option<&str>) -> Result<(), TrunkError> {
        tauri::async_runtime::block_on(remote::git_pull_inner(
            self.ctx.path(),
            strategy,
            self.ctx.state_map(),
            &self.cache,
            &self.running.0,
            &trunk_lib::state::RefVisibilityState::default(),
            self.app.handle(),
        ))
    }

    pub fn push(&self) -> Result<(), TrunkError> {
        tauri::async_runtime::block_on(remote::git_push_inner(
            self.ctx.path(),
            self.ctx.state_map(),
            &self.cache,
            &self.running.0,
            &trunk_lib::state::RefVisibilityState::default(),
            self.app.handle(),
        ))
    }

    pub fn push_force(&self, remote: &str, branch: &str) -> Result<(), TrunkError> {
        tauri::async_runtime::block_on(remote::git_push_force_inner(
            self.ctx.path(),
            remote::ConfirmedPush { remote, branch },
            self.ctx.state_map(),
            &self.cache,
            &self.running.0,
            &trunk_lib::state::RefVisibilityState::default(),
            self.app.handle(),
        ))
    }

    /// Mark `path` as having a remote op in flight, as a live `git` child would. Lets a
    /// test observe the mutual-exclusion guard without a real process to signal.
    pub fn seed_running_op(&self, path: &str, pid: u32) {
        self.running.0.lock().unwrap().insert(path.to_owned(), pid);
    }

    /// The graph the last successful command cached, as the UI would receive it.
    pub fn cached_graph(&self) -> Option<GraphResult> {
        self.cache.0.lock().unwrap().get(self.ctx.path()).cloned()
    }
}

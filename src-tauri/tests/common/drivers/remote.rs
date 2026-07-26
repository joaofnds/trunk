use crate::common::context::TestContext;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::test::MockRuntime;
use trunk_lib::commands::remote;
use trunk_lib::git::types::GraphResult;
use trunk_lib::state::{CommitCache, RunningOp};

/// The stable `code` of a command's JSON error payload — the contract the
/// frontend branches on, as opposed to the human-facing message.
pub fn error_code(err: &str) -> String {
    serde_json::from_str::<serde_json::Value>(err)
        .unwrap_or_else(|_| panic!("command error is not JSON: {err}"))["code"]
        .as_str()
        .unwrap_or_else(|| panic!("command error has no code: {err}"))
        .to_owned()
}

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
    pub fn pull(&self, strategy: Option<&str>) -> Result<(), String> {
        tauri::async_runtime::block_on(remote::git_pull_inner(
            self.ctx.path(),
            strategy,
            self.ctx.state_map(),
            &self.cache,
            &self.running.0,
            self.app.handle(),
        ))
    }

    pub fn push(&self) -> Result<(), String> {
        tauri::async_runtime::block_on(remote::git_push_inner(
            self.ctx.path(),
            self.ctx.state_map(),
            &self.cache,
            &self.running.0,
            self.app.handle(),
        ))
    }

    pub fn push_force(&self) -> Result<(), String> {
        tauri::async_runtime::block_on(remote::git_push_force_inner(
            self.ctx.path(),
            self.ctx.state_map(),
            &self.cache,
            &self.running.0,
            self.app.handle(),
        ))
    }

    /// The graph the last successful command cached, as the UI would receive it.
    pub fn cached_graph(&self) -> Option<GraphResult> {
        self.cache.0.lock().unwrap().get(self.ctx.path()).cloned()
    }
}

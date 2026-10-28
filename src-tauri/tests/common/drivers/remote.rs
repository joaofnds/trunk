use crate::common::context::TestContext;
use std::sync::Mutex;
use tauri::Manager;
use tauri::test::MockRuntime;
use trunk_git::error::TrunkError;
use trunk_git::graph_input::GraphSnapshot;
use trunk_lib::commands::remote;
use trunk_lib::state::{CommitCache, GraphCache, RemoteOps, RunningOp};

/// Drives the remote commands against a real `git` subprocess and a real bare
/// remote. Owns the Tauri state the commands write to, so a test can read the
/// `CommitCache` back at the moment a command returns.
pub struct RemoteDriver<'a> {
    ctx: &'a TestContext,
    app: tauri::App<MockRuntime>,
}

impl TestContext {
    pub fn remote(&self) -> RemoteDriver<'_> {
        let cache = CommitCache::new(GraphCache::default());
        cache.open_session(self.path());
        RemoteDriver {
            ctx: self,
            app: tauri::test::mock_builder()
                .manage(cache)
                .manage(RunningOp(Mutex::new(RemoteOps::default())))
                .manage(trunk_lib::background_fetch::BackgroundFetch::default())
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap(),
        }
    }
}

impl RemoteDriver<'_> {
    pub fn pull(&self, strategy: Option<&str>) -> Result<(), TrunkError> {
        tauri::async_runtime::block_on(remote::git_pull_inner(
            self.ctx.path(),
            strategy,
            self.ctx.state_map(),
            &self.app.state::<CommitCache>(),
            &self.app.state::<RunningOp>().0,
            &trunk_lib::state::RefVisibilityState::default(),
            self.app.handle(),
        ))
    }

    /// Pull, and once `reached` returns, cancel the pull the way closing the repository
    /// does. `reached` blocks until git is at the point the test wants to stop it at.
    pub fn pull_cancelled_once(
        &self,
        strategy: Option<&str>,
        reached: impl FnOnce() + Send + 'static,
    ) -> Result<(), TrunkError> {
        let running = &self.app.state::<RunningOp>().0;
        let cache = self.app.state::<CommitCache>();
        let visibility = trunk_lib::state::RefVisibilityState::default();
        let cancel = async {
            tauri::async_runtime::spawn_blocking(reached).await.unwrap();
            let process = running.lock().unwrap().cancel(self.ctx.path());
            if let Some(process) = process {
                process.stop();
            }
        };
        tauri::async_runtime::block_on(async {
            let (pulled, ()) = tokio::join!(
                remote::git_pull_inner(
                    self.ctx.path(),
                    strategy,
                    self.ctx.state_map(),
                    &cache,
                    running,
                    &visibility,
                    self.app.handle(),
                ),
                cancel
            );
            pulled
        })
    }

    pub fn push(&self) -> Result<(), TrunkError> {
        tauri::async_runtime::block_on(remote::git_push_inner(
            self.ctx.path(),
            self.ctx.state_map(),
            &self.app.state::<CommitCache>(),
            &self.app.state::<RunningOp>().0,
            &trunk_lib::state::RefVisibilityState::default(),
            self.app.handle(),
        ))
    }

    pub fn push_force(&self, remote: &str, branch: &str) -> Result<(), TrunkError> {
        tauri::async_runtime::block_on(remote::git_push_force_inner(
            self.ctx.path(),
            remote::ConfirmedPush { remote, branch },
            self.ctx.state_map(),
            &self.app.state::<CommitCache>(),
            &self.app.state::<RunningOp>().0,
            &trunk_lib::state::RefVisibilityState::default(),
            self.app.handle(),
        ))
    }

    /// Mark `path` as having a remote op in flight, as a live `git` child would. Lets a
    /// test observe the mutual-exclusion guard without a real process to signal.
    pub fn seed_running_op(&self, path: &str) {
        let common = git2::Repository::open(path)
            .ok()
            .and_then(|repo| repo.commondir().canonicalize().ok())
            .map_or_else(
                || path.to_owned(),
                |path| path.to_string_lossy().into_owned(),
            );
        self.app
            .state::<RunningOp>()
            .0
            .lock()
            .unwrap()
            .reserve_foreground(trunk_lib::remote_ops::RemoteTarget {
                path,
                common: &common,
            })
            .unwrap();
    }

    /// The graph the last successful command cached, as the UI would receive it.
    pub fn cached_graph(&self) -> Option<GraphSnapshot> {
        self.app.state::<CommitCache>().snapshot(self.ctx.path())
    }
}

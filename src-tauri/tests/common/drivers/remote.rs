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
            &trunk_lib::activity::ActivityState::default()
                .acquire()
                .unwrap(),
            self.ctx.path(),
            strategy,
            self.ctx.state_map(),
            &self.app.state::<CommitCache>(),
            &self.app.state::<RunningOp>().0,
            &trunk_lib::state::RefVisibilityState::default(),
            self.app.handle(),
        ))
    }

    /// Pull, and once `reached` returns, cancel the pull as `cancel_remote_op` does,
    /// which is also how closing the repository stops it. `reached` blocks until git is
    /// where the test wants it stopped. A pull that ends first returns its own result,
    /// so the test fails on it rather than waiting on a cancel that never comes.
    pub fn pull_cancelled_once(
        &self,
        strategy: Option<&str>,
        reached: impl FnOnce() + Send + 'static,
    ) -> Result<(), TrunkError> {
        let running = &self.app.state::<RunningOp>().0;
        let cache = self.app.state::<CommitCache>();
        let visibility = trunk_lib::state::RefVisibilityState::default();
        let reached = tauri::async_runtime::spawn_blocking(reached);
        tauri::async_runtime::block_on(async {
            let activity = trunk_lib::activity::ActivityState::default()
                .acquire()
                .unwrap();
            let pull = remote::git_pull_inner(
                &activity,
                self.ctx.path(),
                strategy,
                self.ctx.state_map(),
                &cache,
                running,
                &visibility,
                self.app.handle(),
            );
            tokio::pin!(pull);
            tokio::select! {
                pulled = &mut pull => return pulled,
                _ = reached => {}
            }
            let process = running.lock().unwrap().cancel(self.ctx.path());
            if let Some(process) = process {
                process.stop();
            }
            pull.await
        })
    }

    pub fn push(&self) -> Result<(), TrunkError> {
        tauri::async_runtime::block_on(remote::git_push_inner(
            &trunk_lib::activity::ActivityState::default()
                .acquire()
                .unwrap(),
            self.ctx.path(),
            self.ctx.state_map(),
            &self.app.state::<CommitCache>(),
            &self.app.state::<RunningOp>().0,
            &trunk_lib::state::RefVisibilityState::default(),
            self.app.handle(),
        ))
    }

    pub fn fetch(&self) -> Result<trunk_lib::background_fetch::FetchReport, TrunkError> {
        tauri::async_runtime::block_on(remote::git_fetch_inner(
            &trunk_lib::activity::ActivityState::default()
                .acquire()
                .unwrap(),
            self.ctx.path(),
            self.ctx.state_map(),
            &self.app.state::<CommitCache>(),
            &self.app.state::<RunningOp>().0,
            &trunk_lib::state::RefVisibilityState::default(),
            self.app.handle(),
        ))
    }

    /// Delete `name`, a remote-tracking name such as `origin/feature`, from its remote.
    pub fn delete_remote_branch(&self, name: &str) -> Result<(), TrunkError> {
        tauri::async_runtime::block_on(remote::delete_remote_branch_inner(
            &trunk_lib::activity::ActivityState::default()
                .acquire()
                .unwrap(),
            self.ctx.path(),
            name,
            self.ctx.state_map(),
            &self.app.state::<CommitCache>(),
            &self.app.state::<RunningOp>().0,
            &trunk_lib::state::RefVisibilityState::default(),
            self.app.handle(),
        ))
    }

    /// Push `branch` as its menu entry first does, refusing one that tracks nothing
    pub fn push_branch(&self, branch: &str) -> Result<(), TrunkError> {
        self.push_branch_publishing(branch, false)
    }

    /// Push `branch` once the user agreed to publish it and track it
    pub fn publish_branch(&self, branch: &str) -> Result<(), TrunkError> {
        self.push_branch_publishing(branch, true)
    }

    fn push_branch_publishing(&self, branch: &str, publish: bool) -> Result<(), TrunkError> {
        tauri::async_runtime::block_on(remote::push_branch_inner(
            &trunk_lib::activity::ActivityState::default()
                .acquire()
                .unwrap(),
            self.ctx.path(),
            branch,
            publish,
            self.ctx.state_map(),
            &self.app.state::<CommitCache>(),
            &self.app.state::<RunningOp>().0,
            &trunk_lib::state::RefVisibilityState::default(),
            self.app.handle(),
        ))
    }

    pub fn push_tag(&self, remote: &str, tag: &str) -> Result<(), TrunkError> {
        self.change_tag(remote::TagChange::Push, remote, tag)
    }

    pub fn delete_remote_tag(&self, remote: &str, tag: &str) -> Result<(), TrunkError> {
        self.change_tag(remote::TagChange::Delete, remote, tag)
    }

    fn change_tag(
        &self,
        change: remote::TagChange,
        remote: &str,
        tag: &str,
    ) -> Result<(), TrunkError> {
        tauri::async_runtime::block_on(remote::change_remote_tag_inner(
            &trunk_lib::activity::ActivityState::default()
                .acquire()
                .unwrap(),
            self.ctx.path(),
            change,
            &remote::TagOnRemote { remote, tag },
            self.ctx.state_map(),
            &self.app.state::<RunningOp>().0,
            self.app.handle(),
        ))
    }

    pub fn push_force(&self, remote: &str, branch: &str) -> Result<(), TrunkError> {
        tauri::async_runtime::block_on(remote::git_push_force_inner(
            &trunk_lib::activity::ActivityState::default()
                .acquire()
                .unwrap(),
            self.ctx.path(),
            remote::ConfirmedPush { remote, branch },
            self.ctx.state_map(),
            &self.app.state::<CommitCache>(),
            &self.app.state::<RunningOp>().0,
            &trunk_lib::state::RefVisibilityState::default(),
            self.app.handle(),
        ))
    }

    pub fn push_publish(&self, remote: &str, branch: &str) -> Result<(), TrunkError> {
        tauri::async_runtime::block_on(remote::git_push_publish_inner(
            &trunk_lib::activity::ActivityState::default()
                .acquire()
                .unwrap(),
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

use crate::common::context::TestContext;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use tauri::test::MockRuntime;
use tauri::{Listener, Manager};
use trunk_lib::commands::review::{
    RenderedThread, add_reply, add_thread, follow_on_publication, follow_rewritten_commits,
    list_threads, mark_replies_seen, refresh_thread_ref_staleness, refresh_thread_staleness,
};
use trunk_lib::state::{
    CommitCache, GraphCache, GraphRebuild, RefVisibilityState, RepoState, ReviewStoreState,
    StoreSlot, SweptRepos,
};
use trunk_review::reviewdb;
use trunk_review::types::{Anchor, Channel, Delivery};

/// Drives review commands against a real `mock_app`, the only seam that reaches
/// `add_thread`'s and `add_reply`'s emit: it lives in `write_and_notify`, which
/// wraps the `#[tauri::command]` fn, not their `_inner` twins (`add_thread` has
/// none; `add_reply_inner` exists but stops short of the emit), so this owns
/// the `State<T>` wiring those commands need.
pub struct ReviewDriver<'a> {
    ctx: &'a TestContext,
    app: tauri::App<MockRuntime>,
    fired: Arc<Mutex<bool>>,
    _data_dir_guard: DataDirGuard,
}

/// Clears `TRUNK_DATA_DIR` on drop, so a panic mid-test still leaves the env
/// var unset for the next test in this binary.
struct DataDirGuard;

impl Drop for DataDirGuard {
    fn drop(&mut self) {
        // SAFETY: this project's gated runner (`just rust`/`just check`, cargo
        // nextest) runs each #[test] fn in its own process, so no other thread
        // in this process reads or writes the environment.
        unsafe { std::env::remove_var("TRUNK_DATA_DIR") };
    }
}

impl TestContext {
    /// `store_data_dir` accepts `TRUNK_DATA_DIR` as authoritative and skips the
    /// Tauri resolver `MockRuntime` cannot serve, so the driver sets it for the
    /// lifetime of the returned value.
    pub fn review(&self) -> ReviewDriver<'_> {
        // SAFETY: this project's gated runner (`just rust`/`just check`, cargo
        // nextest) runs each #[test] fn in its own process, so no other thread
        // in this process reads or writes the environment.
        unsafe { std::env::set_var("TRUNK_DATA_DIR", self.data_dir()) };

        let app = tauri::test::mock_app();
        app.manage(RepoState(Mutex::new(self.state_map().clone())));
        app.manage(ReviewStoreState(StoreSlot::default()));
        app.manage(SweptRepos::default());
        app.manage(CommitCache::new(GraphCache::default()));
        app.manage(RefVisibilityState::default());
        follow_on_publication(app.handle());

        let fired = Arc::new(Mutex::new(false));
        let fired_handle = Arc::clone(&fired);
        app.listen("reviews-changed", move |_| {
            *fired_handle.lock().unwrap() = true;
        });

        ReviewDriver {
            ctx: self,
            app,
            fired,
            _data_dir_guard: DataDirGuard,
        }
    }
}

impl ReviewDriver<'_> {
    pub fn add_thread(
        &self,
        text: &str,
        anchor: Anchor,
        cached_excerpt: &str,
    ) -> Result<(), String> {
        tauri::async_runtime::block_on(add_thread(
            self.ctx.path().to_string(),
            text.to_string(),
            anchor,
            cached_excerpt.to_string(),
            Delivery::Send,
            false,
            self.app.state::<RepoState>(),
            self.app.state::<ReviewStoreState>(),
            self.app.handle().clone(),
        ))
    }

    pub fn add_reply(&self, thread_id: &str, text: &str) -> Result<(), String> {
        tauri::async_runtime::block_on(add_reply(
            self.ctx.path().to_string(),
            thread_id.to_string(),
            text.to_string(),
            Delivery::Send,
            self.app.state::<RepoState>(),
            self.app.state::<ReviewStoreState>(),
            self.app.handle().clone(),
        ))
    }

    /// Writes an agent reply straight to the store, the way the CLI does from
    /// another process, so the app has emitted nothing for it.
    pub fn agent_reply(&self, thread_id: &str, text: &str) -> String {
        let canonical = self.ctx.repo_path().canonicalize().unwrap();
        let store = reviewdb::open(self.ctx.data_dir()).unwrap();

        store
            .write(|tx| {
                reviewdb::replies::add(
                    tx,
                    &canonical,
                    thread_id,
                    text,
                    Channel::Agent,
                    Delivery::Send,
                    1_001,
                )
            })
            .unwrap()
    }

    pub fn mark_replies_seen(&self, ids: &[String]) -> Result<usize, String> {
        tauri::async_runtime::block_on(mark_replies_seen(
            self.ctx.path().to_string(),
            ids.to_vec(),
            self.app.state::<RepoState>(),
            self.app.state::<ReviewStoreState>(),
            self.app.handle().clone(),
        ))
    }

    pub fn list_threads(&self) -> Result<Vec<RenderedThread>, String> {
        tauri::async_runtime::block_on(list_threads(
            self.ctx.path().to_string(),
            None,
            self.app.state::<RepoState>(),
            self.app.state::<ReviewStoreState>(),
            self.app.state::<SweptRepos>(),
            self.app.handle().clone(),
        ))
    }

    /// Capture the repository's graph and publish it through the commit cache,
    /// as opening the repository or the file watcher does.
    pub fn publish_graph(&self) {
        let cache = self.app.state::<CommitCache>();
        let visibility = self.app.state::<RefVisibilityState>();
        let location = self.ctx.repo_path().to_path_buf();

        tauri::async_runtime::block_on(
            GraphRebuild::new(&cache, &visibility)
                .rebuild(self.ctx.path().to_string(), move || {
                    trunk_lib::state::read_graph(&mut git2::Repository::open(location)?)
                }),
        )
        .unwrap();
    }

    /// The full staleness pass a working-tree change starts.
    pub fn refresh_staleness(&self) -> Result<usize, String> {
        tauri::async_runtime::block_on(refresh_thread_staleness(
            self.ctx.path().to_string(),
            self.app.state::<RepoState>(),
            self.app.state::<ReviewStoreState>(),
            self.app.handle().clone(),
        ))
    }

    /// The narrower pass a refs-only change starts while the tab is on screen.
    pub fn refresh_ref_staleness(&self) -> Result<usize, String> {
        tauri::async_runtime::block_on(refresh_thread_ref_staleness(
            self.ctx.path().to_string(),
            self.app.state::<RepoState>(),
            self.app.state::<ReviewStoreState>(),
            self.app.handle().clone(),
        ))
    }

    /// Hide `full_ref` in the graph, as the sidebar's eye does, before the next
    /// publication.
    pub fn hide_ref(&self, full_ref: &str) {
        let visibility = self.app.state::<RefVisibilityState>();
        let mut hidden = visibility.get(self.ctx.path());
        hidden.hidden_refs.insert(full_ref.to_string());

        visibility.set(self.ctx.path().to_string(), hidden);
    }

    /// The graph the app has published for this repository now.
    pub fn published_graph(&self) -> trunk_git::graph_input::GraphSnapshot {
        self.app
            .state::<CommitCache>()
            .snapshot(self.ctx.path())
            .unwrap()
    }

    /// A follow decided against `published`, the way a task started by an earlier
    /// publication or recheck runs once a newer graph has been published.
    pub fn follow_against(
        &self,
        store: &reviewdb::Store,
        published: &trunk_git::graph_input::GraphSnapshot,
    ) -> usize {
        let canonical = self.ctx.repo_path().canonicalize().unwrap();

        follow_rewritten_commits(
            store,
            &canonical,
            self.ctx.path(),
            Some(published),
            &self.app.state::<CommitCache>(),
        )
        .unwrap()
    }

    /// Each later `reviews-changed`, for a test that blocks until work the app
    /// started on its own has announced itself.
    pub fn reviews_changed_events(&self) -> Receiver<()> {
        let (tx, rx) = mpsc::channel();
        self.app.listen("reviews-changed", move |_| {
            let _ = tx.send(());
        });

        rx
    }

    pub fn fired_reviews_changed(&self) -> bool {
        *self.fired.lock().unwrap()
    }

    /// Clears the fired flag, so a test can isolate whether a later command
    /// fires the event, separate from setup that fired it already.
    pub fn reset_fired(&self) {
        *self.fired.lock().unwrap() = false;
    }
}

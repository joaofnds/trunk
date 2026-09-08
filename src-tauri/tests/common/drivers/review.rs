use crate::common::context::TestContext;
use std::sync::{Arc, Mutex};
use tauri::test::MockRuntime;
use tauri::{Listener, Manager};
use trunk_lib::commands::review::{RenderedThread, add_reply, add_thread, list_threads};
use trunk_lib::git::types::Anchor;
use trunk_lib::state::{RepoState, ReviewStoreState, StoreSlot, SweptRepos};

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
            self.app.state::<RepoState>(),
            self.app.state::<ReviewStoreState>(),
            self.app.handle().clone(),
        ))
    }

    pub fn list_threads(&self) -> Result<Vec<RenderedThread>, String> {
        tauri::async_runtime::block_on(list_threads(
            self.ctx.path().to_string(),
            self.app.state::<RepoState>(),
            self.app.state::<ReviewStoreState>(),
            self.app.state::<SweptRepos>(),
            self.app.handle().clone(),
        ))
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

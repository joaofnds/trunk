//! Characterizes `reviews-changed`: every review mutation command must fire it,
//! so a command that forgets the emit is a silently stale panel (TRUNK-20).

mod common;

use common::context::TestContext;
use std::sync::{Arc, Mutex};
use tauri::{Listener, Manager};
use trunk_lib::commands::review::add_thread;
use trunk_lib::git::types::{Anchor, Side, Source};
use trunk_lib::state::{RepoState, ReviewStoreState, StoreSlot};

/// Clears `TRUNK_DATA_DIR` on drop, so a panic mid-test (an `unwrap()` on an
/// unexpected error, say) still leaves the env var unset for the next test in
/// this binary.
struct DataDirGuard;

impl Drop for DataDirGuard {
    fn drop(&mut self) {
        // SAFETY: single-threaded test process; no other thread reads this env var.
        unsafe { std::env::remove_var("TRUNK_DATA_DIR") };
    }
}

#[test]
fn add_thread_fires_reviews_changed() {
    let ctx = TestContext::new_empty();
    // SAFETY: single-threaded test process; no other thread reads this env var.
    unsafe { std::env::set_var("TRUNK_DATA_DIR", ctx.data_dir()) };
    let _guard = DataDirGuard;

    let app = tauri::test::mock_app();
    app.manage(RepoState(Mutex::new(ctx.state_map().clone())));
    app.manage(ReviewStoreState(StoreSlot::default()));

    let fired = Arc::new(Mutex::new(false));
    let fired_handle = Arc::clone(&fired);
    app.listen("reviews-changed", move |_| {
        *fired_handle.lock().unwrap() = true;
    });

    let anchor = Anchor {
        commit_oid: "0".repeat(40),
        file_path: "a.txt".to_string(),
        source: Source::Diff,
        side: Side::New,
        start_line: 1,
        end_line: 1,
    };

    tauri::async_runtime::block_on(add_thread(
        ctx.path().to_string(),
        "a comment".to_string(),
        anchor,
        String::new(),
        app.state::<RepoState>(),
        app.state::<ReviewStoreState>(),
        app.handle().clone(),
    ))
    .unwrap();

    assert!(*fired.lock().unwrap(), "reviews-changed did not fire");
}

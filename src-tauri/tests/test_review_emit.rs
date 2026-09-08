//! Characterizes `reviews-changed`: every review mutation command must fire it,
//! so a command that forgets the emit is a silently stale panel (TRUNK-20).

mod common;

use common::context::TestContext;
use trunk_lib::git::types::{Anchor, Side, Source};

fn anchor() -> Anchor {
    Anchor {
        commit_oid: "0".repeat(40),
        file_path: "a.txt".to_string(),
        source: Source::Diff,
        side: Side::New,
        start_line: 1,
        end_line: 1,
    }
}

#[test]
fn add_thread_fires_reviews_changed() {
    let ctx = TestContext::new_empty();
    let driver = ctx.review();

    driver
        .add_thread("a comment", anchor(), "")
        .expect("add_thread should write the thread");
    let fired = driver.fired_reviews_changed();
    drop(driver);

    assert!(fired, "reviews-changed did not fire");
}

#[test]
fn add_reply_fires_reviews_changed() {
    let ctx = TestContext::new_empty();
    let driver = ctx.review();

    driver
        .add_thread("a comment", anchor(), "")
        .expect("add_thread should write the thread");
    let threads = driver.list_threads().expect("list_threads should succeed");
    let thread_id = &threads.first().expect("thread should exist").id;
    driver.reset_fired();

    driver
        .add_reply(thread_id, "a reply")
        .expect("add_reply should write the reply");
    let fired = driver.fired_reviews_changed();
    drop(driver);

    assert!(fired, "reviews-changed did not fire for add_reply");
}

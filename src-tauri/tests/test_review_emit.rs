//! Characterizes `reviews-changed`: every review mutation command must fire it,
//! so a command that forgets the emit is a silently stale panel (TRUNK-20).

mod common;

use common::context::TestContext;
use trunk_review::types::{Anchor, Side, Source};

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

fn thread_with_agent_reply(driver: &common::drivers::review::ReviewDriver<'_>) -> String {
    driver
        .add_thread("a comment", anchor(), "")
        .expect("add_thread should write the thread");
    let threads = driver.list_threads().expect("list_threads should succeed");
    let thread_id = &threads.first().expect("thread should exist").id;

    driver.agent_reply(thread_id, "an answer")
}

#[test]
fn marking_an_unseen_reply_seen_fires_reviews_changed() {
    let ctx = TestContext::new_empty();
    let driver = ctx.review();
    let reply_id = thread_with_agent_reply(&driver);
    driver.reset_fired();

    driver
        .mark_replies_seen(&[reply_id])
        .expect("mark_replies_seen should write");
    let fired = driver.fired_reviews_changed();
    drop(driver);

    assert!(fired, "reviews-changed did not fire for mark_replies_seen");
}

#[test]
fn marking_a_seen_reply_seen_again_stays_silent() {
    let ctx = TestContext::new_empty();
    let driver = ctx.review();
    let ids = [thread_with_agent_reply(&driver)];
    driver.mark_replies_seen(&ids).expect("first mark");
    driver.reset_fired();

    driver.mark_replies_seen(&ids).expect("second mark");
    let fired = driver.fired_reviews_changed();
    drop(driver);

    assert!(
        !fired,
        "a mark that changed nothing must not refresh every panel"
    );
}

#[test]
fn a_listed_agent_reply_reads_seen_once_marked() {
    let ctx = TestContext::new_empty();
    let driver = ctx.review();
    let reply_id = thread_with_agent_reply(&driver);
    let before = driver.list_threads().expect("list before")[0].replies[0].seen;

    driver
        .mark_replies_seen(std::slice::from_ref(&reply_id))
        .expect("mark_replies_seen should write");
    let after = driver.list_threads().expect("list after")[0].replies[0].seen;
    drop(driver);

    assert_eq!((before, after), (false, true));
}

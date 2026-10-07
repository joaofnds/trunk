//! Comments reach the agent the moment they are submitted, unless the user
//! holds them in a batch, as GitHub's Start a review does. Sending the batch
//! hands every held comment over at once.

mod common;

use common::context::TestContext;
use std::path::{Path, PathBuf};
use trunk_lib::commands::review::list_threads_inner;
use trunk_review::reviewdb::{self, Store, replies, reviews, threads};
use trunk_review::types::{Channel, Delivery};

fn setup() -> (TestContext, Store, PathBuf) {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    (ctx, store, canonical)
}

fn a_review(store: &Store, canonical: &Path) -> String {
    store
        .write(|tx| reviews::create(tx, canonical, Some("a review"), 1_000))
        .unwrap()
}

fn comment(store: &Store, review: &str, delivery: Delivery) -> String {
    store
        .write(|tx| {
            threads::insert(
                tx,
                review,
                threads::NewThread {
                    text: "a comment".to_string(),
                    anchor: None,
                    commit_oid: None,
                    content_pin: None,
                    cached_excerpt: None,
                    delivery,
                },
                1_000,
            )
        })
        .unwrap()
}

fn reply(
    store: &Store,
    canonical: &Path,
    thread: &str,
    channel: Channel,
    delivery: Delivery,
) -> String {
    store
        .write(|tx| replies::add(tx, canonical, thread, "a reply", channel, delivery, 1_000))
        .unwrap()
}

fn thread_ids(store: &Store, review: &str, reader: Channel) -> Vec<String> {
    store
        .read(|c| threads::list_for_review(c, review, reader))
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect()
}

fn reply_ids(store: &Store, thread: &str, reader: Channel) -> Vec<String> {
    store
        .read(|c| replies::list_for_threads(c, &[thread.to_string()], reader))
        .unwrap()
        .remove(thread)
        .unwrap_or_default()
        .into_iter()
        .map(|r| r.id)
        .collect()
}

fn review(store: &Store, id: &str) -> reviews::Review {
    store.read(|c| reviews::get(c, id)).unwrap().unwrap()
}

fn send(store: &Store, canonical: &Path, review: &str) {
    store
        .write(|tx| reviews::send_batch(tx, canonical, review, 2_000))
        .unwrap();
}

#[test]
fn a_sent_comment_reaches_the_agent() {
    let (_ctx, store, canonical) = setup();
    let review = a_review(&store, &canonical);

    let thread = comment(&store, &review, Delivery::Send);

    assert_eq!(thread_ids(&store, &review, Channel::Agent), vec![thread]);
}

#[test]
fn a_held_comment_is_hidden_from_the_agent_and_shown_to_the_reviewer() {
    let (_ctx, store, canonical) = setup();
    let review = a_review(&store, &canonical);

    let thread = comment(&store, &review, Delivery::Hold);

    assert!(thread_ids(&store, &review, Channel::Agent).is_empty());
    assert_eq!(thread_ids(&store, &review, Channel::Human), vec![thread]);
}

#[test]
fn a_sent_comment_joins_a_batch_the_review_already_holds() {
    let (_ctx, store, canonical) = setup();
    let review = a_review(&store, &canonical);
    comment(&store, &review, Delivery::Hold);

    comment(&store, &review, Delivery::Send);

    assert!(thread_ids(&store, &review, Channel::Agent).is_empty());
}

#[test]
fn a_sent_comment_joins_a_batch_held_by_a_reply_alone() {
    let (_ctx, store, canonical) = setup();
    let review = a_review(&store, &canonical);
    let first = comment(&store, &review, Delivery::Send);
    reply(&store, &canonical, &first, Channel::Human, Delivery::Hold);

    comment(&store, &review, Delivery::Send);

    assert_eq!(thread_ids(&store, &review, Channel::Agent), vec![first]);
}

#[test]
fn a_held_reply_on_a_sent_thread_is_hidden_from_the_agent() {
    let (_ctx, store, canonical) = setup();
    let review = a_review(&store, &canonical);
    let thread = comment(&store, &review, Delivery::Send);

    let held = reply(&store, &canonical, &thread, Channel::Human, Delivery::Hold);

    assert!(reply_ids(&store, &thread, Channel::Agent).is_empty());
    assert_eq!(reply_ids(&store, &thread, Channel::Human), vec![held]);
}

#[test]
fn a_sent_reply_joins_a_batch_the_review_already_holds() {
    let (_ctx, store, canonical) = setup();
    let review = a_review(&store, &canonical);
    let thread = comment(&store, &review, Delivery::Send);
    comment(&store, &review, Delivery::Hold);

    reply(&store, &canonical, &thread, Channel::Human, Delivery::Send);

    assert!(reply_ids(&store, &thread, Channel::Agent).is_empty());
}

#[test]
fn an_agent_reply_is_never_held() {
    let (_ctx, store, canonical) = setup();
    let review = a_review(&store, &canonical);
    let thread = comment(&store, &review, Delivery::Send);
    comment(&store, &review, Delivery::Hold);

    let agent = reply(&store, &canonical, &thread, Channel::Agent, Delivery::Send);

    assert_eq!(reply_ids(&store, &thread, Channel::Agent), vec![agent]);
}

#[test]
fn sending_the_batch_hands_every_held_comment_to_the_agent() {
    let (_ctx, store, canonical) = setup();
    let review = a_review(&store, &canonical);
    let live = comment(&store, &review, Delivery::Send);
    let held_reply = reply(&store, &canonical, &live, Channel::Human, Delivery::Hold);
    let held_thread = comment(&store, &review, Delivery::Hold);

    send(&store, &canonical, &review);

    assert_eq!(
        thread_ids(&store, &review, Channel::Agent),
        vec![live.clone(), held_thread]
    );
    assert_eq!(reply_ids(&store, &live, Channel::Agent), vec![held_reply]);
}

#[test]
fn sending_one_review_leaves_another_reviews_batch_held() {
    let (_ctx, store, canonical) = setup();
    let sent = a_review(&store, &canonical);
    let kept = a_review(&store, &canonical);
    comment(&store, &sent, Delivery::Hold);
    comment(&store, &kept, Delivery::Hold);

    send(&store, &canonical, &sent);

    assert!(thread_ids(&store, &kept, Channel::Agent).is_empty());
}

#[test]
fn a_review_holding_only_held_comments_is_not_visible_to_the_agent() {
    let (_ctx, store, canonical) = setup();
    let id = a_review(&store, &canonical);

    comment(&store, &id, Delivery::Hold);

    assert!(!review(&store, &id).visible_to_agent);
}

#[test]
fn a_review_is_visible_to_the_agent_once_a_comment_is_sent() {
    let (_ctx, store, canonical) = setup();
    let id = a_review(&store, &canonical);

    comment(&store, &id, Delivery::Send);

    assert!(review(&store, &id).visible_to_agent);
}

#[test]
fn a_review_counts_its_held_comments_and_replies() {
    let (_ctx, store, canonical) = setup();
    let id = a_review(&store, &canonical);
    let thread = comment(&store, &id, Delivery::Send);
    reply(&store, &canonical, &thread, Channel::Human, Delivery::Hold);
    comment(&store, &id, Delivery::Hold);

    let before = review(&store, &id).pending_count;
    send(&store, &canonical, &id);

    assert_eq!(before, 2);
    assert_eq!(review(&store, &id).pending_count, 0);
}

#[test]
fn sending_a_review_from_another_repo_answers_not_found() {
    let (_ctx, store, canonical) = setup();
    let id = a_review(&store, &canonical);
    comment(&store, &id, Delivery::Hold);

    let refused = store
        .write(|tx| reviews::send_batch(tx, Path::new("/elsewhere"), &id, 2_000))
        .unwrap_err();

    assert_eq!(refused.code, "not_found");
    assert_eq!(review(&store, &id).pending_count, 1, "the batch stays held");
}

fn listed_batch_held(store: &Store, canonical: &Path, review: &str) -> Vec<bool> {
    list_threads_inner(store, canonical, Some(review))
        .unwrap()
        .into_iter()
        .map(|t| t.batch_held)
        .collect()
}

#[test]
fn every_listed_thread_says_its_review_holds_a_batch() {
    let (_ctx, store, canonical) = setup();
    let id = a_review(&store, &canonical);
    comment(&store, &id, Delivery::Send);
    comment(&store, &id, Delivery::Hold);

    assert_eq!(listed_batch_held(&store, &canonical, &id), vec![true, true]);
}

#[test]
fn a_held_reply_alone_holds_the_batch() {
    let (_ctx, store, canonical) = setup();
    let id = a_review(&store, &canonical);
    let thread = comment(&store, &id, Delivery::Send);
    reply(&store, &canonical, &thread, Channel::Human, Delivery::Hold);

    assert_eq!(listed_batch_held(&store, &canonical, &id), vec![true]);
}

#[test]
fn a_listed_thread_holds_no_batch_once_it_is_sent() {
    let (_ctx, store, canonical) = setup();
    let id = a_review(&store, &canonical);
    comment(&store, &id, Delivery::Hold);

    send(&store, &canonical, &id);

    assert_eq!(listed_batch_held(&store, &canonical, &id), vec![false]);
}

mod migrating_from_v11 {
    use super::*;
    use rusqlite::Connection;

    /// A v11 store holding one unpublished review and one published review,
    /// each with a thread carrying a human reply.
    fn a_v11_store(ctx: &TestContext, canonical: &Path) -> (String, String) {
        let store = reviewdb::open(ctx.data_dir()).unwrap();
        let unpublished = a_review(&store, canonical);
        let published = a_review(&store, canonical);
        for review in [&unpublished, &published] {
            let thread = comment(&store, review, Delivery::Send);
            reply(&store, canonical, &thread, Channel::Human, Delivery::Send);
        }
        drop(store);

        let conn = Connection::open(ctx.data_dir().join("reviews.db")).unwrap();
        conn.execute_batch(
            "ALTER TABLE threads DROP COLUMN pending;
             ALTER TABLE replies DROP COLUMN pending;
             ALTER TABLE reviews ADD COLUMN published INTEGER NOT NULL DEFAULT 0;
             PRAGMA user_version = 11;",
        )
        .unwrap();
        conn.execute(
            "UPDATE reviews SET published = 1 WHERE id = ?1",
            [&published],
        )
        .unwrap();

        (unpublished, published)
    }

    #[test]
    fn holds_everything_in_an_unpublished_review() {
        let ctx = TestContext::new_empty();
        let canonical = ctx.repo_path().canonicalize().unwrap();
        let (unpublished, _) = a_v11_store(&ctx, &canonical);

        let store = reviewdb::open(ctx.data_dir()).unwrap();

        assert!(thread_ids(&store, &unpublished, Channel::Agent).is_empty());
        assert_eq!(review(&store, &unpublished).pending_count, 2);
    }

    #[test]
    fn keeps_a_published_review_live() {
        let ctx = TestContext::new_empty();
        let canonical = ctx.repo_path().canonicalize().unwrap();
        let (_, published) = a_v11_store(&ctx, &canonical);

        let store = reviewdb::open(ctx.data_dir()).unwrap();

        assert_eq!(thread_ids(&store, &published, Channel::Agent).len(), 1);
        assert_eq!(review(&store, &published).pending_count, 0);
    }
}

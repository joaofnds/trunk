//! Whose move a thread waits on: the channel of its latest action. An agent
//! that starts after the reviewer acted has no event to tell it so, and reads
//! this instead of guessing from the order of the replies.

mod common;

use common::context::TestContext;
use std::path::{Path, PathBuf};
use trunk_review::reviewdb::{self, Store, replies, reviews, threads};
use trunk_review::types::{Channel, Delivery, ThreadState};

fn setup() -> (TestContext, Store, PathBuf) {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    (ctx, store, canonical)
}

fn a_comment(store: &Store, canonical: &Path) -> (String, String) {
    store
        .write(|tx| {
            let review = reviews::create(tx, canonical, Some("a review"), 1_000)?;
            let thread = threads::insert(
                tx,
                &review,
                threads::NewThread {
                    whole_file: false,
                    text: "a comment".to_string(),
                    anchor: None,
                    commit_oid: None,
                    content_pin: None,
                    cached_excerpt: None,
                    delivery: Delivery::Send,
                },
                1_000,
            )?;
            Ok((review, thread))
        })
        .unwrap()
}

fn reply(
    store: &Store,
    canonical: &Path,
    thread: &str,
    channel: Channel,
    delivery: Delivery,
    now: i64,
) {
    store
        .write(|tx| replies::add(tx, canonical, thread, "a reply", channel, delivery, now))
        .unwrap();
}

fn set_state(
    store: &Store,
    canonical: &Path,
    thread: &str,
    state: ThreadState,
    channel: Channel,
    now: i64,
) {
    store
        .write(|tx| threads::set_state(tx, canonical, thread, state, channel, now))
        .unwrap();
}

fn last_action(store: &Store, thread: &str) -> Channel {
    store.read(|c| threads::last_action(c, thread)).unwrap()
}

#[test]
fn a_new_comment_waits_on_the_agent() {
    let (_ctx, store, canonical) = setup();
    let (_review, thread) = a_comment(&store, &canonical);

    assert_eq!(last_action(&store, &thread), Channel::Human);
}

#[test]
fn an_agent_reply_answers_the_comment() {
    let (_ctx, store, canonical) = setup();
    let (_review, thread) = a_comment(&store, &canonical);

    reply(
        &store,
        &canonical,
        &thread,
        Channel::Agent,
        Delivery::Send,
        2_000,
    );

    assert_eq!(last_action(&store, &thread), Channel::Agent);
}

#[test]
fn an_agent_claim_after_its_reply_leaves_the_move_with_the_reviewer() {
    let (_ctx, store, canonical) = setup();
    let (_review, thread) = a_comment(&store, &canonical);
    reply(
        &store,
        &canonical,
        &thread,
        Channel::Agent,
        Delivery::Send,
        2_000,
    );

    set_state(
        &store,
        &canonical,
        &thread,
        ThreadState::Addressed,
        Channel::Agent,
        2_001,
    );

    assert_eq!(last_action(&store, &thread), Channel::Agent);
}

#[test]
fn a_human_reply_after_the_agent_reply_waits_on_the_agent() {
    let (_ctx, store, canonical) = setup();
    let (_review, thread) = a_comment(&store, &canonical);
    reply(
        &store,
        &canonical,
        &thread,
        Channel::Agent,
        Delivery::Send,
        2_000,
    );

    reply(
        &store,
        &canonical,
        &thread,
        Channel::Human,
        Delivery::Send,
        3_000,
    );

    assert_eq!(last_action(&store, &thread), Channel::Human);
}

#[test]
fn a_reopen_with_no_reply_waits_on_the_agent() {
    let (_ctx, store, canonical) = setup();
    let (_review, thread) = a_comment(&store, &canonical);
    reply(
        &store,
        &canonical,
        &thread,
        Channel::Agent,
        Delivery::Send,
        2_000,
    );
    set_state(
        &store,
        &canonical,
        &thread,
        ThreadState::Addressed,
        Channel::Agent,
        2_001,
    );

    set_state(
        &store,
        &canonical,
        &thread,
        ThreadState::Open,
        Channel::Human,
        3_000,
    );

    assert_eq!(last_action(&store, &thread), Channel::Human);
}

#[test]
fn an_edit_after_the_agent_reply_waits_on_the_agent() {
    let (_ctx, store, canonical) = setup();
    let (_review, thread) = a_comment(&store, &canonical);
    reply(
        &store,
        &canonical,
        &thread,
        Channel::Agent,
        Delivery::Send,
        2_000,
    );

    store
        .write(|tx| threads::edit(tx, &canonical, &thread, "a sharper comment", 3_000))
        .unwrap();

    assert_eq!(last_action(&store, &thread), Channel::Human);
}

#[test]
fn a_reply_written_held_before_the_agent_reply_and_sent_after_it_waits_on_the_agent() {
    let (_ctx, store, canonical) = setup();
    let (review, thread) = a_comment(&store, &canonical);
    reply(
        &store,
        &canonical,
        &thread,
        Channel::Human,
        Delivery::Hold,
        1_500,
    );
    reply(
        &store,
        &canonical,
        &thread,
        Channel::Agent,
        Delivery::Send,
        2_000,
    );

    store
        .write(|tx| reviews::send_batch(tx, &canonical, &review, 3_000))
        .unwrap();

    assert_eq!(last_action(&store, &thread), Channel::Human);
}

#[test]
fn a_held_reply_the_reviewer_has_not_sent_is_not_yet_an_action() {
    let (_ctx, store, canonical) = setup();
    let (_review, thread) = a_comment(&store, &canonical);
    reply(
        &store,
        &canonical,
        &thread,
        Channel::Agent,
        Delivery::Send,
        2_000,
    );

    reply(
        &store,
        &canonical,
        &thread,
        Channel::Human,
        Delivery::Hold,
        3_000,
    );

    assert_eq!(last_action(&store, &thread), Channel::Agent);
}

#[test]
fn a_reviewer_action_in_the_same_second_as_the_agent_reply_waits_on_the_agent() {
    let (_ctx, store, canonical) = setup();
    let (_review, thread) = a_comment(&store, &canonical);
    reply(
        &store,
        &canonical,
        &thread,
        Channel::Agent,
        Delivery::Send,
        2_000,
    );

    reply(
        &store,
        &canonical,
        &thread,
        Channel::Human,
        Delivery::Send,
        2_000,
    );

    assert_eq!(last_action(&store, &thread), Channel::Human);
}

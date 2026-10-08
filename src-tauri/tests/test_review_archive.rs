//! Archiving a review: the user puts it away, the agent stops seeing it, and
//! unarchiving brings it back as it was.

mod common;

use common::context::TestContext;
use std::path::{Path, PathBuf};
use trunk_lib::commands::review::set_active_review_inner;
use trunk_review::reviewdb::{self, Store, reviews, threads};
use trunk_review::types::Delivery;

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

fn archived(store: &Store, id: &str) -> bool {
    store
        .read(|c| reviews::get(c, id))
        .unwrap()
        .unwrap()
        .archived
}

#[test]
fn an_archived_review_reads_archived_until_it_is_unarchived() {
    let (_ctx, store, canonical) = setup();
    let id = a_review(&store, &canonical);

    store
        .write(|tx| reviews::archive(tx, &canonical, &id, 2_000))
        .unwrap();
    let after_archive = archived(&store, &id);
    store
        .write(|tx| reviews::unarchive(tx, &canonical, &id, 3_000))
        .unwrap();

    assert!(after_archive);
    assert!(!archived(&store, &id));
}

#[test]
fn an_archived_review_is_not_visible_to_the_agent_whatever_it_was_sent() {
    let (_ctx, store, canonical) = setup();
    let id = a_review(&store, &canonical);
    store
        .write(|tx| {
            threads::insert(
                tx,
                &id,
                threads::NewThread {
                    whole_file: false,
                    text: "sent".to_string(),
                    anchor: None,
                    commit_oid: None,
                    content_pin: None,
                    cached_excerpt: None,
                    delivery: Delivery::Send,
                },
                1_000,
            )
        })
        .unwrap();

    store
        .write(|tx| reviews::archive(tx, &canonical, &id, 2_000))
        .unwrap();

    let review = store.read(|c| reviews::get(c, &id)).unwrap().unwrap();
    assert!(!review.visible_to_agent);
}

#[test]
fn a_new_review_is_not_archived() {
    let (_ctx, store, canonical) = setup();

    let id = a_review(&store, &canonical);

    assert!(!archived(&store, &id));
}

#[test]
fn archiving_the_active_review_leaves_the_repo_pointing_at_none() {
    let (_ctx, store, canonical) = setup();
    let id = a_review(&store, &canonical);
    store
        .write(|tx| reviews::set_active(tx, &canonical, &id))
        .unwrap();

    store
        .write(|tx| reviews::archive(tx, &canonical, &id, 2_000))
        .unwrap();

    assert_eq!(
        store.read(|c| reviews::active(c, &canonical)).unwrap(),
        None
    );
}

#[test]
fn archiving_another_review_keeps_the_active_one() {
    let (_ctx, store, canonical) = setup();
    let active = a_review(&store, &canonical);
    let other = a_review(&store, &canonical);
    store
        .write(|tx| reviews::set_active(tx, &canonical, &active))
        .unwrap();

    store
        .write(|tx| reviews::archive(tx, &canonical, &other, 2_000))
        .unwrap();

    assert_eq!(
        store.read(|c| reviews::active(c, &canonical)).unwrap(),
        Some(active)
    );
}

#[test]
fn archiving_a_review_of_another_repo_is_refused() {
    let (_ctx, store, canonical) = setup();
    let elsewhere = TestContext::new_empty();
    let other_repo = elsewhere.repo_path().canonicalize().unwrap();
    let id = a_review(&store, &other_repo);

    let err = store
        .write(|tx| reviews::archive(tx, &canonical, &id, 2_000))
        .unwrap_err();

    assert_eq!(err.code, "not_found");
    assert!(!archived(&store, &id));
}

#[test]
fn a_v10_store_gains_the_archived_flag_with_every_review_unarchived() {
    let (ctx, store, canonical) = setup();
    let id = a_review(&store, &canonical);
    drop(store);
    {
        let conn = rusqlite::Connection::open(ctx.data_dir().join("reviews.db")).unwrap();
        conn.execute_batch("ALTER TABLE threads DROP COLUMN whole_file; ALTER TABLE threads DROP COLUMN pending; ALTER TABLE replies DROP COLUMN pending; ALTER TABLE reviews ADD COLUMN published INTEGER NOT NULL DEFAULT 1; ALTER TABLE reviews DROP COLUMN archived; PRAGMA user_version = 10;")
            .unwrap();
    }

    let store = reviewdb::open(ctx.data_dir()).unwrap();

    assert!(!archived(&store, &id));
    assert_eq!(
        store.read(reviewdb::schema::user_version).unwrap(),
        reviewdb::schema::CURRENT_VERSION
    );
}

#[test]
fn an_archived_review_cannot_be_made_active() {
    let (_ctx, store, canonical) = setup();
    let id = a_review(&store, &canonical);
    store
        .write(|tx| reviews::archive(tx, &canonical, &id, 2_000))
        .unwrap();

    let err = set_active_review_inner(&store, &canonical, &id).unwrap_err();

    assert_eq!(err.code, "archived");
    assert_eq!(
        store.read(|c| reviews::active(c, &canonical)).unwrap(),
        None
    );
}

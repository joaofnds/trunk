//! A thread's history: each state change, who made it, when, and the commit an
//! agent names as its fix, which the card draws between the replies.

mod common;

use common::context::TestContext;
use trunk_lib::commands::review::{SubmitThreadRequest, list_threads_inner, submit_thread_inner};
use trunk_review::reviewdb::{self, Store, history::StateChange};
use trunk_review::types::{Anchor, Channel, Side, Source, ThreadState};

fn submission() -> SubmitThreadRequest {
    SubmitThreadRequest {
        text: "a comment".to_string(),
        anchor: Some(Anchor {
            commit_oid: "abc123def456".to_string(),
            file_path: "src/lib/foo.rs".to_string(),
            source: Source::Diff,
            side: Side::New,
            start_line: 12,
            end_line: 34,
        }),
        commit_oid: None,
        content_pin: None,
        cached_excerpt: Some("let x = 1;".to_string()),
        clears_draft: true,
    }
}

fn history(store: &Store, thread: &str) -> Vec<StateChange> {
    store
        .read(|c| reviewdb::history::list_for_threads(c, &[thread.to_string()]))
        .unwrap()
        .remove(thread)
        .unwrap_or_default()
}

fn setup() -> (TestContext, Store, std::path::PathBuf, String) {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread = submit_thread_inner(&store, &canonical, submission(), 1_000).unwrap();
    (ctx, store, canonical, thread)
}

#[test]
fn a_state_change_records_who_made_it_and_when() {
    let (_ctx, store, canonical, thread) = setup();

    store
        .write(|tx| {
            reviewdb::threads::set_state(
                tx,
                &canonical,
                &thread,
                ThreadState::Addressed,
                Channel::Agent,
                1_001,
            )
        })
        .unwrap();

    assert_eq!(
        history(&store, &thread),
        vec![StateChange {
            state: ThreadState::Addressed,
            channel: Channel::Agent,
            commit: None,
            created_at: 1_001,
        }]
    );
}

#[test]
fn an_addressed_claim_keeps_the_commit_it_names() {
    let (_ctx, store, canonical, thread) = setup();

    store
        .write(|tx| {
            reviewdb::threads::set_state_at_commit(
                tx,
                &canonical,
                &thread,
                ThreadState::Addressed,
                Channel::Agent,
                Some("a3f9c21d00000000000000000000000000000000"),
                1_001,
            )
        })
        .unwrap();

    assert_eq!(
        history(&store, &thread)[0].commit.as_deref(),
        Some("a3f9c21d00000000000000000000000000000000")
    );
}

#[test]
fn a_refused_state_change_records_nothing() {
    let (_ctx, store, canonical, thread) = setup();

    let refused = store.write(|tx| {
        reviewdb::threads::set_state(
            tx,
            &canonical,
            &thread,
            ThreadState::Done,
            Channel::Agent,
            1_001,
        )
    });

    assert!(refused.is_err());
    assert_eq!(history(&store, &thread), vec![]);
}

#[test]
fn deleting_a_thread_deletes_its_history() {
    let (_ctx, store, canonical, thread) = setup();
    store
        .write(|tx| {
            reviewdb::threads::set_state(
                tx,
                &canonical,
                &thread,
                ThreadState::Dismissed,
                Channel::Human,
                1_001,
            )?;
            reviewdb::threads::delete(tx, &canonical, &thread)
        })
        .unwrap();

    let left: i64 = store
        .read(|c| {
            c.query_row("SELECT count(*) FROM thread_history", [], |r| r.get(0))
                .map_err(|e| trunk_git::error::TrunkError::new("sqlite", e.to_string()))
        })
        .unwrap();

    assert_eq!(left, 0);
}

#[test]
fn a_listed_thread_carries_its_history() {
    let (_ctx, store, canonical, thread) = setup();
    store
        .write(|tx| {
            reviewdb::threads::set_state(
                tx,
                &canonical,
                &thread,
                ThreadState::Done,
                Channel::Human,
                1_001,
            )
        })
        .unwrap();

    let listed = list_threads_inner(&store, &canonical, None).unwrap();

    assert_eq!(listed[0].history.len(), 1);
    assert_eq!(listed[0].history[0].state, ThreadState::Done);
}

#[test]
fn a_v9_store_gains_the_history_table_and_keeps_its_threads() {
    let (ctx, store, canonical, thread) = setup();
    drop(store);
    {
        let conn = rusqlite::Connection::open(ctx.data_dir().join(reviewdb::DB_FILE)).unwrap();
        conn.execute_batch("DROP TABLE thread_history; PRAGMA user_version = 9;")
            .unwrap();
    }

    let store = reviewdb::open(ctx.data_dir()).unwrap();
    store
        .write(|tx| {
            reviewdb::threads::set_state(
                tx,
                &canonical,
                &thread,
                ThreadState::Dismissed,
                Channel::Human,
                1_002,
            )
        })
        .unwrap();

    assert_eq!(
        store.read(reviewdb::schema::user_version).unwrap(),
        reviewdb::schema::CURRENT_VERSION
    );
    assert_eq!(history(&store, &thread)[0].state, ThreadState::Dismissed);
}

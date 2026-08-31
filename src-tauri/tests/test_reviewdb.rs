//! The persistent review store, driven through the command layer's `_inner`
//! seams — the same wedge `test_review.rs` uses for the JSON session store.

mod common;

use common::context::TestContext;
use trunk_lib::commands::review::{
    SubmitThreadRequest, list_threads_inner, set_thread_state_inner, submit_thread_inner,
};
use trunk_lib::git::types::{Anchor, Side, Source};
use trunk_lib::review_types::{Channel, ThreadState};
use trunk_lib::reviewdb::{self, reviews::ReviewState};

/// A commit-set member with the subject a test stores it under.
fn member(oid: &str, subject: &str) -> reviewdb::commits::ReviewCommit {
    reviewdb::commits::ReviewCommit {
        oid: oid.to_string(),
        subject: subject.to_string(),
    }
}

fn diff_anchor() -> Anchor {
    Anchor {
        commit_oid: "abc123def456".to_string(),
        file_path: "src/lib/foo.rs".to_string(),
        source: Source::Diff,
        side: Side::New,
        start_line: 12,
        end_line: 34,
    }
}

fn submission(text: &str) -> SubmitThreadRequest {
    SubmitThreadRequest {
        text: text.to_string(),
        anchor: Some(diff_anchor()),
        commit_oid: None,
        cached_excerpt: Some("let x = 1;".to_string()),
        clears_draft: true,
    }
}

#[test]
fn submit_with_no_active_review_creates_one() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    submit_thread_inner(&store, &canonical, submission("looks wrong"), 1_000).unwrap();

    let reviews = store
        .read(|c| reviewdb::reviews::list(c, &canonical))
        .unwrap();
    assert_eq!(
        reviews.len(),
        1,
        "a gesture with no active review creates one"
    );
    assert_eq!(
        reviews[0].state,
        ReviewState::Composing,
        "an auto-created review is composing — nothing publishes it",
    );
    assert_eq!(reviews[0].thread_count, 1);
}

#[test]
fn a_submitted_thread_survives_a_restart() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    {
        let store = reviewdb::open(ctx.data_dir()).unwrap();
        submit_thread_inner(&store, &canonical, submission("still here?"), 1_000).unwrap();
    }

    let reopened = reviewdb::open(ctx.data_dir()).unwrap();

    let reviews = reopened
        .read(|c| reviewdb::reviews::list(c, &canonical))
        .unwrap();
    assert_eq!(reviews.len(), 1);
    let threads = reopened
        .read(|c| reviewdb::threads::list_for_review(c, &reviews[0].id))
        .unwrap();
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].text, "still here?");
    assert_eq!(
        threads[0].anchor.as_ref().unwrap().start_line,
        12,
        "the anchor must round-trip through the store, not just the body",
    );
}

#[test]
fn a_second_submit_lands_in_the_same_review() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    submit_thread_inner(&store, &canonical, submission("first"), 1_000).unwrap();
    submit_thread_inner(&store, &canonical, submission("second"), 1_000).unwrap();

    let reviews = store
        .read(|c| reviewdb::reviews::list(c, &canonical))
        .unwrap();
    assert_eq!(
        reviews.len(),
        1,
        "auto-creation fires only when there is no active review",
    );
    assert_eq!(reviews[0].thread_count, 2);
}

#[test]
fn one_repos_threads_do_not_leak_into_another() {
    let ctx = TestContext::new_empty();
    let other = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let other_canonical = other.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    submit_thread_inner(&store, &canonical, submission("mine"), 1_000).unwrap();

    assert_eq!(
        store
            .read(|c| reviewdb::reviews::list(c, &other_canonical))
            .unwrap()
            .len(),
        0,
        "one database holds every repo, so the repo_path column is the isolation",
    );
}

// ── Milestone 2, Task 1: replies table, v2 migration, cascade delete ────────

#[test]
fn a_reply_survives_a_restart() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let thread_id = {
        let store = reviewdb::open(ctx.data_dir()).unwrap();
        let id = submit_thread_inner(&store, &canonical, submission("root"), 1_000).unwrap();
        store
            .write(|tx| {
                reviewdb::replies::add(tx, &canonical, &id, "a reply", Channel::Human, 1_001)
            })
            .unwrap();
        id
    };

    let reopened = reviewdb::open(ctx.data_dir()).unwrap();
    let replies = reopened
        .read(|c| reviewdb::replies::list_for_threads(c, std::slice::from_ref(&thread_id)))
        .unwrap();
    let replies = replies.get(&thread_id).cloned().unwrap_or_default();

    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0].text, "a reply");
    assert_eq!(replies[0].channel, Channel::Human);
    assert_eq!(replies[0].thread_id, thread_id);
}

/// A frozen snapshot of the v1 `reviews` + `threads` DDL, written directly so
/// this test proves the migration is additive against a REAL v1 store rather
/// than one this build already upgraded on the way in.
const V1_SNAPSHOT: &str = r#"
CREATE TABLE reviews (
    id         TEXT PRIMARY KEY,
    repo_path  TEXT    NOT NULL,
    title      TEXT    NOT NULL,
    published  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE threads (
    id          TEXT PRIMARY KEY,
    review_id   TEXT    NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    body        TEXT    NOT NULL,
    channel     TEXT    NOT NULL CHECK (channel IN ('human', 'agent')),
    state       TEXT    NOT NULL DEFAULT 'open'
                CHECK (state IN ('open', 'addressed', 'done', 'dismissed')),
    stale       INTEGER NOT NULL DEFAULT 0,
    anchor_kind TEXT    NOT NULL CHECK (anchor_kind IN ('diff', 'commit', 'none')),
    commit_oid  TEXT,
    file_path   TEXT,
    source      TEXT CHECK (source IS NULL OR source IN ('Diff', 'FullFile')),
    side        TEXT CHECK (side IS NULL OR side IN ('Old', 'New')),
    start_line  INTEGER,
    end_line    INTEGER,
    excerpt     TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE review_commits (
    review_id TEXT    NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    oid       TEXT    NOT NULL,
    position  INTEGER NOT NULL,
    PRIMARY KEY (review_id, oid)
);

PRAGMA user_version = 1;
"#;

#[test]
fn migrates_v1_to_v2_additively() {
    let dir = tempfile::tempdir().unwrap();
    {
        let conn = rusqlite::Connection::open(dir.path().join(reviewdb::DB_FILE)).unwrap();
        conn.execute_batch(V1_SNAPSHOT).unwrap();
        conn.execute(
            "INSERT INTO reviews (id, repo_path, title, published, created_at, updated_at)
             VALUES ('REVIEW01', '/repo', 'title', 0, 1000, 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO threads (id, review_id, body, channel, anchor_kind, created_at, updated_at)
             VALUES ('THREAD01', 'REVIEW01', 'pre-existing', 'human', 'none', 1000, 1000)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO review_commits (review_id, oid, position)
             VALUES ('REVIEW01', 'oldoid', 0)",
            [],
        )
        .unwrap();
    }

    let store = reviewdb::open(dir.path()).unwrap();

    let version = store.read(reviewdb::schema::user_version).unwrap();
    assert_eq!(version, reviewdb::schema::CURRENT_VERSION);

    let reviews = store
        .read(|c| reviewdb::reviews::list(c, std::path::Path::new("/repo")))
        .unwrap();
    assert_eq!(reviews.len(), 1, "a v1 review must survive the migration");

    assert_eq!(
        store
            .read(|c| reviewdb::commits::list(c, "REVIEW01"))
            .unwrap(),
        vec![member("oldoid", "")],
        "a pre-v3 commit row survives with an empty stored subject",
    );

    let reply_id = store
        .write(|tx| {
            reviewdb::replies::add(
                tx,
                std::path::Path::new("/repo"),
                "THREAD01",
                "a v2 reply",
                Channel::Human,
                1_001,
            )
        })
        .unwrap();
    let replies = store
        .read(|c| reviewdb::replies::list_for_threads(c, &["THREAD01".to_string()]))
        .unwrap();
    assert_eq!(
        replies
            .get("THREAD01")
            .map(|rs| rs.iter().map(|r| &r.id).collect::<Vec<_>>())
            .unwrap_or_default(),
        vec![&reply_id],
        "the new replies table must be usable against a pre-existing thread",
    );
}

#[test]
fn deleting_a_composing_thread_cascades_to_replies() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id = submit_thread_inner(&store, &canonical, submission("root"), 1_000).unwrap();
    store
        .write(|tx| {
            reviewdb::replies::add(tx, &canonical, &thread_id, "a reply", Channel::Human, 1_001)
        })
        .unwrap();

    store
        .write(|tx| reviewdb::threads::delete(tx, &canonical, &thread_id))
        .unwrap();

    let replies = store
        .read(|c| reviewdb::replies::list_for_threads(c, std::slice::from_ref(&thread_id)))
        .unwrap();
    assert!(
        replies.get(&thread_id).is_none_or(|rs| rs.is_empty()),
        "deleting a thread must take its replies with it (ON DELETE CASCADE)",
    );
}

#[test]
fn each_thread_gets_only_its_own_replies() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_a = submit_thread_inner(&store, &canonical, submission("thread a"), 1_000).unwrap();
    let thread_b = submit_thread_inner(&store, &canonical, submission("thread b"), 1_001).unwrap();
    store
        .write(|tx| {
            reviewdb::replies::add(
                tx,
                &canonical,
                &thread_a,
                "reply on a",
                Channel::Human,
                1_002,
            )
        })
        .unwrap();
    store
        .write(|tx| {
            reviewdb::replies::add(
                tx,
                &canonical,
                &thread_b,
                "reply on b",
                Channel::Human,
                1_003,
            )
        })
        .unwrap();

    let by_thread = store
        .read(|c| reviewdb::replies::list_for_threads(c, &[thread_a.clone(), thread_b.clone()]))
        .unwrap();

    let texts_a: Vec<&str> = by_thread[&thread_a]
        .iter()
        .map(|r| r.text.as_str())
        .collect();
    let texts_b: Vec<&str> = by_thread[&thread_b]
        .iter()
        .map(|r| r.text.as_str())
        .collect();
    assert_eq!(
        texts_a,
        vec!["reply on a"],
        "thread a must not see thread b's reply"
    );
    assert_eq!(
        texts_b,
        vec!["reply on b"],
        "thread b must not see thread a's reply"
    );
}

#[test]
fn replies_keep_their_insertion_order_within_one_second() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id = submit_thread_inner(&store, &canonical, submission("root"), 1_000).unwrap();

    // The same pinned timestamp for all three: ordering must not fall through to
    // the random id, which would sort them by a coin flip.
    for text in ["first", "second", "third"] {
        store
            .write(|tx| {
                reviewdb::replies::add(tx, &canonical, &thread_id, text, Channel::Human, 1_001)
            })
            .unwrap();
    }

    let by_thread = store
        .read(|c| reviewdb::replies::list_for_threads(c, std::slice::from_ref(&thread_id)))
        .unwrap();
    let texts: Vec<&str> = by_thread[&thread_id]
        .iter()
        .map(|r| r.text.as_str())
        .collect();
    assert_eq!(texts, vec!["first", "second", "third"]);
}

// ── Milestone 2, Task 3: replying from the UI ────────────────────────────────

#[test]
fn a_ui_reply_is_attributed_human() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id = submit_thread_inner(&store, &canonical, submission("root"), 1_000).unwrap();

    trunk_lib::commands::review::add_reply_inner(&store, &canonical, &thread_id, "a reply", 1_001)
        .unwrap();

    let threads = list_threads_inner(&store, &canonical).unwrap();
    let thread = threads.iter().find(|t| t.id == thread_id).unwrap();
    assert_eq!(thread.replies.len(), 1);
    assert_eq!(thread.replies[0].channel, Channel::Human);
    assert_eq!(thread.replies[0].text, "a reply");
}

#[test]
fn a_reply_aimed_at_another_repos_thread_is_refused() {
    let ctx = TestContext::new_empty();
    let other = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let other_canonical = other.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let other_thread_id =
        submit_thread_inner(&store, &other_canonical, submission("root"), 1_000).unwrap();

    let err = trunk_lib::commands::review::add_reply_inner(
        &store,
        &canonical,
        &other_thread_id,
        "planted",
        1_001,
    )
    .unwrap_err();

    assert_eq!(err.code, "not_found");
}

// ── Task 4: per-repo snapshot rows ───────────────────────────────────────────

use trunk_lib::commands::review::{ensure_review_snapshot_inner, read_snapshots_inner};
use trunk_lib::git::workdir_snapshot::SnapshotKind;

#[test]
fn ensure_snapshot_reuses_the_repos_prior_oid() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    std::fs::write(ctx.repo_path().join("a.txt"), "edited").unwrap();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    let first =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
            .unwrap();
    let second =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
            .unwrap();

    assert_eq!(
        first, second,
        "an unchanged worktree must reuse the stored snapshot — without a prior, \
         get-or-create degenerates and every submit mints a fresh snapshot commit",
    );
}

#[test]
fn a_changed_worktree_mints_a_fresh_snapshot() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    std::fs::write(ctx.repo_path().join("a.txt"), "edited").unwrap();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    let first =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
            .unwrap();
    std::fs::write(ctx.repo_path().join("a.txt"), "edited again").unwrap();
    let second =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
            .unwrap();

    assert_ne!(
        first, second,
        "a changed tree supersedes the prior snapshot"
    );
    assert_eq!(
        read_snapshots_inner(&store, &canonical)
            .unwrap()
            .working_tree_snapshot,
        Some(second),
        "the stored pointer tracks the latest snapshot",
    );
}

#[test]
fn snapshots_are_per_repo_not_per_review() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    std::fs::write(ctx.repo_path().join("a.txt"), "edited").unwrap();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    let oid =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
            .unwrap();
    // A second review for the same repo — the snapshot is not scoped to either.
    let second_review = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, Some("another"), 0))
        .unwrap();
    store
        .write(|tx| reviewdb::reviews::set_active(tx, &canonical, &second_review))
        .unwrap();

    assert_eq!(
        read_snapshots_inner(&store, &canonical)
            .unwrap()
            .working_tree_snapshot,
        Some(oid),
        "switching the active review must not change which snapshot the repo is pinned to",
    );
}

#[test]
fn the_two_snapshot_kinds_are_tracked_apart() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    std::fs::write(ctx.repo_path().join("a.txt"), "edited").unwrap();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    let workdir =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
            .unwrap();
    let index =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Index, 1_000)
            .unwrap();

    let stored = read_snapshots_inner(&store, &canonical).unwrap();
    assert_eq!(stored.working_tree_snapshot, Some(workdir));
    assert_eq!(stored.index_snapshot, Some(index));
    assert_ne!(
        stored.working_tree_snapshot, stored.index_snapshot,
        "an unstaged comment dedups against the workdir tree, a staged one against the index",
    );
}

// ── Milestone 3, Task 7: the store revision counter ─────────────────────────

/// The poll emits only when `store_revision` moved (plan §3): every mutation
/// bumps it, EXCEPT the per-keystroke draft autosave — a draft bump would
/// refetch every thread several times a second while the user types.
#[test]
fn every_write_bumps_the_revision_except_the_draft_autosave() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let before = store.read(reviewdb::revision).unwrap();

    submit_thread_inner(&store, &canonical, submission("bump"), 1_000).unwrap();
    let after_thread = store.read(reviewdb::revision).unwrap();
    assert!(
        after_thread > before,
        "a thread submit must move the revision ({before} -> {after_thread})",
    );

    trunk_lib::commands::review::save_draft_inner(&store, &canonical, "typing…", None, 1_001)
        .unwrap();
    assert_eq!(
        store.read(reviewdb::revision).unwrap(),
        after_thread,
        "the draft autosave must not move the revision",
    );
}

// ── Milestone 3, watch verb: the store's event feed ─────────────────────────

/// The event-driven counterpart of the poll (João 2026-08-31): the writer
/// rings a unix-socket doorbell, `store_revision` decides whether the wakeup
/// means anything. No timer anywhere in the production path, and none in
/// these tests either: `sync` blocks until every ring delivered so far has
/// been processed, so each assertion below is about what the subscriber did
/// rather than about how long the test was willing to wait.
#[test]
fn store_events_fire_on_a_foreign_commit() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    reviewdb::open(ctx.data_dir()).unwrap();
    let events = reviewdb::events::subscribe(ctx.data_dir()).unwrap();

    let foreign = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(
        &foreign,
        &canonical,
        submission("from another process"),
        1_000,
    )
    .unwrap();

    assert!(events.sync(), "the feed must still be live");
    assert!(
        matches!(
            events.try_recv(),
            Some(reviewdb::events::StoreEvent::Changed { .. }),
        ),
        "a foreign revision-bumping commit must produce an event",
    );
}

/// The listener's half of the contract, which the two tests above cannot
/// reach: they assert that a quiet write never rings, so the listener never
/// runs. Here the doorbell is rung with no write behind it at all. The
/// module's promise is that a coalesced or spurious ring is verified against
/// `store_meta.revision` and discarded, so nothing is announced.
#[test]
fn store_events_ignore_a_ring_with_no_commit_behind_it() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    reviewdb::open(ctx.data_dir()).unwrap();
    let events = reviewdb::events::subscribe(ctx.data_dir()).unwrap();

    reviewdb::events::ring(ctx.data_dir());
    reviewdb::events::ring(ctx.data_dir());

    assert!(events.sync(), "the feed must still be live");
    assert!(
        events.try_recv().is_none(),
        "a ring with no revision movement behind it must announce nothing",
    );
}

/// The window TRUNK-57 found open in the poll: a write landing between the
/// subscriber starting up and its listener first running. Here the socket is
/// bound before the baseline revision is read, so such a write is either
/// already in the baseline or queued in the socket backlog — never lost.
///
/// The assertion is the invariant, not the event. A test that accepted both
/// an event and no event would pass with the window reopened, because a lost
/// commit and a commit already in the baseline both show up as no event. What
/// separates them is the baseline itself: if nothing was announced, the
/// commit must already be inside it. `baseline` exposes that, so the two
/// cases are told apart rather than both waved through.
#[test]
fn store_events_survive_a_commit_racing_the_subscribe() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    reviewdb::open(ctx.data_dir()).unwrap();
    let before = reviewdb::open(ctx.data_dir())
        .unwrap()
        .read(reviewdb::revision)
        .unwrap();
    let foreign = reviewdb::open(ctx.data_dir()).unwrap();

    let writing = std::thread::spawn(move || {
        submit_thread_inner(&foreign, &canonical, submission("racing"), 1_000).unwrap();
    });
    let events = reviewdb::events::subscribe(ctx.data_dir()).unwrap();
    writing.join().unwrap();

    assert!(events.sync(), "the feed must still be live");
    let revision = reviewdb::open(ctx.data_dir())
        .unwrap()
        .read(reviewdb::revision)
        .unwrap();
    assert_ne!(
        revision, before,
        "the racing commit must have bumped the revision, or this test races nothing",
    );
    match events.try_recv() {
        // The commit landed after the baseline: it must have been announced.
        Some(reviewdb::events::StoreEvent::Changed { revision: seen }) => {
            assert_eq!(
                seen, revision,
                "the announced revision must be the current one"
            );
        }
        // Nothing was announced, so the only way the commit was not lost is
        // that the baseline already contained it. This is the arm that fails
        // when the socket binds after the baseline is read.
        None => {
            assert_eq!(
                events.baseline(),
                Some(revision),
                "a commit that produced no event must already be in the baseline",
            );
        }
        other => panic!("unexpected event: {other:?}"),
    }
}

/// A peer that connects and never writes must not be able to stall the feed.
/// `is_sync` reads the connection to tell a barrier from a doorbell, and a
/// read with no deadline would park the listener thread forever: the loop
/// never reaches `accept` again, every later doorbell goes unread, and a
/// running watch goes deaf without erroring. The read therefore gives up,
/// and a peer that says nothing in time is treated as the doorbell it
/// most likely is.
#[test]
fn store_events_survive_a_peer_that_connects_and_says_nothing() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    reviewdb::open(ctx.data_dir()).unwrap();
    let events = reviewdb::events::subscribe(ctx.data_dir()).unwrap();

    let socket = std::fs::read_dir(ctx.data_dir().join("w"))
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| path.extension().and_then(|e| e.to_str()) == Some("sock"))
        .expect("the subscriber's socket");
    let mute = std::os::unix::net::UnixStream::connect(&socket).unwrap();

    // A real commit behind the mute peer. If the listener is stuck on it,
    // this doorbell is never processed and the event never arrives.
    let foreign = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(
        &foreign,
        &canonical,
        submission("behind a mute peer"),
        1_000,
    )
    .unwrap();

    // The barrier is the assertion everywhere else in this file, but here it
    // is the thing under test: a wedged listener never acknowledges, so a
    // bare `sync()` would hang instead of failing. Run it on its own thread
    // and give it a deadline, so the wedge is reported rather than waited on.
    let (done, settled) = std::sync::mpsc::channel();
    let barrier = std::thread::spawn(move || {
        let live = events.sync();
        let event = events.try_recv();
        let _ = done.send(());
        (live, event)
    });
    assert!(
        settled
            .recv_timeout(std::time::Duration::from_secs(10))
            .is_ok(),
        "a silent peer must not stall the listener: the feed stopped answering",
    );
    let (live, event) = barrier.join().unwrap();

    assert!(live, "the feed must still be live");
    assert!(
        matches!(event, Some(reviewdb::events::StoreEvent::Changed { .. })),
        "a commit behind a silent peer must still be announced",
    );
    drop(mute);
}

#[test]
fn store_events_stay_silent_for_a_draft_autosave() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    reviewdb::open(ctx.data_dir()).unwrap();
    let events = reviewdb::events::subscribe(ctx.data_dir()).unwrap();

    let foreign = reviewdb::open(ctx.data_dir()).unwrap();
    trunk_lib::commands::review::save_draft_inner(&foreign, &canonical, "typing…", None, 1_000)
        .unwrap();

    assert!(events.sync(), "the feed must still be live");
    assert!(
        events.try_recv().is_none(),
        "a draft autosave commits without bumping the revision — no event",
    );
}

/// The poll tests below drive the loop rather than waiting on it: the test
/// supplies the ticker, so `run_cycle` returns only once that cycle's work is
/// done and every assertion is about what the loop did, not about how fast the
/// scheduler got to it. The wall clock made these fail under `cargo mutants`,
/// which saturates the machine (João 2026-08-31).
#[test]
fn poll_announces_a_foreign_commit_on_the_next_cycle() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    reviewdb::open(ctx.data_dir()).unwrap();
    let (emitted, changes) = std::sync::mpsc::channel();
    let (ticker, driver) = reviewdb::poll::ManualTicker::new();
    let _poll = reviewdb::poll::spawn_ticked(ctx.data_dir(), ticker, move || {
        let _ = emitted.send(());
    });

    let foreign = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(
        &foreign,
        &canonical,
        submission("from another process"),
        1_000,
    )
    .unwrap();

    assert!(driver.run_cycle(), "the poll must keep running");
    changes
        .try_recv()
        .expect("a foreign revision-bumping commit must be announced");
}

#[test]
fn a_draft_write_triggers_no_emit() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    reviewdb::open(ctx.data_dir()).unwrap();
    let (emitted, changes) = std::sync::mpsc::channel();
    let (ticker, driver) = reviewdb::poll::ManualTicker::new();
    let _poll = reviewdb::poll::spawn_ticked(ctx.data_dir(), ticker, move || {
        let _ = emitted.send(());
    });

    let foreign = reviewdb::open(ctx.data_dir()).unwrap();
    trunk_lib::commands::review::save_draft_inner(&foreign, &canonical, "typing…", None, 1_000)
        .unwrap();

    assert!(driver.run_cycle(), "the poll must keep running");
    assert!(
        changes.try_recv().is_err(),
        "the draft autosave moves data_version but not the revision — no emit",
    );
}

/// D4/grilled §7: an open-time-only check would let a still-running old app
/// keep refetching a store a newer CLI just migrated. Every access path
/// refuses — open, read, write — and the poll stops instead of re-observing
/// the refusal every 300 ms.
#[test]
fn a_newer_store_refuses_open_write_and_poll() {
    let ctx = TestContext::new_empty();
    let held = reviewdb::open(ctx.data_dir()).unwrap();
    rusqlite::Connection::open(ctx.data_dir().join(reviewdb::DB_FILE))
        .unwrap()
        .pragma_update(None, "user_version", 99)
        .unwrap();

    let reopen = reviewdb::open(ctx.data_dir());
    assert_eq!(reopen.unwrap_err().code, "store_newer");

    let read = held.read(reviewdb::revision);
    assert_eq!(read.unwrap_err().code, "store_newer");

    let canonical = ctx.repo_path().canonicalize().unwrap();
    let write = submit_thread_inner(&held, &canonical, submission("refused"), 1_000);
    let err = write.unwrap_err();
    assert_eq!(err.code, "store_newer");
    assert!(
        err.message.contains("estart"),
        "the refusal must tell the user the way out is restarting, got {:?}",
        err.message,
    );

    let (ticker, driver) = reviewdb::poll::ManualTicker::new();
    let poll = reviewdb::poll::spawn_ticked(ctx.data_dir(), ticker, || {});
    assert!(
        !driver.run_cycle(),
        "the poll must stop on a refused store, not loop on the refusal",
    );
    // `run_cycle` alone is false for any missing loop, including one that never
    // spawned. Only a thread that started and then exited pins the refusal.
    assert!(
        poll.ran_and_stopped(),
        "the loop must have run and exited, not failed to start",
    );
}

// ── Milestone 2, Task 10: snapshot ref pruning at supersession ──────────────

#[test]
fn superseding_a_snapshot_deletes_the_old_pin() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let repo = git2::Repository::open(ctx.path()).unwrap();

    let mut last_oid = String::new();
    for (i, content) in ["edit 1", "edit 2", "edit 3"].iter().enumerate() {
        std::fs::write(ctx.repo_path().join("a.txt"), content).unwrap();
        last_oid = ensure_review_snapshot_inner(
            &store,
            &canonical,
            ctx.path(),
            SnapshotKind::Workdir,
            1_000 + i as i64,
        )
        .unwrap();
    }

    let refs: Vec<String> = repo
        .references_glob(&format!(
            "{}*",
            trunk_lib::git::workdir_snapshot::SNAPSHOT_REF_PREFIX
        ))
        .unwrap()
        .filter_map(|r| r.ok())
        .filter_map(|r| r.name().ok().map(str::to_owned))
        .collect();

    assert_eq!(
        refs,
        vec![format!(
            "{}{}",
            trunk_lib::git::workdir_snapshot::SNAPSHOT_REF_PREFIX,
            last_oid
        )],
        "only the current pin survives",
    );
}

/// Ruling on TRUNK-18 (2026-08-31): supersession alone must not unpin a
/// snapshot a thread still anchors to — gc would collect it and the thread's
/// inline diff would resolve CommitGone while the thread is still live.
#[test]
fn a_pin_survives_supersession_while_a_thread_anchors_to_it() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let repo = git2::Repository::open(ctx.path()).unwrap();

    std::fs::write(ctx.repo_path().join("a.txt"), "edit 1").unwrap();
    let anchored_oid =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
            .unwrap();
    let mut anchored = submission("on uncommitted work");
    anchored.anchor = Some(Anchor {
        commit_oid: anchored_oid.clone(),
        ..diff_anchor()
    });
    submit_thread_inner(&store, &canonical, anchored, 1_000).unwrap();

    std::fs::write(ctx.repo_path().join("a.txt"), "edit 2").unwrap();
    ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_001)
        .unwrap();

    let prefix = trunk_lib::git::workdir_snapshot::SNAPSHOT_REF_PREFIX;
    assert!(
        repo.find_reference(&format!("{prefix}{anchored_oid}"))
            .is_ok(),
        "a superseded snapshot a thread still anchors to must stay pinned",
    );
}

/// The gate scopes by repo: one database holds every repo, so a thread in one
/// repo must not keep another repo's superseded pin alive. Without the
/// `repo_path` clause in `any_anchored_to` this passes on the oid alone.
#[test]
fn a_thread_in_one_repo_does_not_pin_another_repos_snapshot() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let other = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let other_canonical = other.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let repo = git2::Repository::open(ctx.path()).unwrap();

    // The snapshot to be superseded lives in `ctx`, and nothing in `ctx`
    // anchors to it.
    std::fs::write(ctx.repo_path().join("a.txt"), "edit 1").unwrap();
    let superseded =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
            .unwrap();

    // The only thread anchored to that oid belongs to the OTHER repo.
    let mut foreign = submission("another repo's thread, same oid");
    foreign.anchor = Some(Anchor {
        commit_oid: superseded.clone(),
        ..diff_anchor()
    });
    submit_thread_inner(&store, &other_canonical, foreign, 1_000).unwrap();

    std::fs::write(ctx.repo_path().join("a.txt"), "edit 2").unwrap();
    ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_001)
        .unwrap();

    let prefix = trunk_lib::git::workdir_snapshot::SNAPSHOT_REF_PREFIX;
    assert!(
        repo.find_reference(&format!("{prefix}{superseded}"))
            .is_err(),
        "a foreign repo's thread must not keep this repo's superseded pin alive",
    );
}

#[test]
fn pruning_one_kind_leaves_the_other_pinned() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let repo = git2::Repository::open(ctx.path()).unwrap();

    // Stage the index kind's snapshot first — workdir_tree_oid swaps a
    // throwaway index into ensure_review_snapshot_inner's own repo handle,
    // but that handle is fresh per call, so ordering here is only about
    // which snapshot exists to compare the pin against, not contamination.
    std::fs::write(ctx.repo_path().join("a.txt"), "staged edit").unwrap();
    {
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("a.txt")).unwrap();
        idx.write().unwrap();
    }
    let index_oid =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Index, 1_000)
            .unwrap();
    let workdir_oid_1 =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
            .unwrap();

    // Supersede only the workdir kind.
    std::fs::write(ctx.repo_path().join("a.txt"), "staged edit\nmore").unwrap();
    ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_001)
        .unwrap();

    let prefix = trunk_lib::git::workdir_snapshot::SNAPSHOT_REF_PREFIX;
    assert!(
        repo.find_reference(&format!("{prefix}{index_oid}")).is_ok(),
        "the untouched kind's pin must survive",
    );
    assert!(
        repo.find_reference(&format!("{prefix}{workdir_oid_1}"))
            .is_err(),
        "the superseded kind's old pin must be pruned",
    );
}

#[test]
fn a_failed_store_write_leaves_the_old_pin_in_place() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let repo = git2::Repository::open(ctx.path()).unwrap();

    std::fs::write(ctx.repo_path().join("a.txt"), "edit 1").unwrap();
    let old_oid =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
            .unwrap();

    // Make the store-side write of the *next* snapshot fail, simulating a
    // busy-timeout or full-disk failure between the two ref calls — SQLite
    // fires a BEFORE INSERT trigger even for the ON CONFLICT DO UPDATE path
    // `snapshots::set` uses, so this blocks both a fresh row and an update.
    store
        .write(|tx| {
            tx.execute(
                "CREATE TRIGGER fail_snapshot_write BEFORE INSERT ON repo_snapshots
                 BEGIN SELECT RAISE(ABORT, 'simulated store.write failure'); END",
                [],
            )
            .map_err(reviewdb::sqlite_error)?;
            Ok(())
        })
        .unwrap();

    std::fs::write(ctx.repo_path().join("a.txt"), "edit 2").unwrap();
    let result =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_001);

    assert!(
        result.is_err(),
        "the simulated store.write failure must propagate",
    );

    let prefix = trunk_lib::git::workdir_snapshot::SNAPSHOT_REF_PREFIX;
    assert!(
        repo.find_reference(&format!("{prefix}{old_oid}")).is_ok(),
        "a store.write failure must not leave the old pin unpinned — pruning \
         must wait until the new oid is durably recorded",
    );
}

#[test]
fn review_deletion_touches_no_refs() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let repo = git2::Repository::open(ctx.path()).unwrap();

    std::fs::write(ctx.repo_path().join("a.txt"), "edited").unwrap();
    let oid =
        ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
            .unwrap();
    submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();
    let review_id = only_review(&store, &canonical).id;

    store
        .write(|tx| reviewdb::reviews::delete(tx, &canonical, &review_id))
        .unwrap();

    let snap_ref = format!(
        "{}{}",
        trunk_lib::git::workdir_snapshot::SNAPSHOT_REF_PREFIX,
        oid
    );
    assert!(
        repo.find_reference(&snap_ref).is_ok(),
        "review deletion must not touch snapshot refs — D8 makes them repo-level pins",
    );
}

// ── Tasks 5–8: list, derived state, rename, active pointer, publish, delete ──

use trunk_lib::reviewdb::Store;

fn only_review(store: &Store, canonical: &std::path::Path) -> trunk_lib::reviewdb::reviews::Review {
    store
        .read(|c| reviewdb::reviews::list(c, canonical))
        .unwrap()
        .pop()
        .expect("expected exactly one review")
}

#[test]
fn a_rename_round_trips_through_a_restart() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let id = {
        let store = reviewdb::open(ctx.data_dir()).unwrap();
        submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();
        let id = only_review(&store, &canonical).id;
        store
            .write(|tx| reviewdb::reviews::rename(tx, &canonical, &id, "Auth review", 0))
            .unwrap();
        id
    };

    let reopened = reviewdb::open(ctx.data_dir()).unwrap();

    assert_eq!(only_review(&reopened, &canonical).title, "Auth review");
    assert_eq!(only_review(&reopened, &canonical).id, id);
}

#[test]
fn a_default_title_carries_the_date_and_short_id() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();

    let review = only_review(&store, &canonical);
    assert!(
        review.title.starts_with("Review ") && review.title.ends_with(&review.id),
        "an auto-created review needs a readable default title, got {:?}",
        review.title,
    );
}

#[test]
fn gestures_land_in_the_switched_review() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("into the first"), 1_000).unwrap();
    let first = only_review(&store, &canonical).id;

    let second = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, Some("second"), 0))
        .unwrap();
    store
        .write(|tx| reviewdb::reviews::set_active(tx, &canonical, &second))
        .unwrap();
    submit_thread_inner(&store, &canonical, submission("into the second"), 1_000).unwrap();

    let threads = store
        .read(|c| reviewdb::threads::list_for_review(c, &second))
        .unwrap();
    assert_eq!(
        threads.len(),
        1,
        "the gesture after the switch lands in the new review"
    );
    assert_eq!(threads[0].text, "into the second");
    assert_eq!(
        store
            .read(|c| reviewdb::threads::list_for_review(c, &first))
            .unwrap()
            .len(),
        1,
        "the review switched away from keeps exactly what it had",
    );
}

#[test]
fn publishing_keeps_threads_and_refs() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    std::fs::write(ctx.repo_path().join("a.txt"), "edited").unwrap();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("keep me"), 1_000).unwrap();
    ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
        .unwrap();
    let id = only_review(&store, &canonical).id;

    store
        .write(|tx| reviewdb::reviews::publish(tx, &canonical, &id, 0))
        .unwrap();

    let review = only_review(&store, &canonical);
    assert!(review.published, "publishing sets the latch");
    assert_eq!(review.thread_count, 1, "publishing deletes no thread");
    assert_eq!(
        store
            .read(|c| reviewdb::threads::list_for_review(c, &id))
            .unwrap()[0]
            .text,
        "keep me",
    );

    let repo = ctx.repo();
    let pins: Vec<String> = repo
        .references_glob("refs/trunk/review-snapshots/*")
        .unwrap()
        .filter_map(|r| r.ok())
        .filter_map(|r| r.name().ok().map(str::to_owned))
        .collect();
    assert_eq!(
        pins.len(),
        1,
        "End Review no longer clears the snapshot keepalive refs — pruning is milestone 2's",
    );
}

#[test]
fn publishing_an_empty_review_is_refused() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let id = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, None, 0))
        .unwrap();

    let err = store
        .write(|tx| reviewdb::reviews::publish(tx, &canonical, &id, 0))
        .expect_err("a review with zero threads cannot be published");

    assert_eq!(err.code, "no_threads");
    assert!(
        !only_review(&store, &canonical).published,
        "a refused publish must leave the latch unset",
    );
}

#[test]
fn delete_review_removes_threads_and_pointer_in_one_transaction() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("doomed"), 1_000).unwrap();
    let id = only_review(&store, &canonical).id;

    store
        .write(|tx| reviewdb::reviews::delete(tx, &canonical, &id))
        .unwrap();

    assert_eq!(
        store
            .read(|c| reviewdb::reviews::list(c, &canonical))
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        store
            .read(|c| reviewdb::threads::list_for_review(c, &id))
            .unwrap()
            .len(),
        0,
        "threads cascade with their review",
    );
    assert_eq!(
        store
            .read(|c| reviewdb::reviews::active(c, &canonical))
            .unwrap(),
        None,
        "the active pointer cascades too — PRAGMA foreign_keys defaults OFF, and a \
         cascade that silently does not fire leaves a dangling row",
    );
}

#[test]
fn deleting_one_review_leaves_anothers_threads_intact() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("survivor"), 1_000).unwrap();
    let keeper = only_review(&store, &canonical).id;

    let doomed = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, Some("doomed"), 0))
        .unwrap();
    store
        .write(|tx| reviewdb::reviews::set_active(tx, &canonical, &doomed))
        .unwrap();
    submit_thread_inner(&store, &canonical, submission("goes away"), 1_000).unwrap();

    store
        .write(|tx| reviewdb::reviews::delete(tx, &canonical, &doomed))
        .unwrap();

    let left = store
        .read(|c| reviewdb::reviews::list(c, &canonical))
        .unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].id, keeper);
    assert_eq!(
        store
            .read(|c| reviewdb::threads::list_for_review(c, &keeper))
            .unwrap()[0]
            .text,
        "survivor",
        "an operation on one review leaves the others byte-identical",
    );
}

// ── Task 9: drafts live without a review ─────────────────────────────────────

use trunk_lib::commands::review::{get_draft_inner, save_draft_inner};

#[test]
fn a_draft_saves_with_no_review_in_existence() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    save_draft_inner(
        &store,
        &canonical,
        "half typed",
        Some(&diff_anchor()),
        1_000,
    )
    .unwrap();

    assert_eq!(
        store
            .read(|c| reviewdb::reviews::list(c, &canonical))
            .unwrap()
            .len(),
        0,
        "the draft row has no review foreign key — autosave must strand nothing",
    );
    let draft = get_draft_inner(&store, &canonical)
        .unwrap()
        .expect("a draft was saved");
    assert_eq!(draft.text, "half typed");
    assert_eq!(draft.anchor.as_ref().unwrap().start_line, 12);
}

#[test]
fn a_draft_survives_a_restart() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    {
        let store = reviewdb::open(ctx.data_dir()).unwrap();
        save_draft_inner(&store, &canonical, "typing...", None, 1_000).unwrap();
    }

    let reopened = reviewdb::open(ctx.data_dir()).unwrap();

    assert_eq!(
        get_draft_inner(&reopened, &canonical)
            .unwrap()
            .unwrap()
            .text,
        "typing...",
        "drafts still survive a crash — that is what l02c bought and D6 keeps",
    );
}

#[test]
fn submit_creates_review_thread_and_clears_draft() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    save_draft_inner(
        &store,
        &canonical,
        "half typed",
        Some(&diff_anchor()),
        1_000,
    )
    .unwrap();

    submit_thread_inner(&store, &canonical, submission("finished"), 1_000).unwrap();

    let reviews = store
        .read(|c| reviewdb::reviews::list(c, &canonical))
        .unwrap();
    assert_eq!(reviews.len(), 1, "one transaction created the review");
    assert_eq!(reviews[0].thread_count, 1, "…and the thread");
    assert!(
        get_draft_inner(&store, &canonical).unwrap().is_none(),
        "…and cleared the draft, so the composer never reopens with stale text",
    );
}

#[test]
fn cancelled_composer_creates_nothing() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    save_draft_inner(&store, &canonical, "never sent", None, 1_000).unwrap();
    store
        .write(|tx| reviewdb::drafts::delete(tx, &canonical))
        .unwrap();

    assert_eq!(
        store
            .read(|c| reviewdb::reviews::list(c, &canonical))
            .unwrap()
            .len(),
        0,
        "a cancelled composer leaves no review behind — auto-creation is at submit",
    );
    assert!(get_draft_inner(&store, &canonical).unwrap().is_none());
}

// ── Task 10: the active review carries a commit set ──────────────────────────

#[test]
fn seeding_a_range_populates_the_active_reviews_commits() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();
    let id = only_review(&store, &canonical).id;

    store
        .write(|tx| {
            reviewdb::commits::seed(
                tx,
                &id,
                &[member("oid-a", "subject a"), member("oid-b", "subject b")],
            )
        })
        .unwrap();

    assert_eq!(
        store.read(|c| reviewdb::commits::list(c, &id)).unwrap(),
        vec![member("oid-a", "subject a"), member("oid-b", "subject b")],
        "the commit set is per review and keeps its seeded order",
    );
}

#[test]
fn adding_and_removing_a_commit_is_idempotent() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let id = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, None, 0))
        .unwrap();

    store
        .write(|tx| reviewdb::commits::add(tx, &id, "oid-a", "subject a"))
        .unwrap();
    store
        .write(|tx| reviewdb::commits::add(tx, &id, "oid-a", "subject a"))
        .unwrap();
    assert_eq!(
        store
            .read(|c| reviewdb::commits::list(c, &id))
            .unwrap()
            .len(),
        1
    );

    store
        .write(|tx| reviewdb::commits::remove(tx, &id, "oid-a"))
        .unwrap();
    store
        .write(|tx| reviewdb::commits::remove(tx, &id, "oid-a"))
        .unwrap();
    assert_eq!(
        store
            .read(|c| reviewdb::commits::list(c, &id))
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn each_review_carries_its_own_commit_set() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let first = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, Some("a"), 0))
        .unwrap();
    let second = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, Some("b"), 0))
        .unwrap();

    store
        .write(|tx| reviewdb::commits::add(tx, &first, "only-in-first", "s"))
        .unwrap();

    assert_eq!(
        store
            .read(|c| reviewdb::commits::list(c, &second))
            .unwrap()
            .len(),
        0
    );
}

// ── Task 12: the v2 session JSON is neither read nor written ─────────────────

#[test]
fn a_v2_session_file_is_left_byte_identical_and_ignored() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    std::fs::write(ctx.repo_path().join("a.txt"), "edited").unwrap();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let sessions = ctx.data_dir().join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let seeded = sessions.join("deadbeefdeadbeef.json");
    let body = br#"{"schema_version":2,"commits":[],"comments":[{"id":"old","text":"from v2","anchor":null,"cached_excerpt":null,"commit_oid":null}],"draft_comment":null}"#;
    std::fs::write(&seeded, body).unwrap();

    let store = reviewdb::open(ctx.data_dir()).unwrap();
    assert_eq!(
        store
            .read(|c| reviewdb::reviews::list(c, &canonical))
            .unwrap()
            .len(),
        0,
        "the new store starts empty on a data dir holding a populated session file",
    );

    submit_thread_inner(&store, &canonical, submission("new world"), 1_000).unwrap();
    save_draft_inner(&store, &canonical, "d", None, 1_000).unwrap();
    ensure_review_snapshot_inner(&store, &canonical, ctx.path(), SnapshotKind::Workdir, 1_000)
        .unwrap();

    assert_eq!(
        std::fs::read(&seeded).unwrap(),
        body.to_vec(),
        "a full store round trip must neither import nor delete the v2 file",
    );
}

// ── Task 11: copy-as-markdown for a named review, from store rows ────────────

use trunk_lib::commands::review::generate_review_doc_inner;

#[test]
fn renders_a_stored_review() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "alpha\nbeta\ngamma\n")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let head = ctx
        .repo()
        .head()
        .unwrap()
        .peel_to_commit()
        .unwrap()
        .id()
        .to_string();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    for (text, excerpt) in [("first note", "alpha"), ("second note", "beta")] {
        let mut anchor = diff_anchor();
        anchor.commit_oid = head.clone();
        anchor.file_path = "a.txt".to_string();
        anchor.start_line = 1;
        anchor.end_line = 1;
        submit_thread_inner(
            &store,
            &canonical,
            SubmitThreadRequest {
                text: text.to_string(),
                anchor: Some(anchor),
                commit_oid: None,
                cached_excerpt: Some(excerpt.to_string()),
                clears_draft: true,
            },
            1_000,
        )
        .unwrap();
    }
    let review = only_review(&store, &canonical);
    store
        .write(|tx| reviewdb::commits::add(tx, &review.id, &head, "head subject"))
        .unwrap();

    let doc = generate_review_doc_inner(&store, &canonical, ctx.path(), &review.id).unwrap();

    assert!(
        doc.contains("first note"),
        "both thread bodies must reach the doc"
    );
    assert!(
        !doc.contains("review reply"),
        "a composing review's doc must omit the CLI instructions (criterion 11)",
    );

    store
        .write(|tx| reviewdb::reviews::publish(tx, &canonical, &review.id, 2_000))
        .unwrap();
    let published_doc =
        generate_review_doc_inner(&store, &canonical, ctx.path(), &review.id).unwrap();
    let exe = std::env::current_exe().unwrap().display().to_string();
    assert!(
        published_doc.contains(&format!("{exe} review reply")),
        "a published review's doc must teach the generating binary's own path and verbs",
    );
    assert!(doc.contains("second note"));
    assert!(
        doc.contains(&review.id),
        "the doc must name the review's short id — it is how the CLI addresses it",
    );
    assert!(
        doc.contains("## Commits"),
        "the commit set still feeds the Commits section"
    );
}

#[test]
fn a_review_with_no_threads_refuses_to_render() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let id = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, None, 0))
        .unwrap();

    let err = generate_review_doc_inner(&store, &canonical, ctx.path(), &id).unwrap_err();

    assert_eq!(err.code, "no_threads");
}

#[test]
fn mutating_one_review_leaves_another_doc_byte_identical() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "alpha\n")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("in the first"), 1_000).unwrap();
    let first = only_review(&store, &canonical).id;
    let before = generate_review_doc_inner(&store, &canonical, ctx.path(), &first).unwrap();

    let second = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, Some("other"), 0))
        .unwrap();
    store
        .write(|tx| reviewdb::reviews::set_active(tx, &canonical, &second))
        .unwrap();
    submit_thread_inner(&store, &canonical, submission("in the second"), 1_000).unwrap();
    store
        .write(|tx| reviewdb::reviews::publish(tx, &canonical, &second, 0))
        .unwrap();
    store
        .write(|tx| reviewdb::reviews::rename(tx, &canonical, &second, "renamed", 0))
        .unwrap();

    assert_eq!(
        generate_review_doc_inner(&store, &canonical, ctx.path(), &first).unwrap(),
        before,
        "any operation on one review must leave the others' printed content unchanged",
    );
}

// ── Named acceptance-criterion checks (plan §7) ──────────────────────────────

#[test]
fn lists_every_review_for_the_repo_with_state_and_title() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    // Explicit, spaced timestamps: the list orders by created_at, so a literal
    // that predates the real clock would invert the two rows.
    let first = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, Some("First pass"), 1_000))
        .unwrap();
    store
        .write(|tx| reviewdb::reviews::set_active(tx, &canonical, &first))
        .unwrap();
    submit_thread_inner(&store, &canonical, submission("in the first"), 1_000).unwrap();
    store
        .write(|tx| reviewdb::reviews::publish(tx, &canonical, &first, 1_000))
        .unwrap();
    let second = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, Some("Second pass"), 2_000))
        .unwrap();

    let listed = store
        .read(|c| reviewdb::reviews::list(c, &canonical))
        .unwrap();

    assert_eq!(listed.len(), 2, "every review for the repo is listed");
    assert_eq!(listed[0].id, first);
    assert_eq!(listed[0].state, ReviewState::Ready);
    assert_eq!(listed[0].thread_count, 1);
    assert_eq!(listed[1].id, second);
    assert_eq!(listed[1].state, ReviewState::Composing);
    assert_eq!(
        listed[1].title, "Second pass",
        "each row carries its own editable title and short id",
    );
}

#[test]
fn publish_leaves_the_pointer_on_the_published_review() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();
    let id = only_review(&store, &canonical).id;

    store
        .write(|tx| reviewdb::reviews::publish(tx, &canonical, &id, 0))
        .unwrap();

    assert_eq!(
        store
            .read(|c| reviewdb::reviews::active(c, &canonical))
            .unwrap(),
        Some(id.clone()),
        "publishing does not touch the pointer — the just-published review keeps \
         receiving gestures",
    );

    submit_thread_inner(&store, &canonical, submission("after publish"), 1_000).unwrap();
    assert_eq!(
        only_review(&store, &canonical).thread_count,
        2,
        "a published review keeps gaining threads",
    );
}

// ── Milestone 2, Task 2: the transition matrix ───────────────────────────────
// The matrix itself is pinned by `the_transition_matrix_is_exact` and its
// companions, unit tests beside `ThreadState::transition` in `review_types.rs`
// (moved with the function, TRUNK-17). What stays here is the I/O seam.

/// `set_thread_state_inner` is the UI-facing seam and always claims
/// `Channel::Human` internally (spec §2: the CLI is the only caller allowed to
/// claim `Channel::Agent`). Open -> Addressed is legal only for `Agent`, so a
/// UI-driven claim must be refused. If the hardcode is ever loosened to a
/// permissive channel, this test starts failing.
#[test]
fn set_thread_state_inner_refuses_a_ui_driven_addressed_claim() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id = submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();

    let err = set_thread_state_inner(
        &store,
        &canonical,
        &thread_id,
        ThreadState::Addressed,
        1_001,
    )
    .unwrap_err();

    assert_eq!(err.code, "illegal_transition");
}

fn schema_rejects(column: &str, value: &str) {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id = submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();

    let err = store
        .write(|tx| {
            tx.execute(
                &format!("UPDATE threads SET {column} = '{value}' WHERE id = ?1"),
                [&thread_id],
            )
            .map_err(trunk_lib::reviewdb::sqlite_error)
        })
        .unwrap_err();

    assert_eq!(err.code, "store");
}

#[test]
fn the_schema_rejects_a_state_outside_the_set() {
    schema_rejects("state", "sideways");
}

#[test]
fn the_schema_rejects_a_channel_outside_the_set() {
    schema_rejects("channel", "robot");
}

#[test]
fn the_schema_rejects_a_side_outside_the_set() {
    schema_rejects("side", "Sideways");
}

// ── The derived state triple, one arm per test ───────────────────────────────

/// A published review holding one thread, driven from `open` to `state` through
/// a real transition (never a direct `UPDATE`).
fn published_review_with(state: ThreadState) -> (TestContext, Store, String, String) {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id =
        submit_thread_inner(&store, &canonical, submission("please fix"), 1_000).unwrap();
    let id = only_review(&store, &canonical).id;
    store
        .write(|tx| reviewdb::reviews::publish(tx, &canonical, &id, 1_000))
        .unwrap();

    let channel = if state == ThreadState::Addressed {
        Channel::Agent
    } else {
        Channel::Human
    };
    if state != ThreadState::Open {
        store
            .write(|tx| {
                reviewdb::threads::set_state(tx, &canonical, &thread_id, state, channel, 1_001)
            })
            .unwrap();
    }

    (ctx, store, id, thread_id)
}

#[test]
fn an_unpublished_review_is_composing() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();

    assert_eq!(
        only_review(&store, &canonical).state,
        ReviewState::Composing
    );
}

#[test]
fn a_published_review_with_an_open_thread_is_ready() {
    let (ctx, store, _, _) = published_review_with(ThreadState::Open);

    let canonical = ctx.repo_path().canonicalize().unwrap();
    assert_eq!(only_review(&store, &canonical).state, ReviewState::Ready);
}

#[test]
fn a_published_review_with_every_thread_resolved_is_settled() {
    let (ctx, store, _, _) = published_review_with(ThreadState::Done);

    let canonical = ctx.repo_path().canonicalize().unwrap();
    assert_eq!(
        only_review(&store, &canonical).state,
        ReviewState::Settled,
        "resolving the only open thread settles the review with no explicit gesture",
    );
}

#[test]
fn an_addressed_thread_keeps_the_review_ready() {
    let (ctx, store, _, _) = published_review_with(ThreadState::Addressed);

    let canonical = ctx.repo_path().canonicalize().unwrap();
    assert_eq!(
        only_review(&store, &canonical).state,
        ReviewState::Ready,
        "an addressed thread is still actionable",
    );
}

// ── Milestone 2, Task 4: derived settling reaches the UI ─────────────────────

#[test]
fn reopening_a_thread_makes_a_settled_review_ready() {
    let (ctx, store, _, thread_id) = published_review_with(ThreadState::Done);
    let canonical = ctx.repo_path().canonicalize().unwrap();

    store
        .write(|tx| {
            reviewdb::threads::set_state(
                tx,
                &canonical,
                &thread_id,
                ThreadState::Open,
                Channel::Human,
                1_002,
            )
        })
        .unwrap();

    assert_eq!(
        only_review(&store, &canonical).state,
        ReviewState::Ready,
        "reopening a thread in a settled review flips it back to ready",
    );
}

#[test]
fn a_new_thread_in_a_settled_review_makes_it_ready() {
    let (ctx, store, review_id, _) = published_review_with(ThreadState::Done);
    let canonical = ctx.repo_path().canonicalize().unwrap();
    assert_eq!(only_review(&store, &canonical).state, ReviewState::Settled);

    store
        .write(|tx| {
            reviewdb::threads::insert(
                tx,
                &review_id,
                reviewdb::threads::NewThread {
                    text: "one more thing".to_string(),
                    anchor: None,
                    commit_oid: None,
                    cached_excerpt: None,
                },
                1_003,
            )
            .map(|_| ())
        })
        .unwrap();

    assert_eq!(
        only_review(&store, &canonical).state,
        ReviewState::Ready,
        "a new thread in a settled review makes it ready again",
    );
}

#[test]
fn publishing_an_all_resolved_review_derives_settled() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id = submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();
    let review_id = only_review(&store, &canonical).id;

    // Resolve BEFORE publishing — the review derives directly to settled the
    // moment it is published, with no intermediate `ready`.
    store
        .write(|tx| {
            reviewdb::threads::set_state(
                tx,
                &canonical,
                &thread_id,
                ThreadState::Done,
                Channel::Human,
                1_001,
            )
        })
        .unwrap();
    store
        .write(|tx| reviewdb::reviews::publish(tx, &canonical, &review_id, 1_002))
        .unwrap();

    assert_eq!(only_review(&store, &canonical).state, ReviewState::Settled);
}

#[test]
fn nine_reviews_hold_three_of_each_derived_state() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "alpha\n")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    let make = |label: &str| -> (String, String) {
        let review_id = store
            .write(|tx| reviewdb::reviews::create(tx, &canonical, Some(label), 1_000))
            .unwrap();
        store
            .write(|tx| reviewdb::reviews::set_active(tx, &canonical, &review_id))
            .unwrap();
        let thread_id = submit_thread_inner(&store, &canonical, submission(label), 1_000).unwrap();
        (review_id, thread_id)
    };

    (0..3).for_each(|i| {
        make(&format!("composing {i}"));
    });
    (0..3).for_each(|i| {
        let pair = make(&format!("ready {i}"));
        store
            .write(|tx| reviewdb::reviews::publish(tx, &canonical, &pair.0, 1_000))
            .unwrap();
    });
    (0..3).for_each(|i| {
        let pair = make(&format!("settled {i}"));
        store
            .write(|tx| reviewdb::reviews::publish(tx, &canonical, &pair.0, 1_000))
            .unwrap();
        store
            .write(|tx| {
                reviewdb::threads::set_state(
                    tx,
                    &canonical,
                    &pair.1,
                    ThreadState::Done,
                    Channel::Human,
                    1_001,
                )
            })
            .unwrap();
    });

    let reviews = store
        .read(|c| reviewdb::reviews::list(c, &canonical))
        .unwrap();
    assert_eq!(
        reviews
            .iter()
            .filter(|r| r.state == ReviewState::Composing)
            .count(),
        3
    );
    assert_eq!(
        reviews
            .iter()
            .filter(|r| r.state == ReviewState::Ready)
            .count(),
        3
    );
    assert_eq!(
        reviews
            .iter()
            .filter(|r| r.state == ReviewState::Settled)
            .count(),
        3
    );
}

// ── Milestone 2, Task 6: human text is editable anytime, agent text is not ──

#[test]
fn list_threads_reports_the_owning_reviews_published_bit() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id = submit_thread_inner(&store, &canonical, submission("root"), 1_000).unwrap();
    let review_id = only_review(&store, &canonical).id;

    let before = list_threads_inner(&store, &canonical).unwrap();
    assert!(
        !before.iter().find(|t| t.id == thread_id).unwrap().published,
        "a composing review's threads report published: false",
    );

    store
        .write(|tx| reviewdb::reviews::publish(tx, &canonical, &review_id, 1_000))
        .unwrap();

    let after = list_threads_inner(&store, &canonical).unwrap();
    assert!(
        after.iter().find(|t| t.id == thread_id).unwrap().published,
        "a published review's threads report published: true",
    );
}

/// The wire precomputes the human-legal moves (`ThreadState::allowed_transitions`)
/// so the UI renders entries instead of re-deriving the matrix (TRUNK-17). The
/// UI batch always claims `Channel::Human`; the CLI computes its own.
#[test]
fn list_threads_carries_the_human_allowed_transitions() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id = submit_thread_inner(&store, &canonical, submission("root"), 1_000).unwrap();

    let open = list_threads_inner(&store, &canonical).unwrap();
    assert_eq!(
        open[0].allowed_transitions,
        vec![ThreadState::Done, ThreadState::Dismissed],
        "an open thread offers the two resolutions",
    );

    set_thread_state_inner(&store, &canonical, &thread_id, ThreadState::Done, 1_001).unwrap();
    let done = list_threads_inner(&store, &canonical).unwrap();
    assert_eq!(
        done[0].allowed_transitions,
        vec![ThreadState::Open],
        "a done thread offers only reopen",
    );
}

#[test]
fn a_published_review_still_accepts_a_reply_and_a_text_edit() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id = submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();
    let review_id = only_review(&store, &canonical).id;
    store
        .write(|tx| reviewdb::reviews::publish(tx, &canonical, &review_id, 1_000))
        .unwrap();

    let reply_id = store
        .write(|tx| {
            reviewdb::replies::add(tx, &canonical, &thread_id, "a reply", Channel::Human, 1_001)
        })
        .unwrap();
    store
        .write(|tx| reviewdb::threads::edit(tx, &canonical, &thread_id, "edited root", 1_002))
        .unwrap();
    store
        .write(|tx| reviewdb::replies::edit(tx, &canonical, &reply_id, "edited reply", 1_002))
        .unwrap();

    let threads = list_threads_inner(&store, &canonical).unwrap();
    let thread = threads.iter().find(|t| t.id == thread_id).unwrap();
    assert_eq!(thread.text, "edited root");
    assert_eq!(thread.replies[0].text, "edited reply");
}

#[test]
fn editing_human_text_leaves_state_untouched() {
    let (ctx, store, review_id, thread_id) = published_review_with(ThreadState::Addressed);
    let canonical = ctx.repo_path().canonicalize().unwrap();

    store
        .write(|tx| reviewdb::threads::edit(tx, &canonical, &thread_id, "edited", 1_002))
        .unwrap();

    let threads = store
        .read(|c| reviewdb::threads::list_for_review(c, &review_id))
        .unwrap();
    assert_eq!(
        threads[0].state,
        ThreadState::Addressed,
        "a text edit never changes state",
    );
}

#[test]
fn editing_an_agent_reply_is_refused() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id = submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();
    let reply_id = store
        .write(|tx| {
            reviewdb::replies::add(
                tx,
                &canonical,
                &thread_id,
                "agent reply",
                Channel::Agent,
                1_001,
            )
        })
        .unwrap();

    let err = store
        .write(|tx| reviewdb::replies::edit(tx, &canonical, &reply_id, "hacked", 1_002))
        .unwrap_err();

    assert_eq!(err.code, "not_editable");
}

#[test]
fn editing_an_agent_thread_is_refused() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id = submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();

    // A thread can only be agent-authored through a hand-edited row today (the
    // CLI, milestone 3's only agent writer, does not exist yet) — probe the
    // same refusal directly against the schema, matching the store's own
    // CHECK-rejection tests.
    store
        .write(|tx| {
            tx.execute(
                "UPDATE threads SET channel = 'agent' WHERE id = ?1",
                [&thread_id],
            )
            .map_err(trunk_lib::reviewdb::sqlite_error)
        })
        .unwrap();

    let err = store
        .write(|tx| reviewdb::threads::edit(tx, &canonical, &thread_id, "hacked", 1_002))
        .unwrap_err();

    assert_eq!(err.code, "not_editable");
}

// ── Milestone 2, Task 7: deletion permanence after publish ──────────────────

#[test]
fn deleting_a_published_thread_is_refused() {
    let (ctx, store, _, thread_id) = published_review_with(ThreadState::Open);
    let canonical = ctx.repo_path().canonicalize().unwrap();

    let err = store
        .write(|tx| reviewdb::threads::delete(tx, &canonical, &thread_id))
        .unwrap_err();

    assert_eq!(err.code, "review_published");
    let review_id = only_review(&store, &canonical).id;
    let threads = store
        .read(|c| reviewdb::threads::list_for_review(c, &review_id))
        .unwrap();
    assert_eq!(threads.len(), 1, "the refused delete must mutate nothing");
}

#[test]
fn deleting_a_published_reply_is_refused() {
    let (ctx, store, _, thread_id) = published_review_with(ThreadState::Open);
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let reply_id = store
        .write(|tx| {
            reviewdb::replies::add(tx, &canonical, &thread_id, "a reply", Channel::Human, 1_002)
        })
        .unwrap();

    let err = store
        .write(|tx| reviewdb::replies::delete(tx, &canonical, &reply_id))
        .unwrap_err();

    assert_eq!(err.code, "review_published");
    let replies = store
        .read(|c| reviewdb::replies::list_for_threads(c, std::slice::from_ref(&thread_id)))
        .unwrap();
    assert_eq!(
        replies.get(&thread_id).map(Vec::len),
        Some(1),
        "the refused delete must mutate nothing",
    );
}

#[test]
fn deleting_a_composing_reply_removes_it() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let thread_id = submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();
    let reply_id = store
        .write(|tx| {
            reviewdb::replies::add(tx, &canonical, &thread_id, "a reply", Channel::Human, 1_001)
        })
        .unwrap();

    store
        .write(|tx| reviewdb::replies::delete(tx, &canonical, &reply_id))
        .unwrap();

    let replies = store
        .read(|c| reviewdb::replies::list_for_threads(c, std::slice::from_ref(&thread_id)))
        .unwrap();
    assert!(replies.get(&thread_id).is_none_or(Vec::is_empty));
}

#[test]
fn deleting_an_unknown_reply_is_an_idempotent_no_op() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    store
        .write(|tx| reviewdb::replies::delete(tx, &canonical, "MISSING1"))
        .unwrap();
}

// ── Behaviours the deleted suites used to pin ────────────────────────────────

#[test]
fn a_thread_anchor_round_trips_every_field() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let mut anchor = diff_anchor();
    anchor.source = Source::FullFile;
    anchor.side = Side::Old;

    submit_thread_inner(
        &store,
        &canonical,
        SubmitThreadRequest {
            text: "whole-file note".to_string(),
            anchor: Some(anchor.clone()),
            commit_oid: None,
            cached_excerpt: Some("x".to_string()),
            clears_draft: true,
        },
        1_000,
    )
    .unwrap();

    let id = only_review(&store, &canonical).id;
    let threads = store
        .read(|c| reviewdb::threads::list_for_review(c, &id))
        .unwrap();
    // Anchor derives no PartialEq, so compare the whole shape rather than the
    // one field a partial assertion would happen to cover.
    assert_eq!(
        serde_json::to_value(threads[0].anchor.as_ref().unwrap()).unwrap(),
        serde_json::to_value(&anchor).unwrap(),
    );
}

#[test]
fn editing_a_thread_targets_it_by_id() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("first"), 1_000).unwrap();
    submit_thread_inner(&store, &canonical, submission("second"), 2_000).unwrap();
    let id = only_review(&store, &canonical).id;
    let target = store
        .read(|c| reviewdb::threads::list_for_review(c, &id))
        .unwrap()[0]
        .id
        .clone();

    store
        .write(|tx| reviewdb::threads::edit(tx, &canonical, &target, "first (edited)", 3_000))
        .unwrap();

    let threads = store
        .read(|c| reviewdb::threads::list_for_review(c, &id))
        .unwrap();
    assert_eq!(threads[0].text, "first (edited)");
    assert_eq!(threads[1].text, "second", "the other thread is untouched");
}

#[test]
fn editing_an_unknown_thread_is_not_found() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("untouched"), 1_000).unwrap();

    let err = store
        .write(|tx| reviewdb::threads::edit(tx, &canonical, "no-such-id", "ignored", 2_000))
        .unwrap_err();

    assert_eq!(err.code, "not_found");
    let id = only_review(&store, &canonical).id;
    assert_eq!(
        store
            .read(|c| reviewdb::threads::list_for_review(c, &id))
            .unwrap()[0]
            .text,
        "untouched",
    );
}

#[test]
fn deleting_an_unknown_thread_is_an_idempotent_no_op() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("survivor"), 1_000).unwrap();
    let id = only_review(&store, &canonical).id;

    store
        .write(|tx| reviewdb::threads::delete(tx, &canonical, "no-such-id"))
        .unwrap();

    assert_eq!(
        store
            .read(|c| reviewdb::threads::list_for_review(c, &id))
            .unwrap()
            .len(),
        1,
    );
}

#[test]
fn threads_keep_their_insertion_order_within_one_second() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    // The same pinned timestamp for all three: ordering must not fall through to
    // the random id, which would sort them by a coin flip.
    for text in ["first", "second", "third"] {
        submit_thread_inner(&store, &canonical, submission(text), 1_000).unwrap();
    }

    let id = only_review(&store, &canonical).id;
    let texts: Vec<String> = store
        .read(|c| reviewdb::threads::list_for_review(c, &id))
        .unwrap()
        .into_iter()
        .map(|t| t.text)
        .collect();
    assert_eq!(texts, vec!["first", "second", "third"]);
}

#[test]
fn reviews_keep_their_creation_order_within_one_second() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    for title in ["alpha", "beta", "gamma"] {
        store
            .write(|tx| reviewdb::reviews::create(tx, &canonical, Some(title), 1_000))
            .unwrap();
    }

    let titles: Vec<String> = store
        .read(|c| reviewdb::reviews::list(c, &canonical))
        .unwrap()
        .into_iter()
        .map(|r| r.title)
        .collect();
    assert_eq!(titles, vec!["alpha", "beta", "gamma"]);
}

#[test]
fn a_range_seed_keeps_hand_picked_commits() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let id = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, None, 1_000))
        .unwrap();
    store
        .write(|tx| reviewdb::commits::add(tx, &id, "picked", "s"))
        .unwrap();

    store
        .write(|tx| {
            reviewdb::commits::seed(tx, &id, &[member("picked", "s"), member("range1", "s")])
        })
        .unwrap();

    assert_eq!(
        store.read(|c| reviewdb::commits::list(c, &id)).unwrap(),
        vec![member("picked", "s"), member("range1", "s")],
        "a seed unions in: hand-picked commits survive and overlaps dedup",
    );
}

#[test]
fn a_repo_with_no_active_review_lists_no_threads_without_erroring() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    let threads = list_threads_inner(&store, &canonical).unwrap();

    assert!(
        threads.is_empty(),
        "a repo with no review has no threads to show — an empty list, never an \
         error, which is what the panel's read path depends on",
    );
}

#[test]
fn switching_back_to_the_older_review_lists_its_threads_again() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("in the older"), 1_000).unwrap();
    let older = only_review(&store, &canonical).id;
    let newer = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, Some("newer"), 2_000))
        .unwrap();
    store
        .write(|tx| reviewdb::reviews::set_active(tx, &canonical, &newer))
        .unwrap();
    submit_thread_inner(&store, &canonical, submission("in the newer"), 3_000).unwrap();

    store
        .write(|tx| reviewdb::reviews::set_active(tx, &canonical, &older))
        .unwrap();

    assert_eq!(
        list_threads_inner(&store, &canonical)
            .unwrap()
            .iter()
            .map(|t| t.text.as_str())
            .collect::<Vec<_>>(),
        vec!["in the older"],
        "the panel body and every comment badge are built from this one list, so \
         it follows the active pointer rather than the newest review",
    );
}

#[test]
fn activating_an_empty_review_hides_the_repos_other_threads() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("still in the store"), 1_000).unwrap();

    let empty = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, Some("empty"), 2_000))
        .unwrap();
    store
        .write(|tx| reviewdb::reviews::set_active(tx, &canonical, &empty))
        .unwrap();

    assert!(
        list_threads_inner(&store, &canonical).unwrap().is_empty(),
        "creating a review blanks every badge in the repo until the user switches \
         back, because badges count only the active review's threads — the \
         projection milestone 5 replaces with an all-reviews unresolved count",
    );
}

// ── The version guard on every access path (D4) ──────────────────────────────

#[test]
fn a_store_migrated_underneath_a_running_process_refuses_reads_and_writes() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    // A newer build migrates the store while this process holds it open.
    {
        let conn = rusqlite::Connection::open(ctx.data_dir().join(reviewdb::DB_FILE)).unwrap();
        conn.pragma_update(None, "user_version", reviewdb::schema::CURRENT_VERSION + 1)
            .unwrap();
    }

    let read = store
        .read(|c| reviewdb::reviews::list(c, &canonical))
        .unwrap_err();
    let write = store
        .write(|tx| reviewdb::reviews::create(tx, &canonical, None, 1_000))
        .unwrap_err();

    assert_eq!(read.code, "store_newer");
    assert_eq!(write.code, "store_newer");
}

// ── Quarantine fires on corruption, and nothing else ─────────────────────────

#[test]
fn a_store_that_cannot_be_opened_reports_the_failure_instead_of_quarantining() {
    let dir = tempfile::tempdir().unwrap();
    // A directory where the database file belongs: SQLite cannot open it, but
    // nothing about it is corruption, so the store must not be renamed aside.
    std::fs::create_dir(dir.path().join(reviewdb::DB_FILE)).unwrap();

    let err = reviewdb::open(dir.path()).expect_err("opening a directory must fail");

    assert_ne!(
        err.code,
        reviewdb::CORRUPT,
        "a non-corruption failure must not be classified as corruption",
    );
    assert!(
        !dir.path().join("reviews.db.corrupt").exists(),
        "a transient failure must never quarantine the user's review history",
    );
}

#[test]
fn a_commit_note_leaves_the_diff_composers_draft_alone() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    save_draft_inner(
        &store,
        &canonical,
        "half-typed line comment",
        Some(&diff_anchor()),
        1_000,
    )
    .unwrap();

    submit_thread_inner(
        &store,
        &canonical,
        SubmitThreadRequest {
            text: "a note about the commit".to_string(),
            anchor: None,
            commit_oid: Some("deadbeef".to_string()),
            cached_excerpt: None,
            clears_draft: false,
        },
        1_000,
    )
    .unwrap();

    assert_eq!(
        get_draft_inner(&store, &canonical).unwrap().unwrap().text,
        "half-typed line comment",
        "a commit-level note is independent of the diff composer and must not \
         discard a half-typed line comment",
    );
}

#[test]
fn a_review_id_from_another_repo_is_not_found() {
    let mine = TestContext::new_empty();
    let theirs = TestContext::new_empty();
    let my_path = mine.repo_path().canonicalize().unwrap();
    let their_path = theirs.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(mine.data_dir()).unwrap();
    submit_thread_inner(&store, &my_path, submission("mine"), 1_000).unwrap();
    let mine_id = only_review(&store, &my_path).id;

    let err = store
        .write(|tx| reviewdb::reviews::set_active_checked(tx, &their_path, &mine_id))
        .unwrap_err();

    assert_eq!(
        err.code, "not_found",
        "the repo a review belongs to is part of its address, not just a filter",
    );
}

#[test]
fn a_prefix_holding_a_sql_wildcard_matches_nothing() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    submit_thread_inner(&store, &canonical, submission("x"), 1_000).unwrap();

    for wildcard in ["%", "_", "3%"] {
        assert_eq!(
            reviewdb::ids::resolve_prefix(&store, reviewdb::ids::IdKind::Review, wildcard)
                .unwrap_err(),
            reviewdb::ids::ResolveError::NotFound,
            "{wildcard:?} reaches a LIKE pattern and must not act as a wildcard",
        );
    }
}

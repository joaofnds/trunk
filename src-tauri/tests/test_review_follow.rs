//! A thread follows its commit when a rebase, amend or cherry-pick replaces that
//! commit with a rewritten copy, so updating the local repository never takes a
//! review off the graph (TRUNK-430).

mod common;

use common::context::TestContext;
use std::time::Duration;
use trunk_lib::commands::review::{
    RenderedThread, SubmitThreadRequest, list_threads_inner, submit_thread_inner,
};
use trunk_review::reviewdb::{self, Store};
use trunk_review::types::{Anchor, Channel, Delivery, Side, Source, ThreadState};

const BASE: &str = "one\ntwo\nthree\n";
const UPSTREAM: &str = "zero\none\ntwo\nthree\n";
const LOCAL: &str = "one\ntwo\nthree\nfour\n";

/// A clone one commit behind its remote, whose upstream inserted a line at the top
/// of `a.txt`, with a local commit adding a line at the bottom.
fn behind_upstream() -> TestContext {
    TestContext::builder()
        .with_file("a.txt", BASE)
        .with_commit("base")
        .with_remote("origin")
        .with_pushed("origin", "main")
        .with_tracking("origin", "main")
        .with_remote_commit("origin", "main", "a.txt", UPSTREAM, "upstream adds zero")
        .with_file("a.txt", LOCAL)
        .with_commit("local adds four")
        .build()
}

fn git(ctx: &TestContext, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(ctx.repo_path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

fn comment_on(store: &Store, ctx: &TestContext, oid: &str, line: u32) -> String {
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let request = SubmitThreadRequest {
        whole_file: false,
        text: "why four?".to_string(),
        anchor: Some(Anchor {
            commit_oid: oid.to_string(),
            file_path: "a.txt".to_string(),
            source: Source::Diff,
            side: Side::New,
            start_line: line,
            end_line: line,
        }),
        commit_oid: None,
        content_pin: None,
        cached_excerpt: Some("four".to_string()),
        clears_draft: false,
        delivery: Delivery::Send,
    };

    submit_thread_inner(store, &canonical, request, 1_000).unwrap()
}

fn follow(store: &Store, ctx: &TestContext) -> usize {
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let mut repo = ctx.repo();
    let captured = trunk_git::graph::capture(&mut repo).unwrap();

    reviewdb::follow::follow(store, &canonical, &repo, &captured.commits, 2_000).unwrap()
}

fn thread(store: &Store, ctx: &TestContext, id: &str) -> RenderedThread {
    let canonical = ctx.repo_path().canonicalize().unwrap();

    list_threads_inner(store, &canonical, None)
        .unwrap()
        .into_iter()
        .find(|thread| thread.id == id)
        .unwrap()
}

#[test]
fn a_thread_follows_its_commit_through_a_pull_with_rebase() {
    let ctx = behind_upstream();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let written_on = git(&ctx, &["rev-parse", "HEAD"]);
    let id = comment_on(&store, &ctx, &written_on, 4);
    git(&ctx, &["pull", "--rebase", "--quiet"]);
    let replayed = git(&ctx, &["rev-parse", "HEAD"]);

    let moved = follow(&store, &ctx);

    let followed = thread(&store, &ctx, &id);
    let anchor = followed.anchor.unwrap();
    assert_eq!(moved, 1);
    assert_eq!(anchor.commit_oid, replayed);
    assert_eq!((anchor.start_line, anchor.end_line), (5, 5));
    assert!(!followed.stale);
}

/// Rewrites the local commit's own line, the way an agent's fixup squashed into
/// the commented commit does.
fn amend_line_four(ctx: &TestContext, text: &str) {
    std::fs::write(
        ctx.repo_path().join("a.txt"),
        format!("one\ntwo\nthree\n{text}\n"),
    )
    .unwrap();
    git(ctx, &["commit", "--quiet", "--amend", "--no-edit", "--all"]);
}

fn recheck(store: &Store, ctx: &TestContext) {
    let canonical = ctx.repo_path().canonicalize().unwrap();

    trunk_lib::commands::review::recompute_staleness(store, &canonical, ctx.path()).unwrap();
    trunk_lib::commands::review::recompute_ref_staleness(store, &canonical, ctx.path()).unwrap();
}

#[test]
fn a_thread_whose_own_line_changed_follows_and_stays_stale_through_every_recheck() {
    let ctx = behind_upstream();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let written_on = git(&ctx, &["rev-parse", "HEAD"]);
    let id = comment_on(&store, &ctx, &written_on, 4);
    amend_line_four(&ctx, "FOUR");
    let amended = git(&ctx, &["rev-parse", "HEAD"]);

    follow(&store, &ctx);
    recheck(&store, &ctx);

    let followed = thread(&store, &ctx, &id);
    assert_eq!(followed.anchor.unwrap().commit_oid, amended);
    assert!(followed.stale);
}

#[test]
fn following_back_onto_the_original_commit_clears_the_stale_marker() {
    let ctx = behind_upstream();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let written_on = git(&ctx, &["rev-parse", "HEAD"]);
    let id = comment_on(&store, &ctx, &written_on, 4);
    amend_line_four(&ctx, "FOUR");
    follow(&store, &ctx);
    git(&ctx, &["reset", "--quiet", "--keep", &written_on]);

    follow(&store, &ctx);
    recheck(&store, &ctx);

    let followed = thread(&store, &ctx, &id);
    let anchor = followed.anchor.unwrap();
    assert_eq!(anchor.commit_oid, written_on);
    assert_eq!((anchor.start_line, anchor.end_line), (4, 4));
    assert!(!followed.stale);
}

const SAME_SECOND: i64 = 1_800_000_000;

/// Two local commits authored in the same second, as an agent's quick
/// successive commits are, the second adding line four.
fn same_second_pair() -> TestContext {
    TestContext::builder()
        .with_file("a.txt", BASE)
        .with_commit("base")
        .with_file("b.txt", "sibling\n")
        .with_commit_at("sibling adds b", SAME_SECOND)
        .with_file("a.txt", LOCAL)
        .with_commit_at("local adds four", SAME_SECOND)
        .build()
}

#[test]
fn a_dropped_commit_never_hands_its_threads_to_a_sibling_from_the_same_second() {
    let ctx = same_second_pair();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let written_on = git(&ctx, &["rev-parse", "HEAD"]);
    let id = comment_on(&store, &ctx, &written_on, 4);
    git(&ctx, &["reset", "--quiet", "--keep", "HEAD~1"]);

    let moved = follow(&store, &ctx);

    assert_eq!(moved, 0);
    assert_eq!(
        thread(&store, &ctx, &id).anchor.unwrap().commit_oid,
        written_on
    );
}

#[test]
fn a_reworded_commit_takes_its_threads_by_its_unchanged_changes() {
    let ctx = same_second_pair();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let written_on = git(&ctx, &["rev-parse", "HEAD"]);
    let id = comment_on(&store, &ctx, &written_on, 4);
    git(
        &ctx,
        &["commit", "--quiet", "--amend", "-m", "local writes four"],
    );
    let reworded = git(&ctx, &["rev-parse", "HEAD"]);

    follow(&store, &ctx);

    let followed = thread(&store, &ctx, &id);
    assert_eq!(followed.anchor.unwrap().commit_oid, reworded);
    assert!(!followed.stale);
}

#[test]
fn a_commit_note_follows_its_commit() {
    let ctx = behind_upstream();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let written_on = git(&ctx, &["rev-parse", "HEAD"]);
    let request = SubmitThreadRequest {
        whole_file: false,
        text: "split this commit".to_string(),
        anchor: None,
        commit_oid: Some(written_on),
        content_pin: None,
        cached_excerpt: None,
        clears_draft: false,
        delivery: Delivery::Send,
    };
    let id = submit_thread_inner(&store, &canonical, request, 1_000).unwrap();
    git(&ctx, &["pull", "--rebase", "--quiet"]);
    let replayed = git(&ctx, &["rev-parse", "HEAD"]);

    follow(&store, &ctx);

    let followed = thread(&store, &ctx, &id);
    assert_eq!(followed.commit_oid.as_deref(), Some(replayed.as_str()));
    assert!(!followed.stale);
}

/// How long a test waits for the app to announce a follow before calling it
/// absent. It bounds a failure, never a pass.
const ANNOUNCE_TIMEOUT: Duration = Duration::from_secs(30);

#[test]
fn opening_the_repository_after_a_pull_with_rebase_in_a_terminal_moves_its_threads() {
    let ctx = behind_upstream();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let written_on = git(&ctx, &["rev-parse", "HEAD"]);
    let id = comment_on(&store, &ctx, &written_on, 4);
    git(&ctx, &["pull", "--rebase", "--quiet"]);
    let replayed = git(&ctx, &["rev-parse", "HEAD"]);
    let review = ctx.review();
    let announced = review.reviews_changed_events();

    review.publish_graph();

    announced
        .recv_timeout(ANNOUNCE_TIMEOUT)
        .expect("the app never announced a follow");
    assert_eq!(
        thread(&store, &ctx, &id).anchor.unwrap().commit_oid,
        replayed
    );
}

#[test]
fn a_pull_with_rebase_in_a_terminal_moves_the_threads_of_an_open_repository_on_its_next_graph() {
    let ctx = behind_upstream();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let review = ctx.review();
    review.publish_graph();
    let written_on = git(&ctx, &["rev-parse", "HEAD"]);
    let id = comment_on(&store, &ctx, &written_on, 4);
    git(&ctx, &["pull", "--rebase", "--quiet"]);
    let replayed = git(&ctx, &["rev-parse", "HEAD"]);
    let announced = review.reviews_changed_events();

    review.publish_graph();

    announced
        .recv_timeout(ANNOUNCE_TIMEOUT)
        .expect("the app never announced a follow");
    assert_eq!(
        thread(&store, &ctx, &id).anchor.unwrap().commit_oid,
        replayed
    );
}

fn review_of(store: &Store, ctx: &TestContext) -> String {
    let canonical = ctx.repo_path().canonicalize().unwrap();

    store
        .read(|conn| reviewdb::reviews::active(conn, &canonical))
        .unwrap()
        .unwrap()
}

fn add_members(store: &Store, review: &str, members: &[(&str, &str)]) {
    store
        .write(|tx| {
            for (oid, subject) in members {
                reviewdb::commits::add(tx, review, oid, subject)?;
            }
            Ok(())
        })
        .unwrap();
}

fn members(store: &Store, review: &str) -> Vec<(String, String)> {
    store
        .read(|conn| reviewdb::commits::list(conn, review))
        .unwrap()
        .into_iter()
        .map(|member| (member.oid, member.subject))
        .collect()
}

#[test]
fn a_commit_set_member_keeps_its_position_on_the_rewritten_copy_under_its_new_subject() {
    let ctx = same_second_pair();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let base = git(&ctx, &["rev-parse", "HEAD~2"]);
    let written_on = git(&ctx, &["rev-parse", "HEAD"]);
    comment_on(&store, &ctx, &base, 1);
    let review = review_of(&store, &ctx);
    add_members(
        &store,
        &review,
        &[(&written_on, "local adds four"), (&base, "base")],
    );
    git(
        &ctx,
        &["commit", "--quiet", "--amend", "-m", "local writes four"],
    );
    let reworded = git(&ctx, &["rev-parse", "HEAD"]);

    follow(&store, &ctx);

    assert_eq!(
        members(&store, &review),
        [
            (reworded, "local writes four".to_string()),
            (base, "base".to_string())
        ]
    );
}

#[test]
fn a_commit_set_member_whose_copy_is_already_a_member_leaves_the_set() {
    let ctx = behind_upstream();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let base = git(&ctx, &["rev-parse", "HEAD~1"]);
    let written_on = git(&ctx, &["rev-parse", "HEAD"]);
    comment_on(&store, &ctx, &base, 1);
    let review = review_of(&store, &ctx);
    git(&ctx, &["pull", "--rebase", "--quiet"]);
    let replayed = git(&ctx, &["rev-parse", "HEAD"]);
    add_members(
        &store,
        &review,
        &[
            (&written_on, "local adds four"),
            (&replayed, "local adds four"),
        ],
    );

    follow(&store, &ctx);

    assert_eq!(
        members(&store, &review),
        [(replayed, "local adds four".to_string())]
    );
}

#[test]
fn a_fix_commit_names_the_rewritten_copy_of_the_commit_it_named() {
    let ctx = behind_upstream();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let base = git(&ctx, &["rev-parse", "HEAD~1"]);
    let fix = git(&ctx, &["rev-parse", "HEAD"]);
    let id = comment_on(&store, &ctx, &base, 1);
    store
        .write(|tx| {
            reviewdb::threads::set_state_at_commit(
                tx,
                &canonical,
                &id,
                ThreadState::Addressed,
                Channel::Agent,
                Some(&fix),
                1_500,
            )
        })
        .unwrap();
    git(&ctx, &["pull", "--rebase", "--quiet"]);
    let replayed = git(&ctx, &["rev-parse", "HEAD"]);

    follow(&store, &ctx);

    let claimed = thread(&store, &ctx, &id).history.pop().unwrap();
    assert_eq!(claimed.commit, Some(replayed));
}

#[test]
fn a_thread_on_a_review_snapshot_never_follows_a_look_alike_commit() {
    let ctx = behind_upstream();
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let snapshot = git(&ctx, &["rev-parse", "HEAD"]);
    store
        .write(|tx| reviewdb::minted::record(tx, &canonical, &snapshot))
        .unwrap();
    let id = comment_on(&store, &ctx, &snapshot, 4);
    git(&ctx, &["pull", "--rebase", "--quiet"]);

    let moved = follow(&store, &ctx);

    assert_eq!(moved, 0);
    assert_eq!(
        thread(&store, &ctx, &id).anchor.unwrap().commit_oid,
        snapshot
    );
}

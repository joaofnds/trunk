//! Built-binary probes for the `trunk review` CLI (milestone 3). The CLI is
//! the argv branch of the app binary itself, so these tests drive the real
//! executable via `CARGO_BIN_EXE_trunk` — `cargo test` builds it. Every
//! invocation sets `TRUNK_DATA_DIR` to a scratch dir: the test-built binary
//! carries the *prod* identifier, and without the override it would read the
//! developer's real store.

mod common;

use common::context::TestContext;
use std::path::Path;
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};
use trunk_lib::review_types::ThreadState;
use trunk_lib::reviewdb::{self, reviews, threads};

/// A store seeded the way the app would seed it: one composing review (title
/// "draft in progress") and one published review (title "ready for reading")
/// with a single thread, both keyed by the repo's canonical path. Returns the
/// two review ids `(composing, published)`.
fn seed_reviews(ctx: &TestContext) -> (String, String) {
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let store = reviewdb::open(ctx.data_dir()).unwrap();

    let composing = store
        .write(|tx| reviews::create(tx, &canonical, Some("draft in progress"), 100))
        .unwrap();
    let published = store
        .write(|tx| reviews::create(tx, &canonical, Some("ready for reading"), 200))
        .unwrap();
    store
        .write(|tx| {
            threads::insert(
                tx,
                &published,
                threads::NewThread {
                    text: "a note".to_string(),
                    anchor: None,
                    commit_oid: None,
                    cached_excerpt: None,
                },
                300,
            )?;
            reviews::publish(tx, &canonical, &published, 400)
        })
        .unwrap();

    (composing, published)
}

/// Wait for the child with a Rust-side deadline (macOS ships no `timeout`
/// binary). A hang here means the argv branch fell through to the GUI, which
/// would block forever — kill it and fail loudly rather than wedge the suite.
fn wait_or_kill(mut child: Child, deadline: Duration) -> Output {
    let started = Instant::now();
    loop {
        match child.try_wait().expect("try_wait failed") {
            Some(_) => return child.wait_with_output().expect("wait_with_output failed"),
            None if started.elapsed() > deadline => {
                child.kill().expect("kill failed");
                let _ = child.wait();
                panic!("the process did not exit — the review branch fell through to the GUI");
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn trunk_review(args: &[&str], data_dir: &Path) -> Output {
    trunk_review_in(data_dir, args, data_dir)
}

/// Run `trunk review …` with `cwd` as the working directory — repo discovery
/// starts there when `--repo` is absent.
fn trunk_review_in(cwd: &Path, args: &[&str], data_dir: &Path) -> Output {
    let child = Command::new(env!("CARGO_BIN_EXE_trunk"))
        .arg("review")
        .args(args)
        .current_dir(cwd)
        .env("TRUNK_DATA_DIR", data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn the trunk binary");
    wait_or_kill(child, Duration::from_secs(10))
}

/// One store, two discoverers: the app resolves its data dir through Tauri's
/// path resolver, the CLI derives it from the compiled-in identifier alone.
/// The two must name the same directory or app and CLI silently run two
/// stores. (`TRUNK_DATA_DIR` overrides both sides; the built-binary tests
/// cover that per-process, since env mutation races parallel tests here.)
#[test]
fn data_dir_matches_the_app_handles() {
    use tauri::Manager;
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let identifier = app.config().identifier.clone();

    let derived = trunk_lib::reviewdb::data_dir_for(&identifier);

    assert_eq!(
        derived,
        app.path().app_data_dir().unwrap(),
        "the CLI's derivation must name the exact dir the app resolves",
    );
}

#[test]
fn cli_lists_only_published_reviews() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let (composing, published) = seed_reviews(&ctx);

    let out = trunk_review_in(ctx.repo_path(), &["list"], ctx.data_dir());

    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains(&published)
            && stdout.contains("ready")
            && stdout.contains("ready for reading"),
        "the published review must be listed with state and title, got {stdout:?}",
    );
    assert!(
        !stdout.contains(&composing) && !stdout.contains("draft in progress"),
        "a composing review must not leak through the CLI, got {stdout:?}",
    );
}

#[test]
fn discovery_from_a_subdirectory_and_a_symlink_matches_the_app() {
    let ctx = TestContext::builder()
        .with_file("nested/deep.txt", "content")
        .with_commit("c1")
        .build();
    let (_, published) = seed_reviews(&ctx);

    let subdir = ctx.repo_path().join("nested");
    let from_subdir = trunk_review_in(&subdir, &["list"], ctx.data_dir());
    assert!(
        String::from_utf8_lossy(&from_subdir.stdout).contains(&published),
        "discovery from a subdirectory must land on the app's repo key",
    );

    let link = tempfile::TempDir::new().unwrap();
    let link_path = link.path().join("repo-link");
    std::os::unix::fs::symlink(ctx.repo_path(), &link_path).unwrap();
    let via_symlink = trunk_review_in(
        ctx.repo_path(),
        &["list", "--repo", link_path.to_str().unwrap()],
        ctx.data_dir(),
    );
    assert!(
        String::from_utf8_lossy(&via_symlink.stdout).contains(&published),
        "a symlinked --repo must canonicalize onto the app's repo key",
    );
}

#[test]
fn cli_show_prints_threads_states_and_excerpts() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let (_, published) = seed_reviews(&ctx);
    {
        let store = reviewdb::open(ctx.data_dir()).unwrap();
        store
            .write(|tx| {
                threads::insert(
                    tx,
                    &published,
                    threads::NewThread {
                        text: "please rename this".to_string(),
                        anchor: Some(trunk_lib::git::types::Anchor {
                            commit_oid: "abc123def456".to_string(),
                            file_path: "a.txt".to_string(),
                            source: trunk_lib::git::types::Source::Diff,
                            side: trunk_lib::git::types::Side::New,
                            start_line: 1,
                            end_line: 1,
                        }),
                        commit_oid: None,
                        cached_excerpt: Some("EXCERPT_TOKEN line".to_string()),
                    },
                    500,
                )
            })
            .unwrap();
    }

    let out = trunk_review_in(ctx.repo_path(), &["show", &published], ctx.data_dir());

    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    for expected in ["please rename this", "EXCERPT_TOKEN line", "open", "a note"] {
        assert!(
            stdout.contains(expected),
            "show must print threads, states and excerpts; missing {expected:?} in {stdout:?}",
        );
    }
}

#[test]
fn a_thread_added_after_publish_shows_in_cli_show() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let (_, published) = seed_reviews(&ctx);
    {
        let store = reviewdb::open(ctx.data_dir()).unwrap();
        store
            .write(|tx| {
                threads::insert(
                    tx,
                    &published,
                    threads::NewThread {
                        text: "LATE_THREAD_TOKEN".to_string(),
                        anchor: None,
                        commit_oid: None,
                        cached_excerpt: None,
                    },
                    9_000,
                )
            })
            .unwrap();
    }

    let out = trunk_review_in(ctx.repo_path(), &["show", &published], ctx.data_dir());

    assert!(
        String::from_utf8_lossy(&out.stdout).contains("LATE_THREAD_TOKEN"),
        "a thread born into a published review is immediately CLI-visible",
    );
}

#[test]
fn cli_show_answers_a_composing_review_exactly_as_missing() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let (composing, _) = seed_reviews(&ctx);

    let of_composing = trunk_review_in(ctx.repo_path(), &["show", &composing], ctx.data_dir());
    let of_missing = trunk_review_in(ctx.repo_path(), &["show", "ZZZZZZZZ"], ctx.data_dir());

    assert_eq!(
        of_composing.status.code(),
        of_missing.status.code(),
        "same exit code",
    );
    assert_ne!(of_composing.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&of_composing.stderr).replace(&composing, "ZZZZZZZZ"),
        String::from_utf8_lossy(&of_missing.stderr),
        "a composing review must be indistinguishable from a missing one",
    );
    assert!(
        of_composing.stdout.is_empty(),
        "no partial write on the error path",
    );
}

/// The thread living in the published review seeded by `seed_reviews`.
fn published_thread_id(ctx: &TestContext, published: &str) -> String {
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    store
        .read(|c| threads::list_for_review(c, published))
        .unwrap()
        .first()
        .expect("the published review has a thread")
        .id
        .clone()
}

#[test]
fn cli_reply_posts_an_agent_attributed_reply() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let (_, published) = seed_reviews(&ctx);
    let thread_id = published_thread_id(&ctx, &published);

    let out = trunk_review_in(
        ctx.repo_path(),
        &["reply", &thread_id, "done, see the new commit"],
        ctx.data_dir(),
    );

    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let replies = store
        .read(|c| trunk_lib::reviewdb::replies::list_for_threads(c, &[thread_id]))
        .unwrap();
    let reply = replies
        .values()
        .flatten()
        .next()
        .expect("the reply must land in the store");
    assert_eq!(reply.text, "done, see the new commit");
    assert_eq!(
        reply.channel,
        trunk_lib::review_types::Channel::Agent,
        "a CLI write renders as agent, whoever drove it",
    );
}

#[test]
fn cli_reply_reads_the_text_from_stdin() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let (_, published) = seed_reviews(&ctx);
    let thread_id = published_thread_id(&ctx, &published);

    let mut child = Command::new(env!("CARGO_BIN_EXE_trunk"))
        .args(["review", "reply", &thread_id, "--stdin"])
        .current_dir(ctx.repo_path())
        .env("TRUNK_DATA_DIR", ctx.data_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        child
            .stdin
            .take()
            .unwrap()
            .write_all(b"multi\nline\nreply")
            .unwrap();
    }
    let out = wait_or_kill(child, Duration::from_secs(10));

    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let replies = store
        .read(|c| trunk_lib::reviewdb::replies::list_for_threads(c, &[thread_id]))
        .unwrap();
    assert_eq!(
        replies.values().flatten().next().unwrap().text,
        "multi\nline\nreply",
    );
}

#[test]
fn two_concurrent_cli_replies_both_land() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let (_, published) = seed_reviews(&ctx);
    let thread_id = published_thread_id(&ctx, &published);

    let spawn = |text: &str| {
        Command::new(env!("CARGO_BIN_EXE_trunk"))
            .args(["review", "reply", &thread_id, text])
            .current_dir(ctx.repo_path())
            .env("TRUNK_DATA_DIR", ctx.data_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap()
    };
    let first = spawn("first writer");
    let second = spawn("second writer");

    let first = wait_or_kill(first, Duration::from_secs(10));
    let second = wait_or_kill(second, Duration::from_secs(10));

    assert!(
        first.status.success() && second.status.success(),
        "busy_timeout must turn contention into queueing; stderr: {} / {}",
        String::from_utf8_lossy(&first.stderr),
        String::from_utf8_lossy(&second.stderr),
    );
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    let replies = store
        .read(|c| trunk_lib::reviewdb::replies::list_for_threads(c, &[thread_id]))
        .unwrap();
    assert_eq!(
        replies.values().flatten().count(),
        2,
        "both concurrent writes must land",
    );
}

#[test]
fn cli_reply_to_a_composing_thread_answers_as_missing() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let (composing, _) = seed_reviews(&ctx);
    let composing_thread = {
        let store = reviewdb::open(ctx.data_dir()).unwrap();
        store
            .write(|tx| {
                threads::insert(
                    tx,
                    &composing,
                    threads::NewThread {
                        text: "unpublished".to_string(),
                        anchor: None,
                        commit_oid: None,
                        cached_excerpt: None,
                    },
                    600,
                )
            })
            .unwrap()
    };

    let of_composing = trunk_review_in(
        ctx.repo_path(),
        &["reply", &composing_thread, "hello"],
        ctx.data_dir(),
    );
    let of_missing = trunk_review_in(
        ctx.repo_path(),
        &["reply", "ZZZZZZZZ", "hello"],
        ctx.data_dir(),
    );

    assert_ne!(of_composing.status.code(), Some(0));
    assert_eq!(
        String::from_utf8_lossy(&of_composing.stderr).replace(&composing_thread, "ZZZZZZZZ"),
        String::from_utf8_lossy(&of_missing.stderr),
        "an unpublished review must not leak through reply either",
    );
}

fn thread_state(ctx: &TestContext, review_id: &str, thread_id: &str) -> ThreadState {
    let store = reviewdb::open(ctx.data_dir()).unwrap();
    store
        .read(|c| threads::list_for_review(c, review_id))
        .unwrap()
        .into_iter()
        .find(|t| t.id == thread_id)
        .unwrap()
        .state
}

#[test]
fn cli_address_moves_open_to_addressed() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let (_, published) = seed_reviews(&ctx);
    let thread_id = published_thread_id(&ctx, &published);

    let out = trunk_review_in(ctx.repo_path(), &["address", &thread_id], ctx.data_dir());

    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        thread_state(&ctx, &published, &thread_id),
        ThreadState::Addressed,
    );
}

#[test]
fn cli_illegal_transition_names_the_current_state_and_writes_nothing() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let (_, published) = seed_reviews(&ctx);
    let thread_id = published_thread_id(&ctx, &published);
    trunk_review_in(ctx.repo_path(), &["address", &thread_id], ctx.data_dir());

    let second = trunk_review_in(ctx.repo_path(), &["address", &thread_id], ctx.data_dir());

    assert_eq!(second.status.code(), Some(1), "a second claim must fail");
    assert!(
        String::from_utf8_lossy(&second.stderr).contains("addressed"),
        "the error must name the CURRENT state, got {:?}",
        String::from_utf8_lossy(&second.stderr),
    );
    assert!(second.stdout.is_empty(), "no partial write");
    assert_eq!(
        thread_state(&ctx, &published, &thread_id),
        ThreadState::Addressed,
        "the failed claim must change nothing",
    );
}

#[test]
fn cli_has_no_verb_for_done_or_reopen() {
    let scratch = tempfile::TempDir::new().unwrap();

    for verb in ["done", "dismiss", "reopen"] {
        let out = trunk_review(&[verb, "SOMEID"], scratch.path());
        assert_eq!(
            out.status.code(),
            Some(2),
            "`{verb}` must not exist: resolution is the human's, or an agent could settle a review",
        );
    }
}

/// Criterion 2's CLI clause: any operation on one review leaves the others'
/// CLI-printed content unchanged, byte for byte.
#[test]
fn mutating_one_review_leaves_anothers_cli_output_byte_identical() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let (_, published_a) = seed_reviews(&ctx);
    let published_b = {
        let store = reviewdb::open(ctx.data_dir()).unwrap();
        let b = store
            .write(|tx| reviews::create(tx, &canonical, Some("the other review"), 700))
            .unwrap();
        store
            .write(|tx| {
                threads::insert(
                    tx,
                    &b,
                    threads::NewThread {
                        text: "b's thread".to_string(),
                        anchor: None,
                        commit_oid: None,
                        cached_excerpt: None,
                    },
                    800,
                )?;
                reviews::publish(tx, &canonical, &b, 900)
            })
            .unwrap();
        b
    };
    let before = trunk_review_in(ctx.repo_path(), &["show", &published_a], ctx.data_dir());

    let b_thread = published_thread_id(&ctx, &published_b);
    trunk_review_in(
        ctx.repo_path(),
        &["reply", &b_thread, "mutating B"],
        ctx.data_dir(),
    );
    trunk_review_in(ctx.repo_path(), &["address", &b_thread], ctx.data_dir());

    let after = trunk_review_in(ctx.repo_path(), &["show", &published_a], ctx.data_dir());
    assert_eq!(
        String::from_utf8_lossy(&before.stdout),
        String::from_utf8_lossy(&after.stdout),
        "operations on review B must leave A's printed content byte-identical",
    );
}

/// A running `trunk review watch` child whose stdout arrives line by line
/// over a channel, so a test can wait on output with a deadline while the
/// process itself blocks on the store's doorbell.
struct WatchChild {
    child: Child,
    lines: std::sync::mpsc::Receiver<String>,
}

impl WatchChild {
    fn spawn(ctx: &TestContext) -> WatchChild {
        WatchChild::spawn_with(ctx, &["review", "watch"])
    }

    fn spawn_json(ctx: &TestContext) -> WatchChild {
        WatchChild::spawn_with(ctx, &["review", "watch", "--json"])
    }

    fn spawn_with(ctx: &TestContext, args: &[&str]) -> WatchChild {
        let mut child = Command::new(env!("CARGO_BIN_EXE_trunk"))
            .args(args)
            .current_dir(ctx.repo_path())
            .env("TRUNK_DATA_DIR", ctx.data_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();

        let stdout = child.stdout.take().unwrap();
        let (sender, lines) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                if sender.send(line).is_err() {
                    return;
                }
            }
        });

        let watch = WatchChild { child, lines };
        assert!(
            watch
                .next_line(Duration::from_secs(10))
                .is_some_and(|l| l.starts_with("# watching")),
            "the readiness line must come first",
        );
        watch
    }

    fn next_line(&self, timeout: Duration) -> Option<String> {
        self.lines.recv_timeout(timeout).ok()
    }
}

impl Drop for WatchChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn watch_emits_the_review_id_when_a_published_review_changes() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let (_, published) = seed_reviews(&ctx);
    let thread_id = published_thread_id(&ctx, &published);
    let watch = WatchChild::spawn(&ctx);

    let reply = trunk_review_in(
        ctx.repo_path(),
        &["reply", &thread_id, "waking the watcher"],
        ctx.data_dir(),
    );
    assert_eq!(reply.status.code(), Some(0));

    assert_eq!(
        watch.next_line(Duration::from_secs(10)).as_deref(),
        Some(published.as_str()),
        "the changed review's id, one line, nothing else",
    );
}

#[test]
fn watch_stays_silent_for_composing_changes_and_drafts() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let (composing, published) = seed_reviews(&ctx);
    let thread_id = published_thread_id(&ctx, &published);
    let watch = WatchChild::spawn(&ctx);

    {
        let store = reviewdb::open(ctx.data_dir()).unwrap();
        store
            .write(|tx| {
                threads::insert(
                    tx,
                    &composing,
                    threads::NewThread {
                        text: "unpublished edit".to_string(),
                        anchor: None,
                        commit_oid: None,
                        cached_excerpt: None,
                    },
                    600,
                )
            })
            .unwrap();
        trunk_lib::commands::review::save_draft_inner(&store, &canonical, "typing…", None, 700)
            .unwrap();
    }

    assert_eq!(
        watch.next_line(Duration::from_millis(900)),
        None,
        "composing edits and drafts must print nothing",
    );

    // Liveness, not deafness: the same watcher still reports a real change.
    trunk_review_in(
        ctx.repo_path(),
        &["reply", &thread_id, "now a real one"],
        ctx.data_dir(),
    );
    assert_eq!(
        watch.next_line(Duration::from_secs(10)).as_deref(),
        Some(published.as_str()),
    );
}

/// `--json` exists so a harness never refetches and rediffs: each line is one
/// self-contained event carrying the change's full data.
#[test]
fn watch_json_streams_the_events_full_data() {
    let ctx = TestContext::builder()
        .with_file("a.txt", "one")
        .with_commit("c1")
        .build();
    let (_, published) = seed_reviews(&ctx);
    let thread_id = published_thread_id(&ctx, &published);
    let watch = WatchChild::spawn_json(&ctx);

    trunk_review_in(
        ctx.repo_path(),
        &["reply", &thread_id, "here is what I did"],
        ctx.data_dir(),
    );
    let event: serde_json::Value =
        serde_json::from_str(&watch.next_line(Duration::from_secs(10)).unwrap()).unwrap();
    assert_eq!(event["event"], "reply_added");
    assert_eq!(event["review"], published.as_str());
    assert_eq!(event["thread"], thread_id.as_str());
    assert_eq!(event["channel"], "agent");
    assert_eq!(event["text"], "here is what I did");

    trunk_review_in(ctx.repo_path(), &["address", &thread_id], ctx.data_dir());
    let event: serde_json::Value =
        serde_json::from_str(&watch.next_line(Duration::from_secs(10)).unwrap()).unwrap();
    assert_eq!(event["event"], "thread_state_changed");
    assert_eq!(event["thread"], thread_id.as_str());
    assert_eq!(event["from"], "open");
    assert_eq!(event["to"], "addressed");

    {
        let store = reviewdb::open(ctx.data_dir()).unwrap();
        store
            .write(|tx| {
                threads::insert(
                    tx,
                    &published,
                    threads::NewThread {
                        text: "new comment on a line".to_string(),
                        anchor: Some(trunk_lib::git::types::Anchor {
                            commit_oid: "abc123def456".to_string(),
                            file_path: "src/deep/file.rs".to_string(),
                            source: trunk_lib::git::types::Source::Diff,
                            side: trunk_lib::git::types::Side::New,
                            start_line: 4,
                            end_line: 9,
                        }),
                        commit_oid: None,
                        cached_excerpt: None,
                    },
                    5_000,
                )
            })
            .unwrap();
    }
    let event: serde_json::Value =
        serde_json::from_str(&watch.next_line(Duration::from_secs(10)).unwrap()).unwrap();
    assert_eq!(event["event"], "thread_added");
    assert_eq!(event["review"], published.as_str());
    assert_eq!(event["text"], "new comment on a line");
    assert_eq!(event["state"], "open");
    assert_eq!(event["anchor"]["file_path"], "src/deep/file.rs");
    assert_eq!(event["anchor"]["start_line"], 4);
    assert_eq!(event["anchor"]["end_line"], 9);
}

#[test]
fn the_review_subcommand_exits_without_a_window() {
    let scratch = tempfile::TempDir::new().unwrap();

    let out = trunk_review(&[], scratch.path());

    assert_eq!(
        out.status.code(),
        Some(2),
        "a bare `trunk review` must exit with a usage error, not start the GUI",
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("usage: trunk review"),
        "stderr must teach the verbs, got {stderr:?}",
    );
}

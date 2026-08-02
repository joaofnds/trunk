mod common;

use common::context::TestContext;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};
use trunk_lib::commands::review::{
    SessionState, end_review_session_inner, get_review_session_status_inner,
    resume_review_session_inner, start_review_session_inner,
};
use trunk_lib::git::review_store::{
    LoadOutcome, delete_session, load_session, save_session, session_exists,
};
use trunk_lib::git::types::ReviewSession;

fn empty_session() -> ReviewSession {
    ReviewSession {
        schema_version: 2,
        commits: vec!["abc123".to_string()],
        comments: vec![],
        draft_comment: None,
        working_tree_snapshot: None,
        index_snapshot: None,
    }
}

/// The single `.json` file in the sessions dir (panics if not exactly one).
fn the_session_file(data_dir: &Path) -> PathBuf {
    let entries: Vec<PathBuf> = fs::read_dir(data_dir.join("sessions"))
        .expect("sessions dir should exist after a save")
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    assert_eq!(entries.len(), 1, "expected exactly one .json session file");
    entries.into_iter().next().unwrap()
}

#[test]
fn session_round_trips() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let session = empty_session();

    save_session(ctx.data_dir(), &canonical, &session).unwrap();
    let outcome = load_session(ctx.data_dir(), &canonical).unwrap();

    let LoadOutcome::Loaded(loaded) = outcome else {
        panic!("expected Loaded, got a different outcome");
    };
    assert_eq!(
        serde_json::to_value(&loaded).unwrap(),
        serde_json::to_value(&session).unwrap(),
    );
}

#[test]
fn first_write_creates_dir() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();

    assert!(
        !ctx.data_dir().join("sessions").exists(),
        "sessions dir must not exist before the first save",
    );

    save_session(ctx.data_dir(), &canonical, &empty_session()).unwrap();

    assert!(
        ctx.data_dir().join("sessions").is_dir(),
        "first save should create the sessions dir",
    );
}

#[test]
fn atomic_write_clean() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();

    save_session(ctx.data_dir(), &canonical, &empty_session()).unwrap();

    let session_file = the_session_file(ctx.data_dir());
    let raw = fs::read_to_string(&session_file).unwrap();
    serde_json::from_str::<serde_json::Value>(&raw).expect("session file should be valid JSON");

    let leftover_tmp = fs::read_dir(ctx.data_dir().join("sessions"))
        .unwrap()
        .any(|e| e.unwrap().path().to_string_lossy().ends_with(".json.tmp"));
    assert!(
        !leftover_tmp,
        "no .tmp file should remain after a clean save"
    );
}

#[test]
fn corrupt_quarantined() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();

    save_session(ctx.data_dir(), &canonical, &empty_session()).unwrap();
    let session_file = the_session_file(ctx.data_dir());
    fs::write(&session_file, b"}}}not valid json{{{").unwrap();

    let outcome = load_session(ctx.data_dir(), &canonical).unwrap();

    assert!(matches!(outcome, LoadOutcome::RecoveredCorrupt));
    let corrupt_sidecar = session_file.with_extension("json.corrupt");
    assert!(
        corrupt_sidecar.exists(),
        ".corrupt sidecar should exist after quarantine",
    );
    assert!(
        !session_file.exists(),
        "original .json should be gone after quarantine",
    );
}

#[test]
fn newer_version_refused() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();

    save_session(ctx.data_dir(), &canonical, &empty_session()).unwrap();
    let session_file = the_session_file(ctx.data_dir());
    fs::write(
        &session_file,
        br#"{"schema_version":3,"commits":[],"comments":[],"draft_comment":null}"#,
    )
    .unwrap();
    let before = fs::read(&session_file).unwrap();

    let outcome = load_session(ctx.data_dir(), &canonical).unwrap();

    assert!(matches!(outcome, LoadOutcome::RefusedNewer));
    let after = fs::read(&session_file).unwrap();
    assert_eq!(
        before, after,
        "a refused newer-version file must be left byte-identical"
    );
}

// ── Lifecycle _inner tests (Plan 65-03) ──────────────────────────────────────
// These exercise the testability wedge: each _inner takes data_dir, a plain
// state_map and the raw sessions mutex, so both halves of the session — the file
// and the in-memory entry — are sampled and mutated where a test can drive them.

/// Start a session for the context's repo against a throwaway in-memory map, for
/// the tests that only assert on the disk half.
fn start_on_disk(ctx: &TestContext) -> PathBuf {
    start_review_session_inner(
        ctx.data_dir(),
        ctx.path(),
        ctx.state_map(),
        &Mutex::new(HashMap::new()),
    )
    .unwrap()
}

#[test]
fn start_creates_session() {
    let ctx = TestContext::new_empty();
    let sessions = Mutex::new(HashMap::new());

    let canonical =
        start_review_session_inner(ctx.data_dir(), ctx.path(), ctx.state_map(), &sessions).unwrap();

    let map = sessions.lock().unwrap();
    let session = map.get(&canonical).expect("start must cache the session");
    assert_eq!(session.schema_version, 2);
    assert!(session.commits.is_empty());
    assert!(session.comments.is_empty());
    assert!(session.draft_comment.is_none());
    assert!(
        load_matches_loaded(ctx.data_dir(), &canonical),
        "the session file should now exist on disk after start"
    );
}

#[test]
fn start_rejects_closed_repo() {
    let ctx = TestContext::new_empty();
    let empty: HashMap<String, PathBuf> = HashMap::new();

    let err = start_review_session_inner(
        ctx.data_dir(),
        ctx.path(),
        &empty,
        &Mutex::new(HashMap::new()),
    )
    .unwrap_err();

    assert_eq!(err.code, "not_open");
}

#[test]
fn start_rejects_when_session_exists() {
    let ctx = TestContext::new_empty();
    start_on_disk(&ctx);

    let err = start_review_session_inner(
        ctx.data_dir(),
        ctx.path(),
        ctx.state_map(),
        &Mutex::new(HashMap::new()),
    )
    .unwrap_err();

    assert_eq!(err.code, "session_exists");
}

#[test]
fn resume_after_restart() {
    let ctx = TestContext::new_empty();
    start_on_disk(&ctx);

    // A fresh process has no in-memory state — resume loads from disk.
    let sessions = Mutex::new(HashMap::new());
    let (canonical, outcome) =
        resume_review_session_inner(ctx.data_dir(), ctx.path(), ctx.state_map(), &sessions)
            .unwrap();

    assert!(
        matches!(outcome, LoadOutcome::Loaded(_)),
        "resume after a start must load the same session from disk"
    );
    assert!(
        sessions.lock().unwrap().contains_key(&canonical),
        "resume must cache what it loaded"
    );
}

#[cfg(unix)]
#[test]
fn symlink_resumes_same_session() {
    use std::os::unix::fs::symlink;

    let ctx = TestContext::new_empty();
    start_on_disk(&ctx);

    // Create a symlink pointing at the real repo dir and open via that path.
    let link_dir = tempfile::tempdir().unwrap();
    let link_path = link_dir.path().join("repo-alias");
    symlink(ctx.repo_path(), &link_path).unwrap();
    let link_str = link_path.display().to_string();
    let mut alias_map: HashMap<String, PathBuf> = HashMap::new();
    alias_map.insert(link_str.clone(), link_path.clone());

    let (alias_canonical, outcome) = resume_review_session_inner(
        ctx.data_dir(),
        &link_str,
        &alias_map,
        &Mutex::new(HashMap::new()),
    )
    .unwrap();

    let real_canonical = ctx.repo_path().canonicalize().unwrap();
    assert_eq!(
        alias_canonical, real_canonical,
        "the symlink path must canonicalize to the real repo path"
    );
    assert!(
        matches!(outcome, LoadOutcome::Loaded(_)),
        "opening via a symlink resumes the SAME session (canonical-path keying, crit #3)"
    );
}

#[test]
fn end_clears_session() {
    let ctx = TestContext::new_empty();
    start_on_disk(&ctx);
    let sessions = Mutex::new(HashMap::new());
    let app = tauri::test::mock_app();

    tauri::async_runtime::block_on(end_review_session_inner(
        ctx.data_dir(),
        ctx.path(),
        ctx.state_map(),
        &sessions,
        app.handle(),
    ))
    .unwrap();

    let status =
        get_review_session_status_inner(ctx.data_dir(), ctx.path(), ctx.state_map(), &sessions)
            .unwrap();
    assert!(!status.file_exists, "the file must be gone after end");
    assert_eq!(
        status.state,
        SessionState::None,
        "both halves are gone once the session is ended"
    );
}

#[test]
fn status_reports_active_when_both_halves_are_present() {
    let ctx = TestContext::new_empty();
    let sessions = Mutex::new(HashMap::new());
    start_review_session_inner(ctx.data_dir(), ctx.path(), ctx.state_map(), &sessions).unwrap();

    let status =
        get_review_session_status_inner(ctx.data_dir(), ctx.path(), ctx.state_map(), &sessions)
            .unwrap();

    assert!(status.file_exists);
    assert_eq!(status.state, SessionState::Active);
}

#[test]
fn status_reports_resume_available_for_a_file_this_process_never_loaded() {
    let ctx = TestContext::new_empty();
    start_on_disk(&ctx);

    let status = get_review_session_status_inner(
        ctx.data_dir(),
        ctx.path(),
        ctx.state_map(),
        &Mutex::new(HashMap::new()),
    )
    .unwrap();

    assert!(status.file_exists);
    assert_eq!(status.state, SessionState::ResumeAvailable);
}

// ── Lifecycle race harness ───────────────────────────────────────────────────
// Every session writer holds ReviewSessionsState across its disk write and its
// map write (mutate_session_rmw). These tests park one such writer mid-critical-
// section and run another lifecycle operation against it: whatever the operation
// does to disk must not land while the mutex is held by someone else.

type Sessions = Arc<Mutex<HashMap<PathBuf, ReviewSession>>>;

/// A session writer holding the mutex with its work still ahead of it.
struct ParkedWriter {
    release: mpsc::Sender<()>,
    thread: thread::JoinHandle<()>,
}

impl ParkedWriter {
    /// Take the mutex, then block until released and run `work` under the guard.
    /// Returns once the mutex is actually held.
    fn park<F>(sessions: &Sessions, work: F) -> Self
    where
        F: FnOnce(&mut HashMap<PathBuf, ReviewSession>) + Send + 'static,
    {
        let (holding_tx, holding_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let sessions = Arc::clone(sessions);
        let thread = thread::spawn(move || {
            let mut map = sessions.lock().unwrap();
            holding_tx.send(()).unwrap();
            release_rx.recv().unwrap();

            work(&mut map);
        });
        holding_rx.recv().unwrap();

        Self { release, thread }
    }

    fn finish(self) {
        self.release.send(()).unwrap();
        self.thread.join().unwrap();
    }
}

/// Wait for `condition`, or spend the budget. A condition that never holds is the
/// passing case for these races — it means the operation stayed off disk — so the
/// budget is spent in full whenever the code under test is correct.
fn settle(condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_millis(300);
    while !condition() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
}

/// Starting a session is the same critical section as ending one. A start that
/// persists the file outside the mutex can have it deleted by an End that lands
/// before the map insert does, leaving an in-memory session with nothing on disk.
#[test]
fn start_leaves_no_in_memory_session_without_its_file() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));

    let ender = {
        let data_dir = ctx.data_dir().to_path_buf();
        let canonical = canonical.clone();
        ParkedWriter::park(&sessions, move |map| {
            delete_session(&data_dir, &canonical).unwrap();
            map.remove(&canonical);
        })
    };

    let start = {
        let sessions = Arc::clone(&sessions);
        let data_dir = ctx.data_dir().to_path_buf();
        let path = ctx.path().to_string();
        let state_map = ctx.state_map().clone();
        thread::spawn(move || start_review_session_inner(&data_dir, &path, &state_map, &sessions))
    };
    settle(|| session_exists(ctx.data_dir(), &canonical));

    ender.finish();
    start.join().unwrap().unwrap();

    assert_eq!(
        session_exists(ctx.data_dir(), &canonical),
        sessions.lock().unwrap().contains_key(&canonical),
        "a session on disk and a session in memory must appear and vanish together"
    );
}

/// Resume's disk work belongs in the same critical section. On the corrupt-recovery
/// path it quarantines the bad file and writes a fresh one — outside the mutex, an
/// End deletes that fresh file and resume's insert still lands, leaving an in-memory
/// session with nothing on disk. The plain `Loaded` path rides the same lock; its
/// read leaves no trace to observe, so this pins the branch that writes.
#[test]
fn resume_leaves_no_in_memory_session_without_its_file() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    save_session(ctx.data_dir(), &canonical, &empty_session()).unwrap();
    let quarantined = the_session_file(ctx.data_dir()).with_extension("json.corrupt");
    fs::write(the_session_file(ctx.data_dir()), b"}}}not valid json{{{").unwrap();
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));

    let ender = {
        let data_dir = ctx.data_dir().to_path_buf();
        let canonical = canonical.clone();
        ParkedWriter::park(&sessions, move |map| {
            delete_session(&data_dir, &canonical).unwrap();
            map.remove(&canonical);
        })
    };

    let resume = {
        let sessions = Arc::clone(&sessions);
        let data_dir = ctx.data_dir().to_path_buf();
        let path = ctx.path().to_string();
        let state_map = ctx.state_map().clone();
        thread::spawn(move || resume_review_session_inner(&data_dir, &path, &state_map, &sessions))
    };
    // Both conditions, not just the quarantine: the rename happens before the fresh
    // write, and releasing between them lets the delete beat the write and hides the
    // divergence. This pair is the instant resume reaches for the mutex.
    settle(|| quarantined.exists() && session_exists(ctx.data_dir(), &canonical));

    ender.finish();
    let (_, outcome) = resume.join().unwrap().unwrap();

    assert!(matches!(outcome, LoadOutcome::RecoveredCorrupt));
    assert_eq!(
        session_exists(ctx.data_dir(), &canonical),
        sessions.lock().unwrap().contains_key(&canonical),
        "a recovered session on disk and in memory must appear and vanish together"
    );
}

/// Ending a session must be atomic against the writers that share its mutex. Every
/// other writer holds `ReviewSessionsState` across `save_session` → map-write
/// (`mutate_session_rmw`), so a writer that owns the lock when End runs has to see
/// End's file delete and its map removal both before its own write or both after —
/// never straddling it. A file left on disk with no in-memory entry is
/// `ResumeAvailable`, and the panel resumes that state on its own.
#[test]
fn end_leaves_no_session_a_concurrent_writer_recreated() {
    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    save_session(ctx.data_dir(), &canonical, &empty_session()).unwrap();
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::from([(
        canonical.clone(),
        empty_session(),
    )])));
    let app = tauri::test::mock_app();

    let writer = {
        let data_dir = ctx.data_dir().to_path_buf();
        let canonical = canonical.clone();
        ParkedWriter::park(&sessions, move |map| {
            save_session(&data_dir, &canonical, &empty_session()).unwrap();
            map.insert(canonical, empty_session());
        })
    };

    let end = {
        let sessions = Arc::clone(&sessions);
        let data_dir = ctx.data_dir().to_path_buf();
        let path = ctx.path().to_string();
        let state_map = ctx.state_map().clone();
        let handle = app.handle().clone();
        thread::spawn(move || {
            tauri::async_runtime::block_on(end_review_session_inner(
                &data_dir, &path, &state_map, &sessions, &handle,
            ))
        })
    };

    settle(|| !session_exists(ctx.data_dir(), &canonical));

    writer.finish();
    end.join().unwrap().unwrap();

    assert!(
        !session_exists(ctx.data_dir(), &canonical),
        "end must not leave a session file the concurrent writer put back"
    );
    assert!(
        !sessions.lock().unwrap().contains_key(&canonical),
        "end must drop the in-memory entry"
    );
}

/// True when a session round-trips back as `Loaded` for the canonical path.
fn load_matches_loaded(data_dir: &Path, canonical: &Path) -> bool {
    matches!(
        load_session(data_dir, canonical),
        Ok(LoadOutcome::Loaded(_))
    )
}

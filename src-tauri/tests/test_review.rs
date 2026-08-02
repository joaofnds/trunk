mod common;

use common::context::TestContext;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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
// These exercise the testability wedge: each _inner takes data_dir + a plain
// state_map, with NO Tauri state, so the 3-state status merge that needs the
// in-memory ReviewSessionsState lives only in the thin command (tested via the
// disk half here).

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
    let (_canonical, outcome) =
        resume_review_session_inner(ctx.data_dir(), ctx.path(), ctx.state_map()).unwrap();

    assert!(
        matches!(outcome, LoadOutcome::Loaded(_)),
        "resume after a start must load the same session from disk"
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

    let (alias_canonical, outcome) =
        resume_review_session_inner(ctx.data_dir(), &link_str, &alias_map).unwrap();

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
        get_review_session_status_inner(ctx.data_dir(), ctx.path(), ctx.state_map()).unwrap();
    assert!(!status.file_exists, "the file must be gone after end");
    assert_eq!(
        status.state,
        SessionState::None,
        "the disk-only view reports None once the file is deleted"
    );
}

#[test]
fn status_inner_never_reports_active() {
    let ctx = TestContext::new_empty();
    start_on_disk(&ctx);

    // _inner sees only disk: a present file is ResumeAvailable, never Active.
    // Promotion to Active is the thin command's job after locking the in-memory map.
    let status =
        get_review_session_status_inner(ctx.data_dir(), ctx.path(), ctx.state_map()).unwrap();
    assert!(status.file_exists);
    assert_eq!(status.state, SessionState::ResumeAvailable);
}

/// Starting a session is the same critical section as ending one. A start that
/// persists the file outside the mutex can have it deleted by an End that lands
/// before the map insert does, leaving an in-memory session with nothing on disk.
#[test]
fn start_leaves_no_in_memory_session_without_its_file() {
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    let sessions: Arc<Mutex<HashMap<PathBuf, ReviewSession>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // An End parked mid-critical-section: mutex in hand, its delete still ahead.
    let (holding_tx, holding_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let ender = {
        let sessions = Arc::clone(&sessions);
        let data_dir = ctx.data_dir().to_path_buf();
        let canonical = canonical.clone();
        thread::spawn(move || {
            let mut map = sessions.lock().unwrap();
            holding_tx.send(()).unwrap();
            release_rx.recv().unwrap();

            delete_session(&data_dir, &canonical).unwrap();
            map.remove(&canonical);
        })
    };
    holding_rx.recv().unwrap();

    let start = {
        let sessions = Arc::clone(&sessions);
        let data_dir = ctx.data_dir().to_path_buf();
        let path = ctx.path().to_string();
        let state_map = ctx.state_map().clone();
        thread::spawn(move || start_review_session_inner(&data_dir, &path, &state_map, &sessions))
    };

    // Same budget as the End race: a file that never appears while the mutex is
    // held is the passing case, not a stalled one.
    let deadline = Instant::now() + Duration::from_millis(300);
    while !session_exists(ctx.data_dir(), &canonical) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }

    release_tx.send(()).unwrap();
    ender.join().unwrap();
    start.join().unwrap().unwrap();

    assert_eq!(
        session_exists(ctx.data_dir(), &canonical),
        sessions.lock().unwrap().contains_key(&canonical),
        "a session on disk and a session in memory must appear and vanish together"
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
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    let ctx = TestContext::new_empty();
    let canonical = ctx.repo_path().canonicalize().unwrap();
    save_session(ctx.data_dir(), &canonical, &empty_session()).unwrap();
    let sessions = Arc::new(Mutex::new(HashMap::from([(
        canonical.clone(),
        empty_session(),
    )])));
    let app = tauri::test::mock_app();

    // A writer parked mid-RMW: mutex in hand, its save and its map-write still ahead.
    let (holding_tx, holding_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let writer = {
        let sessions = Arc::clone(&sessions);
        let data_dir = ctx.data_dir().to_path_buf();
        let canonical = canonical.clone();
        thread::spawn(move || {
            let mut map = sessions.lock().unwrap();
            holding_tx.send(()).unwrap();
            release_rx.recv().unwrap();

            save_session(&data_dir, &canonical, &empty_session()).unwrap();
            map.insert(canonical, empty_session());
        })
    };
    holding_rx.recv().unwrap();

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

    // Nothing signals "End reached its delete", and once End is correct that moment
    // no longer exists — so watch the observable effect within a budget. A session
    // that outlives the budget is the passing case, not a stalled one.
    let deadline = Instant::now() + Duration::from_millis(300);
    while session_exists(ctx.data_dir(), &canonical) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }

    release_tx.send(()).unwrap();
    writer.join().unwrap();
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

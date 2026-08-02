//! Review-session lifecycle commands (Phase 65, Plan 03).
//!
//! Four thin `#[tauri::command]`s over testable `_inner(data_dir: &Path, ...)`
//! functions, mirroring `stash.rs`. The `_inner` wedge takes plain args (no Tauri
//! state) so disk behavior is provable with a `tempfile::TempDir`.
//!
//! Canonical-path keying (D-11): the repo's `PathBuf` is canonicalized so a repo
//! opened via a symlink or alias resumes the SAME session.
//!
//! Disk-first mutation ordering (D-10): `_inner` writes the file → the thin
//! command then updates `ReviewSessionsState` → then emits `session-changed`, so
//! a failed write can never leave memory and disk diverged.

use super::resolve_data_dir;
use crate::error::TrunkError;
use crate::git::review_store::{self, LoadOutcome};
use crate::git::types::{Comment, DraftComment, ReviewSession};
use crate::state::{CommitCache, RepoState, ReviewSessionsState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime, State};

mod range;
use range::*;

mod resolution;
// Re-export so `crate::commands::review::{classify_anchor, OrphanReason}` (used by
// git/review.rs) and the resolution types/fn keep resolving after the move.
pub(crate) use resolution::classify_anchor;
pub use resolution::{CommentResolution, OrphanReason, resolve_all};

/// The three review-session states the frontend renders (D-12). Serializes
/// kebab-case to match the stub strings `active` / `resume-available` / `none`.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionState {
    /// File on disk AND in-memory entry present (only the thin command derives this).
    Active,
    /// File on disk but no in-memory entry — the user can resume.
    ResumeAvailable,
    /// No file and no in-memory entry.
    None,
}

/// Status payload for `get_review_session_status`. `_inner` fills the DISK half
/// (`file_exists` + `state` = ResumeAvailable/None); the thin command promotes to
/// `Active` after locking `ReviewSessionsState`. `canonical_path` is the
/// canonicalized path as a String so the frontend can match `session-changed`
/// payloads without re-canonicalizing (it cannot call `std::fs::canonicalize`).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionStatus {
    pub state: SessionState,
    pub file_exists: bool,
    pub canonical_path: String,
}

/// A single commit in the review session, rendered by the panel (D-05) and
/// consumed as a membership set by the graph (D-04/D-06). Serialize-default
/// snake_case matches `GraphCommit`, whose fields it copies 1:1.
#[derive(Debug, Serialize, Clone)]
pub struct SessionCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    /// True when this commit is an auto-created review snapshot (working-tree or
    /// index), not a commit the user hand-picked. The panel hides EMPTY snapshot
    /// sections (260531-l02d) while keeping empty hand-picked sections (their
    /// per-commit "Add note" affordance). Set by `list_session_commits`.
    #[serde(default)]
    pub is_snapshot: bool,
}

/// Look the repo up in `RepoState`'s map and canonicalize its `PathBuf`.
/// Returns `not_open` when the path is not a currently-open repo (SESS-01).
fn canonical_repo_path(
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<PathBuf, TrunkError> {
    let path_buf = crate::commands::repo_path_from_state(path, state_map)?;
    std::fs::canonicalize(path_buf).map_err(|e| TrunkError::new("io", e.to_string()))
}

/// Start a fresh review session for a currently-open repo (SESS-01 / D-08).
/// Rejects with `session_exists` if a file is already present — the client must
/// Resume or End-and-clear first (RESEARCH Open Question 2).
pub fn start_review_session_inner(
    data_dir: &Path,
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(PathBuf, ReviewSession), TrunkError> {
    let canonical = canonical_repo_path(path, state_map)?;
    if review_store::session_exists(data_dir, &canonical) {
        return Err(TrunkError::new(
            "session_exists",
            "A review session already exists for this repository — resume or end it first",
        ));
    }
    let session = ReviewSession {
        schema_version: 2,
        commits: vec![],
        comments: vec![],
        draft_comment: None,
        working_tree_snapshot: None,
        index_snapshot: None,
    };
    review_store::save_session(data_dir, &canonical, &session)?;
    Ok((canonical, session))
}

/// Load an existing session from disk for a currently-open repo (SESS-02 / D-14).
/// Returns the canonical path + the `LoadOutcome` so the command layer can branch
/// (Loaded → insert + emit; RecoveredCorrupt → fresh + toast; RefusedNewer → warn).
pub fn resume_review_session_inner(
    data_dir: &Path,
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(PathBuf, LoadOutcome), TrunkError> {
    let canonical = canonical_repo_path(path, state_map)?;
    let outcome = review_store::load_session(data_dir, &canonical)?;
    Ok((canonical, outcome))
}

/// End a review session for a currently-open repo (SESS-03 / D-13): drop the file,
/// drop the in-memory entry, release the snapshot keepalive refs, and announce it.
///
/// Generic over `R` so a test can drive the whole composition against
/// `tauri::test::mock_app()` — the `#[tauri::command]` wrapper's bare `AppHandle`
/// is `AppHandle<Wry>` and cannot (matches `remote::git_pull_inner`).
pub async fn end_review_session_inner<R: Runtime>(
    data_dir: &Path,
    path: &str,
    state_map: &HashMap<String, PathBuf>,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    app: &AppHandle<R>,
) -> Result<PathBuf, TrunkError> {
    let canonical = canonical_repo_path(path, state_map)?;

    end_session_rmw(data_dir, &canonical, sessions)?;

    // Best-effort: drop the working-tree snapshot keepalive refs (C3). The session is
    // already ended; a failure here only delays gc reachability, so it never aborts End.
    // Outside the critical section — git2 work has no business under the sessions lock.
    let path_for_refs = path.to_string();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Ok(repo) = git2::Repository::open(&path_for_refs) {
            let _ = crate::git::workdir_snapshot::clear_snapshot_refs(&repo);
        }
    })
    .await;

    emit_session_changed(app, &canonical);

    Ok(canonical)
}

/// Report the DISK half of the session status (D-14). `_inner` has no Tauri state
/// so it NEVER returns `Active` — it sets `ResumeAvailable` if the file exists,
/// else `None`. The thin command promotes to `Active` after locking the in-memory map.
pub fn get_review_session_status_inner(
    data_dir: &Path,
    path: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<SessionStatus, TrunkError> {
    let canonical = canonical_repo_path(path, state_map)?;
    let file_exists = review_store::session_exists(data_dir, &canonical);
    let state = if file_exists {
        SessionState::ResumeAvailable
    } else {
        SessionState::None
    };
    Ok(SessionStatus {
        state,
        file_exists,
        canonical_path: canonical.to_string_lossy().into_owned(),
    })
}

/// Derive the final three-state status from disk presence + in-memory presence.
/// This is the merge `_inner` structurally cannot do (it has no Tauri state).
/// `Active` is produced ONLY here, when both halves are present.
fn merge_status(file_exists: bool, in_memory_present: bool) -> SessionState {
    match (file_exists, in_memory_present) {
        (true, true) => SessionState::Active,
        (true, false) => SessionState::ResumeAvailable,
        (false, _) => SessionState::None,
    }
}

/// Emit the `session-changed` Tauri event for `canonical`, logging on failure
/// (66/WR-04). Phase 65's stance is "never silently destroy" — the previous
/// silent-discard pattern violated it. Failure here is an unrecoverable
/// runtime fault (dead event bus); the diagnostic goes to stderr because the
/// codebase has no `log`/`tracing` dependency.
fn emit_session_changed<R: Runtime>(app: &AppHandle<R>, canonical: &Path) {
    if let Err(e) = app.emit("session-changed", canonical.to_string_lossy().into_owned()) {
        eprintln!(
            "session-changed emit failed for {}: {}",
            canonical.display(),
            e
        );
    }
}

// ── Selection RMW core (Phase 66, Plan 02): mutex-serialized read-modify-write ─
// Add/remove/seed mutate the PERSISTED session — unlike the Phase 65 create/delete
// `_inner`s, which read no prior state. Two rapid clicks racing the read-mutate-
// write would lose a write (Pitfall 2), so the ENTIRE
// read→mutate→save_session→map-write runs under the `ReviewSessionsState` mutex.
// These free functions take the raw `&Mutex<..>` (not Tauri `State`) so the
// serialization is unit-testable without a Tauri runtime (`selection_rmw_serialized`).

/// Read-modify-write the session's commit set under the sessions mutex.
///
/// The lock is held across read → `mutate` → `save_session` → map-write so disk
/// and memory never diverge and no concurrent caller observes a stale set. The
/// blocking disk write inside the critical section is fine (small atomic
/// tmp+rename); the lock is never held across an `.await`. Returns `no_session`
/// when there is no in-memory session for `canonical` (distinct from `not_open`).
fn mutate_session_rmw<F>(
    data_dir: &Path,
    canonical: &Path,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    mutate: F,
) -> Result<(), TrunkError>
where
    F: FnOnce(&mut ReviewSession),
{
    let mut map = sessions.lock().unwrap();
    // Disk-first ordering (D-10): clone the current session, mutate the clone,
    // persist it to disk, and only then commit the clone back into the map. If
    // save_session fails, the in-memory map keeps the prior session unchanged,
    // so disk and memory never diverge (matches start/end_review_session's
    // verified-correct ordering and the docstring contract above).
    let mut next = map
        .get(canonical)
        .ok_or_else(|| {
            TrunkError::new("no_session", "No active review session for this repository")
        })?
        .clone();
    mutate(&mut next);
    review_store::save_session(data_dir, canonical, &next)?;
    map.insert(canonical.to_path_buf(), next);
    Ok(())
}

/// Delete the session from disk and from the map under the sessions mutex.
///
/// Same critical section as `mutate_session_rmw` and for the same reason: a writer
/// that persists between End's two halves recreates the file End already unlinked,
/// leaving a file with no in-memory entry — the `ResumeAvailable` state, which the
/// panel resumes on its own. Disk-first ordering (D-10) holds: a failed delete
/// leaves the map entry in place, so the two halves never diverge.
fn end_session_rmw(
    data_dir: &Path,
    canonical: &Path,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
) -> Result<(), TrunkError> {
    let mut map = sessions.lock().unwrap();

    review_store::delete_session(data_dir, canonical)?;
    map.remove(canonical);

    Ok(())
}

/// Union `range_oids` into the session set, deduped (SEL-01, D-03). One walk, one
/// save, one map-write — never decomposed into N adds.
fn seed_review_range_rmw(
    data_dir: &Path,
    canonical: &Path,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    range_oids: Vec<String>,
) -> Result<(), TrunkError> {
    mutate_session_rmw(data_dir, canonical, sessions, |session| {
        session.commits = union_dedup(&session.commits, range_oids);
    })
}

/// Add `oid` to the session set if absent (SEL-02, idempotent).
fn add_review_commit_rmw(
    data_dir: &Path,
    canonical: &Path,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    oid: &str,
) -> Result<(), TrunkError> {
    mutate_session_rmw(data_dir, canonical, sessions, |session| {
        apply_add(&mut session.commits, oid);
    })
}

/// Remove every occurrence of `oid` from the session set (SEL-03, no-op if absent).
fn remove_review_commit_rmw(
    data_dir: &Path,
    canonical: &Path,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    oid: &str,
) -> Result<(), TrunkError> {
    mutate_session_rmw(data_dir, canonical, sessions, |session| {
        apply_remove(&mut session.commits, oid);
    })
}

/// Point the session's working-tree snapshot at `new_oid` with GET-OR-CREATE,
/// never-orphan semantics (locked decision): apply_add the new snapshot oid and
/// set the field to it, but NEVER apply_remove the prior snapshot. Earlier
/// snapshots stay in `commits` so comments anchored to them never orphan when the
/// file changes mid-review; the field always tracks the LATEST snapshot.
///
/// When `decide_snapshot` reused the prior (unchanged workdir), `new_oid` is
/// already in `commits` → apply_add is a no-op and the field is unchanged. The
/// add + field-update run in ONE `mutate_session_rmw` closure so disk and memory
/// stay consistent.
fn set_review_snapshot_rmw(
    data_dir: &Path,
    canonical: &Path,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    kind: crate::git::workdir_snapshot::SnapshotKind,
    new_oid: &str,
) -> Result<(), TrunkError> {
    use crate::git::workdir_snapshot::SnapshotKind;
    mutate_session_rmw(data_dir, canonical, sessions, |session| {
        apply_add(&mut session.commits, new_oid);
        match kind {
            SnapshotKind::Workdir => {
                session.working_tree_snapshot = Some(new_oid.to_string());
            }
            SnapshotKind::Index => {
                session.index_snapshot = Some(new_oid.to_string());
            }
        }
    })
}

// ── Comment capture (Phase 67, Plan 02): shared dumb writers ──────────────────
// `add_comment_inner` and `save_draft_comment_inner` reuse the SAME serialized
// `mutate_session_rmw` as the selection RMW functions — the comment writer pushes
// a fully-formed `Comment` (the `Anchor` already carries source/side from the TS
// adapter) and clears the single draft slot; the draft writer replaces that slot.

/// Argument bundle for `add_comment_inner` (the testable core). The thin command
/// takes flat named args off the wire and assembles this; `_inner` is the wedge so
/// disk behavior is provable with a `TempDir` (no Tauri runtime).
#[derive(Debug)]
pub struct AddCommentRequest {
    pub path: String,
    pub text: String,
    pub anchor: crate::git::types::Anchor,
    pub cached_excerpt: String,
}

/// Argument bundle for `save_draft_comment_inner`. `DraftComment` has NO
/// `cached_excerpt` (schema asymmetry, Pitfall 5) — the draft carries text+anchor.
#[derive(Debug)]
pub struct SaveDraftCommentRequest {
    pub path: String,
    pub text: String,
    pub anchor: Option<crate::git::types::Anchor>,
}

/// Argument bundle for `add_commit_comment_inner` (the testable core). A
/// commit-level note (ANCH-03) is tied to a `commit_oid` with NO code anchor — the
/// sibling of `AddCommentRequest`, not an extension of it (RESEARCH Open Question 2).
#[derive(Debug)]
pub struct AddCommitCommentRequest {
    pub commit_oid: String,
    pub text: String,
}

/// Submit a comment: push the fully-formed `Comment` (the `Anchor` already carries
/// source/side from the TS adapter — L-08 dumb writer) and clear the single draft
/// slot so the composer never reopens with stale text. The push + clear + save run
/// inside the serialized RMW critical section, so concurrent submits never lose a
/// write and disk/memory never diverge.
fn add_comment_inner(
    data_dir: &Path,
    canonical: &Path,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    req: AddCommentRequest,
) -> Result<(), TrunkError> {
    mutate_session_rmw(data_dir, canonical, sessions, |session| {
        session.comments.push(Comment {
            id: uuid::Uuid::new_v4().to_string(),
            text: req.text,
            anchor: Some(req.anchor),
            cached_excerpt: Some(req.cached_excerpt),
            commit_oid: None,
        });
        session.draft_comment = None;
    })
}

/// Add a commit-level note (ANCH-03): push a `Comment` tied to `commit_oid` with NO
/// code anchor and NO cached excerpt, distinguishable from line-anchored comments so
/// render/jump can branch (D-01). Unlike `add_comment_inner`, it does NOT clear the
/// draft slot — a commit-level note is independent of the diff composer.
fn add_commit_comment_inner(
    data_dir: &Path,
    canonical: &Path,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    req: AddCommitCommentRequest,
) -> Result<(), TrunkError> {
    mutate_session_rmw(data_dir, canonical, sessions, |session| {
        session.comments.push(Comment {
            id: uuid::Uuid::new_v4().to_string(),
            text: req.text,
            anchor: None,
            cached_excerpt: None,
            commit_oid: Some(req.commit_oid),
        });
    })
}

/// Update a comment's text by stable `id` (CMT-02, D-03). Targets by uuid, never by
/// list position, so a concurrent tab reordering the list cannot misfire (T-69-05).
/// A missing id returns a `not_found` `TrunkError` and mutates nothing.
///
/// `mutate_session_rmw`'s closure is infallible, so presence is captured into a flag
/// inside the single critical section (no TOCTOU) and the error surfaced after.
fn edit_comment_inner(
    data_dir: &Path,
    canonical: &Path,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    id: &str,
    text: String,
) -> Result<(), TrunkError> {
    let mut found = false;
    mutate_session_rmw(data_dir, canonical, sessions, |session| {
        if let Some(comment) = session.comments.iter_mut().find(|c| c.id == id) {
            comment.text = text;
            found = true;
        }
    })?;
    if !found {
        return Err(TrunkError::new(
            "not_found",
            format!("no comment with id {id}"),
        ));
    }
    Ok(())
}

/// Remove a comment by stable `id` (CMT-03, D-03). A missing id is an idempotent
/// no-op (parity with `apply_remove`) — `retain` simply keeps everything when nothing
/// matches, so a double-delete or a stale id from another tab never errors.
fn delete_comment_inner(
    data_dir: &Path,
    canonical: &Path,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    id: &str,
) -> Result<(), TrunkError> {
    mutate_session_rmw(data_dir, canonical, sessions, |session| {
        session.comments.retain(|c| c.id != id);
    })
}

/// Write/replace the single draft-comment slot (per-keystroke). `DraftComment` has
/// NO `cached_excerpt` (schema asymmetry, Pitfall 5) — only text + anchor persist;
/// the excerpt is computed at submit. Does NOT emit `session-changed` (drafts are
/// not panel-visible until Phase 69; per-keystroke emits would cause reload storms).
fn save_draft_comment_inner(
    data_dir: &Path,
    canonical: &Path,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    req: SaveDraftCommentRequest,
) -> Result<(), TrunkError> {
    mutate_session_rmw(data_dir, canonical, sessions, |session| {
        session.draft_comment = Some(DraftComment {
            text: req.text,
            anchor: req.anchor,
        });
    })
}

/// Sync core mirroring `seed_review_range`'s precheck + git2 walk + RMW sequence.
/// Takes a pre-resolved canonical (matching siblings like
/// `add_review_commit:676-677`) and the raw `repo_path` for `Repository::open`.
///
/// **Test-only.** The live command does NOT call this helper because
/// `ReviewSessionsState` is a bare `Mutex` (not `Arc<Mutex>`), whose borrow
/// cannot satisfy `spawn_blocking`'s `'static + Send` bound. The command
/// duplicates the precheck inline above its `spawn_blocking` call; this helper
/// exists so a unit test pins the no-walk-on-no-session contract (66/WR-03)
/// without a Tauri runtime. Any future change to the live precheck must be
/// mirrored here so the test continues to gate the contract.
#[cfg(test)]
fn seed_review_range_inner(
    data_dir: &Path,
    canonical: &Path,
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    base_oid: &str,
    tip_oid: &str,
    repo_path: &str,
) -> Result<(), TrunkError> {
    // Fast-fail precheck (66/WR-03): probe the sessions mutex BEFORE any git2
    // work. Without this, an empty sessions map forces libgit2 to open the
    // repo, parse OIDs, validate, and walk the range — only for the RMW lock
    // to surface `no_session` after a wasted walk. Held in an explicit scope
    // so the MutexGuard drops before any git2 call. The TOCTOU window between
    // this probe and `seed_review_range_rmw` is acceptable: if End-review
    // fires between them, the RMW lock still surfaces `no_session` and the
    // user-visible result is identical (RESEARCH §3 Option A).
    {
        let map = sessions.lock().unwrap();
        if !map.contains_key(canonical) {
            return Err(TrunkError::new(
                "no_session",
                "No active review session for this repository",
            ));
        }
    }
    let repo = git2::Repository::open(repo_path).map_err(TrunkError::from)?;
    let base = git2::Oid::from_str(base_oid).map_err(TrunkError::from)?;
    let tip = git2::Oid::from_str(tip_oid).map_err(TrunkError::from)?;
    validate_range(&repo, base, tip)?;
    let range_oids = compute_range_oids(&repo, base, tip)?;
    seed_review_range_rmw(data_dir, canonical, sessions, range_oids)
}

/// Seed the session from an inclusive commit range `[base..tip]` (SEL-01, D-02/D-03).
///
/// Canonical resolves OUTSIDE `spawn_blocking` (matches sibling commands like
/// `add_review_commit:676-677`, closing INT-W1). git2 work runs on the blocking
/// pool; the RMW + emit stay on the async-runtime thread because
/// `ReviewSessionsState` is a bare `Mutex` (not `Arc<Mutex>`), so its borrow
/// cannot satisfy `spawn_blocking`'s `'static + Send` bound. One emit per gesture.
#[tauri::command]
pub async fn seed_review_range(
    path: String,
    base_oid: String,
    tip_oid: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    // Fast-fail precheck (66/WR-03): bail before spawning the git2 walk when no
    // session exists for this canonical. Mirrors the precheck inside
    // `seed_review_range_inner` (which the unit test pins) — the inner can't
    // run on the live command because `ReviewSessionsState` is a bare `Mutex`
    // whose borrow cannot satisfy `spawn_blocking`'s `'static + Send` bound.
    {
        let map = sessions.0.lock().unwrap();
        if !map.contains_key(&canonical) {
            return Err(TrunkError::new(
                "no_session",
                "No active review session for this repository",
            )
            .to_json());
        }
    }

    let path_for_blocking = path.clone();
    let range_oids =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, TrunkError> {
            let repo = git2::Repository::open(&path_for_blocking).map_err(TrunkError::from)?;
            let base = git2::Oid::from_str(&base_oid).map_err(TrunkError::from)?;
            let tip = git2::Oid::from_str(&tip_oid).map_err(TrunkError::from)?;
            validate_range(&repo, base, tip)?;
            compute_range_oids(&repo, base, tip)
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())?;

    seed_review_range_rmw(&data_dir, &canonical, &sessions.0, range_oids)
        .map_err(|e| e.to_json())?;
    emit_session_changed(&app, &canonical);
    Ok(())
}

/// Add a single hand-picked commit to the session (SEL-02).
#[tauri::command]
pub async fn add_review_commit(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    add_review_commit_rmw(&data_dir, &canonical, &sessions.0, &oid).map_err(|e| e.to_json())?;
    emit_session_changed(&app, &canonical);
    Ok(())
}

/// Get-or-create a review snapshot for the active session and return its OID.
/// `kind` selects the tree: `"workdir"` (HEAD→working tree, for unstaged comments)
/// or `"index"` (HEAD→index, for staged comments). On an UNCHANGED tree the existing
/// snapshot for that kind is reused (no redundant commit); otherwise a fresh dangling
/// snapshot commit (parent = HEAD) is created and pinned. The prior snapshot is NEVER
/// removed — earlier comments anchored to it never orphan.
#[tauri::command]
pub async fn ensure_review_snapshot(
    path: String,
    kind: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<String, String> {
    use crate::git::workdir_snapshot::SnapshotKind;
    let snapshot_kind = match kind.as_str() {
        "workdir" => SnapshotKind::Workdir,
        "index" => SnapshotKind::Index,
        other => {
            return Err(
                TrunkError::new("bad_request", format!("unknown snapshot kind: {other}")).to_json(),
            );
        }
    };

    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    // Fast-fail precheck (mirrors seed_review_range): bail before the git2 work
    // when no session exists. Also read the prior snapshot oid FOR THIS KIND under
    // the same short lock, then DROP the guard before any git2 work — the
    // read-prior-then-decide TOCTOU is benign (worst case one redundant snapshot).
    let prior_oid = {
        let map = sessions.0.lock().unwrap();
        match map.get(&canonical) {
            None => {
                return Err(TrunkError::new(
                    "no_session",
                    "No active review session for this repository",
                )
                .to_json());
            }
            Some(session) => match snapshot_kind {
                SnapshotKind::Workdir => session.working_tree_snapshot.clone(),
                SnapshotKind::Index => session.index_snapshot.clone(),
            },
        }
    };

    // git2::Repository is not Sync; decide off the async runtime and never hold a
    // lock across spawn_blocking (same constraint as seed_review_range).
    let path_for_blocking = path.clone();
    let snapshot_oid =
        tauri::async_runtime::spawn_blocking(move || -> Result<String, TrunkError> {
            let repo = git2::Repository::open(&path_for_blocking).map_err(TrunkError::from)?;
            let prior = match prior_oid {
                Some(s) => Some(git2::Oid::from_str(&s).map_err(TrunkError::from)?),
                None => None,
            };
            let (oid, _created) =
                crate::git::workdir_snapshot::decide_snapshot(&repo, snapshot_kind, prior)?;
            // Pin the snapshot so gc can't prune it and orphan its comments (C3).
            crate::git::workdir_snapshot::keep_snapshot_ref(&repo, oid)?;
            Ok(oid.to_string())
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())?;

    set_review_snapshot_rmw(
        &data_dir,
        &canonical,
        &sessions.0,
        snapshot_kind,
        &snapshot_oid,
    )
    .map_err(|e| e.to_json())?;
    emit_session_changed(&app, &canonical);
    Ok(snapshot_oid)
}

/// Remove a single commit from the session (SEL-03).
#[tauri::command]
pub async fn remove_review_commit(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    remove_review_commit_rmw(&data_dir, &canonical, &sessions.0, &oid).map_err(|e| e.to_json())?;
    emit_session_changed(&app, &canonical);
    Ok(())
}

/// Submit a comment to the active session (ANCH-01). Dumb writer: the `Anchor`
/// already carries source/side from the TS adapter (L-08). Emits `session-changed`
/// because a submitted comment is panel-visible state.
///
/// Flat named args (not a single struct param) mirror the sibling commands and the
/// `safeInvoke("add_comment", { path, text, anchor, cachedExcerpt })` flat wire
/// shape; Tauri maps the camelCase JS key `cachedExcerpt` to `cached_excerpt`.
#[tauri::command]
pub async fn add_comment(
    path: String,
    text: String,
    anchor: crate::git::types::Anchor,
    cached_excerpt: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    let req = AddCommentRequest {
        path,
        text,
        anchor,
        cached_excerpt,
    };
    add_comment_inner(&data_dir, &canonical, &sessions.0, req).map_err(|e| e.to_json())?;
    emit_session_changed(&app, &canonical);
    Ok(())
}

/// Persist the in-progress draft comment on keystroke (ANCH-01). Does NOT emit
/// `session-changed`: drafts are not panel-visible until Phase 69, and per-keystroke
/// emits would cause needless reload storms (RESEARCH Q3).
///
/// Flat named args mirror `add_comment` and the
/// `safeInvoke("save_draft_comment", { path, text, anchor })` flat wire shape.
#[tauri::command]
pub async fn save_draft_comment(
    path: String,
    text: String,
    anchor: Option<crate::git::types::Anchor>,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    let req = SaveDraftCommentRequest { path, text, anchor };
    save_draft_comment_inner(&data_dir, &canonical, &sessions.0, req).map_err(|e| e.to_json())?;
    Ok(())
}

/// Add a commit-level note (ANCH-03): a comment tied to a commit with no code anchor.
/// The backend for the per-commit "Add note" affordance (Plan 05). Emits
/// `session-changed` because the note is panel-visible state.
///
/// Flat named args mirror the sibling comment commands and the
/// `safeInvoke("add_commit_comment", { path, commitOid, text })` flat wire shape;
/// Tauri maps the camelCase JS key `commitOid` to `commit_oid`.
#[tauri::command]
pub async fn add_commit_comment(
    path: String,
    commit_oid: String,
    text: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    let req = AddCommitCommentRequest { commit_oid, text };
    add_commit_comment_inner(&data_dir, &canonical, &sessions.0, req).map_err(|e| e.to_json())?;
    emit_session_changed(&app, &canonical);
    Ok(())
}

/// Update a comment's text by stable `id` (CMT-02). A missing id surfaces as a
/// serialized `not_found` `TrunkError`. Emits `session-changed` after a successful
/// edit because the comment list is panel-visible state.
///
/// Flat named args mirror the sibling comment commands and the
/// `safeInvoke("edit_comment", { path, id, text })` flat wire shape.
#[tauri::command]
pub async fn edit_comment(
    path: String,
    id: String,
    text: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    edit_comment_inner(&data_dir, &canonical, &sessions.0, &id, text).map_err(|e| e.to_json())?;
    emit_session_changed(&app, &canonical);
    Ok(())
}

/// Remove a comment by stable `id` (CMT-03). A missing id is an idempotent no-op.
/// Emits `session-changed` because the comment list is panel-visible state.
///
/// Flat named args mirror the sibling comment commands and the
/// `safeInvoke("delete_comment", { path, id })` flat wire shape.
#[tauri::command]
pub async fn delete_comment(
    path: String,
    id: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    delete_comment_inner(&data_dir, &canonical, &sessions.0, &id).map_err(|e| e.to_json())?;
    emit_session_changed(&app, &canonical);
    Ok(())
}

/// List the session's commits in graph order (SEL-04). No mutation, no emit.
///
/// Dual path-keying (Pitfall 3): the session set is read by CANONICAL key from the
/// in-memory map; the graph order comes from `CommitCache` by RAW path. A missing
/// in-memory session is `no_session` (distinct from `canonical_repo_path`'s
/// `not_open`) so the frontend can branch on session-active vs repo-not-open.
#[tauri::command]
pub async fn list_session_commits(
    path: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    cache: State<'_, CommitCache>,
) -> Result<Vec<SessionCommit>, String> {
    let state_map = state.0.lock().unwrap().clone();
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    // Read the session set by CANONICAL key; a missing entry is `no_session`.
    // Also read the snapshot oids (working-tree + index) to mark SessionCommits as
    // snapshots so the panel can hide EMPTY snapshot sections (260531-l02d).
    let (commits, snapshot_oids) = {
        let map = sessions.0.lock().unwrap();
        let session = map.get(&canonical).ok_or_else(|| {
            TrunkError::new("no_session", "No active review session for this repository").to_json()
        })?;
        let mut snaps: Vec<String> = Vec::new();
        if let Some(s) = &session.working_tree_snapshot {
            snaps.push(s.clone());
        }
        if let Some(s) = &session.index_snapshot {
            snaps.push(s.clone());
        }
        (session.commits.clone(), snaps)
    };

    // Read the full graph order from CommitCache by RAW path (Pitfall 3).
    let graph = {
        let map = cache.0.lock().unwrap();
        map.get(&path)
            .ok_or_else(|| TrunkError::new("not_open", "Repository not open").to_json())?
            .clone()
    };

    // Open the repo fresh in spawn_blocking (orphan fallback needs find_commit);
    // never hold the RepoState lock across git2 work.
    let mut result =
        tauri::async_runtime::spawn_blocking(move || -> Result<Vec<SessionCommit>, TrunkError> {
            let repo = git2::Repository::open(&path).map_err(TrunkError::from)?;
            Ok(intersect_graph_order(&commits, &graph, &repo))
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())?;

    for commit in result.iter_mut() {
        commit.is_snapshot = snapshot_oids.contains(&commit.oid);
    }

    Ok(result)
}

/// A session comment plus its markdown body rendered to sanitized HTML. The
/// persisted `Comment` stays raw source (the composer/edit textareas round-trip
/// it); `text_html` is a derived, list-time-only field so the frontend can
/// `{@html}` the body without a per-card render IPC (grill §1).
#[derive(Debug, Serialize, Clone)]
pub struct CommentView {
    pub id: String,
    pub text: String,
    pub anchor: Option<crate::git::types::Anchor>,
    pub cached_excerpt: Option<String>,
    pub commit_oid: Option<String>,
    pub text_html: String,
}

impl CommentView {
    fn from_comment(c: Comment) -> Self {
        let text_html = crate::commands::markdown::render_comment_text(&c.text);
        CommentView {
            id: c.id,
            text: c.text,
            anchor: c.anchor,
            cached_excerpt: c.cached_excerpt,
            commit_oid: c.commit_oid,
            text_html,
        }
    }
}

/// List the active session's comments incl. stable ids (CMT-01) and rendered
/// markdown HTML per body. Read-only: clones `.comments` from the in-memory map
/// by CANONICAL key; no `save_session`, no emit (mirrors `list_session_commits`).
/// A missing in-memory session is `no_session` (distinct from
/// `canonical_repo_path`'s `not_open`) so the frontend can branch on
/// session-active vs repo-not-open. No git2 work — the resolvability/orphan check
/// is the separate `resolve_session_comments` command.
#[tauri::command]
pub async fn list_session_comments(
    path: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
) -> Result<Vec<CommentView>, String> {
    let state_map = state.0.lock().unwrap().clone();
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    let comments = {
        let map = sessions.0.lock().unwrap();
        map.get(&canonical)
            .ok_or_else(|| {
                TrunkError::new("no_session", "No active review session for this repository")
                    .to_json()
            })?
            .comments
            .clone()
    };

    Ok(comments
        .into_iter()
        .map(CommentView::from_comment)
        .collect())
}

/// The two snapshot OIDs the active session currently tracks. Both `None` when
/// no in-memory session exists for the repo — a missing session is "no snapshots",
/// not an error, because the frontend gates inline rendering on session existence
/// anyway. Serialize snake_case (the fields already are) mirrors `Comment`.
#[derive(Debug, Serialize, Clone)]
pub struct ReviewSnapshots {
    pub working_tree_snapshot: Option<String>,
    pub index_snapshot: Option<String>,
}

/// Read the in-memory session's current snapshot OIDs by canonical key. A missing
/// session yields both `None` (not an error). No `save_session`, no emit — the
/// testable read core behind `get_review_snapshots`.
fn read_snapshots(
    sessions: &Mutex<HashMap<PathBuf, ReviewSession>>,
    canonical: &Path,
) -> ReviewSnapshots {
    let map = sessions.lock().unwrap();
    match map.get(canonical) {
        Some(session) => ReviewSnapshots {
            working_tree_snapshot: session.working_tree_snapshot.clone(),
            index_snapshot: session.index_snapshot.clone(),
        },
        None => ReviewSnapshots {
            working_tree_snapshot: None,
            index_snapshot: None,
        },
    }
}

/// Expose the active session's current working-tree / index snapshot OIDs so the
/// frontend can match working-tree/staged comments against the live diff (inline
/// review comments). Read-only: reads the in-memory map by CANONICAL key; no
/// `save_session`, no `session-changed` emit, no snapshot creation (mirrors
/// `list_session_comments`). No in-memory session → both OIDs `None`, not an error
/// (the frontend gates inline rendering on session existence separately).
#[tauri::command]
pub async fn get_review_snapshots(
    path: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
) -> Result<ReviewSnapshots, String> {
    let state_map = state.0.lock().unwrap().clone();
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    Ok(read_snapshots(&sessions.0, &canonical))
}

/// Eagerly resolve every comment's anchor against the live repo (CMT-04, D-06):
/// one `CommentResolution` per comment so the panel shows orphan badges at load
/// without a click. Read-only — no `save_session`, no emit (RESEARCH Pitfall 5).
///
/// Clones `.comments` out of the in-memory map under the lock (a missing session is
/// `no_session`, mirroring `list_session_comments`), then opens the repo FRESH inside
/// `spawn_blocking` and runs the pure `resolve_all` — the `ReviewSessionsState` lock
/// is never held across git2 work (mirrors `list_session_commits:830-882`).
#[tauri::command]
pub async fn resolve_session_comments(
    path: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
) -> Result<Vec<CommentResolution>, String> {
    let state_map = state.0.lock().unwrap().clone();
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    let comments = {
        let map = sessions.0.lock().unwrap();
        map.get(&canonical)
            .ok_or_else(|| {
                TrunkError::new("no_session", "No active review session for this repository")
                    .to_json()
            })?
            .comments
            .clone()
    };

    let result = tauri::async_runtime::spawn_blocking(
        move || -> Result<Vec<CommentResolution>, TrunkError> {
            let repo = git2::Repository::open(&path).map_err(TrunkError::from)?;
            Ok(resolve_all(&comments, &repo))
        },
    )
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    Ok(result)
}

/// Generate the AI-framed markdown review doc for the active session (DOC-01).
/// Read-only: no `save_session`, no `session-changed` emit, no `mutate_session_rmw`.
/// Mirrors `resolve_session_comments`'s clone-under-lock + `spawn_blocking` shape so
/// the `ReviewSessionsState` lock is never held across git2 work (Pitfall 6 — `git2::Repository`
/// is not `Sync`). Clones the FULL `ReviewSession` (not just `.comments`) — the renderer
/// reads `commits` for the D-07 refs list.
///
/// D-11 gate (zero-comment rejection) lives HERE, not in the renderer. The pure
/// `git::review::render` assumes `session.comments.len() >= 1` and has no defensive
/// zero-comment branch; this command is the only invocation path, so the gate at this
/// layer is the contract. A non-UI invocation that bypasses the UI's D-01 gating
/// surfaces as `Err({code: "no_comments", ...})` rather than a soft empty doc.
///
/// SKIP `_inner`: no disk I/O means no disk-testability indirection is warranted. The
/// pure renderer in `git::review::render` IS the testable surface (TDD'd to 30 tests
/// in Phase 70 Plan 01). See PHASE 70 RESEARCH Q1 Option B.
///
/// Markdown injection in comment text is a DELIBERATE non-mitigation (Pitfall 5).
/// The recipient is an AI coding agent; escaping a user's `` ``` `` or heading would
/// hide signal the reviewer intentionally put there. Do not add escaping.
#[tauri::command]
pub async fn generate_review_doc(
    path: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
) -> Result<String, String> {
    let state_map = state.0.lock().unwrap().clone();
    let canonical = canonical_repo_path(&path, &state_map).map_err(|e| e.to_json())?;

    let session = {
        let map = sessions.0.lock().unwrap();
        map.get(&canonical)
            .ok_or_else(|| {
                TrunkError::new("no_session", "No active review session for this repository")
                    .to_json()
            })?
            .clone()
    };

    // D-11 gate: zero comments is the command's contract violation, not the
    // renderer's. The pure renderer assumes >=1 and has no defensive branch.
    if session.comments.is_empty() {
        return Err(TrunkError::new(
            "no_comments",
            "Generate requires at least one comment in the session",
        )
        .to_json());
    }

    let doc = tauri::async_runtime::spawn_blocking(move || -> Result<String, TrunkError> {
        let repo = git2::Repository::open(&path).map_err(TrunkError::from)?;
        Ok(crate::git::review::render(&session, &repo))
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    Ok(doc)
}

#[tauri::command]
pub async fn start_review_session(
    path: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;
    let (canonical, session) = tauri::async_runtime::spawn_blocking(move || {
        start_review_session_inner(&data_dir, &path, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    // Disk-first ordering (D-10): _inner already wrote the file → in-memory → emit.
    sessions
        .0
        .lock()
        .unwrap()
        .insert(canonical.clone(), session);
    emit_session_changed(&app, &canonical);
    Ok(())
}

#[tauri::command]
pub async fn resume_review_session(
    path: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;
    let data_dir_for_save = data_dir.clone();
    let (canonical, outcome) = tauri::async_runtime::spawn_blocking(move || {
        resume_review_session_inner(&data_dir, &path, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    match outcome {
        LoadOutcome::Loaded(session) => {
            sessions
                .0
                .lock()
                .unwrap()
                .insert(canonical.clone(), session);
        }
        LoadOutcome::None => {
            // No file to resume — nothing to load, nothing to insert.
        }
        LoadOutcome::RecoveredCorrupt => {
            // D-15: the corrupt file was quarantined; start a fresh session, persist
            // it (disk-first), cache it, and let the frontend toast the warning.
            let fresh = ReviewSession {
                schema_version: 2,
                commits: vec![],
                comments: vec![],
                draft_comment: None,
                working_tree_snapshot: None,
                index_snapshot: None,
            };
            review_store::save_session(&data_dir_for_save, &canonical, &fresh)
                .map_err(|e| e.to_json())?;
            sessions.0.lock().unwrap().insert(canonical.clone(), fresh);
        }
        LoadOutcome::RefusedNewer => {
            // D-16: a newer-schema file is left untouched; do NOT create a fresh
            // session, so a downgrade cannot wipe newer data.
            return Err(TrunkError::new(
                "newer_version",
                "This review session was written by a newer version of Trunk and cannot be opened",
            )
            .to_json());
        }
    }
    emit_session_changed(&app, &canonical);
    Ok(())
}

#[tauri::command]
pub async fn end_review_session(
    path: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<(), String> {
    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;

    end_review_session_inner(&data_dir, &path, &state_map, &sessions.0, &app)
        .await
        .map_err(|e| e.to_json())?;

    Ok(())
}

#[tauri::command]
pub async fn get_review_session_status(
    path: String,
    state: State<'_, RepoState>,
    sessions: State<'_, ReviewSessionsState>,
    app: AppHandle,
) -> Result<SessionStatus, String> {
    let state_map = state.0.lock().unwrap().clone();
    let data_dir = resolve_data_dir(&app)?;
    let mut status = tauri::async_runtime::spawn_blocking(move || {
        get_review_session_status_inner(&data_dir, &path, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    // THREE-STATE MERGE: _inner returned the disk half; promote to Active here by
    // checking the canonical key in the in-memory map (the only place Active is born).
    let canonical = PathBuf::from(&status.canonical_path);
    let in_memory_present = sessions.0.lock().unwrap().contains_key(&canonical);
    status.state = merge_status(status.file_exists, in_memory_present);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn merge_active_requires_both_halves() {
        assert_eq!(merge_status(true, true), SessionState::Active);
    }

    #[test]
    fn merge_resume_available_when_file_only() {
        assert_eq!(merge_status(true, false), SessionState::ResumeAvailable);
    }

    #[test]
    fn merge_none_when_no_file() {
        assert_eq!(merge_status(false, false), SessionState::None);
        assert_eq!(merge_status(false, true), SessionState::None);
    }

    // ── Task 1: RMW serialization (SEL-02/03, Pitfall 2) ─────────────────────

    #[test]
    fn selection_rmw_serialized() {
        use std::sync::{Arc, Mutex};
        use std::thread;

        let data_dir = TempDir::new().unwrap();
        let canonical = data_dir.path().join("repo-canonical");
        let sessions: Arc<Mutex<HashMap<PathBuf, ReviewSession>>> =
            Arc::new(Mutex::new(HashMap::new()));
        sessions.lock().unwrap().insert(
            canonical.clone(),
            ReviewSession {
                schema_version: 1,
                commits: vec![],
                comments: vec![],
                draft_comment: None,
                working_tree_snapshot: None,
                index_snapshot: None,
            },
        );

        // 50 threads each add a distinct oid concurrently. Without serialization
        // the read-modify-write races and writes clobber each other; with the
        // mutex held across read→mutate→save→map-write, every add survives.
        let n = 50;
        let mut handles = Vec::new();
        for i in 0..n {
            let sessions = Arc::clone(&sessions);
            let data_dir = data_dir.path().to_path_buf();
            let canonical = canonical.clone();
            handles.push(thread::spawn(move || {
                let oid = format!("oid-{i:04}");
                add_review_commit_rmw(&data_dir, &canonical, &sessions, &oid).unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        // In-memory set holds all N adds (no lost write).
        {
            let in_memory = sessions.lock().unwrap();
            let commits = &in_memory.get(&canonical).unwrap().commits;
            assert_eq!(
                commits.len(),
                n,
                "every concurrent add must survive in memory"
            );
            for i in 0..n {
                assert!(
                    commits.contains(&format!("oid-{i:04}")),
                    "oid-{i:04} lost under concurrent RMW"
                );
            }
        }

        // Disk reflects the same set (save_session ran inside the critical section).
        match review_store::load_session(data_dir.path(), &canonical).unwrap() {
            LoadOutcome::Loaded(s) => {
                assert_eq!(s.commits.len(), n, "disk must hold every concurrent add");
            }
            _ => panic!("expected a loadable session on disk"),
        }

        // Removing one oid through the same serialized path leaves a stable set.
        remove_review_commit_rmw(data_dir.path(), &canonical, &sessions, "oid-0000").unwrap();
        let in_memory = sessions.lock().unwrap();
        let commits = &in_memory.get(&canonical).unwrap().commits;
        assert_eq!(commits.len(), n - 1, "remove drops exactly one");
        assert!(
            !commits.contains(&"oid-0000".to_string()),
            "removed oid must be gone"
        );
    }

    #[test]
    fn working_tree_snapshot_never_orphans_prior() {
        let data_dir = TempDir::new().unwrap();
        let canonical = data_dir.path().join("repo-canonical");
        let sessions: Mutex<HashMap<PathBuf, ReviewSession>> = Mutex::new(HashMap::new());
        sessions.lock().unwrap().insert(
            canonical.clone(),
            ReviewSession {
                schema_version: 2,
                commits: vec!["hand-picked".to_string()],
                comments: vec![],
                draft_comment: None,
                working_tree_snapshot: None,
                index_snapshot: None,
            },
        );

        let first = "a".repeat(40);
        let second = "b".repeat(40);
        let kind = crate::git::workdir_snapshot::SnapshotKind::Workdir;
        set_review_snapshot_rmw(data_dir.path(), &canonical, &sessions, kind, &first).unwrap();
        set_review_snapshot_rmw(data_dir.path(), &canonical, &sessions, kind, &second).unwrap();

        let in_memory = sessions.lock().unwrap();
        let session = in_memory.get(&canonical).unwrap();
        // GET-OR-CREATE never-orphan: BOTH snapshot oids stay in commits so
        // comments anchored to the earlier snapshot never orphan; the field
        // tracks the latest. The unrelated hand-picked commit is undisturbed.
        assert!(
            session.commits.contains(&first),
            "the prior snapshot oid must REMAIN in commits (never orphaned)"
        );
        assert!(
            session.commits.contains(&second),
            "the latest snapshot oid must be in commits"
        );
        assert!(
            session.commits.contains(&"hand-picked".to_string()),
            "re-snapshot must not disturb hand-picked commits"
        );
        assert_eq!(
            session.working_tree_snapshot,
            Some(second.clone()),
            "the snapshot pointer must track the latest snapshot oid"
        );
    }

    #[test]
    fn rmw_missing_session_is_no_session_error() {
        use std::sync::Mutex;
        let data_dir = TempDir::new().unwrap();
        let canonical = data_dir.path().join("absent");
        let sessions: Mutex<HashMap<PathBuf, ReviewSession>> = Mutex::new(HashMap::new());
        // No in-memory session for `canonical` → RMW must reject with `no_session`.
        let err = add_review_commit_rmw(data_dir.path(), &canonical, &sessions, "x").unwrap_err();
        assert_eq!(err.code, "no_session");
    }

    // 66/WR-03: seed_review_range_inner must return `no_session` without running a
    // git walk when no session exists for the canonical path. The precheck is the
    // cheap fast-fail gate before any libgit2 work. To prove the walk never ran,
    // `repo_path` points at a tmp dir with NO `.git` — if the inner walked first,
    // `Repository::open` would surface a git2 error code (NOT `no_session`).
    #[test]
    fn seed_review_range_rejects_when_no_session() {
        use std::sync::Mutex;
        let data_dir = TempDir::new().unwrap();
        // A non-repo dir: `Repository::open` would fail here BEFORE the RMW lock
        // reports `no_session` — so a passing assertion proves the precheck ran first.
        let non_repo = TempDir::new().unwrap();
        let canonical = data_dir.path().join("absent");
        let sessions: Mutex<HashMap<PathBuf, ReviewSession>> = Mutex::new(HashMap::new());

        let err = seed_review_range_inner(
            data_dir.path(),
            &canonical,
            &sessions,
            // OIDs are valid hex so a missing precheck would walk past parsing too;
            // the only reason this can surface `no_session` is the precheck.
            "0000000000000000000000000000000000000000",
            "0000000000000000000000000000000000000001",
            non_repo.path().to_str().unwrap(),
        )
        .expect_err("expected an error when no session exists for the canonical path");
        assert_eq!(
            err.code, "no_session",
            "no session for the canonical path must short-circuit BEFORE the git walk (66/WR-03); got {err:?}"
        );
    }

    // Disk-first ordering (D-10): if save_session fails, the in-memory session
    // must NOT be mutated — otherwise the panel would render dirty state that
    // disk never witnessed, and an app restart would silently lose the change.
    // Setup: put a REGULAR FILE at the `sessions` path inside data_dir so the
    // internal `create_dir_all(sessions_dir)` errors with "not a directory",
    // which propagates as a TrunkError out of save_session.
    #[test]
    fn rmw_save_failure_does_not_mutate_in_memory_session() {
        use std::sync::Mutex;
        let data_dir = TempDir::new().unwrap();
        // Block save_session by placing a FILE where it expects a DIRECTORY.
        std::fs::write(data_dir.path().join("sessions"), b"blocker").unwrap();

        let canonical = data_dir.path().join("repo-canonical");
        let original = ReviewSession {
            schema_version: 2,
            commits: vec!["pre-existing".to_string()],
            comments: vec![],
            draft_comment: None,
            working_tree_snapshot: None,
            index_snapshot: None,
        };
        let sessions: Mutex<HashMap<PathBuf, ReviewSession>> = Mutex::new(HashMap::new());
        sessions
            .lock()
            .unwrap()
            .insert(canonical.clone(), original.clone());

        let err = add_review_commit_rmw(data_dir.path(), &canonical, &sessions, "new-oid")
            .expect_err("save_session must fail when sessions/ is blocked by a regular file");
        assert_eq!(err.code, "io", "expected an io error from save_session");

        // Critical assertion: the in-memory session is the UNCHANGED original.
        let in_memory = sessions.lock().unwrap();
        let stored = in_memory.get(&canonical).unwrap();
        assert_eq!(
            stored.commits, original.commits,
            "in-memory session must NOT be mutated when disk write fails (D-10)"
        );
    }

    // ── Phase 67 Plan 02: comment capture (add_comment / save_draft_comment) ──
    // `Comment` + `DraftComment` already come through `use super::*`.
    use crate::git::types::{Anchor, Side, Source};

    /// A `TempDir` data dir + a sessions map seeded with one empty session keyed
    /// by a synthetic canonical path. No git repo is needed — these writers only
    /// touch the persisted JSON store (mirrors `selection_rmw_serialized:940-952`).
    fn seeded_sessions(data_dir: &TempDir) -> (PathBuf, Mutex<HashMap<PathBuf, ReviewSession>>) {
        let canonical = data_dir.path().join("repo-canonical");
        let mut map = HashMap::new();
        map.insert(
            canonical.clone(),
            ReviewSession {
                schema_version: 1,
                commits: vec![],
                comments: vec![],
                draft_comment: None,
                working_tree_snapshot: None,
                index_snapshot: None,
            },
        );
        (canonical, Mutex::new(map))
    }

    /// A non-trivial anchor with all six fields distinct (side=Old, source=Diff).
    fn distinct_anchor() -> Anchor {
        Anchor {
            commit_oid: "abc123def456".to_string(),
            file_path: "src/lib/foo.rs".to_string(),
            source: Source::Diff,
            side: Side::Old,
            start_line: 12,
            end_line: 34,
        }
    }

    fn loaded(data_dir: &TempDir, canonical: &Path) -> ReviewSession {
        match review_store::load_session(data_dir.path(), canonical).unwrap() {
            LoadOutcome::Loaded(s) => s,
            _ => panic!("expected a loadable session on disk"),
        }
    }

    // Test 1 (SC-1): add_comment_inner pushes a Comment with anchor+excerpt, persists.
    #[test]
    fn add_comment_persists_comment_with_anchor_and_excerpt() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        let req = AddCommentRequest {
            path: "ignored".to_string(),
            text: "looks good".to_string(),
            anchor: distinct_anchor(),
            cached_excerpt: "let x = 1;".to_string(),
        };
        add_comment_inner(data_dir.path(), &canonical, &sessions, req).unwrap();

        let s = loaded(&data_dir, &canonical);
        assert_eq!(s.comments.len(), 1);
        assert_eq!(s.comments[0].text, "looks good");
        assert_eq!(s.comments[0].cached_excerpt.as_deref(), Some("let x = 1;"));
        assert!(
            s.comments[0].anchor.is_some(),
            "comment must carry its anchor"
        );
    }

    // Test 2: submit clears the single draft_comment slot.
    #[test]
    fn add_comment_clears_draft_slot() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        // Seed a pre-existing draft that submit must clear.
        sessions
            .lock()
            .unwrap()
            .get_mut(&canonical)
            .unwrap()
            .draft_comment = Some(DraftComment {
            text: "half-typed".to_string(),
            anchor: Some(distinct_anchor()),
        });

        let req = AddCommentRequest {
            path: "ignored".to_string(),
            text: "done".to_string(),
            anchor: distinct_anchor(),
            cached_excerpt: "x".to_string(),
        };
        add_comment_inner(data_dir.path(), &canonical, &sessions, req).unwrap();

        let s = loaded(&data_dir, &canonical);
        assert!(
            s.draft_comment.is_none(),
            "submit must clear the draft slot so the composer never reopens with stale text"
        );
    }

    // Test 3 (no-session): missing in-memory session → "no_session".
    #[test]
    fn add_comment_missing_session_is_no_session_error() {
        let data_dir = TempDir::new().unwrap();
        let canonical = data_dir.path().join("absent");
        let sessions: Mutex<HashMap<PathBuf, ReviewSession>> = Mutex::new(HashMap::new());
        let req = AddCommentRequest {
            path: "ignored".to_string(),
            text: "t".to_string(),
            anchor: distinct_anchor(),
            cached_excerpt: "e".to_string(),
        };
        let err = add_comment_inner(data_dir.path(), &canonical, &sessions, req).unwrap_err();
        assert_eq!(err.code, "no_session");
    }

    // Test 4 (L-08): a Source::FullFile anchor persists unchanged (Phase-68 contract).
    #[test]
    fn add_comment_persists_full_file_source_unchanged() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        let mut anchor = distinct_anchor();
        anchor.source = Source::FullFile;
        let req = AddCommentRequest {
            path: "ignored".to_string(),
            text: "whole-file note".to_string(),
            anchor,
            cached_excerpt: "e".to_string(),
        };
        add_comment_inner(data_dir.path(), &canonical, &sessions, req).unwrap();

        let s = loaded(&data_dir, &canonical);
        let stored = s.comments[0].anchor.as_ref().unwrap();
        assert_eq!(
            stored.source,
            Source::FullFile,
            "add_comment must persist Source::FullFile verbatim (L-08 dumb-writer contract)"
        );
    }

    // Test 5 (SC-2): a non-trivial anchor round-trips with every field identical.
    #[test]
    fn add_comment_anchor_round_trips_all_six_fields() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        let anchor = distinct_anchor();
        let req = AddCommentRequest {
            path: "ignored".to_string(),
            text: "t".to_string(),
            anchor: anchor.clone(),
            cached_excerpt: "e".to_string(),
        };
        add_comment_inner(data_dir.path(), &canonical, &sessions, req).unwrap();

        let s = loaded(&data_dir, &canonical);
        let stored = s.comments[0].anchor.as_ref().unwrap();
        // Anchor derives no PartialEq (frozen schema) — assert field-by-field.
        assert_eq!(stored.commit_oid, anchor.commit_oid);
        assert_eq!(stored.file_path, anchor.file_path);
        assert_eq!(stored.source, anchor.source);
        assert_eq!(stored.side, anchor.side);
        assert_eq!(stored.start_line, anchor.start_line);
        assert_eq!(stored.end_line, anchor.end_line);
    }

    // Test 6 (concurrency): N concurrent submits all survive on disk.
    #[test]
    fn add_comment_concurrent_submits_all_survive() {
        use std::sync::Arc;
        use std::thread;

        let data_dir = TempDir::new().unwrap();
        let canonical = data_dir.path().join("repo-canonical");
        let sessions: Arc<Mutex<HashMap<PathBuf, ReviewSession>>> =
            Arc::new(Mutex::new(HashMap::new()));
        sessions.lock().unwrap().insert(
            canonical.clone(),
            ReviewSession {
                schema_version: 1,
                commits: vec![],
                comments: vec![],
                draft_comment: None,
                working_tree_snapshot: None,
                index_snapshot: None,
            },
        );

        let n = 50;
        let mut handles = Vec::new();
        for i in 0..n {
            let sessions = Arc::clone(&sessions);
            let data_dir = data_dir.path().to_path_buf();
            let canonical = canonical.clone();
            handles.push(thread::spawn(move || {
                let req = AddCommentRequest {
                    path: "ignored".to_string(),
                    text: format!("comment-{i:04}"),
                    anchor: distinct_anchor(),
                    cached_excerpt: "e".to_string(),
                };
                add_comment_inner(&data_dir, &canonical, &sessions, req).unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        match review_store::load_session(data_dir.path(), &canonical).unwrap() {
            LoadOutcome::Loaded(s) => {
                assert_eq!(s.comments.len(), n, "every concurrent submit must survive");
            }
            _ => panic!("expected a loadable session on disk"),
        }
    }

    // Test 7 (T-67-02): a traversal-shaped file_path round-trips verbatim AND does
    // not influence the on-disk session filename (filename is the FNV-1a hash).
    #[test]
    fn add_comment_path_traversal_round_trips_without_affecting_filename() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        let mut anchor = distinct_anchor();
        anchor.file_path = "../../etc/passwd".to_string();
        let req = AddCommentRequest {
            path: "ignored".to_string(),
            text: "t".to_string(),
            anchor,
            cached_excerpt: "e".to_string(),
        };
        add_comment_inner(data_dir.path(), &canonical, &sessions, req).unwrap();

        // The anchor metadata round-trips verbatim.
        let s = loaded(&data_dir, &canonical);
        assert_eq!(
            s.comments[0].anchor.as_ref().unwrap().file_path,
            "../../etc/passwd",
            "traversal-shaped file_path is metadata and must round-trip unchanged"
        );

        // The on-disk filename is the FNV-1a hash of the canonical path, never the
        // anchor: exactly one session file, named `<16 hex>.json`, no traversal.
        let entries: Vec<_> = std::fs::read_dir(data_dir.path().join("sessions"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries.len(), 1, "exactly one session file on disk");
        let name = &entries[0];
        assert!(
            name.len() == "0123456789abcdef.json".len()
                && name.ends_with(".json")
                && name[..16].chars().all(|c| c.is_ascii_hexdigit()),
            "session filename must be the 16-hex FNV-1a hash, got {name}"
        );
        assert!(
            !name.contains("..") && !name.contains("etc") && !name.contains("passwd"),
            "anchor file_path must never leak into the session filename"
        );
    }

    // Test 8: save_draft_comment_inner writes the draft slot (no cached_excerpt).
    #[test]
    fn save_draft_comment_persists_text_and_anchor() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        let req = SaveDraftCommentRequest {
            path: "ignored".to_string(),
            text: "typing...".to_string(),
            anchor: Some(distinct_anchor()),
        };
        save_draft_comment_inner(data_dir.path(), &canonical, &sessions, req).unwrap();

        let s = loaded(&data_dir, &canonical);
        let draft = s.draft_comment.as_ref().expect("draft must be persisted");
        assert_eq!(draft.text, "typing...");
        assert_eq!(
            draft.anchor.as_ref().unwrap().file_path,
            "src/lib/foo.rs",
            "draft must carry its anchor"
        );
        // No comment was added — drafts are not comments.
        assert!(s.comments.is_empty(), "a draft does not append a comment");
    }

    // Test 9: save_draft_comment_inner no-session → "no_session".
    #[test]
    fn save_draft_comment_missing_session_is_no_session_error() {
        let data_dir = TempDir::new().unwrap();
        let canonical = data_dir.path().join("absent");
        let sessions: Mutex<HashMap<PathBuf, ReviewSession>> = Mutex::new(HashMap::new());
        let req = SaveDraftCommentRequest {
            path: "ignored".to_string(),
            text: "t".to_string(),
            anchor: None,
        };
        let err =
            save_draft_comment_inner(data_dir.path(), &canonical, &sessions, req).unwrap_err();
        assert_eq!(err.code, "no_session");
    }

    // ── Phase 69 Plan 02: comment management (commit-level note, edit, delete) ──

    // Test 10 (ANCH-03): add_commit_comment_inner persists a commit-level comment.
    #[test]
    fn add_commit_comment_persists_commit_level_comment() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        let req = AddCommitCommentRequest {
            commit_oid: "abc123def456".to_string(),
            text: "this commit needs a follow-up".to_string(),
        };
        add_commit_comment_inner(data_dir.path(), &canonical, &sessions, req).unwrap();

        let s = loaded(&data_dir, &canonical);
        assert_eq!(s.comments.len(), 1);
        assert_eq!(s.comments[0].text, "this commit needs a follow-up");
        assert_eq!(
            s.comments[0].commit_oid.as_deref(),
            Some("abc123def456"),
            "commit-level comment must carry its commit_oid"
        );
    }

    // Test 11 (D-01): a commit-level comment is distinguishable from a line-anchored
    // one — anchor.is_none() && commit_oid.is_some() && a fresh non-empty id.
    #[test]
    fn add_commit_comment_is_distinguishable_from_line_anchored() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        let req = AddCommitCommentRequest {
            commit_oid: "deadbeef".to_string(),
            text: "note".to_string(),
        };
        add_commit_comment_inner(data_dir.path(), &canonical, &sessions, req).unwrap();

        let s = loaded(&data_dir, &canonical);
        let c = &s.comments[0];
        assert!(
            c.anchor.is_none(),
            "commit-level comment has no code anchor"
        );
        assert!(
            c.commit_oid.is_some(),
            "commit-level comment is tied to a commit"
        );
        assert!(
            c.cached_excerpt.is_none(),
            "commit-level comment has no diff excerpt"
        );
        assert!(
            !c.id.is_empty(),
            "every comment carries a fresh non-empty id"
        );
    }

    // Test 12: add_commit_comment_inner does NOT clear the line-anchored draft slot —
    // a commit-level note is independent of the diff composer.
    #[test]
    fn add_commit_comment_leaves_draft_slot_untouched() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        sessions
            .lock()
            .unwrap()
            .get_mut(&canonical)
            .unwrap()
            .draft_comment = Some(DraftComment {
            text: "half-typed line comment".to_string(),
            anchor: Some(distinct_anchor()),
        });

        let req = AddCommitCommentRequest {
            commit_oid: "abc".to_string(),
            text: "commit note".to_string(),
        };
        add_commit_comment_inner(data_dir.path(), &canonical, &sessions, req).unwrap();

        let s = loaded(&data_dir, &canonical);
        assert!(
            s.draft_comment.is_some(),
            "a commit-level note must not clear the line-anchored draft"
        );
    }

    // Test 13 (CMT-02): edit_comment_inner updates one comment's text by id and
    // leaves every other comment unchanged.
    #[test]
    fn edit_comment_updates_text_by_id_and_leaves_others() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        // Seed two comments so we can prove only the targeted one changes.
        add_commit_comment_inner(
            data_dir.path(),
            &canonical,
            &sessions,
            AddCommitCommentRequest {
                commit_oid: "c1".to_string(),
                text: "first".to_string(),
            },
        )
        .unwrap();
        add_commit_comment_inner(
            data_dir.path(),
            &canonical,
            &sessions,
            AddCommitCommentRequest {
                commit_oid: "c2".to_string(),
                text: "second".to_string(),
            },
        )
        .unwrap();
        let target_id = loaded(&data_dir, &canonical).comments[0].id.clone();

        edit_comment_inner(
            data_dir.path(),
            &canonical,
            &sessions,
            &target_id,
            "first (edited)".to_string(),
        )
        .unwrap();

        let s = loaded(&data_dir, &canonical);
        assert_eq!(s.comments.len(), 2, "edit must not add or drop comments");
        let edited = s.comments.iter().find(|c| c.id == target_id).unwrap();
        assert_eq!(edited.text, "first (edited)");
        let other = s.comments.iter().find(|c| c.id != target_id).unwrap();
        assert_eq!(other.text, "second", "non-targeted comment is untouched");
    }

    // Test 14 (T-69-05): edit_comment_inner on a missing id returns not_found and
    // mutates nothing.
    #[test]
    fn edit_comment_missing_id_is_not_found() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        add_commit_comment_inner(
            data_dir.path(),
            &canonical,
            &sessions,
            AddCommitCommentRequest {
                commit_oid: "c1".to_string(),
                text: "untouched".to_string(),
            },
        )
        .unwrap();

        let err = edit_comment_inner(
            data_dir.path(),
            &canonical,
            &sessions,
            "no-such-id",
            "ignored".to_string(),
        )
        .unwrap_err();
        assert_eq!(err.code, "not_found");

        let s = loaded(&data_dir, &canonical);
        assert_eq!(s.comments.len(), 1);
        assert_eq!(
            s.comments[0].text, "untouched",
            "a not_found edit must mutate nothing"
        );
    }

    // Test 15 (CMT-03): delete_comment_inner removes the comment whose id matches
    // and leaves the rest; the count drops by exactly one.
    #[test]
    fn delete_comment_removes_by_id_and_leaves_rest() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        add_commit_comment_inner(
            data_dir.path(),
            &canonical,
            &sessions,
            AddCommitCommentRequest {
                commit_oid: "c1".to_string(),
                text: "doomed".to_string(),
            },
        )
        .unwrap();
        add_commit_comment_inner(
            data_dir.path(),
            &canonical,
            &sessions,
            AddCommitCommentRequest {
                commit_oid: "c2".to_string(),
                text: "survivor".to_string(),
            },
        )
        .unwrap();
        let target_id = loaded(&data_dir, &canonical).comments[0].id.clone();

        delete_comment_inner(data_dir.path(), &canonical, &sessions, &target_id).unwrap();

        let s = loaded(&data_dir, &canonical);
        assert_eq!(s.comments.len(), 1, "delete drops exactly one comment");
        assert_eq!(
            s.comments[0].text, "survivor",
            "the non-targeted comment survives"
        );
    }

    // Test 16 (T-69-05 idempotency): delete_comment_inner on a missing id mutates
    // nothing and returns Ok — an idempotent no-op (parity with apply_remove).
    #[test]
    fn delete_comment_missing_id_is_idempotent_no_op() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        add_commit_comment_inner(
            data_dir.path(),
            &canonical,
            &sessions,
            AddCommitCommentRequest {
                commit_oid: "c1".to_string(),
                text: "untouched".to_string(),
            },
        )
        .unwrap();

        // Returns Ok — never an error — even though nothing matches.
        delete_comment_inner(data_dir.path(), &canonical, &sessions, "no-such-id").unwrap();

        let s = loaded(&data_dir, &canonical);
        assert_eq!(
            s.comments.len(),
            1,
            "a missing-id delete leaves the comment count unchanged"
        );
        assert_eq!(s.comments[0].text, "untouched");
    }

    // ── Inline review comments: get_review_snapshots (read-only snapshot OIDs) ──

    #[test]
    fn read_snapshots_returns_the_session_current_oids() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);
        {
            let mut map = sessions.lock().unwrap();
            let s = map.get_mut(&canonical).unwrap();
            s.working_tree_snapshot = Some("wt-oid".to_string());
            s.index_snapshot = Some("idx-oid".to_string());
        }

        let snapshots = read_snapshots(&sessions, &canonical);

        assert_eq!(snapshots.working_tree_snapshot.as_deref(), Some("wt-oid"));
        assert_eq!(snapshots.index_snapshot.as_deref(), Some("idx-oid"));
    }

    #[test]
    fn read_snapshots_returns_nulls_when_no_session() {
        let data_dir = TempDir::new().unwrap();
        let absent = data_dir.path().join("absent");
        let sessions: Mutex<HashMap<PathBuf, ReviewSession>> = Mutex::new(HashMap::new());

        let snapshots = read_snapshots(&sessions, &absent);

        assert!(snapshots.working_tree_snapshot.is_none());
        assert!(snapshots.index_snapshot.is_none());
    }

    #[test]
    fn read_snapshots_does_not_mutate_the_session() {
        let data_dir = TempDir::new().unwrap();
        let (canonical, sessions) = seeded_sessions(&data_dir);

        read_snapshots(&sessions, &canonical);

        let map = sessions.lock().unwrap();
        let s = map.get(&canonical).unwrap();
        assert!(s.working_tree_snapshot.is_none());
        assert!(s.index_snapshot.is_none());
        assert!(s.comments.is_empty(), "a read must not append a comment");
    }
}

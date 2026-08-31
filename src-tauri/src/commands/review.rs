//! Review commands over the persistent store.
//!
//! Thin `#[tauri::command]`s over testable `_inner(store: &Store, ...)`
//! functions. `resolve_data_dir` needs an `AppHandle`, which exists only in this
//! layer; everything under `reviewdb` takes `&Path` / `&Store`, which is the
//! wedge tests use and what milestone 3's CLI needs.
//!
//! Canonical-path keying: the repo's `PathBuf` is canonicalized so a repo opened
//! via a symlink or alias reaches the same reviews.

use crate::error::TrunkError;
use crate::git::review_range::{compute_range_oids, intersect_graph_order, validate_range};
use crate::git::review_resolution::{CommentResolution, resolve_all};
use crate::git::types::SessionCommit;
use crate::reviewdb::{Store, commits, drafts, pins, replies, reviews, snapshots, threads};
use crate::state::{CommitCache, RepoState, ReviewStoreState};
use reviews::Review;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Runtime, State};

/// Look the repo up in `RepoState`'s map and canonicalize its `PathBuf`.
/// Returns `not_open` when the path is not a currently-open repo.
fn canonical_of(path: &str, state_map: &HashMap<String, PathBuf>) -> Result<PathBuf, TrunkError> {
    let path_buf = crate::commands::repo_path_from_state(path, state_map)?;
    std::fs::canonicalize(path_buf).map_err(|e| TrunkError::new("io", e.to_string()))
}

/// The review store for this app, opening it on first use.
fn open_cached(
    slot: &Mutex<Option<Arc<Store>>>,
    data_dir: &Path,
) -> Result<Arc<Store>, TrunkError> {
    let mut slot = slot.lock().unwrap();
    if let Some(store) = slot.as_ref() {
        return Ok(Arc::clone(store));
    }

    let store = Arc::new(crate::reviewdb::open(data_dir)?);
    *slot = Some(Arc::clone(&store));

    Ok(store)
}

/// Emit `reviews-changed` for `canonical`, logging on failure. The payload is
/// the canonical repo path, so the frontend's filter shape is unchanged. Failure
/// here is an unrecoverable runtime fault (dead event bus); the diagnostic goes
/// to stderr because the codebase has no `log` dependency.
fn emit_reviews_changed<R: Runtime>(app: &AppHandle<R>, canonical: &Path) {
    if let Err(e) = app.emit("reviews-changed", canonical.to_string_lossy().into_owned()) {
        eprintln!(
            "reviews-changed emit failed for {}: {}",
            canonical.display(),
            e
        );
    }
}

/// Run store work off the async runtime. A contended SQLite write waits up to
/// `busy_timeout`, which would otherwise pin a tokio worker for five seconds —
/// the same reason the git2 paths already use `spawn_blocking`.
async fn blocking_store<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, TrunkError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

/// Resolve `path` and open the store. Every command below starts this way.
async fn prepare<R: Runtime>(
    path: &str,
    state: &RepoState,
    store: &ReviewStoreState,
    app: &AppHandle<R>,
) -> Result<(PathBuf, Arc<Store>), String> {
    let state_map = state.0.lock().unwrap().clone();
    let raw = path.to_string();
    let canonical = blocking_store(move || canonical_of(&raw, &state_map)).await?;

    // Opening does `create_dir_all`, four pragmas and the migration ladder, and
    // can wait on another process's write lock — all of it off the async runtime,
    // for the reason `blocking_store` documents.
    let slot = store.0.clone_handle();
    let app_dir = super::store_data_dir(app)?;
    let store = blocking_store(move || open_cached(&slot, &app_dir)).await?;

    Ok((canonical, store))
}

/// Reclaim this repo's abandoned snapshot pins, once per process.
///
/// The first review command to touch a repo is this process's "app start" for
/// it: the store opens lazily and per repo. Nothing panel-visible changes, so
/// this emits nothing. A sweep failure is not the caller's failure — the
/// command it rode in on has nothing to do with pins — so it is reported to
/// stderr and swallowed.
fn sweep_once(store: &Store, canonical: &Path, repo_path: &str, swept: &crate::state::SweptRepos) {
    if !swept.claim(canonical) {
        return;
    }

    let now = crate::reviewdb::now_secs();
    if let Err(e) = sweep_unanchored_pins(store, canonical, repo_path, now) {
        eprintln!(
            "snapshot pin sweep failed for {}: {}",
            canonical.display(),
            e.message
        );
    }
}

// ── Threads ──────────────────────────────────────────────────────────────────

/// Everything a submitted thread carries. `anchor` is the diff-anchored shape
/// and `commit_oid` the commit-level note; exactly one is set, matching the two
/// comment shapes the app writes today.
#[derive(Debug)]
pub struct SubmitThreadRequest {
    pub text: String,
    pub anchor: Option<crate::git::types::Anchor>,
    pub commit_oid: Option<String>,
    pub cached_excerpt: Option<String>,
    /// True for the diff composer's submit, which owns the draft row. A
    /// commit-level note is independent of the composer and must leave a
    /// half-typed line comment alone.
    pub clears_draft: bool,
}

/// Submit a thread into the repo's active review, creating one when there is
/// none.
///
/// One transaction covers all three writes — create the review, insert the
/// thread, clear the draft — so a submit either lands whole or not at all. A
/// partial commit would strand a review with no thread, which is a review the
/// user can neither publish nor explain.
pub fn submit_thread_inner(
    store: &Store,
    canonical: &Path,
    req: SubmitThreadRequest,
    now: i64,
) -> Result<String, TrunkError> {
    store.write(|tx| {
        let review_id = reviews::ensure_active(tx, canonical, now)?;
        let thread_id = threads::insert(
            tx,
            &review_id,
            threads::NewThread {
                text: req.text,
                anchor: req.anchor,
                commit_oid: req.commit_oid,
                cached_excerpt: req.cached_excerpt,
            },
            now,
        )?;
        if req.clears_draft {
            drafts::delete(tx, canonical)?;
        }

        Ok(thread_id)
    })
}

/// A stored reply plus its markdown body rendered to sanitized HTML, matching
/// `RenderedThread`'s `text_html` treatment.
#[derive(Debug, Serialize, Clone)]
pub struct RenderedReply {
    pub id: String,
    pub text: String,
    pub text_html: String,
    pub channel: crate::review_types::Channel,
    pub created_at: i64,
}

impl RenderedReply {
    fn from_reply(r: replies::Reply) -> Self {
        let text_html = crate::commands::markdown::render_comment_text(&r.text);
        RenderedReply {
            id: r.id,
            text: r.text,
            text_html,
            channel: r.channel,
            created_at: r.created_at,
        }
    }
}

/// A stored thread plus its markdown body rendered to sanitized HTML and its
/// replies. The persisted body stays raw source (the composer round-trips
/// it); `text_html` is derived at list time so the frontend can `{@html}` the
/// body without a per-card render IPC.
#[derive(Debug, Serialize, Clone)]
pub struct RenderedThread {
    pub id: String,
    pub review_id: String,
    pub text: String,
    pub anchor: Option<crate::git::types::Anchor>,
    pub cached_excerpt: Option<String>,
    pub commit_oid: Option<String>,
    pub state: crate::review_types::ThreadState,
    pub stale: bool,
    pub channel: crate::review_types::Channel,
    // The owning review's published bit (criterion 12): once set, the store
    // refuses to delete this thread or its replies, so the frontend needs it
    // to gate the Delete/Delete-reply controls it would otherwise offer.
    pub published: bool,
    // The states a UI gesture may legally move this thread to, in the order
    // the card presents them — `ThreadState::allowed_transitions` for
    // `Channel::Human`, precomputed here so the card never re-derives the
    // matrix. The CLI claims `Channel::Agent` and computes its own set.
    pub allowed_transitions: Vec<crate::review_types::ThreadState>,
    pub text_html: String,
    pub replies: Vec<RenderedReply>,
}

impl RenderedThread {
    fn from_thread(t: threads::Thread, replies: Vec<replies::Reply>, published: bool) -> Self {
        let text_html = crate::commands::markdown::render_comment_text(&t.text);
        RenderedThread {
            id: t.id,
            review_id: t.review_id,
            text: t.text,
            anchor: t.anchor,
            cached_excerpt: t.cached_excerpt,
            commit_oid: t.commit_oid,
            state: t.state,
            stale: t.stale,
            channel: t.channel,
            published,
            allowed_transitions: t
                .state
                .allowed_transitions(crate::review_types::Channel::Human),
            text_html,
            replies: replies.into_iter().map(RenderedReply::from_reply).collect(),
        }
    }
}

/// The threads of the repo's active review, each with its replies. A repo
/// with no active review has no threads to show — an empty list, not an
/// error: there is no "session is active" concept left to report.
pub fn list_threads_inner(
    store: &Store,
    canonical: &Path,
) -> Result<Vec<RenderedThread>, TrunkError> {
    store.read(|conn| {
        let Some(review_id) = reviews::active(conn, canonical)? else {
            return Ok(vec![]);
        };
        // Every thread in this batch belongs to the same active review, so its
        // published bit is read once rather than per-thread.
        let published = reviews::get(conn, &review_id)?
            .map(|r| r.published)
            .unwrap_or(false);

        Ok(threads::list_with_replies(conn, &review_id)?
            .into_iter()
            .map(|(t, replies)| RenderedThread::from_thread(t, replies, published))
            .collect())
    })
}

#[tauri::command]
pub async fn add_thread<R: Runtime>(
    path: String,
    text: String,
    anchor: crate::git::types::Anchor,
    cached_excerpt: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let req = SubmitThreadRequest {
        text,
        anchor: Some(anchor),
        commit_oid: None,
        cached_excerpt: Some(cached_excerpt),
        clears_draft: true,
    };
    let target = canonical.clone();
    let now = crate::reviewdb::now_secs();
    blocking_store(move || submit_thread_inner(&store, &target, req, now)).await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

#[tauri::command]
pub async fn add_commit_thread<R: Runtime>(
    path: String,
    commit_oid: String,
    text: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let req = SubmitThreadRequest {
        text,
        anchor: None,
        commit_oid: Some(commit_oid),
        cached_excerpt: None,
        clears_draft: false,
    };
    let target = canonical.clone();
    let now = crate::reviewdb::now_secs();
    blocking_store(move || submit_thread_inner(&store, &target, req, now)).await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

#[tauri::command]
pub async fn edit_thread<R: Runtime>(
    path: String,
    id: String,
    text: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    blocking_store(move || {
        let now = crate::reviewdb::now_secs();
        store.write(|tx| threads::edit(tx, &target, &id, &text, now))
    })
    .await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

#[tauri::command]
pub async fn delete_thread<R: Runtime>(
    path: String,
    id: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    blocking_store(move || store.write(|tx| threads::delete(tx, &target, &id))).await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

/// Add a human-attributed reply to a thread. A UI write always records
/// `Channel::Human` — the CLI is the only writer that may ever record
/// `Channel::Agent` (spec §2).
pub fn add_reply_inner(
    store: &Store,
    repo_path: &Path,
    thread_id: &str,
    text: &str,
    now: i64,
) -> Result<String, TrunkError> {
    store.write(|tx| {
        replies::add(
            tx,
            repo_path,
            thread_id,
            text,
            crate::review_types::Channel::Human,
            now,
        )
    })
}

#[tauri::command]
pub async fn add_reply<R: Runtime>(
    path: String,
    thread_id: String,
    text: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    blocking_store(move || {
        let now = crate::reviewdb::now_secs();
        add_reply_inner(&store, &target, &thread_id, &text, now)
    })
    .await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

/// No `_inner` seam here, unlike `add_reply_inner`/`set_thread_state_inner`:
/// those hardcode `Channel::Human` (a command-layer rule worth testing on its
/// own), while this command adds no logic beyond the write — `replies::edit`
/// already does the full refusal check and is exercised directly in
/// `test_reviewdb.rs`.
#[tauri::command]
pub async fn edit_reply<R: Runtime>(
    path: String,
    id: String,
    text: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    blocking_store(move || {
        let now = crate::reviewdb::now_secs();
        store.write(|tx| replies::edit(tx, &target, &id, &text, now))
    })
    .await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

/// No `_inner` seam here either, for the same reason as `edit_reply`:
/// `replies::delete` carries the whole refusal check and is tested directly.
#[tauri::command]
pub async fn delete_reply<R: Runtime>(
    path: String,
    id: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    blocking_store(move || store.write(|tx| replies::delete(tx, &target, &id))).await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

/// Move a thread's state from a UI gesture — always `Channel::Human`; the CLI
/// is the only caller that may claim `Channel::Agent` (spec §2).
pub fn set_thread_state_inner(
    store: &Store,
    canonical: &Path,
    id: &str,
    next: crate::review_types::ThreadState,
    now: i64,
) -> Result<(), TrunkError> {
    store.write(|tx| {
        threads::set_state(
            tx,
            canonical,
            id,
            next,
            crate::review_types::Channel::Human,
            now,
        )
    })
}

#[tauri::command]
pub async fn set_thread_state<R: Runtime>(
    path: String,
    id: String,
    next: crate::review_types::ThreadState,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    blocking_store(move || {
        let now = crate::reviewdb::now_secs();
        set_thread_state_inner(&store, &target, &id, next, now)
    })
    .await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

#[tauri::command]
pub async fn list_threads<R: Runtime>(
    path: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    swept: State<'_, crate::state::SweptRepos>,
    app: AppHandle<R>,
) -> Result<Vec<RenderedThread>, String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let swept_repos = swept.inner().clone_handle();
    let target = canonical.clone();
    blocking_store(move || {
        sweep_once(&store, &target, &path, &swept_repos);
        list_threads_inner(&store, &target)
    })
    .await
}

// ── Reviews ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_reviews<R: Runtime>(
    path: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<Vec<Review>, String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    blocking_store(move || store.read(|conn| reviews::list(conn, &canonical))).await
}

#[tauri::command]
pub async fn create_review<R: Runtime>(
    path: String,
    title: Option<String>,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<String, String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    let id = blocking_store(move || {
        let now = crate::reviewdb::now_secs();
        store.write(|tx| {
            let id = reviews::create(tx, &target, title.as_deref(), now)?;
            reviews::set_active(tx, &target, &id)?;
            Ok(id)
        })
    })
    .await?;

    emit_reviews_changed(&app, &canonical);
    Ok(id)
}

#[tauri::command]
pub async fn get_active_review<R: Runtime>(
    path: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<Option<String>, String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    blocking_store(move || store.read(|conn| reviews::active(conn, &canonical))).await
}

#[tauri::command]
pub async fn set_active_review<R: Runtime>(
    path: String,
    review_id: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    blocking_store(move || store.write(|tx| reviews::set_active(tx, &target, &review_id))).await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

#[tauri::command]
pub async fn rename_review<R: Runtime>(
    path: String,
    review_id: String,
    title: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    blocking_store(move || {
        let now = crate::reviewdb::now_secs();
        store.write(|tx| reviews::rename(tx, &target, &review_id, &title, now))
    })
    .await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

/// Ending a review is a publish, never a delete: nothing is removed, the
/// snapshot keepalive refs stay, and the active pointer stays on the published
/// review. Pruning superseded refs is milestone 2's, deliberately paired with
/// the renderer's excerpt-source flip.
#[tauri::command]
pub async fn publish_review<R: Runtime>(
    path: String,
    review_id: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    blocking_store(move || {
        let now = crate::reviewdb::now_secs();
        store.write(|tx| reviews::publish(tx, &target, &review_id, now))
    })
    .await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

#[tauri::command]
pub async fn delete_review<R: Runtime>(
    path: String,
    review_id: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    let repo_path = path.clone();
    blocking_store(move || {
        store.write(|tx| reviews::delete(tx, &target, &review_id))?;
        // Deleting a review is when a batch of pins becomes garbage: the
        // threads that anchored them are gone with it.
        let now = crate::reviewdb::now_secs();
        sweep_unanchored_pins(&store, &target, &repo_path, now)?;
        Ok(())
    })
    .await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

// ── Drafts ───────────────────────────────────────────────────────────────────

/// Write the per-repo draft row. Emits nothing: drafts are not panel-visible and
/// a per-keystroke emit would cause reload storms — today's deliberate silence,
/// kept.
pub fn save_draft_inner(
    store: &Store,
    canonical: &Path,
    text: &str,
    anchor: Option<&crate::git::types::Anchor>,
    now: i64,
) -> Result<(), TrunkError> {
    // Quiet on purpose: a per-keystroke bump would make the poll refetch
    // every thread while the user types (plan §3).
    store.write_quiet(|tx| drafts::save(tx, canonical, text, anchor, now))
}

pub fn get_draft_inner(
    store: &Store,
    canonical: &Path,
) -> Result<Option<drafts::Draft>, TrunkError> {
    store.read(|conn| drafts::get(conn, canonical))
}

#[tauri::command]
pub async fn save_draft<R: Runtime>(
    path: String,
    text: String,
    anchor: Option<crate::git::types::Anchor>,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    blocking_store(move || {
        let now = crate::reviewdb::now_secs();
        save_draft_inner(&store, &canonical, &text, anchor.as_ref(), now)
    })
    .await
}

#[tauri::command]
pub async fn delete_draft<R: Runtime>(
    path: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    blocking_store(move || store.write(|tx| drafts::delete(tx, &canonical))).await
}

#[tauri::command]
pub async fn get_draft<R: Runtime>(
    path: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<Option<drafts::Draft>, String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    blocking_store(move || get_draft_inner(&store, &canonical)).await
}

// ── The active review's commit set ───────────────────────────────────────────

#[tauri::command]
pub async fn seed_review_range<R: Runtime>(
    path: String,
    base_oid: String,
    tip_oid: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    blocking_store(move || {
        let repo = git2::Repository::open(&path).map_err(TrunkError::from)?;
        let base = git2::Oid::from_str(&base_oid).map_err(TrunkError::from)?;
        let tip = git2::Oid::from_str(&tip_oid).map_err(TrunkError::from)?;
        validate_range(&repo, base, tip)?;
        let range_oids = compute_range_oids(&repo, base, tip)?;

        // One transaction: creating the review and seeding it are one gesture, and
        // a failure between them would strand an empty active review the user can
        // neither publish nor explain.
        let now = crate::reviewdb::now_secs();
        // A range walks real history, so subjects are plain summaries — no
        // snapshot can appear in it.
        let members: Vec<commits::ReviewCommit> = range_oids
            .iter()
            .map(|oid| commits::ReviewCommit {
                oid: oid.clone(),
                subject: commit_summary(&repo, oid),
            })
            .collect();
        store.write(|tx| {
            let review_id = reviews::ensure_active(tx, &target, now)?;
            commits::seed(tx, &review_id, &members)
        })
    })
    .await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

#[tauri::command]
pub async fn add_review_commit<R: Runtime>(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    blocking_store(move || {
        let repo = git2::Repository::open(&path).map_err(TrunkError::from)?;
        let now = crate::reviewdb::now_secs();
        store.write(|tx| {
            let review_id = reviews::ensure_active(tx, &target, now)?;
            let subject = member_subject(&repo, &snapshots::get(tx, &target)?, &oid);
            commits::add(tx, &review_id, &oid, &subject)
        })
    })
    .await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

/// The subject a commit-set member is stored under: a current snapshot's
/// synthetic label, a real commit's summary, or '' when neither resolves.
/// Resolved once, at add time — the doc renders from the stored value with no
/// repository open (D13), and a snapshot gc later collects keeps the label it
/// was added under (ruling 2026-08-31).
fn member_subject(repo: &git2::Repository, snaps: &snapshots::RepoSnapshots, oid: &str) -> String {
    use crate::git::workdir_snapshot::SnapshotKind;

    for kind in [SnapshotKind::Workdir, SnapshotKind::Index] {
        if snaps.for_kind(kind) == Some(oid) {
            return kind.label().to_string();
        }
    }

    commit_summary(repo, oid)
}

fn commit_summary(repo: &git2::Repository, oid: &str) -> String {
    git2::Oid::from_str(oid)
        .ok()
        .and_then(|o| repo.find_commit(o).ok())
        .and_then(|c| c.summary().ok().flatten().map(String::from))
        .unwrap_or_default()
}

#[tauri::command]
pub async fn remove_review_commit<R: Runtime>(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    blocking_store(move || {
        store.write(|tx| {
            let Some(review_id) = reviews::active(tx, &target)? else {
                return Ok(());
            };
            commits::remove(tx, &review_id, &oid)
        })
    })
    .await?;

    emit_reviews_changed(&app, &canonical);
    Ok(())
}

/// The active review's commits in graph order. Read-only, no emit.
///
/// Dual path-keying: the commit set is read by CANONICAL key from the store; the
/// graph order comes from `CommitCache` by RAW path.
#[tauri::command]
pub async fn list_session_commits<R: Runtime>(
    path: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    cache: State<'_, CommitCache>,
    app: AppHandle<R>,
) -> Result<Vec<SessionCommit>, String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let graph = {
        let map = cache.0.lock().unwrap();
        map.get(&path)
            .ok_or_else(|| TrunkError::new("not_open", "Repository not open").to_json())?
            .clone()
    };

    blocking_store(move || {
        let (commits, snapshot_oids) = store.read(|conn| {
            let commits = match reviews::active(conn, &canonical)? {
                Some(id) => commits::list(conn, &id)?
                    .into_iter()
                    .map(|c| c.oid)
                    .collect(),
                None => vec![],
            };
            Ok((commits, snapshots::get(conn, &canonical)?.oids()))
        })?;

        let repo = git2::Repository::open(&path).map_err(TrunkError::from)?;
        let mut result = intersect_graph_order(&commits, &graph, &repo);
        for commit in result.iter_mut() {
            commit.is_snapshot = snapshot_oids.contains(&commit.oid);
        }

        Ok(result)
    })
    .await
}

// ── Snapshots ────────────────────────────────────────────────────────────────

/// Get-or-create the repo's snapshot for `kind` and return its OID.
///
/// The stored OID is `decide_snapshot`'s `prior`: on an unchanged tree it is
/// reused, so a submit does not mint a redundant snapshot commit. The snapshot
/// is pinned by a keepalive ref and this function never unpins anything. A
/// superseded pin outlives its snapshot until `sweep_unanchored_pins` reclaims
/// it: a submit resolves its snapshot and lands its thread in two separate
/// calls, so pruning on the supersession that falls between them would unpin
/// the commit an in-flight thread is about to anchor to (TRUNK-61).
pub fn ensure_review_snapshot_inner(
    store: &Store,
    canonical: &Path,
    repo_path: &str,
    kind: crate::git::workdir_snapshot::SnapshotKind,
    now: i64,
) -> Result<String, TrunkError> {
    use crate::git::workdir_snapshot::{decide_snapshot, keep_snapshot_ref};

    let prior = store.read(|conn| {
        Ok(snapshots::get(conn, canonical)?
            .for_kind(kind)
            .map(str::to_owned))
    })?;

    let repo = git2::Repository::open(repo_path).map_err(TrunkError::from)?;
    let prior_oid = match prior {
        Some(s) => Some(git2::Oid::from_str(&s).map_err(TrunkError::from)?),
        None => None,
    };
    let (oid, _) = decide_snapshot(&repo, kind, prior_oid)?;
    keep_snapshot_ref(&repo, oid)?;

    let oid = oid.to_string();
    store.write(|tx| snapshots::set(tx, canonical, kind, &oid, now))?;

    Ok(oid)
}

/// Delete the keepalive refs of snapshots nothing anchors to, and record the
/// ones that must wait for the next sweep.
///
/// Two passes, never one. A submit mints its snapshot and lands its thread in
/// two separate calls, so an unanchored pin may belong to a submit still in
/// flight; deleting on a single observation is the TRUNK-61 race. A pin is
/// reclaimed only when the previous sweep saw it unanchored too, by which time
/// any in-flight submit has landed its thread or died with the process.
///
/// The repo's two current pins are never candidates: they are the snapshots a
/// new comment will anchor to, and they carry no thread until someone comments.
///
/// Store reads and the git deletions do not overlap: every oid is decided
/// before the first ref is touched, so the store's connection lock is never
/// held across git I/O.
pub fn sweep_unanchored_pins(
    store: &Store,
    canonical: &Path,
    repo_path: &str,
    now: i64,
) -> Result<usize, TrunkError> {
    use crate::git::workdir_snapshot::{pinned_snapshot_oids, prune_snapshot_ref};

    let repo = git2::Repository::open(repo_path).map_err(TrunkError::from)?;
    let pinned = pinned_snapshot_oids(&repo)?;

    let (anchored, current, seen_before) = store.read(|conn| {
        Ok((
            threads::anchored_oids(conn, canonical)?,
            snapshots::get(conn, canonical)?.oids(),
            pins::seen_unanchored(conn, canonical)?,
        ))
    })?;

    let unanchored: std::collections::HashSet<String> = pinned
        .into_iter()
        .filter(|oid| !anchored.contains(oid) && !current.contains(oid))
        .collect();

    let reclaimable: Vec<&String> = unanchored
        .iter()
        .filter(|o| seen_before.contains(*o))
        .collect();

    let mut reclaimed = 0;
    for oid in reclaimable {
        let parsed = git2::Oid::from_str(oid).map_err(TrunkError::from)?;
        prune_snapshot_ref(&repo, parsed)?;
        reclaimed += 1;
    }

    store.write(|tx| pins::record_unanchored(tx, canonical, &unanchored, now))?;

    Ok(reclaimed)
}

pub fn read_snapshots_inner(
    store: &Store,
    canonical: &Path,
) -> Result<snapshots::RepoSnapshots, TrunkError> {
    store.read(|conn| snapshots::get(conn, canonical))
}

#[tauri::command]
pub async fn ensure_review_snapshot<R: Runtime>(
    path: String,
    kind: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
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

    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    let target = canonical.clone();
    let oid = blocking_store(move || {
        let now = crate::reviewdb::now_secs();
        ensure_review_snapshot_inner(&store, &target, &path, snapshot_kind, now)
    })
    .await?;

    emit_reviews_changed(&app, &canonical);
    Ok(oid)
}

#[tauri::command]
pub async fn get_review_snapshots<R: Runtime>(
    path: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<snapshots::RepoSnapshots, String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    blocking_store(move || read_snapshots_inner(&store, &canonical)).await
}

// ── Resolution and the review doc ────────────────────────────────────────────

/// A thread as the anchor resolver wants it. The resolver predates threads and
/// takes the comment shape; mapping here keeps it untouched.
fn as_comments(threads: Vec<threads::Thread>) -> Vec<crate::git::types::Comment> {
    threads
        .into_iter()
        .map(|t| crate::git::types::Comment {
            id: t.id,
            text: t.text,
            anchor: t.anchor,
            cached_excerpt: t.cached_excerpt,
            commit_oid: t.commit_oid,
        })
        .collect()
}

/// The renderer's input shape: each thread with its state and its replies,
/// each carrying its channel attribution.
fn as_doc_threads(
    threads_with_replies: Vec<(threads::Thread, Vec<replies::Reply>)>,
) -> Vec<crate::git::review::DocThread> {
    threads_with_replies
        .into_iter()
        .map(|(t, replies)| crate::git::review::DocThread {
            id: t.id,
            text: t.text,
            state: t.state,
            anchor: t.anchor,
            commit_oid: t.commit_oid,
            excerpt: t.cached_excerpt,
            channel: t.channel,
            replies: replies
                .into_iter()
                .map(|r| crate::git::review::DocReply {
                    text: r.text,
                    channel: r.channel,
                })
                .collect(),
        })
        .collect()
}

/// Eagerly resolve every thread's anchor against the live repo: one
/// `CommentResolution` per thread so the panel shows orphan badges at load
/// without a click. Read-only.
#[tauri::command]
pub async fn resolve_threads<R: Runtime>(
    path: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<Vec<CommentResolution>, String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    blocking_store(move || {
        let threads = store.read(|conn| {
            let Some(review_id) = reviews::active(conn, &canonical)? else {
                return Ok(vec![]);
            };
            threads::list_for_review(conn, &review_id)
        })?;

        let repo = git2::Repository::open(&path).map_err(TrunkError::from)?;

        Ok(resolve_all(&as_comments(threads), &repo))
    })
    .await
}

/// Assemble the review doc for one review from store rows.
///
/// The excerpt source still replays diffs live; flipping it to the stored
/// excerpt rows is milestone 2's, paired with the ref pruning that needs it.
///
/// The zero-thread gate lives here, not in the renderer: the pure renderer
/// assumes >= 1 and has no defensive branch.
///
/// Markdown injection in thread text is a DELIBERATE non-mitigation. The
/// recipient is an AI coding agent; escaping a user's fence or heading would
/// hide signal the reviewer intentionally put there. Do not add escaping.
pub fn generate_review_doc_inner(
    store: &Store,
    canonical: &Path,
    repo_path: &str,
    review_id: &str,
) -> Result<String, TrunkError> {
    // The repository contributes two path facts and nothing else — content
    // (subjects, excerpts) is stored, which is what lets the CLI render the
    // same doc with the repo closed (D13).
    let repo = git2::Repository::open(repo_path).map_err(TrunkError::from)?;

    render_review_doc(
        store,
        canonical,
        review_id,
        repo.workdir().map(std::path::Path::to_path_buf),
        repo.path().to_path_buf(),
    )
}

/// Render `review_id`'s doc from stored rows. `workdir` and `repo_dir` are
/// the caller's two path facts: the app takes them from its open repo, the
/// CLI from discovery — neither reads repository content for the doc (D13).
pub fn render_review_doc(
    store: &Store,
    canonical: &Path,
    review_id: &str,
    workdir: Option<PathBuf>,
    repo_dir: PathBuf,
) -> Result<String, TrunkError> {
    use crate::git::review::{DocCommit, RenderInput};

    let input = store.read(|conn| {
        let review = reviews::get(conn, review_id)?.ok_or_else(|| {
            TrunkError::new("not_found", format!("no review with id {review_id}"))
        })?;
        let threads_with_replies = threads::list_with_replies(conn, review_id)?;
        let snapshots = snapshots::get(conn, canonical)?;

        Ok(RenderInput {
            review_id: review.id.clone(),
            title: review.title,
            // The CLI serves published reviews only, so only their docs
            // teach it (criterion 11). `current_exe` at generation time is
            // §5.5's ruling: the doc names the binary that will answer.
            cli_binary: if review.published {
                std::env::current_exe().ok()
            } else {
                None
            },
            workdir: workdir.clone(),
            repo_dir: repo_dir.clone(),
            commits: commits::list(conn, &review.id)?
                .into_iter()
                .map(|c| DocCommit {
                    oid: c.oid,
                    subject: c.subject,
                })
                .collect(),
            threads: as_doc_threads(threads_with_replies),
            working_tree_snapshot: snapshots.working_tree_snapshot,
            index_snapshot: snapshots.index_snapshot,
        })
    })?;

    if input.threads.is_empty() {
        return Err(TrunkError::new(
            "no_threads",
            "Generate requires at least one thread in the review",
        ));
    }

    Ok(crate::git::review::render(&input))
}

#[tauri::command]
pub async fn generate_review_doc<R: Runtime>(
    path: String,
    review_id: String,
    state: State<'_, RepoState>,
    store: State<'_, ReviewStoreState>,
    app: AppHandle<R>,
) -> Result<String, String> {
    let (canonical, store) = prepare(&path, &state, &store, &app).await?;

    blocking_store(move || generate_review_doc_inner(&store, &canonical, &path, &review_id)).await
}

/// The canonical path the backend keys this repo's reviews by. The
/// `reviews-changed` payload is that string, so the frontend filters on it
/// without re-canonicalizing (it cannot call `std::fs::canonicalize`).
#[tauri::command]
pub async fn canonical_repo_path(
    path: String,
    state: State<'_, RepoState>,
) -> Result<String, String> {
    let state_map = state.0.lock().unwrap().clone();
    let canonical = canonical_of(&path, &state_map).map_err(|e| e.to_json())?;

    Ok(canonical.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Canonicalizing here is what makes a repo opened through a symlink reach
    /// the same reviews — every `_inner` test canonicalizes in its own body, so
    /// this seam is the one place the behavior is observable.
    #[test]
    fn a_symlinked_repo_resolves_to_the_same_key() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("repo");
        std::fs::create_dir(&real).unwrap();
        let link = dir.path().join("link-to-repo");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let mut state_map = HashMap::new();
        state_map.insert("real".to_string(), real.clone());
        state_map.insert("link".to_string(), link);

        assert_eq!(
            canonical_of("link", &state_map).unwrap(),
            canonical_of("real", &state_map).unwrap(),
        );
    }

    #[test]
    fn a_path_that_is_not_open_reports_not_open() {
        let err = canonical_of("nowhere", &HashMap::new()).unwrap_err();

        assert_eq!(err.code, "not_open");
    }
}

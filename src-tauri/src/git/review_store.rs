//! Per-repo review-session persistence (Phase 65, Plan 02).
//!
//! This is the one file in the phase with no codebase analog: it owns all
//! session file I/O and the security-relevant recovery behavior.
//!
//! - Writes are atomic via tmp-in-same-dir + `sync_all` + `rename` (D-10).
//! - The on-disk filename is a build-stable FNV-1a hash of the canonical path
//!   (D-11) — also the path-traversal mitigation, since the hash can contain no
//!   `..`, separators, or OS-specific verbatim prefixes.
//! - `load_session` peeks `schema_version` before a full deserialize so it can
//!   refuse a newer-schema file untouched (D-16) and quarantine an unparseable
//!   file to a `.corrupt` sidecar rather than destroying it (D-15).
//!
//! Every function takes `data_dir: &Path` so tests inject a `tempfile::TempDir`
//! instead of resolving the real `app_data_dir` (the testability wedge).

use crate::error::TrunkError;
use crate::git::types::ReviewSession;
use crate::storage::{atomic_write_json, quarantine_corrupt};
use std::fs;
use std::path::{Path, PathBuf};

const CURRENT_SCHEMA_VERSION: u32 = 2;

/// The outcome of attempting to load a session from disk.
pub enum LoadOutcome {
    /// A valid, same-or-older-schema session was read.
    Loaded(ReviewSession),
    /// No session file exists for this repo.
    None,
    /// The file was unparseable and has been quarantined to a `.corrupt`
    /// sidecar; the caller should start a fresh session and warn (D-15).
    RecoveredCorrupt,
    /// The file declares a newer `schema_version` than this build supports and
    /// has been left untouched; the caller must NOT auto-create a fresh
    /// session, so a downgrade cannot wipe newer data (D-16).
    RefusedNewer,
}

fn sessions_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("sessions")
}

/// Build-stable FNV-1a 64-bit hash of the canonical path → filename-safe token.
///
/// PRIVATE by design (encapsulation). NEVER `std::hash::DefaultHasher`: it is
/// not stable across Rust versions, so a toolchain bump would orphan sessions.
/// Hashing the canonical path is also the path-traversal mitigation (D-11).
fn session_filename(canonical: &Path) -> String {
    let s = canonical.to_string_lossy();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325; // FNV-1a 64-bit offset basis
    for b in s.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3); // FNV prime
    }
    format!("{:016x}.json", hash)
}

fn session_path(data_dir: &Path, canonical: &Path) -> PathBuf {
    sessions_dir(data_dir).join(session_filename(canonical))
}

/// Persist a session atomically for the given canonical repo path.
pub fn save_session(
    data_dir: &Path,
    canonical: &Path,
    session: &ReviewSession,
) -> Result<(), TrunkError> {
    let json = serde_json::to_string_pretty(session)
        .map_err(|e| TrunkError::new("serialize", e.to_string()))?;
    atomic_write_json(&session_path(data_dir, canonical), &json)
}

/// Load the session for a canonical repo path, applying the recovery state
/// machine: missing → `None`; newer schema → `RefusedNewer` (file untouched,
/// D-16); unparseable or wrong-shape → quarantine + `RecoveredCorrupt` (D-15).
pub fn load_session(data_dir: &Path, canonical: &Path) -> Result<LoadOutcome, TrunkError> {
    let final_path = session_path(data_dir, canonical);
    let raw = match fs::read_to_string(&final_path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(LoadOutcome::None),
        Err(e) => return Err(TrunkError::new("io", e.to_string())),
    };

    let value = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => v,
        Err(_) => {
            quarantine_corrupt(&final_path)?;
            return Ok(LoadOutcome::RecoveredCorrupt);
        }
    };

    let version = value
        .get("schema_version")
        .and_then(|x| x.as_u64())
        .unwrap_or(0) as u32;
    // D-16: refuse a newer-schema file untouched. This gate MUST stay BEFORE
    // from_value and the migration below, so a future v3 is never mangled.
    if version > CURRENT_SCHEMA_VERSION {
        return Ok(LoadOutcome::RefusedNewer);
    }

    let mut session = match serde_json::from_value::<ReviewSession>(value) {
        Ok(s) => s,
        Err(_) => {
            quarantine_corrupt(&final_path)?;
            return Ok(LoadOutcome::RecoveredCorrupt);
        }
    };

    // v1→v2 migration (shape A): backfill an id on every comment that lacks one
    // (deserialized to "" via #[serde(default)]). Re-save so ids persist —
    // otherwise they re-mint on every reload and break id-targeted edit/delete
    // (Pitfall 3).
    let mut backfilled = false;
    for comment in &mut session.comments {
        if comment.id.is_empty() {
            comment.id = uuid::Uuid::new_v4().to_string();
            backfilled = true;
        }
    }
    session.schema_version = CURRENT_SCHEMA_VERSION;
    if backfilled || version < CURRENT_SCHEMA_VERSION {
        save_session(data_dir, canonical, &session)?;
    }

    Ok(LoadOutcome::Loaded(session))
}

/// Side-effect-free peek for eager hydration on `open_repo`. Returns the session
/// ONLY when the on-disk file is already clean, current-schema, and fully formed —
/// exactly the case `load_session` would return `Loaded` for, but WITHOUT touching
/// disk. Every case `load_session` recovers by mutating disk — quarantining a
/// corrupt/wrong-shape file (D-15), re-saving a v1 migration — yields `None` here
/// instead, leaving the file byte-unchanged for the explicit resume path, which
/// alone surfaces the recovery/refusal toast. This never renames and never writes.
pub fn peek_clean_session(data_dir: &Path, canonical: &Path) -> Option<ReviewSession> {
    let raw = fs::read_to_string(session_path(data_dir, canonical)).ok()?;
    let session = serde_json::from_str::<ReviewSession>(&raw).ok()?;
    // Anything load_session would migrate or refuse is left for the resume path: a
    // non-current schema (newer = refused D-16, older = migration), or a v1 comment
    // still missing its backfilled id (a re-save load_session would perform).
    if session.schema_version != CURRENT_SCHEMA_VERSION {
        return None;
    }
    if session.comments.iter().any(|c| c.id.is_empty()) {
        return None;
    }
    Some(session)
}

/// Hard-delete the per-repo session file (SESS-03 / D-13). NotFound is treated
/// as idempotent success, so end-and-clear is safe to call repeatedly.
pub fn delete_session(data_dir: &Path, canonical: &Path) -> Result<(), TrunkError> {
    match fs::remove_file(session_path(data_dir, canonical)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(TrunkError::new("io", e.to_string())),
    }
}

/// Whether a session file is present for the canonical repo path (drives D-14
/// resume detection).
pub fn session_exists(data_dir: &Path, canonical: &Path) -> bool {
    session_path(data_dir, canonical).is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_canonical_path_same_file() {
        let path = Path::new("/home/user/repos/trunk");
        let other = Path::new("/home/user/repos/other");

        assert_eq!(
            session_filename(path),
            session_filename(path),
            "the same canonical path must map to the same filename (build-stable hash)",
        );
        assert_ne!(
            session_filename(path),
            session_filename(other),
            "different canonical paths must map to different filenames",
        );
    }

    // ── v1→v2 migration / load-recovery state machine ────────────────────────

    /// Write raw bytes to the session path a given canonical repo maps to,
    /// creating the sessions dir first (mirrors atomic_write_json's setup).
    fn seed_session_file(data_dir: &Path, canonical: &Path, raw: &str) {
        let path = session_path(data_dir, canonical);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, raw).unwrap();
    }

    fn corrupt_sidecar_path(data_dir: &Path, canonical: &Path) -> PathBuf {
        session_path(data_dir, canonical).with_extension("json.corrupt")
    }

    #[test]
    fn v1_session_loads_and_backfills_ids_without_corrupting() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = Path::new("/repos/trunk");
        let v1 = r#"{
            "schema_version": 1,
            "commits": ["abc"],
            "comments": [
                { "text": "one", "anchor": null, "cached_excerpt": null },
                { "text": "two", "anchor": null, "cached_excerpt": null }
            ],
            "draft_comment": null
        }"#;
        seed_session_file(dir.path(), canonical, v1);

        let outcome = load_session(dir.path(), canonical).unwrap();

        let session = match outcome {
            LoadOutcome::Loaded(s) => s,
            _ => panic!("v1 file must load, not corrupt/refuse"),
        };
        assert!(
            session.comments.iter().all(|c| !c.id.is_empty()),
            "every comment must have a non-empty backfilled id",
        );
        assert!(
            !corrupt_sidecar_path(dir.path(), canonical).exists(),
            "a valid v1 load must NOT create a .corrupt sidecar (D-15 false positive)",
        );
    }

    #[test]
    fn backfilled_ids_are_stable_across_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = Path::new("/repos/trunk");
        let v1 = r#"{
            "schema_version": 1,
            "commits": [],
            "comments": [
                { "text": "one", "anchor": null, "cached_excerpt": null }
            ],
            "draft_comment": null
        }"#;
        seed_session_file(dir.path(), canonical, v1);

        let first = match load_session(dir.path(), canonical).unwrap() {
            LoadOutcome::Loaded(s) => s,
            _ => panic!("first load must succeed"),
        };
        let second = match load_session(dir.path(), canonical).unwrap() {
            LoadOutcome::Loaded(s) => s,
            _ => panic!("second load must succeed"),
        };

        assert_eq!(
            first.comments[0].id, second.comments[0].id,
            "backfilled ids must persist (re-saved as v2), not re-mint each reload",
        );
        assert_eq!(
            second.schema_version, 2,
            "the on-disk file must have been re-saved as schema_version 2",
        );
    }

    #[test]
    fn v2_session_loads_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = Path::new("/repos/trunk");
        let v2 = r#"{
            "schema_version": 2,
            "commits": [],
            "comments": [
                { "id": "keep-me", "text": "one", "anchor": null, "cached_excerpt": null, "commit_oid": null }
            ],
            "draft_comment": null
        }"#;
        seed_session_file(dir.path(), canonical, v2);

        let session = match load_session(dir.path(), canonical).unwrap() {
            LoadOutcome::Loaded(s) => s,
            _ => panic!("v2 file must load"),
        };
        assert_eq!(session.comments[0].id, "keep-me", "existing ids preserved");
        assert_eq!(session.schema_version, 2);
    }

    #[test]
    fn newer_schema_refused_and_file_left_byte_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = Path::new("/repos/trunk");
        let v3 = r#"{ "schema_version": 3, "commits": [], "comments": [], "draft_comment": null }"#;
        seed_session_file(dir.path(), canonical, v3);
        let before = fs::read(session_path(dir.path(), canonical)).unwrap();

        let outcome = load_session(dir.path(), canonical).unwrap();

        assert!(
            matches!(outcome, LoadOutcome::RefusedNewer),
            "a schema_version > CURRENT must return RefusedNewer (D-16)",
        );
        let after = fs::read(session_path(dir.path(), canonical)).unwrap();
        assert_eq!(
            before, after,
            "the newer file must be left byte-unchanged (D-16)"
        );
        assert!(
            !corrupt_sidecar_path(dir.path(), canonical).exists(),
            "a refused file must NOT be quarantined",
        );
    }

    #[test]
    fn garbage_json_quarantines_to_corrupt_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = Path::new("/repos/trunk");
        seed_session_file(dir.path(), canonical, "{ this is not valid json ]");

        let outcome = load_session(dir.path(), canonical).unwrap();

        assert!(
            matches!(outcome, LoadOutcome::RecoveredCorrupt),
            "malformed JSON must return RecoveredCorrupt (D-15)",
        );
        assert!(
            corrupt_sidecar_path(dir.path(), canonical).exists(),
            "a .corrupt sidecar must be created (D-15)",
        );
    }

    // ── peek_clean_session: side-effect-free hydration peek ───────────────────

    #[test]
    fn peek_returns_a_clean_v2_session() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = Path::new("/repos/trunk");
        let v2 = r#"{
            "schema_version": 2,
            "commits": [],
            "comments": [
                { "id": "keep-me", "text": "one", "anchor": null, "cached_excerpt": null, "commit_oid": null }
            ],
            "draft_comment": null
        }"#;
        seed_session_file(dir.path(), canonical, v2);

        let session = peek_clean_session(dir.path(), canonical)
            .expect("a clean, current-schema session must hydrate");
        assert_eq!(session.comments[0].id, "keep-me");
    }

    #[test]
    fn peek_returns_none_for_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(peek_clean_session(dir.path(), Path::new("/repos/trunk")).is_none());
    }

    #[test]
    fn peek_does_not_quarantine_a_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = Path::new("/repos/trunk");
        seed_session_file(dir.path(), canonical, "{ this is not valid json ]");
        let before = fs::read(session_path(dir.path(), canonical)).unwrap();

        assert!(
            peek_clean_session(dir.path(), canonical).is_none(),
            "a corrupt file must not hydrate",
        );
        assert!(
            !corrupt_sidecar_path(dir.path(), canonical).exists(),
            "peek must NOT quarantine — that side effect belongs to the resume path (D-15)",
        );
        assert_eq!(
            before,
            fs::read(session_path(dir.path(), canonical)).unwrap(),
            "the corrupt file must be left byte-unchanged",
        );
    }

    #[test]
    fn peek_leaves_a_newer_schema_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = Path::new("/repos/trunk");
        let v3 = r#"{ "schema_version": 3, "commits": [], "comments": [], "draft_comment": null }"#;
        seed_session_file(dir.path(), canonical, v3);
        let before = fs::read(session_path(dir.path(), canonical)).unwrap();

        assert!(
            peek_clean_session(dir.path(), canonical).is_none(),
            "a newer-schema file must not hydrate (D-16)",
        );
        assert_eq!(
            before,
            fs::read(session_path(dir.path(), canonical)).unwrap(),
            "the newer file must be left byte-unchanged (D-16)",
        );
    }

    #[test]
    fn peek_does_not_hydrate_or_migrate_a_v1_file() {
        let dir = tempfile::tempdir().unwrap();
        let canonical = Path::new("/repos/trunk");
        let v1 = r#"{
            "schema_version": 1,
            "commits": [],
            "comments": [ { "text": "one", "anchor": null, "cached_excerpt": null } ],
            "draft_comment": null
        }"#;
        seed_session_file(dir.path(), canonical, v1);
        let before = fs::read(session_path(dir.path(), canonical)).unwrap();

        assert!(
            peek_clean_session(dir.path(), canonical).is_none(),
            "a migration-pending v1 file is left for the resume path, not hydrated",
        );
        assert_eq!(
            before,
            fs::read(session_path(dir.path(), canonical)).unwrap(),
            "peek must not re-save (migrate) the v1 file",
        );
    }
}

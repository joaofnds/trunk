//! Capture the current working tree as a REAL but DANGLING commit so it can be reviewed
//! exactly like a hand-picked commit.
//!
//! The snapshot commit's own tree is the working tree (staged + unstaged +
//! untracked-not-ignored); its parent is HEAD. The existing review pipeline then
//! resolves `Side::Old` against the parent tree (= HEAD) and `Side::New` against the
//! snapshot tree (= working tree) — precisely "before vs after" for uncommitted work,
//! with no new Source/Side variant.

use crate::error::TrunkError;

/// Build the current working-tree TREE (staged + unstaged + untracked-not-ignored)
/// and write it to the ODB, returning its Oid — WITHOUT creating a commit and
/// WITHOUT persisting the on-disk `.git/index`.
///
/// No-clobber rationale: the working tree is captured through a THROWAWAY index
/// built with `git2::Index::new()` + `repo.set_index(..)`. `set_index` only
/// associates the in-memory index with the repo so `add_all` can resolve the
/// workdir; `write_tree_to` only writes tree objects to the ODB. Neither calls
/// `index.write()` — the ONLY call that persists `.git/index` to disk. We never
/// call `index.write()`, so the user's real index is byte-for-byte untouched.
///
/// Deterministic by construction: two calls on an unchanged workdir produce the
/// same tree content → the same Oid. This is what lets `decide_snapshot` reuse a
/// prior snapshot whose commit tree equals the current workdir tree.
///
/// # Errors
///
/// Returns the git error when the in-memory index will not build or the tree
/// will not write to the object database.
pub fn workdir_tree_oid(repo: &git2::Repository) -> Result<git2::Oid, TrunkError> {
    // 1. Associate an EMPTY in-memory index with the repo. Starting from empty +
    //    add_all("*") captures the full current workdir (staged + unstaged +
    //    untracked-not-ignored) in one shot, independent of what is staged.
    let mut idx = git2::Index::new()?;
    repo.set_index(&mut idx)?;

    // 2. Re-fetch the now-associated index and add the whole workdir.
    //    IndexAddOption::DEFAULT respects .gitignore: it includes
    //    untracked-but-not-ignored files and excludes ignored ones (identical to
    //    the shipped call in `commands::staging::stage_all_inner`). NEVER call idx.write().
    let mut idx = repo.index()?;
    idx.add_all(std::iter::once(&"*"), git2::IndexAddOption::DEFAULT, None)?;

    // 3. Write the tree objects to the ODB (does NOT persist the on-disk index).
    Ok(idx.write_tree_to(repo)?)
}

/// Build the STAGED (index) tree and write it to the ODB, returning its Oid.
///
/// Unlike `workdir_tree_oid` this captures ONLY what's staged (HEAD→index): a
/// staged-diff comment's New side is the *index*, so it must anchor against the
/// index tree (not the working tree — for a partially-staged file those line
/// numbers diverge). `repo.index().write_tree()` writes a tree object from the
/// current on-disk index WITHOUT modifying the index file.
///
/// # Errors
///
/// Returns the git error when the index will not read or the tree will not
/// write to the object database.
pub fn index_tree_oid(repo: &git2::Repository) -> Result<git2::Oid, TrunkError> {
    Ok(repo.index()?.write_tree()?)
}

/// Which tree a review snapshot captures. `Workdir` = HEAD→working tree (the
/// unstaged diff's New side); `Index` = HEAD→index (the staged diff's New side).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SnapshotKind {
    Workdir,
    Index,
}

impl SnapshotKind {
    fn tree_oid(self, repo: &git2::Repository) -> Result<git2::Oid, TrunkError> {
        match self {
            Self::Workdir => workdir_tree_oid(repo),
            Self::Index => index_tree_oid(repo),
        }
    }

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Workdir => "Uncommitted changes",
            Self::Index => "Staged changes",
        }
    }
}

/// Get-or-create a review snapshot for a session.
///
/// The reuse-vs-create decision in a pure, unit-testable surface — mirrors the
/// `validate_range` / `compute_range_oids` pattern: takes `&Repository`, no
/// Tauri state.
///
/// Returns `(oid, created)`:
/// - When `prior` is `Some` and its COMMIT TREE equals the current tree for `kind`,
///   nothing changed → reuse, `(prior, false)`. The comparison is tree-vs-tree:
///   `kind.tree_oid(repo)` against `repo.find_commit(prior)?.tree_id()`. `prior` is
///   a COMMIT oid, never compared against the tree oid directly.
/// - Otherwise (changed tree, or `prior` is `None`) create a fresh snapshot commit
///   → `(new_oid, true)`.
///
/// # Errors
///
/// Returns the git error when the current tree will not build, `prior` names no
/// commit, or a fresh snapshot will not write.
pub fn decide_snapshot(
    repo: &git2::Repository,
    kind: SnapshotKind,
    prior: Option<git2::Oid>,
) -> Result<(git2::Oid, bool), TrunkError> {
    let current_tree = kind.tree_oid(repo)?;
    if let Some(prior_oid) = prior {
        let prior_tree = repo.find_commit(prior_oid)?.tree_id();
        if prior_tree == current_tree {
            return Ok((prior_oid, false));
        }
    }
    let new_oid = snapshot(repo, kind)?;
    Ok((new_oid, true))
}

/// Snapshot the tree for `kind` into a dangling commit (parent = HEAD) and return
/// its Oid. Builds the tree via the kind's tree fn (neither persists the real
/// `.git/index`) then commits it parent = HEAD.
///
/// # Errors
///
/// Returns the git error when the tree will not build, HEAD will not read, or
/// the commit will not write.
pub fn snapshot(repo: &git2::Repository, kind: SnapshotKind) -> Result<git2::Oid, TrunkError> {
    // 1–3. Build the target tree (no idx.write(), real index untouched).
    let tree = repo.find_tree(kind.tree_oid(repo)?)?;

    // 4. Resolve the parent: HEAD's commit, or none when HEAD is unborn (a fresh
    //    repo with zero commits still snapshots fine — a parent-less commit).
    let head_commit = if is_head_unborn(repo) {
        None
    } else {
        Some(repo.head()?.peel_to_commit()?)
    };
    let parents: Vec<&git2::Commit> = head_commit.iter().collect();

    // 5. Descriptive message only — the snapshot is tracked by OID in the session
    //    field, never by parsing this string. The signature time is fixed, not the
    //    clock: the pin design (reviewdb::pins) relies on a reverted tree handing
    //    out the same oid again, so the oid must be a function of tree, parent,
    //    and kind alone. A wall-clock signature broke that at every second
    //    boundary.
    let sig = git2::Signature::new("Trunk", "review@trunk.local", &git2::Time::new(0, 0))?;
    let msg = kind.label();

    // 6. `None` target ref => the commit is created dangling. The session command
    //    (ensure_review_snapshot) then pins it via keep_snapshot_ref so gc can't
    //    prune a snapshot that still has comments anchored to it (260531-l02 C3).
    let oid = repo.commit(None, &sig, &sig, msg, &tree, &parents)?;
    Ok(oid)
}

/// Workdir convenience wrapper (the original entry point; kept for existing
/// callers and tests).
///
/// # Errors
///
/// Returns whatever `snapshot` returns for `SnapshotKind::Workdir`.
pub fn snapshot_working_tree(repo: &git2::Repository) -> Result<git2::Oid, TrunkError> {
    snapshot(repo, SnapshotKind::Workdir)
}

/// HEAD is unborn when the repo has no commits yet (freshly init'd). Mirrors the
/// probe at commands/diff.rs:25.
fn is_head_unborn(repo: &git2::Repository) -> bool {
    match repo.head() {
        Err(e) => e.code() == git2::ErrorCode::UnbornBranch,
        Ok(_) => false,
    }
}

/// Ref namespace that pins working-tree review snapshots so `git gc` can't prune them.
/// Deliberately NOT under refs/heads|remotes|tags, so these keepalive refs stay out of
/// the branch/commit graph.
pub const SNAPSHOT_REF_PREFIX: &str = "refs/trunk/review-snapshots/";

/// Pin a snapshot commit with a keepalive ref (260531-l02 C3).
///
/// Without it the snapshot is a dangling commit that gc prunes, silently orphaning
/// every comment anchored to it. Named by the oid so re-pinning a reused snapshot is
/// idempotent; `force = true` tolerates an already-present ref.
///
/// # Errors
///
/// Returns the git error when the ref will not write.
pub fn keep_snapshot_ref(repo: &git2::Repository, oid: git2::Oid) -> Result<(), TrunkError> {
    let name = format!("{SNAPSHOT_REF_PREFIX}{oid}");
    repo.reference(&name, oid, true, "trunk working-tree review snapshot")?;
    Ok(())
}

/// Every snapshot oid this repo currently pins.
///
/// Read from each ref's target, not parsed out of its name. The two agree by
/// `keep_snapshot_ref`'s construction, but nothing enforces that, and a name
/// that is not a valid oid would otherwise have to be parsed and could fail.
///
/// # Errors
///
/// Returns the git error when the refs will not enumerate.
pub fn pinned_snapshot_oids(repo: &git2::Repository) -> Result<Vec<git2::Oid>, TrunkError> {
    let refs = repo.references_glob(&format!("{SNAPSHOT_REF_PREFIX}*"))?;

    let mut oids = Vec::new();
    for reference in refs {
        if let Some(target) = reference?.target() {
            oids.push(target);
        }
    }

    Ok(oids)
}

/// Drop the keepalive ref for one specific superseded snapshot oid (D8).
///
/// Named pruning, not glob-based: `refs/trunk/review-snapshots/` holds the
/// two CURRENT pins, one per kind, plus superseded pins threads still anchor
/// to, so deleting only the ref this call names is what leaves every other
/// pin untouched. The caller decides whether a superseded pin may go — this
/// function must never be reached for a snapshot a thread still anchors to
/// (`keep_snapshot_ref`'s contract; the gate lives at the call site, which
/// holds the review store). A missing ref is not an error — pruning is
/// idempotent, same as `keep_snapshot_ref`.
///
/// # Errors
///
/// Returns the git error when the ref exists but will not delete. A missing ref
/// is not an error.
pub fn prune_snapshot_ref(repo: &git2::Repository, oid: git2::Oid) -> Result<(), TrunkError> {
    let name = format!("{SNAPSHOT_REF_PREFIX}{oid}");
    if let Ok(mut reference) = repo.find_reference(&name) {
        reference.delete()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn sig() -> git2::Signature<'static> {
        git2::Signature::new("Test", "test@example.com", &git2::Time::new(0, 0)).unwrap()
    }

    /// Init a repo and write one committed file on HEAD so the snapshot has a
    /// real parent. Returns the `TempDir` (keep alive) and the open repo.
    fn repo_with_initial_commit() -> (TempDir, git2::Repository) {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        fs::write(dir.path().join("committed.txt"), b"original\n").unwrap();
        {
            let mut index = repo.index().unwrap();
            index
                .add_path(std::path::Path::new("committed.txt"))
                .unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let s = sig();
            repo.commit(Some("HEAD"), &s, &s, "initial", &tree, &[])
                .unwrap();
        }
        (dir, repo)
    }

    fn tree_contains(repo: &git2::Repository, oid: git2::Oid, path: &str) -> bool {
        let commit = repo.find_commit(oid).unwrap();
        let tree = commit.tree().unwrap();
        tree.get_path(std::path::Path::new(path)).is_ok()
    }

    // Test A: an untracked-but-not-ignored workdir file IS present in the snapshot.
    #[test]
    fn untracked_file_is_included_in_snapshot() {
        let (dir, repo) = repo_with_initial_commit();
        fs::write(dir.path().join("new.txt"), b"uncommitted\n").unwrap();

        let oid = snapshot_working_tree(&repo).unwrap();

        assert!(
            tree_contains(&repo, oid, "new.txt"),
            "untracked-not-ignored file must appear in the snapshot tree"
        );
    }

    // C3: keep_snapshot_ref pins the snapshot under refs/trunk/review-snapshots/ so gc
    // can't prune it; it is idempotent; prune_snapshot_ref removes one specific pin.
    #[test]
    fn keepalive_ref_pins_the_snapshot_commit() {
        let (dir, repo) = repo_with_initial_commit();
        fs::write(dir.path().join("new.txt"), b"uncommitted\n").unwrap();
        let oid = snapshot_working_tree(&repo).unwrap();

        keep_snapshot_ref(&repo, oid).unwrap();

        let name = format!("{SNAPSHOT_REF_PREFIX}{oid}");
        assert_eq!(
            repo.find_reference(&name).unwrap().target().unwrap(),
            oid,
            "keepalive ref must point at the snapshot commit"
        );
    }

    #[test]
    fn re_pinning_a_reused_snapshot_is_idempotent() {
        let (dir, repo) = repo_with_initial_commit();
        fs::write(dir.path().join("new.txt"), b"uncommitted\n").unwrap();
        let oid = snapshot_working_tree(&repo).unwrap();
        keep_snapshot_ref(&repo, oid).unwrap();

        keep_snapshot_ref(&repo, oid).unwrap();
    }

    #[test]
    fn pruning_removes_the_keepalive_ref() {
        let (dir, repo) = repo_with_initial_commit();
        fs::write(dir.path().join("new.txt"), b"uncommitted\n").unwrap();
        let oid = snapshot_working_tree(&repo).unwrap();
        keep_snapshot_ref(&repo, oid).unwrap();
        let name = format!("{SNAPSHOT_REF_PREFIX}{oid}");

        prune_snapshot_ref(&repo, oid).unwrap();

        assert!(
            repo.find_reference(&name).is_err(),
            "prune_snapshot_ref must remove the keepalive ref"
        );
    }

    #[test]
    fn pruning_an_unpinned_oid_is_idempotent() {
        let (dir, repo) = repo_with_initial_commit();
        fs::write(dir.path().join("new.txt"), b"uncommitted\n").unwrap();
        let oid = snapshot_working_tree(&repo).unwrap();

        prune_snapshot_ref(&repo, oid).unwrap();
    }

    // Test B: a file matching a .gitignore pattern is NOT present in the snapshot.
    #[test]
    fn ignored_file_is_excluded_from_snapshot() {
        let (dir, repo) = repo_with_initial_commit();
        fs::write(dir.path().join(".gitignore"), b"secret.txt\n").unwrap();
        fs::write(dir.path().join("secret.txt"), b"do not capture\n").unwrap();

        let oid = snapshot_working_tree(&repo).unwrap();

        assert!(
            !tree_contains(&repo, oid, "secret.txt"),
            "a .gitignore-matched file must NOT appear in the snapshot tree"
        );
        assert!(
            tree_contains(&repo, oid, ".gitignore"),
            "the .gitignore itself (not ignored) should still be captured"
        );
    }

    // Test C: the user's real .git/index is byte-for-byte unchanged by the call.
    #[test]
    fn real_index_is_untouched() {
        let (dir, repo) = repo_with_initial_commit();
        // The initial commit wrote a real .git/index. Capture its bytes.
        let index_path = dir.path().join(".git").join("index");
        let before = fs::read(&index_path).expect("repo with a commit has a .git/index");

        // Stage nothing extra; just snapshot a dirty workdir.
        fs::write(dir.path().join("new.txt"), b"uncommitted\n").unwrap();
        snapshot_working_tree(&repo).unwrap();

        let after = fs::read(&index_path).expect(".git/index must still exist");
        assert_eq!(
            before, after,
            "snapshot must NOT persist anything to the real .git/index"
        );
    }

    // workdir_tree_oid: two calls on an UNCHANGED workdir return the SAME oid,
    // and it equals the tree of a snapshot_working_tree commit (deterministic).
    #[test]
    fn workdir_tree_oid_is_stable_and_matches_snapshot_tree() {
        let (dir, repo) = repo_with_initial_commit();
        fs::write(dir.path().join("new.txt"), b"uncommitted\n").unwrap();

        let first = workdir_tree_oid(&repo).unwrap();
        let second = workdir_tree_oid(&repo).unwrap();
        assert_eq!(
            first, second,
            "two calls on an unchanged workdir must return the same tree oid"
        );

        let snap = snapshot_working_tree(&repo).unwrap();
        let snap_tree = repo.find_commit(snap).unwrap().tree_id();
        assert_eq!(
            first, snap_tree,
            "workdir_tree_oid must equal the snapshot commit's tree id"
        );
    }

    // decide_snapshot REUSE: prior is the existing snapshot and the workdir is
    // unchanged → returns (prior, false). Asserts BOTH the not-created flag and
    // that the returned oid IS the prior commit oid (catches a tree-vs-commit mixup).
    #[test]
    fn decide_snapshot_reuses_unchanged_workdir() {
        let (dir, repo) = repo_with_initial_commit();
        fs::write(dir.path().join("new.txt"), b"uncommitted\n").unwrap();

        let prior = snapshot_working_tree(&repo).unwrap();
        let (oid, created) = decide_snapshot(&repo, SnapshotKind::Workdir, Some(prior)).unwrap();

        assert!(
            !created,
            "an unchanged workdir must NOT create a new snapshot"
        );
        assert_eq!(
            oid, prior,
            "reuse must return the prior commit oid unchanged"
        );
    }

    // decide_snapshot CREATE: the workdir changed after the prior snapshot →
    // returns (new_oid, true) with new_oid != prior.
    #[test]
    fn decide_snapshot_creates_on_changed_workdir() {
        let (dir, repo) = repo_with_initial_commit();
        fs::write(dir.path().join("new.txt"), b"uncommitted\n").unwrap();
        let prior = snapshot_working_tree(&repo).unwrap();

        fs::write(dir.path().join("new.txt"), b"changed contents\n").unwrap();
        let (oid, created) = decide_snapshot(&repo, SnapshotKind::Workdir, Some(prior)).unwrap();

        assert!(created, "a changed workdir must create a new snapshot");
        assert_ne!(
            oid, prior,
            "the new snapshot oid must differ from the prior"
        );
    }

    // decide_snapshot FIRST snapshot: prior is None → always creates.
    #[test]
    fn decide_snapshot_creates_first_snapshot() {
        let (dir, repo) = repo_with_initial_commit();
        fs::write(dir.path().join("new.txt"), b"uncommitted\n").unwrap();

        let (oid, created) = decide_snapshot(&repo, SnapshotKind::Workdir, None).unwrap();

        assert!(created, "first snapshot (prior=None) must create");
        assert!(
            tree_contains(&repo, oid, "new.txt"),
            "the first snapshot must reflect the workdir"
        );
    }

    // Test D: a freshly init'd repo with zero commits (unborn HEAD) snapshots
    // without error and yields a parent-less commit reflecting the workdir.
    #[test]
    fn unborn_head_snapshots_without_parent() {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        fs::write(dir.path().join("first.txt"), b"hello\n").unwrap();

        let oid = snapshot_working_tree(&repo).unwrap();

        let commit = repo.find_commit(oid).unwrap();
        assert_eq!(
            commit.parent_count(),
            0,
            "unborn-HEAD snapshot must have no parent"
        );
        assert!(
            tree_contains(&repo, oid, "first.txt"),
            "the snapshot tree must reflect the workdir even with no commits yet"
        );
    }

    // Read a file's blob bytes out of a snapshot commit's tree.
    fn blob_at(repo: &git2::Repository, commit_oid: git2::Oid, path: &str) -> Vec<u8> {
        let tree = repo.find_commit(commit_oid).unwrap().tree().unwrap();
        let entry = tree.get_path(std::path::Path::new(path)).unwrap();
        repo.find_blob(entry.id()).unwrap().content().to_vec()
    }

    // 260531-l02b: the INDEX snapshot captures staged content, NOT the working tree.
    // For a partially-staged file the two diverge — this is exactly why staged comments
    // anchor to the index snapshot, not the workdir one. Capture the index snapshot
    // FIRST: workdir_tree_oid swaps a throwaway index into the repo handle, after which
    // repo.index() would no longer reflect the on-disk staged index.
    #[test]
    fn index_snapshot_captures_staged_not_workdir() {
        let (dir, repo) = repo_with_initial_commit(); // committed.txt = "original\n"
        fs::write(dir.path().join("committed.txt"), b"staged\n").unwrap();
        {
            let mut idx = repo.index().unwrap();
            idx.add_path(std::path::Path::new("committed.txt")).unwrap();
            idx.write().unwrap();
        }
        // A further, UNSTAGED edit on top — so index ("staged") ≠ workdir ("workdir").
        fs::write(dir.path().join("committed.txt"), b"workdir\n").unwrap();

        let index_snap = snapshot(&repo, SnapshotKind::Index).unwrap();
        assert_eq!(
            blob_at(&repo, index_snap, "committed.txt"),
            b"staged\n",
            "index snapshot must capture the STAGED content"
        );

        let workdir_snap = snapshot(&repo, SnapshotKind::Workdir).unwrap();
        assert_eq!(
            blob_at(&repo, workdir_snap, "committed.txt"),
            b"workdir\n",
            "workdir snapshot must capture the WORKING-TREE content"
        );

        assert_ne!(
            repo.find_commit(index_snap).unwrap().tree_id(),
            repo.find_commit(workdir_snap).unwrap().tree_id(),
            "index and workdir snapshots must be distinct trees when partially staged"
        );
    }

    // 260531-l02b: decide_snapshot(Index) reuses when the index is unchanged.
    #[test]
    fn decide_snapshot_index_reuses_when_index_unchanged() {
        let (dir, repo) = repo_with_initial_commit();
        fs::write(dir.path().join("committed.txt"), b"staged\n").unwrap();
        {
            let mut idx = repo.index().unwrap();
            idx.add_path(std::path::Path::new("committed.txt")).unwrap();
            idx.write().unwrap();
        }
        let prior = snapshot(&repo, SnapshotKind::Index).unwrap();

        let (oid, created) = decide_snapshot(&repo, SnapshotKind::Index, Some(prior)).unwrap();
        assert_eq!(oid, prior, "unchanged index must reuse the prior snapshot");
        assert!(!created, "reuse must not create a new commit");
    }
}

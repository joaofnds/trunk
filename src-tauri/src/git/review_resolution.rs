//! Comment resolvability (Phase 69, Plan 03): eager orphan classification.
//!
//! The panel needs orphan badges at load time (D-06), so every comment is
//! resolved up-front against the live object DB — a frontend "is the oid in
//! session.commits" check can't catch a deleted/renamed file or an
//! out-of-bounds range. The classifier mirrors `intersect_graph_order`: pure,
//! one entry per input, never drops, never panics (D-08, threat T-69-10).

use crate::git::types::Comment;
use serde::Serialize;
use std::path::Path;

/// Why a comment no longer resolves against the repo (D-08). PascalCase strings,
/// NO `rename_all`, mirroring `Source`/`Side` (`types.rs:295-305`); the TS
/// `OrphanReason` union (`types.ts:311`) mirrors these variant names string-for-string.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub enum OrphanReason {
    /// The anchor/comment's commit is unknown to the repo (or its oid is unparseable).
    CommitGone,
    /// The file does not exist in the commit's tree on the anchor's side
    /// (includes a `Side::Old` anchor on a root commit, which has no parent tree).
    FileGone,
    /// The anchor's line range falls outside the blob's line count.
    LineOutOfRange,
}

/// Per-comment resolvability (D-08). Serialize, snake_case fields; `reason` is
/// `None` (JSON `null`) when resolvable. Mirrors the TS `CommentResolution`
/// interface (`types.ts:315-319`) — do NOT `skip_serializing_if` `reason`, the TS
/// side expects the field present-and-null.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct CommentResolution {
    pub id: String,
    pub resolvable: bool,
    pub reason: Option<OrphanReason>,
}

/// Classify the line range of a line-anchored comment against the repo. Returns
/// `Ok(())` when resolvable, `Err(reason)` for the orphan kind. Pure helper so
/// `resolve_all` reads as a flat per-comment match; never panics.
pub(crate) fn classify_anchor(
    anchor: &crate::git::types::Anchor,
    repo: &git2::Repository,
) -> Result<(), OrphanReason> {
    use crate::git::types::Side;

    // The anchor carries its OWN commit_oid (the commit the line numbers index
    // into), distinct from a commit-level comment's top-level commit_oid.
    let oid = git2::Oid::from_str(&anchor.commit_oid).map_err(|_| OrphanReason::CommitGone)?;
    let commit = repo
        .find_commit(oid)
        .map_err(|_| OrphanReason::CommitGone)?;

    // Side semantics (RESEARCH Pitfall 4): New reads the commit's own tree; Old
    // reads the parent's tree, and a root commit (no parent) is FileGone on Old.
    let tree = match anchor.side {
        Side::New => commit.tree().map_err(|_| OrphanReason::FileGone)?,
        Side::Old => commit
            .parent(0)
            .map_err(|_| OrphanReason::FileGone)?
            .tree()
            .map_err(|_| OrphanReason::FileGone)?,
    };

    let entry = tree
        .get_path(Path::new(&anchor.file_path))
        .map_err(|_| OrphanReason::FileGone)?;
    let blob = repo
        .find_blob(entry.id())
        .map_err(|_| OrphanReason::FileGone)?;

    // 1-based inclusive bounds matching Phase 67/68 capture (RESEARCH A2). `str::lines()`
    // does NOT count a trailing newline as a final empty line, so a comment on the
    // exact last line (end_line == line_count) is in-range.
    let line_count = String::from_utf8_lossy(blob.content()).lines().count() as u32;
    // The Anchor struct has no validating constructor (just Deserialize), so a
    // corrupted session file or a future capture bug could produce an inverted
    // range (start_line > end_line). The classifier is the chokepoint every
    // comment funnels through, so enforce the invariant here.
    if anchor.start_line >= 1
        && anchor.end_line >= anchor.start_line
        && anchor.end_line <= line_count
    {
        Ok(())
    } else {
        Err(OrphanReason::LineOutOfRange)
    }
}

/// Resolve every comment against the repo, returning exactly one
/// `CommentResolution` per input (count in == count out) — never dropping or
/// panicking (D-06/D-08). Commit-level comments (`anchor: None`) only need the
/// commit to exist; line-anchored comments run the full side-aware bound check.
pub fn resolve_all(comments: &[Comment], repo: &git2::Repository) -> Vec<CommentResolution> {
    comments
        .iter()
        .map(|c| {
            let reason = match (&c.anchor, &c.commit_oid) {
                // Line-anchored: classify against the anchor's own commit/side/range.
                (Some(anchor), _) => classify_anchor(anchor, repo).err(),
                // Commit-level: resolvable iff the commit exists.
                (None, Some(commit_oid)) => {
                    match git2::Oid::from_str(commit_oid)
                        .ok()
                        .and_then(|oid| repo.find_commit(oid).ok())
                    {
                        Some(_) => None,
                        None => Some(OrphanReason::CommitGone),
                    }
                }
                // Neither anchor nor commit target (defensive; v1 backfill should
                // prevent it): no resolvable target → CommitGone, never a panic.
                (None, None) => Some(OrphanReason::CommitGone),
            };
            CommentResolution {
                id: c.id.clone(),
                resolvable: reason.is_none(),
                reason,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::types::{Anchor, Side, Source};
    use git2::{Oid, Repository, Signature};
    use tempfile::TempDir;

    /// Deterministic signature so commits are reproducible (F.I.R.S.T.: no clock).
    fn sig() -> Signature<'static> {
        Signature::new("Test", "test@example.com", &git2::Time::new(0, 0)).unwrap()
    }

    /// Commit a single empty-tree commit with the given parents, returning its OID.
    fn commit(repo: &Repository, message: &str, parents: &[Oid]) -> Oid {
        let tree_oid = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let parent_commits: Vec<_> = parents
            .iter()
            .map(|oid| repo.find_commit(*oid).unwrap())
            .collect();
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
        let s = sig();
        repo.commit(None, &s, &s, message, &tree, &parent_refs)
            .unwrap()
    }

    // ── Phase 69 Plan 03: resolve_all classifier (eager orphan detection) ─────
    // Real git2 commits/trees/blobs via make_file_repo (classical TDD, no mocks).
    // make_repo's empty-tree commits can't exercise FileGone/LineOutOfRange, so a
    // sibling helper commits a known-line-count file; make_repo stays untouched.

    /// A repo with two commits: A (root, no files) → B (adds `foo.rs`, a blob with
    /// exactly three lines and a trailing newline). `str::lines()` counts 3. Note
    /// the path is a top-level entry: a `git2::TreeBuilder` inserts ONE level only
    /// (a `/` in the name is rejected), which is sufficient for the bound check.
    struct FileRepo {
        _dir: TempDir,
        repo: Repository,
        root: Oid,      // A: empty tree, no files
        with_file: Oid, // B: foo.rs present (3 lines)
    }

    fn commit_with_file(
        repo: &Repository,
        message: &str,
        parents: &[Oid],
        path: &str,
        content: &str,
    ) -> Oid {
        let blob_oid = repo.blob(content.as_bytes()).unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        builder
            .insert(path, blob_oid, git2::FileMode::Blob.into())
            .unwrap();
        let tree = repo.find_tree(builder.write().unwrap()).unwrap();
        let parent_commits: Vec<_> = parents
            .iter()
            .map(|oid| repo.find_commit(*oid).unwrap())
            .collect();
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
        let s = sig();
        repo.commit(None, &s, &s, message, &tree, &parent_refs)
            .unwrap()
    }

    fn make_file_repo() -> FileRepo {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let root = commit(&repo, "A (root, no files)", &[]);
        let with_file = commit_with_file(
            &repo,
            "B (adds foo.rs)",
            &[root],
            "foo.rs",
            "line one\nline two\nline three\n",
        );
        FileRepo {
            _dir: dir,
            repo,
            root,
            with_file,
        }
    }

    /// A line-anchored comment targeting `file_path` on `side` of `commit_oid`,
    /// lines [start, end]. The top-level `commit_oid` is None (line-anchored).
    fn line_comment(
        id: &str,
        commit_oid: &str,
        file_path: &str,
        side: Side,
        start_line: u32,
        end_line: u32,
    ) -> Comment {
        Comment {
            id: id.to_string(),
            text: "c".to_string(),
            anchor: Some(Anchor {
                commit_oid: commit_oid.to_string(),
                file_path: file_path.to_string(),
                source: Source::Diff,
                side,
                start_line,
                end_line,
            }),
            cached_excerpt: Some("excerpt".to_string()),
            commit_oid: None,
        }
    }

    /// A commit-level comment (anchor None, commit_oid Some).
    fn commit_comment(id: &str, commit_oid: &str) -> Comment {
        Comment {
            id: id.to_string(),
            text: "note".to_string(),
            anchor: None,
            cached_excerpt: None,
            commit_oid: Some(commit_oid.to_string()),
        }
    }

    fn find(resolutions: &[CommentResolution], id: &str) -> CommentResolution {
        resolutions
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .unwrap_or_else(|| panic!("no resolution for id {id}"))
    }

    #[test]
    fn resolve_all_returns_one_resolution_per_comment() {
        let t = make_file_repo();
        let b = t.with_file.to_string();
        let comments = vec![
            line_comment("ok", &b, "foo.rs", Side::New, 1, 3),
            line_comment(
                "commit-gone",
                "0".repeat(40).as_str(),
                "foo.rs",
                Side::New,
                1,
                1,
            ),
            line_comment("file-gone", &b, "missing.rs", Side::New, 1, 1),
            line_comment("line-oob", &b, "foo.rs", Side::New, 1, 99),
            commit_comment("commit-level", &b),
        ];

        let out = resolve_all(&comments, &t.repo);

        assert_eq!(
            out.len(),
            comments.len(),
            "resolve_all returns exactly one resolution per input comment"
        );
    }

    #[test]
    fn resolve_all_classifies_resolvable_line_anchor() {
        let t = make_file_repo();
        let b = t.with_file.to_string();
        let comments = vec![line_comment("ok", &b, "foo.rs", Side::New, 1, 3)];

        let out = resolve_all(&comments, &t.repo);

        assert_eq!(
            find(&out, "ok"),
            CommentResolution {
                id: "ok".to_string(),
                resolvable: true,
                reason: None,
            }
        );
    }

    #[test]
    fn resolve_all_classifies_unknown_commit_as_commit_gone() {
        let t = make_file_repo();
        let gone = "0".repeat(40);
        let comments = vec![line_comment("g", &gone, "foo.rs", Side::New, 1, 1)];

        let out = resolve_all(&comments, &t.repo);

        assert_eq!(find(&out, "g").reason, Some(OrphanReason::CommitGone));
        assert!(!find(&out, "g").resolvable);
    }

    #[test]
    fn resolve_all_classifies_missing_file_as_file_gone() {
        let t = make_file_repo();
        let b = t.with_file.to_string();
        let comments = vec![line_comment("f", &b, "missing.rs", Side::New, 1, 1)];

        let out = resolve_all(&comments, &t.repo);

        assert_eq!(find(&out, "f").reason, Some(OrphanReason::FileGone));
    }

    #[test]
    fn resolve_all_classifies_old_side_on_root_commit_as_file_gone() {
        let t = make_file_repo();
        // The root commit has no parent, so the Old side has no tree to read.
        let root = t.root.to_string();
        let comments = vec![line_comment("r", &root, "foo.rs", Side::Old, 1, 1)];

        let out = resolve_all(&comments, &t.repo);

        assert_eq!(find(&out, "r").reason, Some(OrphanReason::FileGone));
    }

    #[test]
    fn resolve_all_reads_old_side_from_parent_tree() {
        let t = make_file_repo();
        // B's parent is the root A, which has NO foo.rs → Old side is FileGone,
        // proving Old reads the PARENT tree (B's own tree does have the file).
        let b = t.with_file.to_string();
        let comments = vec![line_comment("old", &b, "foo.rs", Side::Old, 1, 1)];

        let out = resolve_all(&comments, &t.repo);

        assert_eq!(
            find(&out, "old").reason,
            Some(OrphanReason::FileGone),
            "Old side reads the parent tree (root A has no foo.rs)"
        );
    }

    #[test]
    fn resolve_all_treats_last_line_as_in_range() {
        let t = make_file_repo();
        let b = t.with_file.to_string();
        // foo.rs has exactly 3 lines.
        let comments = vec![
            line_comment("last", &b, "foo.rs", Side::New, 3, 3),
            line_comment("past", &b, "foo.rs", Side::New, 4, 4),
        ];

        let out = resolve_all(&comments, &t.repo);

        assert!(
            find(&out, "last").resolvable,
            "end_line == line count is in range"
        );
        assert_eq!(
            find(&out, "past").reason,
            Some(OrphanReason::LineOutOfRange),
            "end_line == line count + 1 is out of range"
        );
    }

    #[test]
    fn resolve_all_rejects_inverted_line_range() {
        let t = make_file_repo();
        let b = t.with_file.to_string();
        // start_line > end_line on a 3-line file: the bound check would pass
        // (start_line >= 1, end_line <= line_count) without the inverted-range
        // guard, and the panel would render a normal jump affordance against an
        // empty/inverted span. classify_anchor is the one chokepoint, so it
        // enforces start_line <= end_line.
        let comments = vec![line_comment("inverted", &b, "foo.rs", Side::New, 3, 2)];

        let out = resolve_all(&comments, &t.repo);

        assert_eq!(
            find(&out, "inverted").reason,
            Some(OrphanReason::LineOutOfRange)
        );
        assert!(!find(&out, "inverted").resolvable);
    }

    #[test]
    fn resolve_all_classifies_unparseable_oid_as_commit_gone_without_panicking() {
        let t = make_file_repo();
        // "not-a-valid-oid" is not 40 hex chars → Oid::from_str errors.
        let comments = vec![line_comment(
            "bad",
            "not-a-valid-oid",
            "foo.rs",
            Side::New,
            1,
            1,
        )];

        let out = resolve_all(&comments, &t.repo);

        assert_eq!(find(&out, "bad").reason, Some(OrphanReason::CommitGone));
    }

    #[test]
    fn resolve_all_classifies_commit_level_comment_by_commit_existence() {
        let t = make_file_repo();
        let b = t.with_file.to_string();
        let gone = "0".repeat(40);
        let comments = vec![
            commit_comment("present", &b),
            commit_comment("absent", &gone),
        ];

        let out = resolve_all(&comments, &t.repo);

        assert!(
            find(&out, "present").resolvable,
            "a commit-level comment on an existing commit resolves"
        );
        assert_eq!(
            find(&out, "absent").reason,
            Some(OrphanReason::CommitGone),
            "a commit-level comment on a missing commit is CommitGone"
        );
    }
}

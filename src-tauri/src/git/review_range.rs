//! Selection core (Phase 66, Plan 01): pure, testable range/selection helpers.
//!
//! These take a `&git2::Repository` (no Tauri state) so the range/validation
//! logic is provable against an in-process test repo; `commands/review.rs`
//! wraps them.

use crate::error::TrunkError;
use crate::git::types::SessionCommit;

/// Validate that `[base..tip]` is a meaningful inclusive range (SEL-01).
///
/// Order matters: `graph_descendant_of(x, x)` is `false`, so the `base == tip`
/// case (valid under D-02 inclusive semantics → set `{base}`) MUST short-circuit
/// before the descendant check. Unrelated histories surface as a `merge_base`
/// error; a base that is not an ancestor of the tip is a `bad_range`.
pub(crate) fn validate_range(
    repo: &git2::Repository,
    base: git2::Oid,
    tip: git2::Oid,
) -> Result<(), TrunkError> {
    if base == tip {
        return Ok(());
    }
    repo.merge_base(base, tip)
        .map_err(|_| TrunkError::new("unrelated_history", "These commits share no history"))?;
    if !repo
        .graph_descendant_of(tip, base)
        .map_err(TrunkError::from)?
    {
        return Err(TrunkError::new(
            "bad_range",
            "Base is not an ancestor of tip",
        ));
    }
    Ok(())
}

/// Compute the OIDs in the inclusive range `[base..tip]` (SEL-01, D-02).
///
/// Walks `push(tip)` then hides EVERY parent of `base` so `base` itself stays in
/// the set while none of its ancestors do. Hiding all parents (not just the
/// first) matters when `base` is a merge commit: hiding only `parent(0)` would
/// leave the second-parent side branch reachable from `tip` and leak it into the
/// selection (CR-01). A root-commit base (`parent_count() == 0`) hides nothing,
/// mirroring the verified `interactive_rebase.rs` fallback, so it never panics.
pub(crate) fn compute_range_oids(
    repo: &git2::Repository,
    base: git2::Oid,
    tip: git2::Oid,
) -> Result<Vec<String>, TrunkError> {
    let mut revwalk = repo.revwalk().map_err(TrunkError::from)?;
    revwalk
        .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(TrunkError::from)?;
    revwalk.push(tip).map_err(TrunkError::from)?;

    let base_commit = repo.find_commit(base).map_err(TrunkError::from)?;
    for i in 0..base_commit.parent_count() {
        revwalk
            .hide(base_commit.parent_id(i).map_err(TrunkError::from)?)
            .map_err(TrunkError::from)?;
    }
    // Root commit base: hide nothing — the whole ancestry through tip is included.

    revwalk
        .map(|oid| oid.map(|o| o.to_string()).map_err(TrunkError::from))
        .collect()
}

/// Order the session set by the full cached graph order, deduped, as the SEL-04
/// list. OIDs present in the cached `graph` come first in graph order; any
/// selected OID absent from the graph is appended via `repo.find_commit`, and an
/// OID that even `find_commit` can't resolve is included with an `(unavailable)`
/// summary rather than silently dropped (Phase 65 "never silently destroy").
pub(crate) fn intersect_graph_order(
    commits: &[String],
    graph: &crate::git::types::GraphResult,
    repo: &git2::Repository,
) -> Vec<SessionCommit> {
    let want: std::collections::HashSet<&String> = commits.iter().collect();
    let mut out: Vec<SessionCommit> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for c in graph.commits.iter().filter(|c| want.contains(&c.oid)) {
        if seen.insert(c.oid.clone()) {
            out.push(SessionCommit {
                oid: c.oid.clone(),
                short_oid: c.short_oid.clone(),
                summary: c.summary.clone(),
                is_snapshot: false,
            });
        }
    }

    // Fallback: selected OIDs not in the cached graph (orphaned/force-pushed).
    for oid_str in commits {
        if !seen.insert(oid_str.clone()) {
            continue;
        }
        let summary = git2::Oid::from_str(oid_str)
            .ok()
            .and_then(|oid| repo.find_commit(oid).ok())
            .and_then(|c| {
                c.summary()
                    .ok()
                    .flatten()
                    .map(std::borrow::ToOwned::to_owned)
            })
            .unwrap_or_else(|| "(unavailable)".to_string());
        out.push(SessionCommit {
            oid: oid_str.clone(),
            short_oid: oid_str.chars().take(7).collect(),
            summary,
            is_snapshot: false,
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Oid, Repository, Signature};
    use tempfile::TempDir;

    // ── In-process test-repo helper ──────────────────────────────────────────
    // tempfile::TempDir + git2::Repository::init builds a known topology so the
    // revwalk/validation helpers run against REAL commits (classical TDD: real
    // collaborator, no mocks). The TempDir is returned alongside the repo so the
    // caller keeps it alive for the test's duration (drop deletes the dir).

    /// A deterministic signature so commits are reproducible (F.I.R.S.T.: no clock).
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

    /// A linear chain A→B→C→D plus a merge commit M (side branch off B, merged
    /// into the tip) so range walks can exercise both linear and merge topologies.
    struct TestRepo {
        _dir: TempDir,
        repo: Repository,
        a: Oid, // root
        b: Oid,
        c: Oid,
        d: Oid,
        side: Oid,  // off B
        merge: Oid, // merge of D and side
    }

    fn make_repo() -> TestRepo {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let a = commit(&repo, "A (root)", &[]);
        let b = commit(&repo, "B", &[a]);
        let c = commit(&repo, "C", &[b]);
        let d = commit(&repo, "D", &[c]);
        let side = commit(&repo, "side off B", &[b]);
        let merge = commit(&repo, "merge", &[d, side]);
        TestRepo {
            _dir: dir,
            repo,
            a,
            b,
            c,
            d,
            side,
            merge,
        }
    }

    /// A second, unrelated repository with its own root — for the
    /// unrelated-history rejection case (merge_base across these errors).
    fn make_unrelated_repo() -> (TempDir, Repository, Oid) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let root = commit(&repo, "unrelated root", &[]);
        (dir, repo, root)
    }

    // ── Task 1: Range walk + validation ──────────────────────────────────────

    #[test]
    fn seed_range_inclusive() {
        let t = make_repo();
        let oids = compute_range_oids(&t.repo, t.b, t.d).unwrap();
        // [B..D] inclusive: both endpoints present, plus C between them.
        assert!(oids.contains(&t.b.to_string()), "base B must be included");
        assert!(oids.contains(&t.d.to_string()), "tip D must be included");
        assert!(
            oids.contains(&t.c.to_string()),
            "intermediate C must be included"
        );
        assert!(
            !oids.contains(&t.a.to_string()),
            "A is below base, excluded"
        );
    }

    #[test]
    fn seed_range_root_base() {
        let t = make_repo();
        // Root commit base: walk hides nothing, full ancestry through tip included.
        let oids = compute_range_oids(&t.repo, t.a, t.d).unwrap();
        for oid in [t.a, t.b, t.c, t.d] {
            assert!(
                oids.contains(&oid.to_string()),
                "root-base range must include {oid}"
            );
        }
    }

    #[test]
    fn seed_range_base_eq_tip() {
        let t = make_repo();
        assert!(validate_range(&t.repo, t.c, t.c).is_ok());
        let oids = compute_range_oids(&t.repo, t.c, t.c).unwrap();
        assert_eq!(
            oids,
            vec![t.c.to_string()],
            "base==tip yields exactly {{base}}"
        );
    }

    #[test]
    fn seed_range_rejects_non_ancestor() {
        let t = make_repo();
        // side is NOT an ancestor of D (it forks off B onto its own line).
        let err = validate_range(&t.repo, t.side, t.d).unwrap_err();
        assert_eq!(err.code, "bad_range");
    }

    #[test]
    fn seed_range_rejects_unrelated() {
        let t = make_repo();
        let (_other_dir, _other_repo, other_root) = make_unrelated_repo();
        // other_root lives in a different repo, so it shares no history with D.
        let err = validate_range(&t.repo, other_root, t.d).unwrap_err();
        assert_eq!(err.code, "unrelated_history");
    }

    #[test]
    fn merge_commit_selectable() {
        let t = make_repo();
        // D-08: a merge commit can be the tip and appears in the computed range,
        // with no is_merge gate filtering it out.
        let oids = compute_range_oids(&t.repo, t.b, t.merge).unwrap();
        assert!(
            oids.contains(&t.merge.to_string()),
            "merge commit must be selectable as tip"
        );
        assert!(
            oids.contains(&t.side.to_string()),
            "merge brings in side branch"
        );
    }

    #[test]
    fn seed_range_merge_base_excludes_side_branch() {
        let t = make_repo();
        // D-02 + D-08: when the range BASE is a merge commit, [base..tip] includes
        // base but excludes ALL of base's ancestors — including the second-parent
        // side branch. Regression for CR-01 (hiding only parent_id(0) leaked the
        // side branch into the selection).
        let top = commit(&t.repo, "top of merge", &[t.merge]);
        let oids = compute_range_oids(&t.repo, t.merge, top).unwrap();
        assert!(oids.contains(&top.to_string()), "tip must be included");
        assert!(
            oids.contains(&t.merge.to_string()),
            "merge base must be included"
        );
        assert!(
            !oids.contains(&t.side.to_string()),
            "second-parent side branch must NOT leak when base is a merge"
        );
        assert!(
            !oids.contains(&t.d.to_string()),
            "first-parent ancestor must be excluded"
        );
    }

    // ── Task 3: Graph-ordered intersection (SEL-04) ──────────────────────────

    /// A minimal `GraphCommit` for fixtures — only the fields `SessionCommit`
    /// copies (oid, short_oid, summary) carry meaning; the rest are inert.
    fn graph_commit(oid: &str, summary: &str) -> crate::git::types::GraphCommit {
        crate::git::types::GraphCommit {
            oid: oid.to_string(),
            short_oid: oid.chars().take(7).collect(),
            summary: summary.to_string(),
            body: None,
            author_name: String::new(),
            author_email: String::new(),
            author_timestamp: 0,
            parent_oids: vec![],
            column: 0,
            color_index: 0,
            edges: vec![],
            refs: vec![],
            is_head: false,
            is_merge: false,
            is_branch_tip: false,
            is_stash: false,
            in_head_chain: false,
            lane_ref: None,
        }
    }

    #[test]
    fn list_session_commits_graph_order() {
        let t = make_repo();
        // Graph order: D, C, B (newest-first slice of the cached graph).
        let graph = crate::git::types::GraphResult {
            commits: vec![
                graph_commit(&t.d.to_string(), "D"),
                graph_commit(&t.c.to_string(), "C"),
                graph_commit(&t.b.to_string(), "B"),
            ],
            max_columns: 1,
        };
        // Session set given in a DIFFERENT order, with a duplicate.
        let session = vec![
            t.b.to_string(),
            t.d.to_string(),
            t.b.to_string(), // dup — must collapse
        ];
        let out = intersect_graph_order(&session, &graph, &t.repo);
        let oids: Vec<String> = out.iter().map(|c| c.oid.clone()).collect();
        // Re-imposed graph order (D before B), deduped, C excluded (not selected).
        assert_eq!(oids, vec![t.d.to_string(), t.b.to_string()]);
        assert_eq!(out[0].summary, "D");
    }

    #[test]
    fn list_session_commits_orphan_fallback() {
        let t = make_repo();
        // Graph contains only D; the session also selects A (absent from graph but
        // resolvable via find_commit) and a bogus OID (truly unresolvable).
        let graph = crate::git::types::GraphResult {
            commits: vec![graph_commit(&t.d.to_string(), "D")],
            max_columns: 1,
        };
        let bogus = "0".repeat(40);
        let session = vec![t.d.to_string(), t.a.to_string(), bogus.clone()];
        let out = intersect_graph_order(&session, &graph, &t.repo);
        let oids: Vec<String> = out.iter().map(|c| c.oid.clone()).collect();
        // D from the graph, then the appended fallbacks — none silently dropped.
        assert!(oids.contains(&t.d.to_string()), "in-graph commit present");
        assert!(
            oids.contains(&t.a.to_string()),
            "orphan resolvable via find_commit must be appended"
        );
        assert!(
            oids.contains(&bogus),
            "unresolvable orphan must still appear (never dropped)"
        );
        let unresolved = out.iter().find(|c| c.oid == bogus).unwrap();
        assert_eq!(unresolved.summary, "(unavailable)");
    }
}

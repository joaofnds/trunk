//! The repository shapes the commit-graph tests are built from.
//!
//! Shared by two readers. `tests/test_graph_capture.rs` builds each one and captures it into
//! `tests/rule-inputs/`, which the named-rule placement tests then read instead of building a
//! repository. `tests/test_graph.rs` still builds the ones whose subject is git2 itself — a
//! bare repository, a corrupted object store, a `statuses()` reading — where a capture would
//! record the answer rather than test it.
//!
//! Every shape pins its timestamps. The graph sorts with `TOPOLOGICAL | TIME`, so same-second
//! commits sort arbitrarily; an unpinned shape also cannot be captured, because two builds of
//! it produce different OIDs and the fidelity check has nothing stable to compare.

use std::collections::HashMap;

use crate::common::context::TestContext;

pub fn sig_at(secs: i64) -> git2::Signature<'static> {
    git2::Signature::new("T", "t@t.com", &git2::Time::new(secs, 0)).expect("build a signature")
}

pub fn identity(repo: &git2::Repository) {
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "T").unwrap();
    cfg.set_str("user.email", "t@t.com").unwrap();
}

pub fn checkout_main(repo: &git2::Repository) {
    repo.set_head("refs/heads/main").unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .unwrap();
}

/// Create a commit in a repo, dropping borrows promptly.
pub fn raw_commit(
    repo: &git2::Repository,
    sig: &git2::Signature,
    refname: &str,
    msg: &str,
    file: &str,
    content: &str,
    parents: &[&git2::Commit],
) -> git2::Oid {
    let dir = repo.workdir().unwrap();
    std::fs::write(dir.join(file), content).unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_path(std::path::Path::new(file)).unwrap();
    idx.write().unwrap();
    let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();

    repo.commit(Some(refname), sig, sig, msg, &tree, parents)
        .unwrap()
}

/// A `TestContext` over a repository built by raw git2 rather than by the builder.
pub fn context_at(dir: tempfile::TempDir) -> TestContext {
    let path = dir.path().display().to_string();
    let mut state_map = HashMap::new();
    state_map.insert(path.clone(), dir.path().to_path_buf());

    TestContext::from_parts(dir, path, state_map)
}

/// `BranchA` is merged back, freeing its column, and `BranchB` forks later off `Main-2`.
/// `Main-3` keeps `BranchB` off HEAD's tip: a branch sitting directly on the tip is a linear
/// continuation of it and takes the HEAD lane, which would leave nothing to place.
pub fn freed_column_reuse_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);

        let root = raw_commit(
            &repo,
            &sig_at(1000),
            "refs/heads/main",
            "Root",
            "root.txt",
            "root",
            &[],
        );
        let root_c = repo.find_commit(root).unwrap();
        let main1 = raw_commit(
            &repo,
            &sig_at(2000),
            "refs/heads/main",
            "Main-1",
            "main1.txt",
            "main1",
            &[&root_c],
        );
        let main1_c = repo.find_commit(main1).unwrap();
        let ba = raw_commit(
            &repo,
            &sig_at(3000),
            "refs/heads/branch-a",
            "BranchA",
            "a.txt",
            "a",
            &[&root_c],
        );
        let ba_c = repo.find_commit(ba).unwrap();

        std::fs::write(dir.path().join("merge_a.txt"), "merge_a").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("merge_a.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let merge_sig = sig_at(4000);
        let merge_a = repo
            .commit(
                Some("refs/heads/main"),
                &merge_sig,
                &merge_sig,
                "Merge-A",
                &tree,
                &[&main1_c, &ba_c],
            )
            .unwrap();
        let merge_a_c = repo.find_commit(merge_a).unwrap();

        let main2 = raw_commit(
            &repo,
            &sig_at(5000),
            "refs/heads/main",
            "Main-2",
            "main2.txt",
            "main2",
            &[&merge_a_c],
        );
        let main2_c = repo.find_commit(main2).unwrap();
        raw_commit(
            &repo,
            &sig_at(6000),
            "refs/heads/branch-b",
            "BranchB",
            "b.txt",
            "b",
            &[&main2_c],
        );
        raw_commit(
            &repo,
            &sig_at(7000),
            "refs/heads/main",
            "Main-3",
            "main3.txt",
            "main3",
            &[&main2_c],
        );
        repo.set_head("refs/heads/main").unwrap();
    }

    context_at(dir)
}

/// A merge commit whose parents are one commit each side of a root: `main` C0 -> C1, `feature`
/// C0 -> F1, merged as M on `main`.
pub fn merge_two_parents_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);

        let c0 = raw_commit(
            &repo,
            &sig_at(1000),
            "refs/heads/main",
            "C0",
            "f0.txt",
            "f0",
            &[],
        );
        let c0_commit = repo.find_commit(c0).unwrap();
        let c1 = raw_commit(
            &repo,
            &sig_at(2000),
            "refs/heads/main",
            "C1",
            "f1.txt",
            "f1",
            &[&c0_commit],
        );
        let f1 = raw_commit(
            &repo,
            &sig_at(3000),
            "refs/heads/feature",
            "F1",
            "feat.txt",
            "feat",
            &[&c0_commit],
        );

        let c1_commit = repo.find_commit(c1).unwrap();
        let f1_commit = repo.find_commit(f1).unwrap();
        raw_commit(
            &repo,
            &sig_at(4000),
            "refs/heads/main",
            "M",
            "merge.txt",
            "merge",
            &[&c1_commit, &f1_commit],
        );
        repo.set_head("refs/heads/main").unwrap();
    }

    context_at(dir)
}

/// Two branches off one root, merged back: Root -> A1 on `main`, Root -> B1 on `branch-b`,
/// Merge-AB on `main`. The shape pinned every commit to the *same* second, which is the
/// arbitrary tie-break `.boris/CONTEXT.md` §Fixture repository rules out.
pub fn criss_cross_merge_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);

        let root = raw_commit(
            &repo,
            &sig_at(1000),
            "refs/heads/main",
            "Root",
            "root.txt",
            "root",
            &[],
        );
        let root_c = repo.find_commit(root).unwrap();
        let a1 = raw_commit(
            &repo,
            &sig_at(2000),
            "refs/heads/main",
            "A1",
            "a1.txt",
            "a1",
            &[&root_c],
        );
        let a1_c = repo.find_commit(a1).unwrap();
        let b1 = raw_commit(
            &repo,
            &sig_at(3000),
            "refs/heads/branch-b",
            "B1",
            "b1.txt",
            "b1",
            &[&root_c],
        );
        let b1_c = repo.find_commit(b1).unwrap();

        std::fs::write(dir.path().join("merge_ab.txt"), "merge_ab").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("merge_ab.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = sig_at(4000);
        repo.commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            "Merge-AB",
            &tree,
            &[&a1_c, &b1_c],
        )
        .unwrap();
        repo.set_head("refs/heads/main").unwrap();
    }

    context_at(dir)
}

/// A root, a commit on `main`, and `count` sibling branches off the root, all merged at once.
/// `octopus_merge_compact` and `octopus_no_column_zero_theft` differ only in that count.
fn octopus_repo(branches: usize) -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);

        let root = raw_commit(
            &repo,
            &sig_at(1000),
            "refs/heads/main",
            "Root",
            "root.txt",
            "root",
            &[],
        );
        let root_c = repo.find_commit(root).unwrap();
        let main1 = raw_commit(
            &repo,
            &sig_at(2000),
            "refs/heads/main",
            "Main-1",
            "main1.txt",
            "main1",
            &[&root_c],
        );

        let mut branch_oids = Vec::new();
        for (i, letter) in ["a", "b", "c"].iter().enumerate().take(branches) {
            branch_oids.push(raw_commit(
                &repo,
                &sig_at(3000 + 1000 * i as i64),
                &format!("refs/heads/branch-{letter}"),
                &format!("B{}", letter.to_uppercase()),
                &format!("{letter}.txt"),
                letter,
                &[&root_c],
            ));
        }

        std::fs::write(dir.path().join("octopus.txt"), "octopus").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("octopus.txt")).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = sig_at(3000 + 1000 * branches as i64);

        let main1_c = repo.find_commit(main1).unwrap();
        let branch_commits: Vec<git2::Commit> = branch_oids
            .iter()
            .map(|o| repo.find_commit(*o).unwrap())
            .collect();
        let mut parents: Vec<&git2::Commit> = vec![&main1_c];
        parents.extend(branch_commits.iter());

        repo.commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            "Octopus",
            &tree,
            &parents,
        )
        .unwrap();
        repo.set_head("refs/heads/main").unwrap();
    }

    context_at(dir)
}

pub fn octopus_three_branches_repo() -> TestContext {
    octopus_repo(3)
}

pub fn octopus_two_branches_repo() -> TestContext {
    octopus_repo(2)
}

/// `main` runs C0 -> C1 -> C2; `topic` diverges from C1 with B0. Timestamps follow creation
/// order — the shape was built with `Signature::now`, which put every commit in one second and
/// left the `TOPOLOGICAL | TIME` sort resolving by tie-break.
pub fn branch_fork_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);

        let c0 = raw_commit(
            &repo,
            &sig_at(1000),
            "refs/heads/main",
            "C0",
            "f0.txt",
            "f0",
            &[],
        );
        let c0c = repo.find_commit(c0).unwrap();
        let c1 = raw_commit(
            &repo,
            &sig_at(2000),
            "refs/heads/main",
            "C1",
            "f1.txt",
            "f1",
            &[&c0c],
        );
        let c1c = repo.find_commit(c1).unwrap();
        raw_commit(
            &repo,
            &sig_at(3000),
            "refs/heads/main",
            "C2",
            "f2.txt",
            "f2",
            &[&c1c],
        );
        repo.set_head("refs/heads/main").unwrap();
        raw_commit(
            &repo,
            &sig_at(4000),
            "refs/heads/topic",
            "B0",
            "b0.txt",
            "b0",
            &[&c1c],
        );
    }

    context_at(dir)
}

/// `main` at `base2`, with `later` one commit beyond it on the same first-parent line and no
/// tracking configuration — so the continuation holds the HEAD lane under its own colour.
pub fn non_upstream_continuation_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);
        let b1 = raw_commit(
            &repo,
            &sig_at(1000),
            "refs/heads/main",
            "base1",
            "f.txt",
            "1",
            &[],
        );
        let b1_c = repo.find_commit(b1).unwrap();
        let b2 = raw_commit(
            &repo,
            &sig_at(2000),
            "refs/heads/main",
            "base2",
            "f.txt",
            "2",
            &[&b1_c],
        );
        let b2_c = repo.find_commit(b2).unwrap();
        raw_commit(
            &repo,
            &sig_at(3000),
            "refs/heads/later",
            "later1",
            "f.txt",
            "3",
            &[&b2_c],
        );
        checkout_main(&repo);
    }

    context_at(dir)
}

/// The same shape with a tracked file modified, so `worktree_dirty` is true.
pub fn non_upstream_continuation_dirty_repo() -> TestContext {
    let ctx = non_upstream_continuation_repo();
    std::fs::write(ctx.repo_path().join("f.txt"), "dirty").unwrap();
    ctx
}

/// `main` with one commit, `feature` one commit off it, merged back into `main`.
pub fn merge_feature_repo() -> TestContext {
    TestContext::builder()
        .with_file("README.md", "hello")
        .with_commit("Initial commit")
        .with_branch("feature")
        .checkout("feature")
        .with_file("feature.txt", "feature work")
        .with_commit("Feature commit")
        .checkout("main")
        .merge("feature")
        .build()
}

/// `Add notes` -> `Add app` on main, with a stash on the tip whose committer time predates
/// both. Mirrors QA fixture 15. The tree is left clean, so the stash is inline-eligible.
pub fn backdated_stash_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    let mut repo = git2::Repository::init(dir.path()).unwrap();
    identity(&repo);
    {
        let notes = raw_commit(
            &repo,
            &sig_at(1_700_000_000),
            "refs/heads/main",
            "Add notes",
            "notes.txt",
            "notes v1",
            &[],
        );
        let notes_c = repo.find_commit(notes).unwrap();
        raw_commit(
            &repo,
            &sig_at(1_700_086_400),
            "refs/heads/main",
            "Add app",
            "app.txt",
            "app v1",
            &[&notes_c],
        );
    }
    repo.set_head("refs/heads/main").unwrap();

    std::fs::write(dir.path().join("notes.txt"), "notes v2 \u{2014} stashed").unwrap();
    repo.stash_save(&sig_at(1_699_913_600), "backdated", None)
        .unwrap();
    drop(repo);

    context_at(dir)
}

/// The backdated shape with a lightweight tag on the stash commit, so the stash is reachable
/// from `refs/tags` as well as from `refs/stash`.
pub fn tagged_stash_repo() -> TestContext {
    let ctx = backdated_stash_repo();
    {
        let repo = ctx.repo();
        let stash_oid = repo.refname_to_id("refs/stash").unwrap();
        let stash_obj = repo.find_object(stash_oid, None).unwrap();
        repo.tag_lightweight("keep", &stash_obj, false).unwrap();
    }
    ctx
}

/// Stash B taken while HEAD is detached on stash A, so `B^ == A`. B is timestamped *before*
/// A: under a time-ordered merge the newer parent sorts above its child, which is the
/// inversion the topological walk has to rule out.
///
/// The detach is load-bearing. It puts A in the head chain, so A's column is reserved before
/// B is placed.
pub fn stash_on_stash_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    let mut repo = git2::Repository::init(dir.path()).unwrap();
    identity(&repo);
    {
        let notes = raw_commit(
            &repo,
            &sig_at(1_700_000_000),
            "refs/heads/main",
            "Add notes",
            "notes.txt",
            "notes v1",
            &[],
        );
        let notes_c = repo.find_commit(notes).unwrap();
        raw_commit(
            &repo,
            &sig_at(1_700_086_400),
            "refs/heads/main",
            "Add app",
            "app.txt",
            "app v1",
            &[&notes_c],
        );
    }
    repo.set_head("refs/heads/main").unwrap();

    std::fs::write(dir.path().join("notes.txt"), "notes v2 \u{2014} stash A").unwrap();
    let a = repo
        .stash_save(&sig_at(1_700_259_200), "stash A", None)
        .unwrap();

    {
        let a_obj = repo.find_object(a, None).unwrap();
        let mut checkout = git2::build::CheckoutBuilder::new();
        repo.checkout_tree(&a_obj, Some(checkout.force())).unwrap();
        repo.set_head_detached(a).unwrap();
    }

    std::fs::write(dir.path().join("notes.txt"), "notes v3 \u{2014} stash B").unwrap();
    let b = repo
        .stash_save(&sig_at(1_700_172_800), "stash B", None)
        .unwrap();

    assert_eq!(
        repo.find_commit(b).unwrap().parent_id(0).unwrap(),
        a,
        "fixture is wrong: B's first parent must be stash A"
    );
    drop(repo);

    context_at(dir)
}

/// Two stashes on the same parent, both timestamped before it.
pub fn two_backdated_stashes_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    let mut repo = git2::Repository::init(dir.path()).unwrap();
    identity(&repo);
    {
        let notes = raw_commit(
            &repo,
            &sig_at(1_700_000_000),
            "refs/heads/main",
            "Add notes",
            "notes.txt",
            "notes v1",
            &[],
        );
        let notes_c = repo.find_commit(notes).unwrap();
        raw_commit(
            &repo,
            &sig_at(1_700_086_400),
            "refs/heads/main",
            "Add app",
            "app.txt",
            "app v1",
            &[&notes_c],
        );
    }
    repo.set_head("refs/heads/main").unwrap();

    std::fs::write(dir.path().join("notes.txt"), "notes v2 \u{2014} stashed").unwrap();
    repo.stash_save(&sig_at(1_699_827_200), "older backdated", None)
        .unwrap();

    std::fs::write(dir.path().join("app.txt"), "app v2 \u{2014} stashed").unwrap();
    repo.stash_save(&sig_at(1_699_913_600), "newer backdated", None)
        .unwrap();
    drop(repo);

    context_at(dir)
}

/// QA fixture 12's shape: the stash's parent is dropped from every ref by `reset --hard`, so
/// the only thing still pointing at it is the stash itself.
pub fn orphan_stash_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    let mut repo = git2::Repository::init(dir.path()).unwrap();
    identity(&repo);
    let notes = {
        let notes = raw_commit(
            &repo,
            &sig_at(1_700_000_000),
            "refs/heads/main",
            "Add notes",
            "notes.txt",
            "notes v1",
            &[],
        );
        let notes_c = repo.find_commit(notes).unwrap();
        raw_commit(
            &repo,
            &sig_at(1_700_086_400),
            "refs/heads/main",
            "Add app",
            "app.txt",
            "app v1",
            &[&notes_c],
        );
        notes
    };
    repo.set_head("refs/heads/main").unwrap();

    std::fs::write(dir.path().join("notes.txt"), "notes v2 \u{2014} stashed").unwrap();
    repo.stash_save(&sig_at(1_700_864_000), "half-finished notes", None)
        .unwrap();

    {
        let notes_obj = repo.find_object(notes, None).unwrap();
        repo.reset(&notes_obj, git2::ResetType::Hard, None).unwrap();
    }
    drop(repo);

    context_at(dir)
}

/// C0 -> C1 -> C2 on `main`, with one stash on the tip. The builder pins its own clock.
pub fn stash_on_head_tip_repo() -> TestContext {
    TestContext::builder()
        .with_file("f0.txt", "f0")
        .with_commit("C0")
        .with_file("f1.txt", "f1")
        .with_commit("C1")
        .with_file("f2.txt", "f2")
        .with_commit("C2")
        .with_stash(Some("test stash"))
        .build()
}

/// C0 -> C1 on `main` with two stashes on C1, the HEAD tip.
pub fn two_stashes_one_parent_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);

        let c0 = raw_commit(
            &repo,
            &sig_at(1000),
            "refs/heads/main",
            "C0",
            "f0.txt",
            "f0",
            &[],
        );
        let c0c = repo.find_commit(c0).unwrap();
        raw_commit(
            &repo,
            &sig_at(2000),
            "refs/heads/main",
            "C1",
            "f1.txt",
            "f1",
            &[&c0c],
        );
        repo.set_head("refs/heads/main").unwrap();
    }

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    std::fs::write(dir.path().join("s1.txt"), "stash1").unwrap();
    {
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("s1.txt")).unwrap();
        idx.write().unwrap();
    }
    repo.stash_save(&sig_at(3000), "stash-1", None).unwrap();

    std::fs::write(dir.path().join("s2.txt"), "stash2").unwrap();
    {
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("s2.txt")).unwrap();
        idx.write().unwrap();
    }
    repo.stash_save(&sig_at(4000), "stash-2", None).unwrap();
    drop(repo);

    context_at(dir)
}

/// A stash whose parent is mid-chain: HEAD is detached at C1 while C2 occupies column 0
/// between the stash and C1.
pub fn stash_on_mid_chain_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);

        let c0 = raw_commit(
            &repo,
            &sig_at(1000),
            "refs/heads/main",
            "C0",
            "f0.txt",
            "f0",
            &[],
        );
        let c0c = repo.find_commit(c0).unwrap();
        let c1 = raw_commit(
            &repo,
            &sig_at(2000),
            "refs/heads/main",
            "C1",
            "f1.txt",
            "f1",
            &[&c0c],
        );
        let c1c = repo.find_commit(c1).unwrap();
        raw_commit(
            &repo,
            &sig_at(3000),
            "refs/heads/main",
            "C2",
            "f2.txt",
            "f2",
            &[&c1c],
        );
        repo.set_head("refs/heads/main").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();

        repo.set_head_detached(c1).unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
    }

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    std::fs::write(dir.path().join("dirty.txt"), "dirty").unwrap();
    {
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("dirty.txt")).unwrap();
        idx.write().unwrap();
    }
    repo.stash_save(&sig_at(4000), "test stash on C1", None)
        .unwrap();
    repo.set_head("refs/heads/main").unwrap();
    drop(repo);

    context_at(dir)
}

/// A stash on the HEAD tip with a topic branch off C0 holding another column.
pub fn stash_with_topic_branch_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);

        let c0 = raw_commit(
            &repo,
            &sig_at(1000),
            "refs/heads/main",
            "C0",
            "f0.txt",
            "f0",
            &[],
        );
        let c0c = repo.find_commit(c0).unwrap();
        raw_commit(
            &repo,
            &sig_at(2000),
            "refs/heads/main",
            "C1",
            "f1.txt",
            "f1",
            &[&c0c],
        );
        repo.set_head("refs/heads/main").unwrap();
        raw_commit(
            &repo,
            &sig_at(3000),
            "refs/heads/topic",
            "Topic",
            "topic.txt",
            "topic",
            &[&c0c],
        );
    }

    let mut repo = git2::Repository::open(dir.path()).unwrap();
    std::fs::write(dir.path().join("dirty.txt"), "dirty").unwrap();
    {
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("dirty.txt")).unwrap();
        idx.write().unwrap();
    }
    repo.stash_save(&sig_at(4000), "test stash", None).unwrap();
    drop(repo);

    context_at(dir)
}

pub fn track_origin_main(repo: &git2::Repository) {
    let mut cfg = repo.config().unwrap();
    cfg.set_str("remote.origin.url", "file:///nonexistent")
        .unwrap();
    cfg.set_str("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
        .unwrap();
    cfg.set_str("branch.main.remote", "origin").unwrap();
    cfg.set_str("branch.main.merge", "refs/heads/main").unwrap();
}

/// `main` at `base2`, `origin/main` three commits ahead on the same line.
pub fn behind_upstream_repo() -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    {
        let repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);
        track_origin_main(&repo);

        let main_ref = "refs/heads/main";
        let remote_ref = "refs/remotes/origin/main";
        let b1 = raw_commit(&repo, &sig_at(1000), main_ref, "base1", "f.txt", "1", &[]);
        let b1_c = repo.find_commit(b1).unwrap();
        let b2 = raw_commit(
            &repo,
            &sig_at(2000),
            main_ref,
            "base2",
            "f.txt",
            "2",
            &[&b1_c],
        );
        let b2_c = repo.find_commit(b2).unwrap();
        let u3 = raw_commit(
            &repo,
            &sig_at(3000),
            remote_ref,
            "up3",
            "f.txt",
            "3",
            &[&b2_c],
        );
        let u3_c = repo.find_commit(u3).unwrap();
        let u4 = raw_commit(
            &repo,
            &sig_at(4000),
            remote_ref,
            "up4",
            "f.txt",
            "4",
            &[&u3_c],
        );
        let u4_c = repo.find_commit(u4).unwrap();
        raw_commit(
            &repo,
            &sig_at(5000),
            remote_ref,
            "up5",
            "f.txt",
            "5",
            &[&u4_c],
        );

        checkout_main(&repo);
    }

    context_at(dir)
}

/// The same shape with a tracked file modified, so `worktree_dirty` is true.
pub fn behind_upstream_dirty_repo() -> TestContext {
    let ctx = behind_upstream_repo();
    std::fs::write(ctx.repo_path().join("f.txt"), "dirty").unwrap();
    ctx
}

/// The behind-upstream shape with a stash taken on top, so the unpulled chain owns lane 0
/// while the stash needs a column.
pub fn stash_under_extended_head_lane_repo() -> TestContext {
    let ctx = behind_upstream_repo();
    {
        let mut repo = ctx.repo();
        std::fs::write(ctx.repo_path().join("f.txt"), "half-finished").unwrap();
        repo.stash_save2(&sig_at(9000), Some("half-finished"), None)
            .unwrap();
    }
    ctx
}

/// C0 -> C1 -> C2 -> "Add stash marker" (HEAD tip) with one stash on the marker.
/// `with_stash` reverts the worktree, so the fixture arrives clean. The committed `.gitignore`
/// is what lets a test distinguish `dirty_status_options()` from `statuses(None)`.
pub fn stash_on_tip_with_ignore_repo() -> TestContext {
    TestContext::builder()
        .with_file(".gitignore", "ignored.txt\n")
        .with_commit("Add ignore rules")
        .with_file("f0.txt", "f0")
        .with_commit("C0")
        .with_file("f1.txt", "f1")
        .with_commit("C1")
        .with_file("f2.txt", "f2")
        .with_commit("C2")
        .with_stash(Some("test stash"))
        .build()
}

/// The same shape with a tracked file modified, so `worktree_dirty` is true.
pub fn stash_on_tip_dirty_tracked_repo() -> TestContext {
    let ctx = stash_on_tip_with_ignore_repo();
    std::fs::write(ctx.repo_path().join("f2.txt"), "modified").unwrap();
    ctx
}

/// Dirty by an untracked file alone.
pub fn stash_on_tip_untracked_repo() -> TestContext {
    let ctx = stash_on_tip_with_ignore_repo();
    std::fs::write(ctx.repo_path().join("untracked.txt"), "u").unwrap();
    ctx
}

/// Dirty by a staged addition alone.
pub fn stash_on_tip_staged_repo() -> TestContext {
    let ctx = stash_on_tip_with_ignore_repo();
    std::fs::write(ctx.repo_path().join("staged.txt"), "s").unwrap();
    let repo = ctx.repo();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("staged.txt")).unwrap();
    index.write().unwrap();
    drop(index);
    drop(repo);
    ctx
}

/// `C0 -> C1` on main with `C0 -> T1` on topic, plus one stash on the main tip. `t1_secs`
/// places T1 above or below C1, which is what decides how far the dirtiness churn reaches.
/// The tree is left clean.
pub fn topic_and_stash_repo(t1_secs: i64) -> TestContext {
    let dir = tempfile::tempdir().unwrap();
    {
        let mut repo = git2::Repository::init(dir.path()).unwrap();
        identity(&repo);

        {
            let c0 = raw_commit(
                &repo,
                &sig_at(1000),
                "refs/heads/main",
                "C0",
                "f0.txt",
                "f0",
                &[],
            );
            let c0c = repo.find_commit(c0).unwrap();
            raw_commit(
                &repo,
                &sig_at(t1_secs),
                "refs/heads/topic",
                "T1",
                "topic.txt",
                "topic",
                &[&c0c],
            );
            raw_commit(
                &repo,
                &sig_at(2000),
                "refs/heads/main",
                "C1",
                "f1.txt",
                "f1",
                &[&c0c],
            );
        }
        repo.set_head("refs/heads/main").unwrap();

        std::fs::write(dir.path().join("f1.txt"), "to be stashed").unwrap();
        repo.stash_save(&sig_at(4000), "test stash", None).unwrap();
    }

    context_at(dir)
}

/// The topic-below-C1 shape, left clean.
pub fn topic_below_clean_repo() -> TestContext {
    topic_and_stash_repo(1500)
}

/// The same shape with the worktree dirtied, which costs the stash its inline lane.
pub fn topic_below_dirty_repo() -> TestContext {
    let ctx = topic_and_stash_repo(1500);
    std::fs::write(ctx.repo_path().join("f1.txt"), "dirty").unwrap();
    ctx
}

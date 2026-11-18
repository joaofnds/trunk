use crate::error::TrunkError;
use crate::graph_input::{CommitFacts, GraphSnapshot, GraphSource, RefVisibility};
use crate::placement::PlacementInput;
use crate::repository;
use crate::status;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

fn tracked_upstream_oid(repo: &git2::Repository) -> Option<git2::Oid> {
    let head = repo.head().ok()?;
    if !head.is_branch() {
        return None;
    }
    let branch = git2::Branch::wrap(head);
    branch.upstream().ok()?.get().target()
}

/// Every parent list lane assignment can look up: one entry per walk member, plus the
/// first-parent chains above `head_tip` and `tracked_upstream`, which the descents follow
/// past the walk's own edge. A detached HEAD no ref reaches lives entirely in that closure.
fn parent_map(
    repo: &git2::Repository,
    walked: &[(git2::Oid, Arc<Known>)],
    seeds: [Option<git2::Oid>; 2],
) -> HashMap<git2::Oid, Vec<git2::Oid>> {
    let mut parents: HashMap<git2::Oid, Vec<git2::Oid>> = walked
        .iter()
        .map(|(oid, known)| (*oid, known.parents.clone()))
        .collect();

    for seed in seeds.into_iter().flatten() {
        let mut current = Some(seed);
        while let Some(oid) = current
            && !parents.contains_key(&oid)
        {
            let Ok(commit) = repo.find_commit(oid) else {
                break;
            };
            let list: Vec<git2::Oid> = commit.parent_ids().collect();
            current = list.first().copied();
            parents.insert(oid, list);
        }
    }

    parents
}

/// The commits the walk starts from, in the order libgit2's revwalk would be handed them:
/// every branch, remote branch and tag that peels to a commit, then each stash. A symbolic
/// ref that resolves to nothing, and a ref to a tree or a blob, are skipped, as `push_glob`
/// skips them.
fn walk_tips(repo: &git2::Repository, stashes: &[git2::Oid]) -> Result<Vec<git2::Oid>, TrunkError> {
    let skipped = |error: &git2::Error| {
        matches!(
            error.code(),
            git2::ErrorCode::NotFound | git2::ErrorCode::InvalidSpec | git2::ErrorCode::Peel
        )
    };
    let mut tips = Vec::new();
    for glob in ["refs/heads/*", "refs/remotes/*", "refs/tags/*"] {
        for reference in repo.references_glob(glob)? {
            let target = match reference?.resolve() {
                Ok(resolved) => resolved.target(),
                Err(error) if skipped(&error) => continue,
                Err(error) => return Err(error.into()),
            };
            let Some(target) = target else { continue };
            // A ref naming an object the repository lacks fails the walk, as it fails
            // `git log --all`. One naming a tree or a blob is passed over.
            match repo.find_object(target, None)?.peel_to_commit() {
                Ok(commit) => tips.push(commit.id()),
                Err(error) if skipped(&error) => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    tips.extend_from_slice(stashes);
    Ok(tips)
}

/// Everything a capture reads from one commit. A commit never changes, so what one
/// capture read answers every later capture of the same repository.
struct Known {
    parents: Vec<git2::Oid>,
    /// Committer time, which orders the walk.
    time: i64,
    facts: Arc<CommitFacts>,
}

impl Known {
    fn read(repo: &git2::Repository, oid: git2::Oid) -> Result<Arc<Self>, TrunkError> {
        let commit = repo.find_commit(oid)?;
        let author = commit.author();
        Ok(Arc::new(Self {
            parents: commit.parent_ids().collect(),
            time: commit.time().seconds(),
            facts: Arc::new(CommitFacts {
                summary: commit.summary().ok().flatten().unwrap_or("").to_owned(),
                body: commit
                    .body()
                    .ok()
                    .flatten()
                    .map(std::borrow::ToOwned::to_owned),
                author_name: author.name().unwrap_or("").to_owned(),
                author_email: author.email().unwrap_or("").to_owned(),
                author_timestamp: author.when().seconds(),
            }),
        }))
    }
}

/// The commits a repository's last capture walked, and the graft files they were read
/// under: libgit2 rewrites a commit's parents from `info/grafts` and `shallow`, so once
/// either file changes, nothing read before it can be trusted.
struct Memo {
    grafts: Grafts,
    commits: HashMap<git2::Oid, Arc<Known>>,
}

#[derive(PartialEq, Eq)]
struct Grafts {
    grafts: Option<Vec<u8>>,
    shallow: Option<Vec<u8>>,
}

impl Grafts {
    fn read(repo: &git2::Repository) -> Self {
        let read = |path: PathBuf| std::fs::read(path).ok();
        Self {
            grafts: read(repo.commondir().join("info/grafts")),
            shallow: read(repo.path().join("shallow")),
        }
    }
}

/// Each open repository's memo, by git directory. Every command opens a repository of
/// its own, and a fresh one has an empty object cache, so without this every capture
/// would read the whole history again: about 75 ms at 30,000 commits.
static MEMOS: LazyLock<Mutex<HashMap<PathBuf, Arc<Memo>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn memos() -> std::sync::MutexGuard<'static, HashMap<PathBuf, Arc<Memo>>> {
    // A memo is replaced whole, never edited in place, so a panic cannot leave one torn.
    MEMOS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What the last capture of `repo` read, when the graft files it was read under are
/// still the ones on disk.
fn remembered(repo: &git2::Repository, grafts: &Grafts) -> Option<Arc<Memo>> {
    memos()
        .get(repo.path())
        .filter(|memo| memo.grafts == *grafts)
        .cloned()
}

/// Drop what captures of the repository at `path` have remembered, when it closes.
pub fn forget(path: &Path) {
    if let Ok(repo) = git2::Repository::open(path) {
        memos().remove(repo.path());
    }
}

/// One commit as the walk sees it.
struct WalkNode {
    oid: git2::Oid,
    parents: Vec<usize>,
    time: i64,
    /// Children not yet in the order. A commit is ready once none are left.
    children: usize,
}

/// The commits reachable from `tips`, children before parents and newer before older
/// among the rest, in exactly the order libgit2 1.9's `TOPOLOGICAL | TIME` revwalk gives.
/// `read` answers a commit's parents and committer time, so the order needs no repository
/// and a capture can answer from commits it has already read.
///
/// libgit2 orders the walk with a binary heap of the commits whose children have all gone
/// out, newest on top, and two commits of the same second come out in whatever order that
/// heap keeps. So this keeps the same heap, fed in the same order: the tips first, the last
/// pushed first, then each parent as its last child goes out. libgit2 also files every
/// commit into a list sorted by date first, which changes nothing here: only the tips' order
/// in that list reaches the heap, and the list never reorders them.
fn walk_order(
    tips: &[git2::Oid],
    mut read: impl FnMut(git2::Oid) -> Result<(Vec<git2::Oid>, i64), TrunkError>,
) -> Result<Vec<git2::Oid>, TrunkError> {
    let mut nodes: Vec<WalkNode> = Vec::new();
    let mut index: HashMap<git2::Oid, usize> = HashMap::new();
    let mut node = |nodes: &mut Vec<WalkNode>, oid: git2::Oid| {
        *index.entry(oid).or_insert_with(|| {
            nodes.push(WalkNode {
                oid,
                parents: Vec::new(),
                time: 0,
                children: 0,
            });
            nodes.len() - 1
        })
    };

    let mut starts = Vec::new();
    for &tip in tips.iter().rev() {
        let known = nodes.len();
        let at = node(&mut nodes, tip);
        if nodes.len() > known {
            starts.push(at);
        }
    }

    // Read every commit the tips reach, once each. A commit that will not read fails the
    // walk, as it fails libgit2's.
    let mut at = 0;
    while at < nodes.len() {
        let (parents, time) = read(nodes[at].oid)?;
        let parents: Vec<usize> = parents
            .into_iter()
            .map(|parent| node(&mut nodes, parent))
            .collect();
        for &parent in &parents {
            nodes[parent].children += 1;
        }
        nodes[at].parents = parents;
        nodes[at].time = time;
        at += 1;
    }

    let mut ready = TimeHeap::default();
    for &start in &starts {
        if nodes[start].children == 0 {
            ready.insert(&nodes, start);
        }
    }
    let mut order = Vec::with_capacity(nodes.len());
    while let Some(at) = ready.pop(&nodes) {
        for edge in 0..nodes[at].parents.len() {
            let parent = nodes[at].parents[edge];
            nodes[parent].children -= 1;
            if nodes[parent].children == 0 {
                ready.insert(&nodes, parent);
            }
        }
        order.push(nodes[at].oid);
    }
    Ok(order)
}

/// libgit2's `git_pqueue` keyed on commit time, newest on top, with its exact sift rules,
/// since which of two commits of the same second comes out first is decided by them.
#[derive(Default)]
struct TimeHeap(Vec<usize>);

impl TimeHeap {
    /// `git_commit_list_time_cmp`: `Greater` when `a` belongs below `b`.
    const fn below(nodes: &[WalkNode], a: usize, b: usize) -> bool {
        nodes[a].time < nodes[b].time
    }

    fn insert(&mut self, nodes: &[WalkNode], kid: usize) {
        let heap = &mut self.0;
        heap.push(kid);
        let mut at = heap.len() - 1;
        while at > 0 {
            let parent = (at - 1) >> 1;
            if !Self::below(nodes, heap[parent], kid) {
                break;
            }
            heap[at] = heap[parent];
            at = parent;
        }
        heap[at] = kid;
    }

    fn pop(&mut self, nodes: &[WalkNode]) -> Option<usize> {
        let heap = &mut self.0;
        let top = *heap.first()?;
        let last = heap.pop()?;
        if heap.is_empty() {
            return Some(top);
        }
        let mut at = 0;
        loop {
            let mut kid = 2 * at + 1;
            if kid >= heap.len() {
                break;
            }
            if kid + 1 < heap.len() && Self::below(nodes, heap[kid], heap[kid + 1]) {
                kid += 1;
            }
            if !Self::below(nodes, last, heap[kid]) {
                break;
            }
            heap[at] = heap[kid];
            at = kid;
        }
        heap[at] = last;
        Some(top)
    }
}

/// Everything one walk reads from the repository, in one pass.
///
/// Every git2 call in the commit-graph pipeline lives here; `graph_input::layout` takes
/// it from plain data.
///
/// # Errors
///
/// Returns the git error when a commit the walk reaches, the refs, or the stash
/// reflog will not read.
pub fn capture(repo: &mut git2::Repository) -> Result<GraphSource, TrunkError> {
    capture_with_worktree_reader(repo, status::worktree_dirty)
}

fn capture_with_worktree_reader(
    repo: &mut git2::Repository,
    read_worktree: impl FnOnce(&git2::Repository) -> bool,
) -> Result<GraphSource, TrunkError> {
    // Step 1: Build ref map (needs &mut repo for stash_foreach)
    let ref_map = repository::build_ref_map(repo);

    // Step 1b: Collect stash OIDs (stash_foreach needs &mut repo)
    let mut stash_oids: Vec<git2::Oid> = Vec::new();
    let _ = repo.stash_foreach(|_idx, _name, oid| {
        stash_oids.push(*oid);
        true
    });
    let stash_oid_set: HashSet<git2::Oid> = stash_oids.iter().copied().collect();

    // A stash only joins the walk once every object the walk will reach through it reads
    // back. Skipping an unreadable one costs that stash its row; letting it through costs
    // the whole repo its graph, because the walk fails as a unit.
    //
    // Its parents 1.. are the index tree, and the untracked tree when it was stashed with
    // INCLUDE_UNTRACKED. Pushing the stash makes them reachable, so without this set they
    // enter the walk as rows of their own.
    let mut walkable_stashes: Vec<git2::Oid> = Vec::new();
    let mut stash_internals: HashSet<git2::Oid> = HashSet::new();
    for &s_oid in &stash_oids {
        let Ok(commit) = repo.find_commit(s_oid) else {
            continue;
        };

        let parents: Vec<git2::Oid> = commit.parent_ids().collect();
        if parents.iter().any(|&p| repo.find_commit(p).is_err()) {
            continue;
        }

        stash_internals.extend(parents.iter().skip(1));
        walkable_stashes.push(s_oid);
    }

    // Step 2: Collect all OIDs. Stashes ride the same walk as the refs, so the topological
    // order places each one above its parent whatever its committer time says. A commit
    // the last capture read is answered from its memo, so a rebuild after a commit reads
    // only the commits that are new.
    let grafts = Grafts::read(repo);
    let previous = remembered(repo, &grafts);
    let mut walked: HashMap<git2::Oid, Arc<Known>> = HashMap::new();
    let tips = walk_tips(repo, &walkable_stashes)?;
    let mut oids = walk_order(&tips, |oid| {
        let known = match previous.as_ref().and_then(|memo| memo.commits.get(&oid)) {
            Some(known) => Arc::clone(known),
            None => Known::read(repo, oid)?,
        };
        let read = (known.parents.clone(), known.time);
        walked.insert(oid, known);
        Ok(read)
    })?;
    drop(previous);
    oids.retain(|oid| !stash_internals.contains(oid));
    let members: Vec<(git2::Oid, Arc<Known>)> = oids
        .iter()
        .map(|oid| (*oid, Arc::clone(&walked[oid])))
        .collect();
    memos().insert(
        repo.path().to_path_buf(),
        Arc::new(Memo {
            grafts,
            commits: walked,
        }),
    );

    // Step 3b: Gather everything lane assignment reads. An unborn HEAD leaves `head_tip`
    // None, which is what keeps a fresh repository laying out at all.
    let head_tip = repo.head().ok().and_then(|head_ref| head_ref.target());
    let tracked_upstream = tracked_upstream_oid(repo);
    let parents = parent_map(repo, &members, [head_tip, tracked_upstream]);

    let commits: HashMap<git2::Oid, Arc<CommitFacts>> = members
        .iter()
        .map(|(oid, known)| (*oid, Arc::clone(&known.facts)))
        .collect();

    // Only a page member is ever hydrated, and a page is a subset of the walk, so a ref on
    // anything else would only make the captured file bigger.
    let refs = oids
        .iter()
        .filter_map(|oid| ref_map.get(oid).map(|labels| (*oid, labels.clone())))
        .collect();

    // Observe dirtiness once, after collecting graph inputs and before the caller's
    // final ref check. Dirty work yields column 0 to the frontend's WIP row.
    let worktree_dirty = read_worktree(repo);

    Ok(GraphSource {
        placement: PlacementInput {
            oids,
            parents,
            stashes: stash_oid_set,
            head_tip,
            tracked_upstream,
            worktree_dirty,
        },
        commits,
        refs,
        stash_order: stash_oids,
    })
}

/// Capture with a controlled worktree observation for concurrent-input fixtures.
///
/// # Errors
///
/// Returns repository capture errors.
#[cfg(feature = "test-util")]
pub fn capture_with_worktree_observation(
    repo: &mut git2::Repository,
    read_worktree: impl FnOnce(&git2::Repository) -> bool,
) -> Result<GraphSource, TrunkError> {
    capture_with_worktree_reader(repo, read_worktree)
}

/// The whole history laid out under `visibility`, together with the capture it came from,
/// which is what the commit cache holds so a later visibility change needs no repository.
///
/// Every site that fills `CommitCache` comes through here, which is what keeps a rebuild
/// after a commit, a checkout or a stash honouring the same visibility the graph was drawn
/// with. `visibility` is a parameter rather than a lookup so a new rebuild site cannot
/// forget it.
///
/// # Errors
///
/// Returns whatever `capture` returns.
pub fn snapshot(
    repo: &mut git2::Repository,
    visibility: &RefVisibility,
) -> Result<GraphSnapshot, TrunkError> {
    Ok(GraphSnapshot::new(capture(repo)?, visibility.clone()))
}

#[cfg(test)]
mod tests {
    use super::capture_with_worktree_reader;
    use super::{Known, walk_order, walk_tips};
    use crate::graph_input::CapturedGraph;
    use std::sync::Arc;

    /// A seeded xorshift, so a failing history can be rebuilt from its seed.
    struct Seeded(u64);

    impl Seeded {
        fn below(&mut self, bound: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % bound
        }
    }

    fn signature(seconds: i64) -> git2::Signature<'static> {
        git2::Signature::new(
            "Fixture",
            "fixture@example.invalid",
            &git2::Time::new(seconds, 0),
        )
        .unwrap()
    }

    /// A history of merges, forks and commits sharing a second or going back in time, with
    /// branches, remote branches, lightweight and annotated tags on random commits.
    fn generated_history(seed: u64) -> (tempfile::TempDir, git2::Repository) {
        let directory = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(directory.path()).unwrap();
        let tree_oid = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let mut random = Seeded(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let mut commits: Vec<git2::Oid> = Vec::new();
        let mut seconds = 1_000_000_i64;
        for index in 0..(20 + random.below(60)) {
            seconds += match random.below(10) {
                0..=3 => 0,
                4 => -30,
                _ => i64::try_from(random.below(500)).unwrap(),
            };
            let mut parents = Vec::new();
            if !commits.is_empty() {
                let tail = commits.len() as u64;
                parents
                    .push(commits[usize::try_from(tail - 1 - random.below(tail.min(4))).unwrap()]);
                if random.below(5) == 0 {
                    let other = commits[usize::try_from(random.below(tail)).unwrap()];
                    if !parents.contains(&other) {
                        parents.push(other);
                    }
                }
            }
            let parents: Vec<git2::Commit> = parents
                .iter()
                .map(|&oid| repo.find_commit(oid).unwrap())
                .collect();
            let parents: Vec<&git2::Commit> = parents.iter().collect();
            // The author's clock runs backwards, so only the committer's time orders the walk.
            let author = signature(2_000_000 - seconds);
            let committer = signature(seconds);
            commits.push(
                repo.commit(
                    None,
                    &author,
                    &committer,
                    &format!("commit {index}"),
                    &tree,
                    &parents,
                )
                .unwrap(),
            );
        }
        let pick = |random: &mut Seeded| {
            commits[usize::try_from(random.below(commits.len() as u64)).unwrap()]
        };
        repo.reference("refs/heads/main", *commits.last().unwrap(), true, "fixture")
            .unwrap();
        for branch in 0..random.below(6) {
            repo.reference(
                &format!("refs/heads/b{branch}"),
                pick(&mut random),
                true,
                "fixture",
            )
            .unwrap();
        }
        for remote in 0..random.below(3) {
            repo.reference(
                &format!("refs/remotes/origin/r{remote}"),
                pick(&mut random),
                true,
                "fixture",
            )
            .unwrap();
        }
        for tag in 0..random.below(4) {
            let target = repo.find_object(pick(&mut random), None).unwrap();
            if random.below(2) == 0 {
                repo.tag(
                    &format!("t{tag}"),
                    &target,
                    &signature(seconds),
                    "annotated",
                    true,
                )
                .unwrap();
            } else {
                repo.tag_lightweight(&format!("t{tag}"), &target, true)
                    .unwrap();
            }
        }
        drop(tree);
        (directory, repo)
    }

    fn libgit2_order(repo: &git2::Repository, stashes: &[git2::Oid]) -> Vec<git2::Oid> {
        let mut revwalk = repo.revwalk().unwrap();
        revwalk.push_glob("refs/heads").unwrap();
        revwalk.push_glob("refs/remotes").unwrap();
        revwalk.push_glob("refs/tags").unwrap();
        for &stash in stashes {
            revwalk.push(stash).unwrap();
        }
        revwalk
            .set_sorting(git2::Sort::TIME | git2::Sort::TOPOLOGICAL)
            .unwrap();
        revwalk.collect::<Result<Vec<_>, _>>().unwrap()
    }

    fn ported_order(repo: &git2::Repository, stashes: &[git2::Oid]) -> Vec<git2::Oid> {
        let tips = walk_tips(repo, stashes).unwrap();
        walk_order(&tips, |oid| {
            let known = Known::read(repo, oid)?;
            Ok((known.parents.clone(), known.time))
        })
        .unwrap()
    }

    #[test]
    fn the_walk_orders_commits_as_libgit2s_topological_time_walk_does() {
        for seed in 1..=100 {
            let (_directory, repo) = generated_history(seed);

            let ported = ported_order(&repo, &[]);

            assert_eq!(ported, libgit2_order(&repo, &[]), "history seed {seed}");
        }
    }

    #[test]
    fn the_walk_starts_from_the_same_tips_as_libgit2s_globs_and_pushes() {
        for seed in 1..=40 {
            let (_directory, repo) = generated_history(seed);
            let main = repo.refname_to_id("refs/heads/main").unwrap();
            let head = repo.find_commit(main).unwrap();
            let tree = head.tree().unwrap();
            let blob = repo.blob(b"not a commit").unwrap();
            let off_ref = |message: &str, seconds: i64| {
                let sig = signature(seconds);
                repo.commit(None, &sig, &sig, message, &tree, &[&head])
                    .unwrap()
            };
            let stashes = [off_ref("stash a", 1_000_000), off_ref("stash b", 9_000_000)];
            repo.tag_lightweight("on-a-tree", tree.as_object(), true)
                .unwrap();
            repo.tag(
                "annotated-tree",
                tree.as_object(),
                &signature(1),
                "tree",
                true,
            )
            .unwrap();
            repo.tag_lightweight("on-a-blob", &repo.find_object(blob, None).unwrap(), true)
                .unwrap();
            repo.reference("refs/heads/feature/deep/x", main, true, "fixture")
                .unwrap();
            repo.reference("refs/remotes/origin/main", main, true, "fixture")
                .unwrap();
            repo.reference_symbolic(
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
                true,
                "fixture",
            )
            .unwrap();
            repo.reference_symbolic("refs/heads/to-nowhere", "refs/heads/gone", true, "fixture")
                .unwrap();
            let ported = ported_order(&repo, &stashes);

            assert_eq!(
                ported,
                libgit2_order(&repo, &stashes),
                "history seed {seed}"
            );
        }
    }

    #[test]
    fn a_branch_naming_a_missing_object_fails_the_walk_as_it_fails_libgit2s() {
        let (directory, repo) = generated_history(1);
        std::fs::write(
            directory.path().join(".git/refs/heads/missing"),
            "0123456789abcdef0123456789abcdef01234567\n",
        )
        .unwrap();

        let ported = walk_tips(&repo, &[]).map_err(|error| error.code);

        let mut revwalk = repo.revwalk().unwrap();
        let libgit2 = revwalk
            .push_glob("refs/heads")
            .map_err(|error| error.code());
        assert_eq!(libgit2, Err(git2::ErrorCode::NotFound));
        assert_eq!(ported, Err("git_not_found".to_owned()));
    }

    #[test]
    fn the_walk_stops_at_a_shallow_boundary_as_libgit2s_walk_does() {
        for seed in 1..=40 {
            let (directory, repo) = generated_history(seed);
            let main = repo.refname_to_id("refs/heads/main").unwrap();
            let boundary = repo.find_commit(main).unwrap().parent_id(0).unwrap();
            std::fs::write(
                directory.path().join(".git/shallow"),
                format!("{boundary}\n"),
            )
            .unwrap();
            let repo = git2::Repository::open(directory.path()).unwrap();

            let ported = ported_order(&repo, &[]);

            assert_eq!(ported, libgit2_order(&repo, &[]), "history seed {seed}");
        }
    }

    /// What `capture` gives for `repo` once nothing is remembered, in the committed form so
    /// two captures compare field by field.
    fn fresh_capture(repo: &mut git2::Repository) -> String {
        super::forget(repo.workdir().unwrap());
        remembered_capture(repo)
    }

    fn remembered_capture(repo: &mut git2::Repository) -> String {
        let source = super::capture(repo).unwrap();
        serde_json::to_string(&CapturedGraph::from_source(&source)).unwrap()
    }

    fn commit_on_main(repo: &git2::Repository, message: &str, parents: &[git2::Oid]) {
        let tree_oid = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let parents: Vec<git2::Commit> = parents
            .iter()
            .map(|&oid| repo.find_commit(oid).unwrap())
            .collect();
        let parents: Vec<&git2::Commit> = parents.iter().collect();
        let sig = signature(9_000_000);
        let oid = repo
            .commit(None, &sig, &sig, message, &tree, &parents)
            .unwrap();
        repo.reference("refs/heads/main", oid, true, "fixture")
            .unwrap();
    }

    #[test]
    fn a_recapture_after_history_moves_matches_a_capture_that_remembers_nothing() {
        for seed in 1..=20 {
            let (_directory, mut repo) = generated_history(seed);
            remembered_capture(&mut repo);
            let main = |repo: &git2::Repository| repo.refname_to_id("refs/heads/main").unwrap();

            let tip = main(&repo);
            commit_on_main(&repo, "a new commit", &[tip]);
            let after_commit = remembered_capture(&mut repo);
            assert_eq!(
                after_commit,
                fresh_capture(&mut repo),
                "seed {seed}, commit"
            );

            let parents: Vec<git2::Oid> = repo
                .find_commit(main(&repo))
                .unwrap()
                .parent_ids()
                .collect();
            commit_on_main(&repo, "the same commit, amended", &parents);
            let after_amend = remembered_capture(&mut repo);
            assert_eq!(after_amend, fresh_capture(&mut repo), "seed {seed}, amend");

            for branch in ["b0", "b1"] {
                if let Ok(mut branch) = repo.find_branch(branch, git2::BranchType::Local) {
                    branch.delete().unwrap();
                }
            }
            let after_delete = remembered_capture(&mut repo);
            assert_eq!(
                after_delete,
                fresh_capture(&mut repo),
                "seed {seed}, delete"
            );
        }
    }

    #[test]
    fn a_recapture_answers_the_commits_it_has_seen_from_what_it_read_before() {
        let (_directory, mut repo) = generated_history(7);
        let before = super::capture(&mut repo).unwrap();
        let tip = repo.refname_to_id("refs/heads/main").unwrap();
        commit_on_main(&repo, "a new commit", &[tip]);

        let after = super::capture(&mut repo).unwrap();

        let new_tip = repo.refname_to_id("refs/heads/main").unwrap();
        assert_eq!(after.commits[&new_tip].summary, "a new commit");
        for (oid, facts) in &before.commits {
            assert!(
                Arc::ptr_eq(facts, &after.commits[oid]),
                "{oid} was read again"
            );
        }
    }

    #[test]
    fn a_capture_after_forget_reads_every_commit_again() {
        let (directory, mut repo) = generated_history(7);
        let before = super::capture(&mut repo).unwrap();

        super::forget(directory.path());
        let after = super::capture(&mut repo).unwrap();

        let tip = repo.refname_to_id("refs/heads/main").unwrap();
        assert!(!Arc::ptr_eq(&before.commits[&tip], &after.commits[&tip]));
    }

    #[test]
    fn a_shallow_boundary_moving_drops_what_the_last_capture_read() {
        for seed in 1..=20 {
            let (directory, mut repo) = generated_history(seed);
            remembered_capture(&mut repo);
            let main = repo.refname_to_id("refs/heads/main").unwrap();
            let boundary = repo.find_commit(main).unwrap().parent_id(0).unwrap();
            std::fs::write(
                directory.path().join(".git/shallow"),
                format!("{boundary}\n"),
            )
            .unwrap();
            let mut repo = git2::Repository::open(directory.path()).unwrap();

            let shallow = remembered_capture(&mut repo);

            assert_eq!(shallow, fresh_capture(&mut repo), "seed {seed}");
        }
    }

    #[test]
    fn capture_observes_worktree_after_refs() {
        let directory = tempfile::tempdir().unwrap();
        let mut repo = git2::Repository::init(directory.path()).unwrap();
        let config = git2::Config::open(&repo.path().join("config")).unwrap();
        repo.set_config(&config).unwrap();
        let tree_oid = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let signature = git2::Signature::new(
            "Fixture",
            "fixture@example.invalid",
            &git2::Time::new(1_000, 0),
        )
        .unwrap();
        let oid = repo
            .commit(
                Some("refs/heads/main"),
                &signature,
                &signature,
                "initial",
                &tree,
                &[],
            )
            .unwrap();
        drop(tree);
        repo.set_head("refs/heads/main").unwrap();

        let captured = capture_with_worktree_reader(&mut repo, |repo| {
            std::fs::write(repo.workdir().unwrap().join("late.txt"), "late work").unwrap();
            repo.reference("refs/heads/late", oid, false, "fixture")
                .unwrap();
            crate::status::worktree_dirty(repo)
        })
        .unwrap();

        assert!(captured.placement.worktree_dirty);
        assert!(
            captured
                .refs
                .values()
                .flatten()
                .all(|label| label.name != "refs/heads/late")
        );
        assert!(repo.find_reference("refs/heads/late").is_ok());
    }
}

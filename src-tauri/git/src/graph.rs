use crate::error::TrunkError;
use crate::graph_input::{CommitFacts, GraphSnapshot, GraphSource, RefVisibility};
use crate::placement::PlacementInput;
use crate::repository;
use crate::status;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

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
    walked: &[(git2::Oid, Arc<WalkedCommit>)],
    seeds: [Option<git2::Oid>; 2],
) -> HashMap<git2::Oid, Vec<git2::Oid>> {
    let mut parents: HashMap<git2::Oid, Vec<git2::Oid>> = walked
        .iter()
        .map(|(oid, commit)| (*oid, commit.parents.clone()))
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
/// capture read answers every later capture of the same repository, for as long as the
/// graft files it was read under stay as they were.
struct WalkedCommit {
    parents: Vec<git2::Oid>,
    committer_time: i64,
    facts: Arc<CommitFacts>,
}

impl WalkedCommit {
    fn read(repo: &git2::Repository, oid: git2::Oid) -> Result<Arc<Self>, TrunkError> {
        let commit = repo.find_commit(oid)?;
        let author = commit.author();
        let facts = CommitFacts {
            summary: commit.summary().ok().flatten().unwrap_or("").to_owned(),
            body: commit
                .body()
                .ok()
                .flatten()
                .map(std::borrow::ToOwned::to_owned),
            author_name: author.name().unwrap_or("").to_owned(),
            author_email: author.email().unwrap_or("").to_owned(),
            author_timestamp: author.when().seconds(),
        };

        Ok(Arc::new(Self {
            parents: commit.parent_ids().collect(),
            committer_time: commit.time().seconds(),
            facts: Arc::new(facts),
        }))
    }
}

/// What one open repository's captures have read, so each reads only what the last did not.
///
/// Every command opens a repository handle of its own, and a fresh handle has an empty
/// object cache, so without a memo every capture reads the whole history again.
///
/// Whoever holds the repository open holds its memo, and dropping the memo is what frees
/// the commits, so a capture still running when the repository closes keeps nothing alive.
#[derive(Default)]
pub struct CommitMemo(Mutex<Option<Arc<Walk>>>);

impl std::fmt::Debug for CommitMemo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let commits = self.lock().as_ref().map_or(0, |walk| walk.commits.len());
        f.debug_struct("CommitMemo")
            .field("commits", &commits)
            .finish()
    }
}

impl CommitMemo {
    /// What the last capture walked, when it was read under exactly `grafts`.
    fn remembered(&self, grafts: &Grafts) -> Option<Arc<Walk>> {
        self.lock()
            .as_ref()
            .filter(|walk| walk.grafts == *grafts)
            .cloned()
    }

    fn keep(&self, walk: Walk) {
        // The guard is a temporary, so the walk this replaces is freed after the lock is
        // released rather than under it.
        let replaced = self.lock().replace(Arc::new(walk));
        drop(replaced);
    }

    fn lock(&self) -> MutexGuard<'_, Option<Arc<Walk>>> {
        // A walk is replaced whole, never edited in place, so a panic cannot leave one torn.
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The commits one capture walked, and the graft files it read them under: libgit2
/// rewrites a commit's parents from `info/grafts` and `shallow`, so once either file
/// changes, nothing read before it can be trusted.
struct Walk {
    grafts: Grafts,
    commits: WalkedCommits,
}

type WalkedCommits = HashMap<git2::Oid, Arc<WalkedCommit>>;

#[derive(PartialEq, Eq)]
struct Grafts {
    info_grafts: Option<Vec<u8>>,
    shallow: Option<Vec<u8>>,
}

impl Grafts {
    /// The graft files as they are on disk now, from where libgit2 reads them. `None` when
    /// one exists but will not read, which leaves nothing to compare a memo against.
    fn read(repo: &git2::Repository) -> Option<Self> {
        Some(Self {
            info_grafts: read_graft_file(&repo.commondir().join("info/grafts")).ok()?,
            shallow: read_graft_file(&repo.path().join("shallow")).ok()?,
        })
    }
}

/// A graft file's bytes, or `None` when there is no such file. Reads only the size the file
/// reports, as libgit2 does, so a `shallow` linked to `/dev/zero` reads as empty rather
/// than without end.
fn read_graft_file(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let size = file.metadata()?.len();

    let mut bytes = Vec::new();
    file.take(size).read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

/// One commit as the walk sees it.
struct WalkNode {
    oid: git2::Oid,
    parents: Vec<usize>,
    committer_time: i64,
    /// A commit is ready to go out once none of its children are left to.
    children_left: usize,
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
    let mut index_of = |nodes: &mut Vec<WalkNode>, oid: git2::Oid| {
        *index.entry(oid).or_insert_with(|| {
            nodes.push(WalkNode {
                oid,
                parents: Vec::new(),
                committer_time: 0,
                children_left: 0,
            });
            nodes.len() - 1
        })
    };

    // A tip pushed twice starts the walk once, from where it was first pushed.
    let mut starts = Vec::new();
    for &tip in tips.iter().rev() {
        let nodes_before = nodes.len();
        let tip_index = index_of(&mut nodes, tip);
        if nodes.len() > nodes_before {
            starts.push(tip_index);
        }
    }

    // Read every commit the tips reach, once each. A commit that will not read fails the
    // walk, as it fails libgit2's.
    let mut cursor = 0;
    while cursor < nodes.len() {
        let (parents, committer_time) = read(nodes[cursor].oid)?;
        let parents: Vec<usize> = parents
            .into_iter()
            .map(|parent| index_of(&mut nodes, parent))
            .collect();
        for &parent in &parents {
            nodes[parent].children_left += 1;
        }
        nodes[cursor].parents = parents;
        nodes[cursor].committer_time = committer_time;
        cursor += 1;
    }

    let mut ready = TimeHeap::default();
    for &start in &starts {
        if nodes[start].children_left == 0 {
            ready.insert(&nodes, start);
        }
    }

    let mut order = Vec::with_capacity(nodes.len());
    while let Some(next) = ready.pop(&nodes) {
        for edge in 0..nodes[next].parents.len() {
            let parent = nodes[next].parents[edge];
            nodes[parent].children_left -= 1;
            if nodes[parent].children_left == 0 {
                ready.insert(&nodes, parent);
            }
        }
        order.push(nodes[next].oid);
    }

    Ok(order)
}

/// libgit2's `git_pqueue` keyed on commit time, newest on top, with its exact sift rules,
/// since which of two commits of the same second comes out first is decided by them.
#[derive(Default)]
struct TimeHeap(Vec<usize>);

impl TimeHeap {
    /// Whether `a` belongs below `b`, which is when `git_commit_list_time_cmp` answers
    /// that `a` is the older.
    const fn below(nodes: &[WalkNode], a: usize, b: usize) -> bool {
        nodes[a].committer_time < nodes[b].committer_time
    }

    fn insert(&mut self, nodes: &[WalkNode], node: usize) {
        let heap = &mut self.0;
        heap.push(node);

        let mut slot = heap.len() - 1;
        while slot > 0 {
            let parent = (slot - 1) >> 1;
            if !Self::below(nodes, heap[parent], node) {
                break;
            }
            heap[slot] = heap[parent];
            slot = parent;
        }
        heap[slot] = node;
    }

    fn pop(&mut self, nodes: &[WalkNode]) -> Option<usize> {
        let heap = &mut self.0;
        let top = *heap.first()?;
        let last = heap.pop()?;
        if heap.is_empty() {
            return Some(top);
        }

        let mut slot = 0;
        loop {
            let mut kid = 2 * slot + 1;
            if kid >= heap.len() {
                break;
            }
            if kid + 1 < heap.len() && Self::below(nodes, heap[kid], heap[kid + 1]) {
                kid += 1;
            }
            if !Self::below(nodes, last, heap[kid]) {
                break;
            }
            heap[slot] = heap[kid];
            slot = kid;
        }
        heap[slot] = last;

        Some(top)
    }
}

/// The walk from `tips`, with everything it read from each commit. A commit `previous`
/// holds is answered from it, so only the commits it lacks are read from `objects`.
fn walk_reading(
    objects: &git2::Repository,
    tips: &[git2::Oid],
    previous: Option<&Walk>,
) -> Result<(Vec<git2::Oid>, WalkedCommits), TrunkError> {
    let mut walked = WalkedCommits::new();
    let order = walk_order(tips, |oid| {
        let commit = match previous.and_then(|walk| walk.commits.get(&oid)) {
            Some(commit) => Arc::clone(commit),
            None => WalkedCommit::read(objects, oid)?,
        };
        let read = (commit.parents.clone(), commit.committer_time);
        walked.insert(oid, commit);
        Ok(read)
    })?;

    Ok((order, walked))
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
    capture_with_worktree_reader(repo, &CommitMemo::default(), status::worktree_dirty)
}

/// `capture`, reading only the commits `memo` does not hold yet, and leaving it holding
/// what this capture walked. Pass the same memo for every capture of one open repository.
///
/// # Errors
///
/// As `capture`, and the git error when the repository will not open a second handle.
pub fn capture_remembering(
    repo: &mut git2::Repository,
    memo: &CommitMemo,
) -> Result<GraphSource, TrunkError> {
    capture_with_worktree_reader(repo, memo, status::worktree_dirty)
}

fn capture_with_worktree_reader(
    repo: &mut git2::Repository,
    memo: &CommitMemo,
    read_worktree: impl FnOnce(&git2::Repository) -> bool,
) -> Result<GraphSource, TrunkError> {
    // libgit2 reads the graft files once, as a handle opens, and parses every commit under
    // them after, so the handle the caller opened may hold files older than these. Every
    // commit is parsed through a handle opened after this read, which therefore parses
    // under these files or newer ones, and the memo keeps this walk only when the files
    // still read the same once it is done.
    let grafts = Grafts::read(repo);
    let objects = git2::Repository::open(repo.path())?;

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
        let Ok(commit) = objects.find_commit(s_oid) else {
            continue;
        };

        let parents: Vec<git2::Oid> = commit.parent_ids().collect();
        if parents.iter().any(|&p| objects.find_commit(p).is_err()) {
            continue;
        }

        stash_internals.extend(parents.iter().skip(1));
        walkable_stashes.push(s_oid);
    }

    // Step 2: Collect all OIDs. Stashes ride the same walk as the refs, so the topological
    // order places each one above its parent whatever its committer time says. A commit
    // the last capture read is answered from the memo, so a rebuild after a commit reads
    // only the commits that are new.
    let tips = walk_tips(&objects, &walkable_stashes)?;
    let previous = grafts.as_ref().and_then(|grafts| memo.remembered(grafts));
    let (mut oids, walked) = walk_reading(&objects, &tips, previous.as_deref())?;
    oids.retain(|oid| !stash_internals.contains(oid));
    let members: Vec<(git2::Oid, Arc<WalkedCommit>)> = oids
        .iter()
        .map(|oid| (*oid, Arc::clone(&walked[oid])))
        .collect();

    if let Some(grafts) = grafts
        && Grafts::read(repo).as_ref() == Some(&grafts)
    {
        memo.keep(Walk {
            grafts,
            commits: walked,
        });
    }

    // Step 3b: Gather everything lane assignment reads. An unborn HEAD leaves `head_tip`
    // None, which is what keeps a fresh repository laying out at all.
    let head_tip = repo.head().ok().and_then(|head_ref| head_ref.target());
    let tracked_upstream = tracked_upstream_oid(repo);
    let parents = parent_map(&objects, &members, [head_tip, tracked_upstream]);

    let commits: HashMap<git2::Oid, Arc<CommitFacts>> = members
        .iter()
        .map(|(oid, commit)| (*oid, Arc::clone(&commit.facts)))
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
    capture_with_worktree_reader(repo, &CommitMemo::default(), read_worktree)
}

/// The whole history laid out under `visibility`, together with the capture it came from,
/// which is what the commit cache holds so a later visibility change needs no repository.
///
/// It remembers nothing between calls, so every call is a cold capture, which is what the
/// benches built on it measure. The app captures through `capture_remembering` with the
/// memo its open repository owns, and wraps the result in `GraphSnapshot::new` itself.
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
    use super::{CommitMemo, WalkedCommit, walk_order, walk_tips};
    use crate::graph_input::{CapturedGraph, GraphSource};
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
            let commit = WalkedCommit::read(repo, oid)?;
            Ok((commit.parents.clone(), commit.committer_time))
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

    /// A capture in the committed form, so two captures compare field by field.
    fn committed(source: &GraphSource) -> String {
        serde_json::to_string(&CapturedGraph::from_source(source)).unwrap()
    }

    fn fresh_capture(repo: &mut git2::Repository) -> String {
        committed(&super::capture(repo).unwrap())
    }

    fn remembering(repo: &mut git2::Repository, memo: &CommitMemo) -> String {
        committed(&super::capture_remembering(repo, memo).unwrap())
    }

    fn commit_on(repo: &git2::Repository, message: &str, parents: &[git2::Oid]) -> git2::Oid {
        let tree_oid = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let parents: Vec<git2::Commit> = parents
            .iter()
            .map(|&oid| repo.find_commit(oid).unwrap())
            .collect();
        let parents: Vec<&git2::Commit> = parents.iter().collect();
        let sig = signature(9_000_000);

        repo.commit(None, &sig, &sig, message, &tree, &parents)
            .unwrap()
    }

    fn main_tip(repo: &git2::Repository) -> git2::Oid {
        repo.refname_to_id("refs/heads/main").unwrap()
    }

    /// Check out `main` with a file of its own, so the history can stash.
    fn on_main_with_a_file(repo: &git2::Repository) {
        repo.set_head("refs/heads/main").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        let workdir = repo.workdir().unwrap();
        std::fs::write(workdir.join("work.txt"), "work").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("work.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let head = repo.find_commit(main_tip(repo)).unwrap();
        let sig = signature(9_000_000);
        repo.commit(Some("HEAD"), &sig, &sig, "add work", &tree, &[&head])
            .unwrap();
    }

    fn stash_an_edit(repo: &mut git2::Repository) {
        let workdir = repo.workdir().unwrap().to_owned();
        std::fs::write(workdir.join("work.txt"), "edited").unwrap();
        repo.stash_save(&signature(9_000_100), "an edit", None)
            .unwrap();
    }

    /// For each generated history: run `prepare`, capture into a memo, run `history_move`,
    /// and compare the capture the memo answers with one that remembers nothing.
    fn assert_recapture_matches_a_fresh_one(
        prepare: impl Fn(&mut git2::Repository),
        history_move: impl Fn(&mut git2::Repository),
    ) {
        for seed in 1..=10 {
            let (_directory, mut repo) = generated_history(seed);
            prepare(&mut repo);
            let memo = CommitMemo::default();
            remembering(&mut repo, &memo);

            history_move(&mut repo);
            let recaptured = remembering(&mut repo, &memo);

            assert_eq!(recaptured, fresh_capture(&mut repo), "history seed {seed}");
        }
    }

    #[test]
    fn a_recapture_after_a_commit_matches_a_capture_that_remembers_nothing() {
        assert_recapture_matches_a_fresh_one(
            |_| {},
            |repo| {
                let commit = commit_on(repo, "a new commit", &[main_tip(repo)]);
                repo.reference("refs/heads/main", commit, true, "fixture")
                    .unwrap();
            },
        );
    }

    #[test]
    fn a_recapture_after_an_amend_matches_a_capture_that_remembers_nothing() {
        assert_recapture_matches_a_fresh_one(
            |_| {},
            |repo| {
                let parents: Vec<git2::Oid> = repo
                    .find_commit(main_tip(repo))
                    .unwrap()
                    .parent_ids()
                    .collect();
                let amended = commit_on(repo, "main's tip, amended", &parents);
                repo.reference("refs/heads/main", amended, true, "fixture")
                    .unwrap();
            },
        );
    }

    #[test]
    fn a_recapture_after_a_branch_is_deleted_matches_a_capture_that_remembers_nothing() {
        assert_recapture_matches_a_fresh_one(
            |_| {},
            |repo| {
                repo.find_reference("refs/heads/main")
                    .unwrap()
                    .delete()
                    .unwrap();
            },
        );
    }

    #[test]
    fn a_recapture_after_a_checkout_matches_a_capture_that_remembers_nothing() {
        assert_recapture_matches_a_fresh_one(
            |_| {},
            |repo| {
                let parent = repo.find_commit(main_tip(repo)).unwrap().parent_id(0);
                repo.set_head_detached(parent.unwrap_or_else(|_| main_tip(repo)))
                    .unwrap();
            },
        );
    }

    #[test]
    fn a_recapture_after_a_fetch_matches_a_capture_that_remembers_nothing() {
        assert_recapture_matches_a_fresh_one(
            |_| {},
            |repo| {
                let fetched = commit_on(repo, "a fetched commit", &[main_tip(repo)]);
                repo.reference("refs/remotes/origin/fetched", fetched, true, "fixture")
                    .unwrap();
            },
        );
    }

    #[test]
    fn a_recapture_after_a_stash_matches_a_capture_that_remembers_nothing() {
        assert_recapture_matches_a_fresh_one(|repo| on_main_with_a_file(repo), stash_an_edit);
    }

    #[test]
    fn a_recapture_after_a_stash_pop_matches_a_capture_that_remembers_nothing() {
        assert_recapture_matches_a_fresh_one(
            |repo| {
                on_main_with_a_file(repo);
                stash_an_edit(repo);
            },
            |repo| repo.stash_pop(0, None).unwrap(),
        );
    }

    #[test]
    fn a_recapture_answers_the_commits_it_has_seen_from_what_it_read_before() {
        let (_directory, mut repo) = generated_history(7);
        let memo = CommitMemo::default();
        let before = super::capture_remembering(&mut repo, &memo).unwrap();
        let commit = commit_on(&repo, "a new commit", &[main_tip(&repo)]);
        repo.reference("refs/heads/main", commit, true, "fixture")
            .unwrap();

        let after = super::capture_remembering(&mut repo, &memo).unwrap();

        for (oid, facts) in &before.commits {
            assert!(
                Arc::ptr_eq(facts, &after.commits[oid]),
                "{oid} was read again"
            );
        }
    }

    #[test]
    fn a_shallow_boundary_moving_drops_what_the_last_capture_read() {
        for seed in 1..=20 {
            let (directory, mut repo) = generated_history(seed);
            let memo = CommitMemo::default();
            remembering(&mut repo, &memo);
            let boundary = repo
                .find_commit(main_tip(&repo))
                .unwrap()
                .parent_id(0)
                .unwrap();
            std::fs::write(
                directory.path().join(".git/shallow"),
                format!("{boundary}\n"),
            )
            .unwrap();
            let mut repo = git2::Repository::open(directory.path()).unwrap();

            let shallow = remembering(&mut repo, &memo);

            assert_eq!(shallow, fresh_capture(&mut repo), "history seed {seed}");
        }
    }

    /// libgit2 reads `shallow` as a handle opens, so a handle opened before the file went
    /// still parses the boundary commit as parentless.
    #[test]
    fn a_shallow_boundary_gone_before_the_capture_is_gone_from_it_and_from_the_next() {
        for seed in 1..=20 {
            let (directory, repo) = generated_history(seed);
            let boundary = repo
                .find_commit(main_tip(&repo))
                .unwrap()
                .parent_id(0)
                .unwrap();
            let shallow = directory.path().join(".git/shallow");
            std::fs::write(&shallow, format!("{boundary}\n")).unwrap();
            let mut opened_while_shallow = git2::Repository::open(directory.path()).unwrap();
            std::fs::remove_file(&shallow).unwrap();
            let memo = CommitMemo::default();

            let first = remembering(&mut opened_while_shallow, &memo);
            let mut repo = git2::Repository::open(directory.path()).unwrap();
            let next = remembering(&mut repo, &memo);

            let full = fresh_capture(&mut repo);
            assert_eq!(first, full, "history seed {seed}, first");
            assert_eq!(next, full, "history seed {seed}, next");
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

        let captured = capture_with_worktree_reader(&mut repo, &CommitMemo::default(), |repo| {
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

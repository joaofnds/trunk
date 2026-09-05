use crate::error::TrunkError;
use crate::git::graph_input::{CommitFacts, GraphSnapshot, GraphSource, RefVisibility};
use crate::git::placement::PlacementInput;
use crate::git::repository;
use crate::git::status;
use std::collections::HashMap;
use std::collections::HashSet;

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
    oids: &[git2::Oid],
    seeds: [Option<git2::Oid>; 2],
) -> Result<HashMap<git2::Oid, Vec<git2::Oid>>, TrunkError> {
    let mut parents: HashMap<git2::Oid, Vec<git2::Oid>> = HashMap::new();

    for &oid in oids {
        let commit = repo.find_commit(oid)?;
        parents.insert(oid, commit.parent_ids().collect());
    }

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

    Ok(parents)
}

/// Everything one walk reads from the repository, in one pass. Every git2 call in the
/// commit-graph pipeline lives here; `graph_input::layout` takes it from plain data.
/// Read everything one graph walk needs out of a repository.
///
/// # Errors
///
/// Returns the git error when the revwalk, the refs, or the stash reflog will
/// not read.
pub fn capture(repo: &mut git2::Repository) -> Result<GraphSource, TrunkError> {
    // Step 0: Worktree state, read once — the frontend draws a WIP row in column 0
    // whenever this is true, so inline stash placement has to yield the lane.
    let worktree_dirty = status::worktree_dirty(repo);

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

    // Step 2: Collect all OIDs via revwalk. Stashes ride the same walk as the refs, so
    // TOPOLOGICAL sorting places each one above its parent whatever its committer time says.
    let mut revwalk = repo.revwalk()?;
    revwalk.push_glob("refs/heads")?;
    revwalk.push_glob("refs/remotes")?;
    revwalk.push_glob("refs/tags")?;
    for &s_oid in &walkable_stashes {
        revwalk.push(s_oid)?;
    }
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    let mut oids: Vec<git2::Oid> = revwalk.collect::<Result<Vec<_>, _>>()?;
    oids.retain(|oid| !stash_internals.contains(oid));

    // Step 3b: Gather everything lane assignment reads. An unborn HEAD leaves `head_tip`
    // None, which is what keeps a fresh repository laying out at all.
    let head_tip = repo.head().ok().and_then(|head_ref| head_ref.target());
    let tracked_upstream = tracked_upstream_oid(repo);
    let parents = parent_map(repo, &oids, [head_tip, tracked_upstream])?;

    let mut commits: HashMap<git2::Oid, CommitFacts> = HashMap::new();
    for &oid in &oids {
        let commit = repo.find_commit(oid)?;
        let author = commit.author();
        commits.insert(
            oid,
            CommitFacts {
                summary: commit.summary().ok().flatten().unwrap_or("").to_owned(),
                body: commit
                    .body()
                    .ok()
                    .flatten()
                    .map(std::borrow::ToOwned::to_owned),
                author_name: author.name().unwrap_or("").to_owned(),
                author_email: author.email().unwrap_or("").to_owned(),
                author_timestamp: author.when().seconds(),
            },
        );
    }

    // Only a page member is ever hydrated, and a page is a subset of the walk, so a ref on
    // anything else would only make the captured file bigger.
    let refs = oids
        .iter()
        .filter_map(|oid| ref_map.get(oid).map(|labels| (*oid, labels.clone())))
        .collect();

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

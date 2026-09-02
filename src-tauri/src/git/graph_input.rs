//! The commit facts lane assignment does not read, and the hydration that turns a layout
//! back into `GraphResult`.
//!
//! `GraphSource` is everything `walk_commits` learns from a repository. Production builds it
//! with `graph::capture`; the golden suite parses it from a committed file. Both reach the
//! same `layout`, so a golden stays evidence about production for that half of the pipeline.

use std::collections::{BTreeMap, HashMap, HashSet};

use git2::Oid;
use serde::{Deserialize, Serialize};

use crate::git::placement::{self, PlacementInput};
use crate::git::types::{GraphCommit, GraphResult, RefLabel, RefType};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitFacts {
    pub summary: String,
    pub body: Option<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_timestamp: i64,
}

/// Everything one walk reads from a repository. `commits` is keyed over the walk members;
/// `refs` is filtered to them, since only a page member is ever hydrated. `stash_order`
/// carries `stash_foreach`'s order, which the algorithm does not need and the serialized
/// form does — a `HashSet`'s iteration order would differ between processes.
#[derive(Debug, Clone)]
pub struct GraphSource {
    pub placement: PlacementInput,
    pub commits: HashMap<Oid, CommitFacts>,
    pub refs: HashMap<Oid, Vec<RefLabel>>,
    pub stash_order: Vec<Oid>,
}

/// One fixture's committed input: the capture, plus the `wipCount` the app would pass
/// alongside the layout.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FixtureInput {
    #[serde(rename = "wipCount")]
    pub wip_count: usize,
    pub capture: CapturedGraph,
}

/// The committed form of a `GraphSource`. Every map is a `BTreeMap` and `stashes` is the
/// `stash_foreach` order rather than the algorithm's set, so two captures of one repository
/// produce the same bytes. This shape never appears on a production path — routing the app
/// through it would cost an OID round-trip per commit on every graph refresh.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapturedGraph {
    pub oids: Vec<String>,
    pub parents: BTreeMap<String, Vec<String>>,
    pub stashes: Vec<String>,
    pub head_tip: Option<String>,
    pub tracked_upstream: Option<String>,
    pub worktree_dirty: bool,
    pub commits: BTreeMap<String, CommitFacts>,
    pub refs: BTreeMap<String, Vec<RefLabel>>,
}

/// `Oid::from_str` accepts 1 to 40 hex characters and zero-pads the rest, so a truncated
/// OID would parse cleanly into a different commit. The length check is what stops that.
fn parse_oid(hex: &str) -> Oid {
    if hex.len() != 40 {
        panic!("graph_input: malformed oid {hex}");
    }

    match Oid::from_str(hex) {
        Ok(oid) => oid,
        Err(_) => panic!("graph_input: malformed oid {hex}"),
    }
}

fn hex(oid: &Oid) -> String {
    oid.to_string()
}

impl CapturedGraph {
    pub fn from_source(source: &GraphSource) -> CapturedGraph {
        let placement = &source.placement;

        CapturedGraph {
            oids: placement.oids.iter().map(hex).collect(),
            parents: placement
                .parents
                .iter()
                .map(|(oid, ps)| (hex(oid), ps.iter().map(hex).collect()))
                .collect(),
            stashes: source.stash_order.iter().map(hex).collect(),
            head_tip: placement.head_tip.as_ref().map(hex),
            tracked_upstream: placement.tracked_upstream.as_ref().map(hex),
            worktree_dirty: placement.worktree_dirty,
            commits: source
                .commits
                .iter()
                .map(|(oid, facts)| (hex(oid), facts.clone()))
                .collect(),
            refs: source
                .refs
                .iter()
                .map(|(oid, labels)| (hex(oid), labels.clone()))
                .collect(),
        }
    }

    pub fn to_source(&self) -> GraphSource {
        let stash_order: Vec<Oid> = self.stashes.iter().map(|s| parse_oid(s)).collect();

        GraphSource {
            placement: PlacementInput {
                oids: self.oids.iter().map(|s| parse_oid(s)).collect(),
                parents: self
                    .parents
                    .iter()
                    .map(|(oid, ps)| (parse_oid(oid), ps.iter().map(|p| parse_oid(p)).collect()))
                    .collect(),
                stashes: stash_order.iter().copied().collect::<HashSet<Oid>>(),
                head_tip: self.head_tip.as_deref().map(parse_oid),
                tracked_upstream: self.tracked_upstream.as_deref().map(parse_oid),
                worktree_dirty: self.worktree_dirty,
            },
            commits: self
                .commits
                .iter()
                .map(|(oid, facts)| (parse_oid(oid), facts.clone()))
                .collect(),
            refs: self
                .refs
                .iter()
                .map(|(oid, labels)| (parse_oid(oid), labels.clone()))
                .collect(),
            stash_order,
        }
    }
}

/// Which refs the user has hidden from the graph, as the frontend states it. Empty means
/// everything is visible, which is what a repository with no stored preference gets.
///
/// A label is hidden when any rule matches it. HEAD's own branch is never hidden: column 0,
/// the WIP row and the head-lane extension all assume `head_tip` is in the walk.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RefVisibility {
    /// Full ref names, as `RefLabel::name` carries them.
    pub hidden_refs: HashSet<String>,
    /// Remote names — `origin` hides every `refs/remotes/origin/*`.
    pub hidden_remotes: HashSet<String>,
    /// Stash commit OIDs in hex. A stash has no stable name, so it is keyed by its commit.
    pub hidden_stashes: HashSet<String>,
    pub hide_local: bool,
    pub hide_remote: bool,
    pub hide_tags: bool,
    pub hide_stashes: bool,
}

/// The remote a `refs/remotes/<remote>/<branch>` name belongs to.
///
/// A remote name may itself contain slashes, so the branch cannot be split off from the
/// right. Nothing here knows the configured remotes, so this takes the first segment, which
/// is what the sidebar groups by.
fn remote_of(name: &str) -> Option<&str> {
    name.strip_prefix("refs/remotes/")?.split('/').next()
}

impl RefVisibility {
    pub fn is_empty(&self) -> bool {
        *self == RefVisibility::default()
    }

    fn hides(&self, label: &RefLabel) -> bool {
        if label.is_head {
            return false;
        }

        let by_type = match label.ref_type {
            RefType::LocalBranch => self.hide_local,
            RefType::RemoteBranch => self.hide_remote,
            RefType::Tag => self.hide_tags,
            RefType::Stash => self.hide_stashes,
        };

        let by_remote = match label.ref_type {
            RefType::RemoteBranch => {
                remote_of(&label.name).is_some_and(|remote| self.hidden_remotes.contains(remote))
            }
            _ => false,
        };

        by_type || by_remote || self.hidden_refs.contains(&label.name)
    }

    fn hides_stash(&self, oid: Oid) -> bool {
        self.hide_stashes || self.hidden_stashes.contains(&oid.to_string())
    }
}

/// The pure stage between capture and placement: drop the hidden labels, then drop every
/// commit only they reached.
///
/// The roots are the commits the surviving labels point at, plus the visible stashes, plus
/// `head_tip` and `tracked_upstream`, which the head lane and its extension are entitled to
/// whatever the refs say. Reachability is a pass over `PlacementInput::parents`, which
/// carries a full parent list for every walk member, so no repository is read here.
///
/// The surviving OIDs keep the capture's order. A subsequence of a topological order is
/// still topological over an ancestor-closed subset, so placement sees the walk it expects.
pub fn apply_visibility(source: &GraphSource, visibility: &RefVisibility) -> GraphSource {
    if visibility.is_empty() {
        return source.clone();
    }

    let mut refs: HashMap<Oid, Vec<RefLabel>> = HashMap::new();
    for (&oid, labels) in &source.refs {
        let kept: Vec<RefLabel> = labels
            .iter()
            .filter(|label| !visibility.hides(label))
            .cloned()
            .collect();
        if !kept.is_empty() {
            refs.insert(oid, kept);
        }
    }

    let stash_order: Vec<Oid> = source
        .stash_order
        .iter()
        .copied()
        .filter(|&oid| !visibility.hides_stash(oid))
        .collect();

    let mut roots: Vec<Oid> = refs.keys().copied().collect();
    roots.extend(stash_order.iter().copied());
    roots.extend(source.placement.head_tip);
    roots.extend(source.placement.tracked_upstream);

    let reachable = reachable_from(&source.placement, &roots);

    let oids: Vec<Oid> = source
        .placement
        .oids
        .iter()
        .copied()
        .filter(|oid| reachable.contains(oid))
        .collect();

    GraphSource {
        placement: PlacementInput {
            parents: source
                .placement
                .parents
                .iter()
                .filter(|(oid, _)| reachable.contains(oid))
                .map(|(&oid, list)| (oid, list.clone()))
                .collect(),
            stashes: source
                .placement
                .stashes
                .iter()
                .copied()
                .filter(|oid| reachable.contains(oid))
                .collect(),
            oids,
            head_tip: source.placement.head_tip,
            tracked_upstream: source.placement.tracked_upstream,
            worktree_dirty: source.placement.worktree_dirty,
        },
        commits: source
            .commits
            .iter()
            .filter(|(oid, _)| reachable.contains(oid))
            .map(|(&oid, facts)| (oid, facts.clone()))
            .collect(),
        refs: refs
            .into_iter()
            .filter(|(oid, _)| reachable.contains(oid))
            .collect(),
        stash_order: stash_order
            .into_iter()
            .filter(|oid| reachable.contains(oid))
            .collect(),
    }
}

/// Every OID reachable from `roots` through `parents`, roots included.
///
/// A parent absent from the map is a walk edge, not a defect: `parent_map` closes the
/// first-parent chains above `head_tip` and `tracked_upstream` past the walk, and every
/// other list stops at whatever the walk reached. Descending into one and keeping it is what
/// preserves those chains for the head lane's extension.
fn reachable_from(placement: &PlacementInput, roots: &[Oid]) -> HashSet<Oid> {
    let mut seen: HashSet<Oid> = HashSet::new();
    let mut stack: Vec<Oid> = Vec::new();

    for &root in roots {
        if placement.parents.contains_key(&root) && seen.insert(root) {
            stack.push(root);
        }
    }

    while let Some(oid) = stack.pop() {
        let Some(parents) = placement.parents.get(&oid) else {
            continue;
        };
        for &parent in parents {
            if placement.parents.contains_key(&parent) && seen.insert(parent) {
                stack.push(parent);
            }
        }
    }

    seen
}

/// Ref precedence when one commit carries several, matching the frontend's `sortRefs` so a
/// lane's name and the pill on its tip are always the same ref: HEAD first, then local
/// branch, tag, stash, remote branch.
fn ref_rank(label: &RefLabel) -> (u8, u8) {
    let by_type = match label.ref_type {
        RefType::LocalBranch => 0,
        RefType::Tag => 1,
        RefType::Stash => 2,
        RefType::RemoteBranch => 3,
    };

    (u8::from(!label.is_head), by_type)
}

/// The ref naming the lane `claim` opened, or `None` when nothing points at that commit.
///
/// Resolved against the whole walk rather than the page, which is what lets a row name a
/// lane whose tip has not been paged in yet.
fn lane_ref(source: &GraphSource, claim: Option<Oid>) -> Option<RefLabel> {
    source
        .refs
        .get(&claim?)?
        .iter()
        .min_by_key(|label| ref_rank(label))
        .cloned()
}

fn commit_facts(source: &GraphSource, oid: Oid) -> &CommitFacts {
    match source.commits.get(&oid) {
        Some(facts) => facts,
        None => panic!("graph_input: no commit facts for {oid}"),
    }
}

fn parent_list(source: &GraphSource, oid: Oid) -> &[Oid] {
    match source.placement.parents.get(&oid) {
        Some(list) => list,
        None => panic!("graph_input: no parent list for {oid}"),
    }
}

pub fn layout(source: &GraphSource, offset: usize, limit: usize) -> GraphResult {
    let oids = &source.placement.oids;
    let start = offset.min(oids.len());
    let end = (offset + limit).min(oids.len());
    let page_oids = &oids[start..end];

    let mut assigned = placement::assign_lanes(&source.placement);

    let mut commits = Vec::with_capacity(page_oids.len());
    for &oid in page_oids {
        let facts = commit_facts(source, oid);
        let (column, edges, color_index, is_branch_tip, is_stash, claim) = assigned
            .placements
            .remove(&oid)
            .map(|p| {
                (
                    p.column,
                    p.edges,
                    p.color_index,
                    p.is_branch_tip,
                    p.is_stash,
                    p.lane_claim,
                )
            })
            .unwrap_or((0, vec![], 0, false, false, None));
        let mut refs = source.refs.get(&oid).cloned().unwrap_or_default();
        for r in &mut refs {
            r.color_index = color_index;
        }
        let is_head = refs.iter().any(|r| r.is_head);

        let parents = parent_list(source, oid);
        let is_merge = !is_stash && parents.len() >= 2;
        // For stash commits, only expose the first parent (base commit)
        let parent_oids: Vec<String> = if is_stash {
            parents.first().map(|o| o.to_string()).into_iter().collect()
        } else {
            parents.iter().map(|o| o.to_string()).collect()
        };
        let short_oid = &oid.to_string()[..7];

        commits.push(GraphCommit {
            oid: oid.to_string(),
            short_oid: short_oid.to_owned(),
            summary: facts.summary.clone(),
            body: facts.body.clone(),
            author_name: facts.author_name.clone(),
            author_email: facts.author_email.clone(),
            author_timestamp: facts.author_timestamp,
            parent_oids,
            column,
            color_index,
            edges,
            refs,
            is_head,
            is_merge,
            is_branch_tip,
            is_stash,
            in_head_chain: assigned.head_chain.contains(&oid),
            // Recoloured to this row's lane like the row's own refs above: the name is drawn
            // on the line it names, so it has to be that line's colour rather than whichever
            // one the ref carried when it was captured.
            lane_ref: lane_ref(source, claim).map(|mut label| {
                label.color_index = color_index;
                label
            }),
        });
    }

    GraphResult {
        commits,
        max_columns: assigned.max_columns,
    }
}

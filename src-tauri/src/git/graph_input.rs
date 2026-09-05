//! The commit facts lane assignment does not read, and the hydration that turns a layout
//! back into `GraphResult`.
//!
//! `GraphSource` is everything `graph::snapshot` learns from a repository. Production builds it
//! with `graph::capture`; the golden suite parses it from a committed file. Both reach the
//! same `layout`, so a golden stays evidence about production for that half of the pipeline.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

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

/// Everything one walk reads from a repository.
///
/// `commits` is keyed over the walk members; `refs` is filtered to them, since only a
/// page member is ever hydrated. `stash_order` carries `stash_foreach`'s order, which
/// the algorithm does not need and the serialized form does — a `HashSet`'s iteration
/// order would differ between processes.
#[derive(Debug, Clone, Default)]
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

/// The committed form of a `GraphSource`.
///
/// Every map is a `BTreeMap` and `stashes` is the `stash_foreach` order rather than the
/// algorithm's set, so two captures of one repository produce the same bytes. This
/// shape never appears on a production path — routing the app through it would cost an
/// OID round-trip per commit on every graph refresh.
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
    assert_eq!(hex.len(), 40, "graph_input: malformed oid {hex}");

    Oid::from_str(hex).unwrap_or_else(|_| panic!("graph_input: malformed oid {hex}"))
}

fn hex(oid: &Oid) -> String {
    oid.to_string()
}

impl CapturedGraph {
    pub fn from_source(source: &GraphSource) -> Self {
        let placement = &source.placement;

        Self {
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
/// Every hidden thing is named here individually. The sidebar's section and remote toggles
/// are bulk actions over the rows they cover, not rules of their own, so a ref is hidden if
/// and only if it appears in one of these sets. Holding the group state separately let a row
/// be hidden by a rule its own eye did not show, which is the defect this shape removes
/// (João, 2026-09-02).
///
/// HEAD's own branch is never hidden: column 0, the WIP row and the head-lane extension all
/// assume `head_tip` is in the walk.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RefVisibility {
    /// Full ref names, as `RefLabel::name` carries them.
    pub hidden_refs: HashSet<String>,
    /// Stash commit OIDs in hex. A stash has no stable name, so it is keyed by its commit.
    pub hidden_stashes: HashSet<String>,
}

impl RefVisibility {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.hidden_refs.is_empty() && self.hidden_stashes.is_empty()
    }

    fn hides(&self, label: &RefLabel) -> bool {
        !label.is_head && self.hidden_refs.contains(&label.name)
    }

    fn hides_stash(&self, oid: Oid) -> bool {
        self.hidden_stashes.contains(&oid.to_string())
    }
}

/// The pure stage between capture and placement: drop the hidden labels, then drop every
/// commit only they reached.
///
/// The roots are the commits the surviving labels point at, plus the visible stashes and
/// `head_tip`, which is in the walk whatever the refs say — hiding HEAD's branch is refused
/// at the label, and column 0, the WIP row and the head-lane extension all assume its tip.
///
/// `tracked_upstream` is deliberately **not** a root. It is usually named by a remote ref,
/// and hiding that ref has to drop the commits only it reached, which is the whole feature.
/// The upstream chain stays in `parents` regardless, so `head_lane_extension` can still walk
/// it: a parent list is a lookup, not a row.
///
/// Reachability is a pass over `PlacementInput::parents`, which carries a full parent list
/// for every walk member, so no repository is read here.
///
/// The surviving OIDs keep the capture's order. A subsequence of a topological order is
/// still topological over an ancestor-closed subset, so placement sees the walk it expects.
#[must_use]
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
            // Every parent list the capture carried, including the chains above `head_tip`
            // and `tracked_upstream` that `parent_map` closed past the walk's own edge.
            // Narrowing this to the surviving rows would break `head_lane_extension`, which
            // follows the upstream chain beyond them.
            parents: source.placement.parents.clone(),
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
    source
        .commits
        .get(&oid)
        .unwrap_or_else(|| panic!("graph_input: no commit facts for {oid}"))
}

fn parent_list(source: &GraphSource, oid: Oid) -> &[Oid] {
    source
        .placement
        .parents
        .get(&oid)
        .unwrap_or_else(|| panic!("graph_input: no parent list for {oid}"))
}

#[must_use]
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
            .map_or((0, vec![], 0, false, false, None), |p| {
                (
                    p.column,
                    p.edges,
                    p.color_index,
                    p.is_branch_tip,
                    p.is_stash,
                    p.lane_claim,
                )
            });
        let mut refs = source.refs.get(&oid).cloned().unwrap_or_default();
        for r in &mut refs {
            r.color_index = color_index;
        }
        let is_head = refs.iter().any(|r| r.is_head);

        let parents = parent_list(source, oid);
        let is_merge = !is_stash && parents.len() >= 2;
        // For stash commits, only expose the first parent (base commit)
        let parent_oids: Vec<String> = if is_stash {
            parents
                .first()
                .map(std::string::ToString::to_string)
                .into_iter()
                .collect()
        } else {
            parents
                .iter()
                .map(std::string::ToString::to_string)
                .collect()
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

/// The graph as it was last built for one repository: the capture it came from, the
/// visibility it was laid out under, and the layout itself.
///
/// A visibility change re-lays out the same capture, so a sidebar toggle never reads the
/// repository again (TRUNK-129). The capture and the layout travel together, and the only
/// way to change the visibility is through `with_visibility`, so the cached layout can never
/// describe a visibility other than the one recorded beside it (TRUNK-120).
#[derive(Debug, Clone)]
pub struct GraphSnapshot {
    capture: Arc<GraphSource>,
    visibility: RefVisibility,
    pub layout: GraphResult,
}

/// Over the wire a snapshot is its layout: the capture never leaves the backend, and every
/// command that returns a graph to the frontend returns the same shape it always did.
impl Serialize for GraphSnapshot {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.layout.serialize(serializer)
    }
}

impl GraphSnapshot {
    #[must_use]
    pub fn new(capture: GraphSource, visibility: RefVisibility) -> Self {
        Self::lay_out(Arc::new(capture), visibility)
    }

    /// The same capture, laid out under another visibility. No repository access.
    #[must_use]
    pub fn with_visibility(&self, visibility: RefVisibility) -> Self {
        Self::lay_out(Arc::clone(&self.capture), visibility)
    }

    #[must_use]
    pub const fn visibility(&self) -> &RefVisibility {
        &self.visibility
    }

    /// Whether `other` was laid out from the exact same capture as this snapshot, rather
    /// than one a later rebuild produced. `with_visibility` clones the `Arc`, so two
    /// snapshots from the same capture always point at the same allocation.
    #[must_use]
    pub fn same_capture_as(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.capture, &other.capture)
    }

    fn lay_out(capture: Arc<GraphSource>, visibility: RefVisibility) -> Self {
        let source = apply_visibility(&capture, &visibility);
        let layout = layout(&source, 0, usize::MAX);

        Self {
            capture,
            visibility,
            layout,
        }
    }
}

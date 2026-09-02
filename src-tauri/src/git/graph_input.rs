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

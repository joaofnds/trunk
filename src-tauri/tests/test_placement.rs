use std::collections::{HashMap, HashSet};

use git2::Oid;
use trunk_lib::git::placement::{Layout, PlacementInput, assign_lanes};

fn oid(n: u8) -> Oid {
    Oid::from_str(&format!("{n:040x}")).expect("build a hex oid")
}

/// A head tip with one commit sitting directly above it on the same first-parent line —
/// the shape both `head_lane_extension` arms compete over.
fn head_tip_with_one_commit_above() -> PlacementInput {
    let (above, tip) = (oid(1), oid(2));

    PlacementInput {
        oids: vec![above, tip],
        parents: HashMap::from([(above, vec![tip]), (tip, vec![])]),
        stashes: HashSet::new(),
        head_tip: Some(tip),
        tracked_upstream: None,
        worktree_dirty: false,
    }
}

fn lane_of(layout: &Layout, commit: Oid) -> (usize, usize) {
    let placement = &layout.placements[&commit];

    (placement.column, placement.color_index)
}

#[test]
fn a_linear_history_stacks_in_the_head_lane() {
    let (tip, mid, root) = (oid(1), oid(2), oid(3));
    let input = PlacementInput {
        oids: vec![tip, mid, root],
        parents: HashMap::from([(tip, vec![mid]), (mid, vec![root]), (root, vec![])]),
        stashes: HashSet::new(),
        head_tip: Some(tip),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    let columns: Vec<usize> = [tip, mid, root]
        .iter()
        .map(|o| layout.placements[o].column)
        .collect();
    let colors: Vec<usize> = [tip, mid, root]
        .iter()
        .map(|o| layout.placements[o].color_index)
        .collect();
    assert_eq!(columns, [0, 0, 0]);
    assert_eq!(colors, [0, 0, 0]);
}

#[test]
fn the_head_chain_keeps_the_commit_whose_parents_are_unknown() {
    let (tip, boundary) = (oid(1), oid(2));
    let input = PlacementInput {
        oids: vec![tip],
        parents: HashMap::from([(tip, vec![boundary])]),
        stashes: HashSet::new(),
        head_tip: Some(tip),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(layout.head_chain, HashSet::from([tip, boundary]));
}

#[test]
fn the_head_chain_keeps_the_root_commit() {
    let (tip, root) = (oid(1), oid(2));
    let input = PlacementInput {
        oids: vec![tip, root],
        parents: HashMap::from([(tip, vec![root]), (root, vec![])]),
        stashes: HashSet::new(),
        head_tip: Some(tip),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(layout.head_chain, HashSet::from([tip, root]));
}

#[test]
fn an_upstream_on_the_head_line_holds_the_lane_in_the_head_colour() {
    let mut input = head_tip_with_one_commit_above();
    let above = input.oids[0];
    input.tracked_upstream = Some(above);

    let layout = assign_lanes(&input);

    assert_eq!(lane_of(&layout, above), (0, 0));
}

#[test]
fn an_upstream_that_never_reaches_head_yields_the_lane_a_fresh_colour() {
    let (stranger, unknown) = (oid(8), oid(9));
    let mut input = head_tip_with_one_commit_above();
    let above = input.oids[0];
    input.tracked_upstream = Some(stranger);
    input.parents.insert(stranger, vec![unknown]);

    let layout = assign_lanes(&input);

    assert_eq!(lane_of(&layout, above), (0, 1));
}

#[test]
fn a_stash_never_extends_the_head_lane() {
    let (stash, tip) = (oid(1), oid(2));
    let input = PlacementInput {
        oids: vec![stash, tip],
        parents: HashMap::from([(stash, vec![tip]), (tip, vec![])]),
        stashes: HashSet::from([stash]),
        head_tip: Some(tip),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(lane_of(&layout, stash), (0, 0));
}

#[test]
#[should_panic(expected = "placement: no parent list for")]
fn a_walk_member_the_parent_map_does_not_describe_is_fatal() {
    let tip = oid(1);
    let input = PlacementInput {
        oids: vec![tip],
        parents: HashMap::new(),
        stashes: HashSet::new(),
        head_tip: Some(tip),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    assign_lanes(&input);
}

#[test]
#[should_panic(expected = "placement: cycle in parent map at")]
fn a_cycle_below_the_head_tip_is_fatal() {
    let (tip, ancestor) = (oid(1), oid(2));
    let input = PlacementInput {
        oids: vec![tip, ancestor],
        parents: HashMap::from([(tip, vec![ancestor]), (ancestor, vec![tip])]),
        stashes: HashSet::new(),
        head_tip: Some(tip),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    assign_lanes(&input);
}

#[test]
#[should_panic(expected = "placement: cycle in parent map at")]
fn a_cycle_above_the_tracked_upstream_is_fatal() {
    let (tip, upstream, ancestor) = (oid(1), oid(2), oid(3));
    let input = PlacementInput {
        oids: vec![tip],
        parents: HashMap::from([
            (tip, vec![]),
            (upstream, vec![ancestor]),
            (ancestor, vec![upstream]),
        ]),
        stashes: HashSet::new(),
        head_tip: Some(tip),
        tracked_upstream: Some(upstream),
        worktree_dirty: false,
    };

    assign_lanes(&input);
}

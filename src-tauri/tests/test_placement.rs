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

/// One commit's whole edge list, in emission order, as `Kind(from->to)`. `EdgeType` has no
/// `PartialEq`, and asserting the list whole is what stops a second indistinguishable edge
/// from hiding a changed one.
fn edge_kinds(layout: &Layout, commit: Oid) -> Vec<String> {
    layout.placements[&commit]
        .edges
        .iter()
        .map(|e| format!("{:?}({}->{})", e.edge_type, e.from_column, e.to_column))
        .collect()
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
fn a_stash_on_the_tracked_upstream_path_blocks_the_head_lane_extension() {
    let (above, stash, tip) = (oid(1), oid(2), oid(3));
    let input = PlacementInput {
        oids: vec![above, stash, tip],
        parents: HashMap::from([(above, vec![stash]), (stash, vec![tip]), (tip, vec![])]),
        stashes: HashSet::from([stash]),
        head_tip: Some(tip),
        tracked_upstream: Some(above),
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(lane_of(&layout, above), (1, 1));
}

#[test]
fn a_merge_secondary_parent_never_takes_the_head_lane() {
    let (a, b, m, f, s, y, h, r) = (
        oid(1),
        oid(2),
        oid(3),
        oid(4),
        oid(5),
        oid(6),
        oid(7),
        oid(8),
    );
    let input = PlacementInput {
        oids: vec![a, b, m, f, s, y, h, r],
        parents: HashMap::from([
            (a, vec![m]),
            (b, vec![y]),
            (m, vec![f, s]),
            (f, vec![r]),
            (s, vec![r]),
            (y, vec![r]),
            (h, vec![r]),
            (r, vec![]),
        ]),
        stashes: HashSet::new(),
        head_tip: Some(h),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!((layout.placements[&s].column, layout.max_columns), (3, 4));
    assert_eq!(
        edge_kinds(&layout, m),
        ["Straight(2->2)", "Straight(1->1)", "MergeRight(1->3)"]
    );
}

#[test]
fn a_parent_below_a_still_open_higher_lane_is_not_a_branch_tip() {
    let (t1, t2, p1, p2, q1, q2, h, hr) = (
        oid(1),
        oid(2),
        oid(3),
        oid(4),
        oid(5),
        oid(6),
        oid(7),
        oid(8),
    );
    let input = PlacementInput {
        oids: vec![t1, t2, p1, p2, q1, q2, h, hr],
        parents: HashMap::from([
            (t1, vec![p1]),
            (t2, vec![p2]),
            (p1, vec![q1]),
            (p2, vec![q2]),
            (q1, vec![hr]),
            (q2, vec![hr]),
            (h, vec![hr]),
            (hr, vec![]),
        ]),
        stashes: HashSet::new(),
        head_tip: Some(h),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    let placement = &layout.placements[&p2];
    assert_eq!(
        (
            placement.column,
            placement.is_branch_tip,
            layout.max_columns
        ),
        (2, false, 3)
    );
}

#[test]
fn an_inline_stash_keeps_a_live_lanes_pass_through_rail() {
    let (t1, stash, ht, p1, hr) = (oid(1), oid(2), oid(3), oid(4), oid(5));
    let input = PlacementInput {
        oids: vec![t1, stash, ht, p1, hr],
        parents: HashMap::from([
            (t1, vec![p1]),
            (stash, vec![ht]),
            (ht, vec![hr]),
            (p1, vec![hr]),
            (hr, vec![]),
        ]),
        stashes: HashSet::from([stash]),
        head_tip: Some(ht),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(
        edge_kinds(&layout, stash),
        ["Straight(1->1)", "Straight(0->0)"]
    );
}

#[test]
fn a_stash_below_the_head_tip_branches_out_of_the_head_lane() {
    let (stash, tip, mid, root) = (oid(1), oid(2), oid(3), oid(4));
    let input = PlacementInput {
        oids: vec![stash, tip, mid, root],
        parents: HashMap::from([
            (stash, vec![mid]),
            (tip, vec![mid]),
            (mid, vec![root]),
            (root, vec![]),
        ]),
        stashes: HashSet::from([stash]),
        head_tip: Some(tip),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(layout.placements[&stash].column, 1);
}

#[test]
fn a_stash_on_the_upstream_extension_tip_inlines_into_the_head_lane() {
    let (stash, up5, up4, up3, base2, base1) = (oid(1), oid(2), oid(3), oid(4), oid(5), oid(6));
    let input = PlacementInput {
        oids: vec![stash, up5, up4, up3, base2, base1],
        parents: HashMap::from([
            (stash, vec![up5]),
            (up5, vec![up4]),
            (up4, vec![up3]),
            (up3, vec![base2]),
            (base2, vec![base1]),
            (base1, vec![]),
        ]),
        stashes: HashSet::from([stash]),
        head_tip: Some(base2),
        tracked_upstream: Some(up5),
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(lane_of(&layout, stash), (0, 0));
    assert_eq!(layout.max_columns, 1);
    assert_eq!(edge_kinds(&layout, up5), ["Straight(0->0)"]);
}

#[test]
fn a_stash_on_the_tiebreak_extension_tip_inlines_into_the_head_lane() {
    let (stash, up5, up4, up3, base2, base1) = (oid(1), oid(2), oid(3), oid(4), oid(5), oid(6));
    let input = PlacementInput {
        oids: vec![stash, up5, up4, up3, base2, base1],
        parents: HashMap::from([
            (stash, vec![up5]),
            (up5, vec![up4]),
            (up4, vec![up3]),
            (up3, vec![base2]),
            (base2, vec![base1]),
            (base1, vec![]),
        ]),
        stashes: HashSet::from([stash]),
        head_tip: Some(base2),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(lane_of(&layout, stash), (0, 1));
    assert_eq!(layout.max_columns, 1);
}

#[test]
fn a_stash_inside_the_head_lane_extension_branches_right() {
    let (stash, up5, up4, up3, base2, base1) = (oid(1), oid(2), oid(3), oid(4), oid(5), oid(6));
    let input = PlacementInput {
        oids: vec![stash, up5, up4, up3, base2, base1],
        parents: HashMap::from([
            (stash, vec![up4]),
            (up5, vec![up4]),
            (up4, vec![up3]),
            (up3, vec![base2]),
            (base2, vec![base1]),
            (base1, vec![]),
        ]),
        stashes: HashSet::from([stash]),
        head_tip: Some(base2),
        tracked_upstream: Some(up5),
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(layout.placements[&stash].column, 1);
}

#[test]
fn a_merge_edge_back_to_the_merges_own_column_stays_straight() {
    let (merge, first, second) = (oid(1), oid(2), oid(3));
    let input = PlacementInput {
        oids: vec![merge, first, second],
        parents: HashMap::from([
            (merge, vec![first, second]),
            (first, vec![second]),
            (second, vec![]),
        ]),
        stashes: HashSet::new(),
        head_tip: Some(merge),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(
        edge_kinds(&layout, merge),
        ["Straight(0->0)", "Straight(0->0)"]
    );
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

/// The commit that claimed the lane a commit sits in.
fn lane_claim_of(layout: &Layout, commit: Oid) -> Option<Oid> {
    layout.placements[&commit].lane_claim
}

#[test]
fn a_commit_names_the_tip_that_claimed_its_lane() {
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

    let claims: Vec<Option<Oid>> = [tip, mid, root]
        .iter()
        .map(|&o| lane_claim_of(&layout, o))
        .collect();
    assert_eq!(claims, [Some(tip), Some(tip), Some(tip)]);
}

#[test]
fn a_reused_column_names_the_tip_that_claimed_it_this_time() {
    // `branch_b` takes the column `branch_a` freed when the merge absorbed it — the
    // freed-column-reuse shape. Sharing a column is not sharing a lane: naming a row by the
    // nearest ref up its column would name `branch_a`, which does not contain `branch_b`.
    let (main3, branch_b, main2, merge, branch_a, main1, root) =
        (oid(1), oid(2), oid(3), oid(4), oid(5), oid(6), oid(7));
    let input = PlacementInput {
        oids: vec![main3, branch_b, main2, merge, branch_a, main1, root],
        parents: HashMap::from([
            (main3, vec![main2]),
            (branch_b, vec![main2]),
            (main2, vec![merge]),
            (merge, vec![main1, branch_a]),
            (branch_a, vec![root]),
            (main1, vec![root]),
            (root, vec![]),
        ]),
        stashes: HashSet::new(),
        head_tip: Some(main3),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(
        lane_of(&layout, branch_a).0,
        lane_of(&layout, branch_b).0,
        "the shape under test is a reused column"
    );
    assert_eq!(lane_claim_of(&layout, branch_a), Some(branch_a));
    assert_eq!(lane_claim_of(&layout, branch_b), Some(branch_b));
}

#[test]
fn a_merged_branch_keeps_naming_itself_below_the_merge() {
    // `merge` takes `side` as its second parent, so `side` holds a lane of its own. Its rows
    // name that lane's tip rather than the branch it merged into.
    let (merge, side, base, root) = (oid(1), oid(2), oid(3), oid(4));
    let input = PlacementInput {
        oids: vec![merge, side, base, root],
        parents: HashMap::from([
            (merge, vec![base, side]),
            (side, vec![root]),
            (base, vec![root]),
            (root, vec![]),
        ]),
        stashes: HashSet::new(),
        head_tip: Some(merge),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(lane_claim_of(&layout, side), Some(side));
    assert_eq!(lane_claim_of(&layout, merge), Some(merge));
}

#[test]
fn a_head_tip_behind_its_upstream_names_itself_not_the_upstream() {
    // `above` is the tracked upstream, ahead of `tip` on the same first-parent line, so the
    // clean-worktree extension pre-claims column 0 for `above` before the walk reaches `tip`.
    // `tip` still carries its own ref and must claim its own row rather than inherit that
    // claim, the way its colour already resets to lane 0's own colour at this row.
    let (above, tip, root) = (oid(1), oid(2), oid(3));
    let input = PlacementInput {
        oids: vec![above, tip, root],
        parents: HashMap::from([(above, vec![tip]), (tip, vec![root]), (root, vec![])]),
        stashes: HashSet::new(),
        head_tip: Some(tip),
        tracked_upstream: Some(above),
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(lane_claim_of(&layout, above), Some(above));
    assert_eq!(lane_claim_of(&layout, tip), Some(tip));
}

#[test]
fn a_stash_never_claims_the_lane_it_inlines_into() {
    // A stash inlines at the top of the HEAD lane when the worktree is clean, so it is the
    // first row seen in column 0. It names a state, not a line of history, so the lane still
    // belongs to the branch continuing below it.
    let (stash, tip, root) = (oid(1), oid(2), oid(3));
    let input = PlacementInput {
        oids: vec![stash, tip, root],
        parents: HashMap::from([(stash, vec![tip]), (tip, vec![root]), (root, vec![])]),
        stashes: HashSet::from([stash]),
        head_tip: Some(tip),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(
        lane_of(&layout, stash).0,
        lane_of(&layout, tip).0,
        "the shape under test is an inlined stash"
    );
    assert_eq!(lane_claim_of(&layout, tip), Some(tip));
    assert_eq!(lane_claim_of(&layout, root), Some(tip));
}

#[test]
fn a_tip_taking_a_freed_column_claims_it_from_the_previous_holder() {
    // `delta` opens a new lane in the column `orphan` released, and gets a colour of its own
    // for it. The claim has to move with the colour: inheriting `orphan` would name a lane
    // after a branch that does not contain it. The merge-13-freed-column-left fixture is
    // this shape.
    let (head, orphan, delta, root) = (oid(1), oid(2), oid(3), oid(4));
    let input = PlacementInput {
        oids: vec![head, orphan, delta, root],
        parents: HashMap::from([
            (head, vec![root]),
            (orphan, vec![]),
            (delta, vec![root]),
            (root, vec![]),
        ]),
        stashes: HashSet::new(),
        head_tip: Some(head),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(
        lane_of(&layout, orphan).0,
        lane_of(&layout, delta).0,
        "the shape under test reuses a freed column"
    );
    assert_ne!(
        lane_of(&layout, orphan).1,
        lane_of(&layout, delta).1,
        "the new lane takes a colour of its own"
    );
    assert_eq!(lane_claim_of(&layout, delta), Some(delta));
}

#[test]
fn a_stash_taking_a_freed_column_clears_the_previous_holders_claim() {
    // `stash` opens no claim of its own in the column `orphan` released — a stash names no
    // line of history — but a commit below it in that column must not inherit `orphan`'s
    // stale claim either. Same defect as `a_tip_taking_a_freed_column_claims_it_from_the_
    // previous_holder`, on the one `open_lane` call site that can pass a `None` claim.
    let (head, orphan, stash, below_stash, root) = (oid(1), oid(2), oid(3), oid(4), oid(5));
    let input = PlacementInput {
        oids: vec![head, orphan, stash, below_stash, root],
        parents: HashMap::from([
            (head, vec![root]),
            (orphan, vec![]),
            (stash, vec![below_stash]),
            (below_stash, vec![root]),
            (root, vec![]),
        ]),
        stashes: HashSet::from([stash]),
        head_tip: Some(head),
        tracked_upstream: None,
        worktree_dirty: false,
    };

    let layout = assign_lanes(&input);

    assert_eq!(
        lane_of(&layout, orphan).0,
        lane_of(&layout, stash).0,
        "the shape under test reuses a freed column"
    );
    assert_eq!(lane_claim_of(&layout, below_stash), Some(below_stash));
}

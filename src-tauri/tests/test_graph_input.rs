use std::collections::{BTreeMap, HashMap, HashSet};

use git2::Oid;
use trunk_lib::git::graph_input::{CapturedGraph, CommitFacts, GraphSource, layout};
use trunk_lib::git::placement::PlacementInput;
use trunk_lib::git::types::{RefLabel, RefType};

fn oid(n: u8) -> Oid {
    Oid::from_str(&format!("{n:040x}")).expect("build a hex oid")
}

fn facts(summary: &str) -> CommitFacts {
    CommitFacts {
        summary: summary.to_owned(),
        body: None,
        author_name: "T".to_owned(),
        author_email: "t@t.com".to_owned(),
        author_timestamp: 1000,
    }
}

#[test]
fn a_page_row_carries_the_captured_facts_and_refs() {
    let (tip, root) = (oid(1), oid(2));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![tip, root],
            parents: HashMap::from([(tip, vec![root]), (root, vec![])]),
            stashes: HashSet::new(),
            head_tip: Some(tip),
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([(tip, facts("Add lib")), (root, facts("Init"))]),
        refs: HashMap::from([(
            tip,
            vec![RefLabel {
                name: "refs/heads/main".to_owned(),
                short_name: "main".to_owned(),
                ref_type: RefType::LocalBranch,
                is_head: true,
                color_index: 99,
            }],
        )]),
        stash_order: Vec::new(),
    };

    let result = layout(&source, 0, usize::MAX);

    let summaries: Vec<&str> = result.commits.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(summaries, ["Add lib", "Init"]);
    assert_eq!(result.max_columns, 1);
    assert_eq!(result.commits[0].refs[0].short_name, "main");
    assert_eq!(result.commits[0].refs[0].color_index, 0);
    assert!(result.commits[0].is_head);
    assert!(result.commits[1].refs.is_empty());
}

#[test]
fn a_stash_row_exposes_only_its_first_parent() {
    let (stash, tip, index, untracked) = (oid(1), oid(2), oid(3), oid(4));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![stash, tip],
            parents: HashMap::from([(stash, vec![tip, index, untracked]), (tip, vec![])]),
            stashes: HashSet::from([stash]),
            head_tip: Some(tip),
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([(stash, facts("WIP on main")), (tip, facts("Init"))]),
        refs: HashMap::new(),
        stash_order: vec![stash],
    };

    let result = layout(&source, 0, usize::MAX);

    assert_eq!(result.commits[0].parent_oids, [tip.to_string()]);
    assert!(!result.commits[0].is_merge);
    assert!(result.commits[0].is_stash);
}

#[test]
fn a_page_renders_only_the_requested_rows() {
    let (tip, mid, root) = (oid(1), oid(2), oid(3));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![tip, mid, root],
            parents: HashMap::from([(tip, vec![mid]), (mid, vec![root]), (root, vec![])]),
            stashes: HashSet::new(),
            head_tip: Some(tip),
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([
            (tip, facts("Third")),
            (mid, facts("Second")),
            (root, facts("Init")),
        ]),
        refs: HashMap::new(),
        stash_order: Vec::new(),
    };

    let result = layout(&source, 1, 1);

    let summaries: Vec<&str> = result.commits.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(summaries, ["Second"]);
}

/// A source exercising every field the committed form carries: two stashes whose order is
/// not the walk's, refs, a tracked upstream, a dirty worktree and a commit with a body.
fn source_using_every_captured_field() -> GraphSource {
    let (newer_stash, older_stash, tip, root) = (oid(1), oid(2), oid(3), oid(4));

    GraphSource {
        placement: PlacementInput {
            oids: vec![newer_stash, older_stash, tip, root],
            parents: HashMap::from([
                (newer_stash, vec![tip, oid(9)]),
                (older_stash, vec![root]),
                (tip, vec![root]),
                (root, vec![]),
            ]),
            stashes: HashSet::from([newer_stash, older_stash]),
            head_tip: Some(tip),
            tracked_upstream: Some(root),
            worktree_dirty: true,
        },
        commits: HashMap::from([
            (newer_stash, facts("WIP on main")),
            (older_stash, facts("WIP on topic")),
            (
                tip,
                CommitFacts {
                    body: Some("why it changed".to_owned()),
                    ..facts("Add lib")
                },
            ),
            (root, facts("Init")),
        ]),
        refs: HashMap::from([(
            tip,
            vec![RefLabel {
                name: "refs/heads/main".to_owned(),
                short_name: "main".to_owned(),
                ref_type: RefType::LocalBranch,
                is_head: true,
                color_index: 99,
            }],
        )]),
        stash_order: vec![newer_stash, older_stash],
    }
}

#[test]
fn the_committed_form_round_trips_a_source() {
    let source = source_using_every_captured_field();

    let restored = CapturedGraph::from_source(&source).to_source();

    let rendered = |s: &GraphSource| {
        serde_json::to_string(&layout(s, 0, usize::MAX)).expect("serialize layout")
    };
    assert_eq!(rendered(&restored), rendered(&source));
}

#[test]
fn the_committed_form_keeps_the_stash_order_it_was_given() {
    let source = source_using_every_captured_field();

    let captured = CapturedGraph::from_source(&source);

    let expected: Vec<String> = source.stash_order.iter().map(|o| o.to_string()).collect();
    assert_eq!(captured.stashes, expected);
}

#[test]
#[should_panic(expected = "graph_input: malformed oid")]
fn a_truncated_oid_in_a_committed_input_is_fatal() {
    let captured = CapturedGraph {
        oids: vec!["abc".to_owned()],
        parents: BTreeMap::new(),
        stashes: Vec::new(),
        head_tip: None,
        tracked_upstream: None,
        worktree_dirty: false,
        commits: BTreeMap::new(),
        refs: BTreeMap::new(),
    };

    captured.to_source();
}

fn ref_label(name: &str, short: &str, ref_type: RefType) -> RefLabel {
    RefLabel {
        name: name.to_owned(),
        short_name: short.to_owned(),
        ref_type,
        is_head: false,
        color_index: 0,
    }
}

#[test]
fn every_row_of_a_lane_names_the_ref_that_claimed_it() {
    let (tip, mid, root) = (oid(1), oid(2), oid(3));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![tip, mid, root],
            parents: HashMap::from([(tip, vec![mid]), (mid, vec![root]), (root, vec![])]),
            stashes: HashSet::new(),
            head_tip: Some(tip),
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([
            (tip, facts("Tip")),
            (mid, facts("Mid")),
            (root, facts("Init")),
        ]),
        refs: HashMap::from([(
            tip,
            vec![ref_label("refs/heads/main", "main", RefType::LocalBranch)],
        )]),
        stash_order: Vec::new(),
    };

    let result = layout(&source, 0, usize::MAX);

    let names: Vec<Option<&str>> = result
        .commits
        .iter()
        .map(|c| c.lane_ref.as_ref().map(|r| r.short_name.as_str()))
        .collect();
    assert_eq!(names, [Some("main"), Some("main"), Some("main")]);
}

#[test]
fn a_tag_inside_a_branchs_lane_does_not_name_it() {
    // The defect this whole field exists for: a tag a few rows below a branch tip used to
    // capture every row under it, so one lane read as two different branches.
    let (tip, tagged, root) = (oid(1), oid(2), oid(3));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![tip, tagged, root],
            parents: HashMap::from([(tip, vec![tagged]), (tagged, vec![root]), (root, vec![])]),
            stashes: HashSet::new(),
            head_tip: Some(tip),
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([
            (tip, facts("Tip")),
            (tagged, facts("Tagged")),
            (root, facts("Init")),
        ]),
        refs: HashMap::from([
            (
                tip,
                vec![ref_label("refs/heads/main", "main", RefType::LocalBranch)],
            ),
            (
                tagged,
                vec![ref_label("refs/tags/v1.0.0", "v1.0.0", RefType::Tag)],
            ),
        ]),
        stash_order: Vec::new(),
    };

    let result = layout(&source, 0, usize::MAX);

    let names: Vec<Option<&str>> = result
        .commits
        .iter()
        .map(|c| c.lane_ref.as_ref().map(|r| r.short_name.as_str()))
        .collect();
    assert_eq!(names, [Some("main"), Some("main"), Some("main")]);
}

#[test]
fn a_lane_only_a_tag_holds_is_named_by_that_tag() {
    // Branch off main, commit, tag the tip, delete the branch: the tag is the only thing
    // keeping that line of history on the graph, so it is what names it.
    let (head, tagged, root) = (oid(1), oid(2), oid(3));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![head, tagged, root],
            parents: HashMap::from([(head, vec![root]), (tagged, vec![root]), (root, vec![])]),
            stashes: HashSet::new(),
            head_tip: Some(head),
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([
            (head, facts("Head")),
            (tagged, facts("Tagged")),
            (root, facts("Init")),
        ]),
        refs: HashMap::from([
            (
                head,
                vec![ref_label("refs/heads/main", "main", RefType::LocalBranch)],
            ),
            (
                tagged,
                vec![ref_label("refs/tags/v1.0.0", "v1.0.0", RefType::Tag)],
            ),
        ]),
        stash_order: Vec::new(),
    };

    let result = layout(&source, 0, usize::MAX);

    let tagged_row = result.commits.iter().find(|c| c.oid == tagged.to_string());
    assert_eq!(
        tagged_row
            .and_then(|c| c.lane_ref.as_ref())
            .map(|r| r.short_name.as_str()),
        Some("v1.0.0")
    );
}

#[test]
fn a_lane_whose_claiming_ref_is_beyond_the_page_still_names_it() {
    // The claim is resolved against the whole walk, not the page, so a row paged in without
    // its lane's tip is still named. This is the branch-far-behind-upstream shape.
    let (tip, mid, root) = (oid(1), oid(2), oid(3));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![tip, mid, root],
            parents: HashMap::from([(tip, vec![mid]), (mid, vec![root]), (root, vec![])]),
            stashes: HashSet::new(),
            head_tip: Some(tip),
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([
            (tip, facts("Tip")),
            (mid, facts("Mid")),
            (root, facts("Init")),
        ]),
        refs: HashMap::from([(
            tip,
            vec![ref_label("refs/heads/main", "main", RefType::LocalBranch)],
        )]),
        stash_order: Vec::new(),
    };

    // Page 2 only: the tip carrying `main` is not in it.
    let result = layout(&source, 1, 2);

    let names: Vec<Option<&str>> = result
        .commits
        .iter()
        .map(|c| c.lane_ref.as_ref().map(|r| r.short_name.as_str()))
        .collect();
    assert_eq!(names, [Some("main"), Some("main")]);
}

#[test]
fn a_lane_ref_carries_the_lanes_own_colour() {
    // The ghost pill is drawn from `lane_ref` and has to match the line it names. The
    // captured colour is whatever the ref carried on disk, so it is replaced here the same
    // way a row's own refs are.
    let (tip, mid, root) = (oid(1), oid(2), oid(3));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![tip, mid, root],
            parents: HashMap::from([(tip, vec![root]), (mid, vec![root]), (root, vec![])]),
            stashes: HashSet::new(),
            head_tip: Some(root),
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([
            (tip, facts("Tip")),
            (mid, facts("Mid")),
            (root, facts("Init")),
        ]),
        refs: HashMap::from([(
            tip,
            vec![RefLabel {
                name: "refs/heads/topic".to_owned(),
                short_name: "topic".to_owned(),
                ref_type: RefType::LocalBranch,
                is_head: false,
                color_index: 99,
            }],
        )]),
        stash_order: Vec::new(),
    };

    let result = layout(&source, 0, usize::MAX);

    let tip_row = &result.commits[0];
    assert_eq!(
        tip_row.lane_ref.as_ref().map(|r| r.color_index),
        Some(tip_row.color_index),
        "the lane's name is drawn in the lane's colour"
    );
    assert_ne!(tip_row.color_index, 99, "the captured colour is replaced");
}

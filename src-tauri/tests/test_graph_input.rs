use std::collections::{BTreeMap, HashMap, HashSet};

use git2::Oid;
use trunk_lib::git::graph_input::{
    CapturedGraph, CommitFacts, GraphSnapshot, GraphSource, RefVisibility, apply_visibility, layout,
};
use trunk_lib::git::layout_dump;
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

#[test]
fn a_merged_branch_with_no_ref_left_on_its_tip_draws_no_pill() {
    // AC6's narrower scope: a merged topic branch keeps naming itself only while its tip
    // still carries a ref. Once that branch is deleted, the commit that claimed its lane
    // resolves to zero refs, and the row draws no pill rather than falling back to main's.
    // Joao ruled a containing-ref fallback out of scope; this is the shape from the
    // career-ops repo's "Merge remote-tracking branch origin/main" commit, where the
    // absorbed side has no ref of its own left on disk.
    let (merge, side, base, root) = (oid(1), oid(2), oid(3), oid(4));
    let source = GraphSource {
        placement: PlacementInput {
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
        },
        commits: HashMap::from([
            (merge, facts("Merge")),
            (side, facts("Side")),
            (base, facts("Base")),
            (root, facts("Init")),
        ]),
        refs: HashMap::from([(
            merge,
            vec![ref_label("refs/heads/main", "main", RefType::LocalBranch)],
        )]),
        stash_order: Vec::new(),
    };

    let result = layout(&source, 0, usize::MAX);

    let side_row = result.commits.iter().find(|c| c.oid == side.to_string());
    assert!(side_row.is_some_and(|c| c.lane_ref.is_none()));
}

#[test]
fn a_lane_claim_carrying_several_refs_names_the_local_branch_over_the_tag() {
    // `ref_rank` mirrors the frontend's `sortRefs` precedence so the lane's name and the
    // claiming commit's own pill agree: HEAD, then local branch, tag, stash, remote branch
    // last. A commit release-tagged on its own branch tip carries both.
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
        commits: HashMap::from([(tip, facts("Tip")), (root, facts("Init"))]),
        refs: HashMap::from([(
            tip,
            vec![
                ref_label("refs/tags/v1.0.0", "v1.0.0", RefType::Tag),
                ref_label("refs/heads/main", "main", RefType::LocalBranch),
                ref_label(
                    "refs/remotes/origin/main",
                    "origin/main",
                    RefType::RemoteBranch,
                ),
            ],
        )]),
        stash_order: Vec::new(),
    };

    let result = layout(&source, 0, usize::MAX);

    let tip_row = &result.commits[0];
    assert_eq!(
        tip_row.lane_ref.as_ref().map(|r| r.short_name.as_str()),
        Some("main")
    );
}

/// A ref the user hid takes its pill and its private history out of the graph, and leaves
/// every other row exactly where the all-visible layout put it.
#[test]
fn a_hidden_ref_drops_its_pill_and_the_commits_only_it_reaches() {
    let (topic, tip, root) = (oid(1), oid(2), oid(3));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![topic, tip, root],
            parents: HashMap::from([(topic, vec![root]), (tip, vec![root]), (root, vec![])]),
            stashes: HashSet::new(),
            head_tip: Some(tip),
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([
            (topic, facts("Topic")),
            (tip, facts("Tip")),
            (root, facts("Init")),
        ]),
        refs: HashMap::from([
            (
                tip,
                vec![RefLabel {
                    name: "refs/heads/main".to_owned(),
                    short_name: "main".to_owned(),
                    ref_type: RefType::LocalBranch,
                    is_head: true,
                    color_index: 0,
                }],
            ),
            (
                topic,
                vec![ref_label(
                    "refs/remotes/origin/topic",
                    "origin/topic",
                    RefType::RemoteBranch,
                )],
            ),
        ]),
        stash_order: Vec::new(),
    };

    let mut hidden = RefVisibility::default();
    hidden
        .hidden_refs
        .insert("refs/remotes/origin/topic".to_owned());

    let visible = layout(&apply_visibility(&source, &hidden), 0, usize::MAX);

    let summaries: Vec<&str> = visible.commits.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(summaries, ["Tip", "Init"]);
    assert!(
        visible
            .commits
            .iter()
            .all(|c| c.refs.iter().all(|r| r.short_name != "origin/topic"))
    );

    let all = layout(&source, 0, usize::MAX);
    for (hidden_row, all_row) in visible.commits.iter().zip(all.commits.iter().skip(1)) {
        assert_eq!(hidden_row.oid, all_row.oid);
        assert_eq!(hidden_row.column, all_row.column);
    }
}

/// A visibility change re-lays out the capture the graph was built from, so a sidebar toggle
/// never reads the repository again (TRUNK-129), and the snapshot carries the visibility it
/// was laid out under, so the two cannot disagree (TRUNK-120).
#[test]
fn a_snapshot_re_laid_out_under_a_visibility_equals_a_fresh_layout_under_it() {
    let (tip, root) = (oid(1), oid(2));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![tip, root],
            parents: HashMap::from([(tip, vec![root]), (root, vec![])]),
            stashes: HashSet::new(),
            head_tip: None,
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([(tip, facts("Tip")), (root, facts("Init"))]),
        refs: HashMap::from([(
            tip,
            vec![
                ref_label("refs/heads/main", "main", RefType::LocalBranch),
                ref_label(
                    "refs/remotes/origin/main",
                    "origin/main",
                    RefType::RemoteBranch,
                ),
            ],
        )]),
        stash_order: Vec::new(),
    };
    let mut hidden = RefVisibility::default();
    hidden.hidden_refs.insert("refs/heads/main".to_owned());

    let toggled = GraphSnapshot::new(source.clone(), RefVisibility::default())
        .with_visibility(hidden.clone());

    assert_eq!(toggled.visibility(), &hidden);
    assert_eq!(
        layout_dump::render(&toggled.layout),
        layout_dump::render(&layout(&apply_visibility(&source, &hidden), 0, usize::MAX))
    );
}

/// Acceptance #4: a commit a visible ref still reaches keeps its row, and both its pill and
/// the name of its lane fall back to the highest-ranked ref that is still visible.
#[test]
fn a_commit_a_visible_ref_still_reaches_keeps_its_row_and_names_itself_by_that_ref() {
    let (tip, root) = (oid(1), oid(2));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![tip, root],
            parents: HashMap::from([(tip, vec![root]), (root, vec![])]),
            stashes: HashSet::new(),
            head_tip: None,
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([(tip, facts("Tip")), (root, facts("Init"))]),
        refs: HashMap::from([(
            tip,
            vec![
                ref_label("refs/heads/main", "main", RefType::LocalBranch),
                ref_label(
                    "refs/remotes/origin/main",
                    "origin/main",
                    RefType::RemoteBranch,
                ),
            ],
        )]),
        stash_order: Vec::new(),
    };

    let mut hidden = RefVisibility::default();
    hidden.hidden_refs.insert("refs/heads/main".to_owned());

    let result = layout(&apply_visibility(&source, &hidden), 0, usize::MAX);

    let summaries: Vec<&str> = result.commits.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(summaries, ["Tip", "Init"]);

    let pills: Vec<&str> = result.commits[0]
        .refs
        .iter()
        .map(|r| r.short_name.as_str())
        .collect();
    assert_eq!(pills, ["origin/main"]);
    assert_eq!(
        result.commits[0]
            .lane_ref
            .as_ref()
            .map(|r| r.short_name.as_str()),
        Some("origin/main")
    );
}

/// HEAD's own branch survives every rule, including its own section's: column 0, the WIP row
/// and the head-lane extension all assume `head_tip` is in the walk.
#[test]
fn heads_own_branch_survives_hiding_the_whole_local_section() {
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
        commits: HashMap::from([(tip, facts("Tip")), (root, facts("Init"))]),
        refs: HashMap::from([(
            tip,
            vec![
                RefLabel {
                    name: "refs/heads/main".to_owned(),
                    short_name: "main".to_owned(),
                    ref_type: RefType::LocalBranch,
                    is_head: true,
                    color_index: 0,
                },
                ref_label("refs/heads/other", "other", RefType::LocalBranch),
            ],
        )]),
        stash_order: Vec::new(),
    };

    // A bulk "hide the Local section" writes every local branch name, HEAD's among them
    // if the caller is careless. The filter refuses it at the label either way.
    let mut hidden = RefVisibility::default();
    hidden.hidden_refs.insert("refs/heads/main".to_owned());
    hidden.hidden_refs.insert("refs/heads/other".to_owned());

    let result = layout(&apply_visibility(&source, &hidden), 0, usize::MAX);

    let pills: Vec<&str> = result.commits[0]
        .refs
        .iter()
        .map(|r| r.short_name.as_str())
        .collect();
    assert_eq!(pills, ["main"]);
    assert_eq!(result.commits.len(), 2);
}

/// Hiding a remote group hides every branch under it and nothing under a remote whose name
/// merely starts the same way.
#[test]
fn hiding_a_remote_takes_only_its_own_branches() {
    let (origin_topic, fork_topic, root) = (oid(1), oid(2), oid(3));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![origin_topic, fork_topic, root],
            parents: HashMap::from([
                (origin_topic, vec![root]),
                (fork_topic, vec![root]),
                (root, vec![]),
            ]),
            stashes: HashSet::new(),
            head_tip: Some(root),
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([
            (origin_topic, facts("Origin topic")),
            (fork_topic, facts("Fork topic")),
            (root, facts("Init")),
        ]),
        refs: HashMap::from([
            (
                origin_topic,
                vec![ref_label(
                    "refs/remotes/origin/topic",
                    "origin/topic",
                    RefType::RemoteBranch,
                )],
            ),
            (
                fork_topic,
                vec![ref_label(
                    "refs/remotes/origin-fork/topic",
                    "origin-fork/topic",
                    RefType::RemoteBranch,
                )],
            ),
        ]),
        stash_order: Vec::new(),
    };

    // Hiding a remote group is a bulk write of the names under it, so a remote whose name
    // merely starts the same way is untouched by construction.
    let mut hidden = RefVisibility::default();
    hidden
        .hidden_refs
        .insert("refs/remotes/origin/topic".to_owned());

    let result = layout(&apply_visibility(&source, &hidden), 0, usize::MAX);

    let summaries: Vec<&str> = result.commits.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(summaries, ["Fork topic", "Init"]);
}

/// A stash has no stable name, so it is hidden by its commit OID, and hiding it takes its
/// row out of the walk.
#[test]
fn a_hidden_stash_leaves_the_walk() {
    let (stash, tip) = (oid(1), oid(2));
    let source = GraphSource {
        placement: PlacementInput {
            oids: vec![stash, tip],
            parents: HashMap::from([(stash, vec![tip]), (tip, vec![])]),
            stashes: HashSet::from([stash]),
            head_tip: Some(tip),
            tracked_upstream: None,
            worktree_dirty: false,
        },
        commits: HashMap::from([(stash, facts("WIP on main")), (tip, facts("Init"))]),
        refs: HashMap::new(),
        stash_order: vec![stash],
    };

    let mut hidden = RefVisibility::default();
    hidden.hidden_stashes.insert(stash.to_string());

    let result = layout(&apply_visibility(&source, &hidden), 0, usize::MAX);

    let summaries: Vec<&str> = result.commits.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(summaries, ["Init"]);
}

/// The empty value is the identity: a repository with no stored preference lays out exactly
/// as it did before this stage existed.
#[test]
fn an_empty_visibility_changes_nothing() {
    let source = source_using_every_captured_field();

    let before = layout(&source, 0, usize::MAX);
    let after = layout(
        &apply_visibility(&source, &RefVisibility::default()),
        0,
        usize::MAX,
    );

    let oids_before: Vec<&str> = before.commits.iter().map(|c| c.oid.as_str()).collect();
    let oids_after: Vec<&str> = after.commits.iter().map(|c| c.oid.as_str()).collect();
    assert_eq!(oids_before, oids_after);
    assert_eq!(before.max_columns, after.max_columns);
}

/// The value the frontend sends is the value the filter reads. `RefVisibility` crosses the
/// `set_ref_visibility` boundary whole, so its serialized field names are a contract with
/// `src/lib/ref-visibility.ts` — a rename on either side silently stops hiding anything.
#[test]
fn the_wire_form_matches_the_frontends_field_names() {
    let mut visibility = RefVisibility::default();
    visibility.hidden_refs.insert("refs/heads/topic".to_owned());
    visibility.hidden_stashes.insert("abc".to_owned());

    let json = serde_json::to_value(&visibility).expect("serialize");
    let object = json.as_object().expect("an object");

    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["hiddenRefs", "hiddenStashes"]);

    let back: RefVisibility = serde_json::from_value(json).expect("round trip");
    assert_eq!(back, visibility);
}

/// An older prefs file, or a frontend that omits a field, still parses: every field defaults.
#[test]
fn a_partial_wire_form_fills_in_the_visible_default() {
    let json = serde_json::json!({ "hiddenRefs": ["refs/heads/topic"] });

    let parsed: RefVisibility = serde_json::from_value(json).expect("parse");

    assert!(parsed.hidden_refs.contains("refs/heads/topic"));
    assert!(parsed.hidden_stashes.is_empty());
}

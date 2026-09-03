//! Every case builds to the fingerprint the shell corpus produced: one test per case,
//! against the oracle file captured before the port.

use trunk_fixtures::fingerprint;

mod common;

use common::{case, oracle, report};

fn assert_matches_oracle(name: &str) {
    trunk_fixtures::isolate();
    let case = case(name);
    let out = tempfile::tempdir().unwrap();

    (case.build)(out.path());

    let actual = fingerprint::fingerprint(out.path(), case.repos).unwrap();
    let expected = oracle(name);
    assert!(
        actual == expected,
        "the built corpus differs from the oracle:\n{}",
        report(&expected, &actual)
    );
}

#[test]
fn stash_lanes_matches_its_oracle() {
    assert_matches_oracle("06-stash-lanes");
}

#[test]
fn graph_lanes_matches_its_oracle() {
    assert_matches_oracle("04-graph-lanes");
}

#[test]
fn graph_merges_matches_its_oracle() {
    assert_matches_oracle("05-graph-merges");
}

#[test]
fn commit_message_matches_its_oracle() {
    assert_matches_oracle("01-commit-message");
}

#[test]
fn staging_ignore_ws_matches_its_oracle() {
    assert_matches_oracle("03-staging-ignore-ws");
}

#[test]
fn remote_branch_matches_its_oracle() {
    assert_matches_oracle("07-remote-branch");
}

#[test]
fn merge_conflict_matches_its_oracle() {
    assert_matches_oracle("08-merge-conflict");
}

#[test]
fn kitchen_sink_matches_its_oracle() {
    assert_matches_oracle("09-kitchen-sink");
}

#[test]
fn nested_conflict_matches_its_oracle() {
    assert_matches_oracle("10-nested-conflict");
}

#[test]
fn diff_scenarios_matches_its_oracle() {
    assert_matches_oracle("02-diff-scenarios");
}

#[test]
fn rendered_markdown_matches_its_oracle() {
    assert_matches_oracle("11-rendered-markdown");
}

#[test]
fn deep_history_matches_its_oracle() {
    assert_matches_oracle("12-deep-history");
}

//! Every case builds to its committed fingerprint: one test per case, against the oracle
//! file captured from the shell corpus before the port, or from the Rust builder for a
//! case added since. The same build is checked for the document a person opening each
//! repository reads, so no test has to build the whole corpus in one go.

use std::path::Path;

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
    assert_documented(out.path(), case.repos);
}

/// 04 and 05 carry no document of their own (the catalogue is theirs); 06 and 07 carry
/// one for the whole corpus, named here.
const CORPUS_DOCUMENTS: [(&str, &str); 4] = [
    ("graph-lanes/", ""),
    ("graph-merges/", ""),
    ("stash-lanes/", "stash-lanes/README.md"),
    ("remote-branch/", "remote-branch/WALKTHROUGH.md"),
];

fn assert_documented(out: &Path, repos: &[&str]) {
    let mut missing = Vec::new();
    for repo in repos {
        let document = match CORPUS_DOCUMENTS
            .iter()
            .find(|(corpus, _)| repo.starts_with(corpus))
        {
            Some((_, "")) => continue,
            Some((_, document)) => (*document).to_owned(),
            None => format!("{repo}/SCENARIO.md"),
        };
        if !out.join(&document).is_file() && !missing.contains(&document) {
            missing.push(document);
        }
    }
    assert!(missing.is_empty(), "documents missing: {missing:?}");
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

#[test]
fn snapshot_impostor_matches_its_oracle() {
    assert_matches_oracle("13-snapshot-impostor");
}

//! Every case builds to the fingerprint the shell corpus produced: one test per case,
//! against the oracle file captured before the port.

use std::path::Path;

use trunk_fixtures::cases::{CASES, Case};
use trunk_fixtures::fingerprint;

fn case(name: &str) -> &'static Case {
    CASES
        .iter()
        .find(|case| case.name == name)
        .unwrap_or_else(|| panic!("{name} is not in CASES"))
}

fn oracle(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("oracle")
        .join(format!("{name}.txt"));

    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The differing lines, block by block, so a failure names the repository and the line.
fn report(expected: &str, actual: &str) -> String {
    let blocks = |text: &str| {
        text.split("\n\n")
            .map(|block| {
                let mut lines = block.lines();
                let name = lines.next().unwrap_or_default().to_owned();
                (name, lines.map(str::to_owned).collect::<Vec<_>>())
            })
            .collect::<Vec<_>>()
    };
    let (expected, actual) = (blocks(expected), blocks(actual));
    let mut out = String::from("the built corpus differs from the oracle:\n");
    for (want, got) in expected.iter().zip(&actual) {
        if want == got {
            continue;
        }
        out.push_str(&format!("  {}\n", want.0));
        let longest = want.1.len().max(got.1.len());
        for i in 0..longest {
            let (w, g) = (want.1.get(i), got.1.get(i));
            if w != g {
                out.push_str(&format!(
                    "    oracle: {}\n    built:  {}\n",
                    w.map_or("<none>", String::as_str),
                    g.map_or("<none>", String::as_str)
                ));
            }
        }
    }
    if expected.len() != actual.len() {
        out.push_str(&format!(
            "  oracle has {} blocks, the build {}\n",
            expected.len(),
            actual.len()
        ));
    }

    out
}

fn assert_matches_oracle(name: &str) {
    trunk_fixtures::isolate();
    let case = case(name);
    let out = tempfile::tempdir().unwrap();

    (case.build)(out.path());

    let actual = fingerprint::fingerprint(out.path(), case.repos).unwrap();
    let expected = oracle(name);
    assert!(actual == expected, "{}", report(&expected, &actual));
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

//! Deterministic text rendering of a graph layout, for golden-file tests
//! and manual QA diffs.
//!
//! Rows are keyed by commit summary rather than OID: editing one fixture churns every
//! descendant hash, and a golden full of churned hashes is unreadable as a diff.

use std::collections::HashMap;
use std::fmt::Write;

use super::types::{GraphCommit, GraphResult, RefLabel};

const UNLOADED: &str = "<not-loaded>";

#[must_use]
pub fn render(result: &GraphResult) -> String {
    let summaries = summaries_by_oid(&result.commits);
    let mut out = String::new();

    writeln!(out, "max_columns={}", result.max_columns).expect("write to String");
    for (row, commit) in result.commits.iter().enumerate() {
        render_row(&mut out, row, commit, &summaries);
    }

    out
}

fn summaries_by_oid(commits: &[GraphCommit]) -> HashMap<&str, &str> {
    commits
        .iter()
        .map(|c| (c.oid.as_str(), c.summary.as_str()))
        .collect()
}

fn render_row(out: &mut String, row: usize, commit: &GraphCommit, summaries: &HashMap<&str, &str>) {
    writeln!(out, "\nrow {row}: {}", commit.summary).expect("write to String");
    writeln!(
        out,
        "  col={} color={} head={} merge={} tip={} stash={} in_head_chain={}",
        commit.column,
        commit.color_index,
        commit.is_head,
        commit.is_merge,
        commit.is_branch_tip,
        commit.is_stash,
        commit.in_head_chain,
    )
    .expect("write to String");

    let parents: Vec<&str> = commit
        .parent_oids
        .iter()
        .map(|oid| *summaries.get(oid.as_str()).unwrap_or(&UNLOADED))
        .collect();
    writeln!(out, "  parents: {}", join_or_dash(&parents)).expect("write to String");

    let refs: Vec<String> = commit.refs.iter().map(render_ref).collect();
    let refs: Vec<&str> = refs.iter().map(String::as_str).collect();
    writeln!(out, "  refs: {}", join_or_dash(&refs)).expect("write to String");

    for edge in &commit.edges {
        writeln!(
            out,
            "  edge {}->{} {:?} color={} dashed={}",
            edge.from_column, edge.to_column, edge.edge_type, edge.color_index, edge.dashed,
        )
        .expect("write to String");
    }
}

fn render_ref(label: &RefLabel) -> String {
    format!(
        "{} ({:?} color={} head={})",
        label.name, label.ref_type, label.color_index, label.is_head,
    )
}

fn join_or_dash(items: &[&str]) -> String {
    if items.is_empty() {
        return "-".to_string();
    }

    items.join(", ")
}

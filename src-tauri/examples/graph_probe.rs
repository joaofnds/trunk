//! Dump `walk_commits` output for one repository as deterministic text.
//!
//!     cargo run --example graph_probe -- <repo-path>
//!
//! Driven by `scripts/qa-stash-probe.sh`, which runs it over the QA stash
//! fixtures so two runs can be diffed.

use trunk_lib::git::graph::walk_commits;
use trunk_lib::git::types::GraphCommit;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("usage: graph_probe <repo-path>");
        std::process::exit(2);
    };

    let mut repo = git2::Repository::open(&path).expect("open repository");
    let result = walk_commits(&mut repo, 0, usize::MAX).expect("walk_commits");

    println!("max_columns={}", result.max_columns);
    for (row, commit) in result.commits.iter().enumerate() {
        print_row(row, commit);
    }
}

fn print_row(row: usize, commit: &GraphCommit) {
    println!(
        "row={row} col={} color={} stash={} merge={} tip={} head_chain={} oid={} summary={}",
        commit.column,
        commit.color_index,
        commit.is_stash,
        commit.is_merge,
        commit.is_branch_tip,
        commit.in_head_chain,
        commit.short_oid,
        commit.summary,
    );

    for edge in &commit.edges {
        println!(
            "  edge {}->{} {:?} color={} dashed={}",
            edge.from_column, edge.to_column, edge.edge_type, edge.color_index, edge.dashed,
        );
    }
}

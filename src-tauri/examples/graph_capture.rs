//! Dump everything `graph::snapshot` reads from one repository, as a committed fixture input.
//!
//!     cargo run --example graph_capture -- <repo-path>
//!
//! Driven by `scripts/graph-capture.sh`, which builds the three graph cases of the fixture
//! corpus (`docs/fixtures.md`) into a throwaway directory, runs this over each repository and
//! writes `src-tauri/tests/inputs/`. The golden suite reads those files instead of building
//! repositories, so this is the only place a built fixture still reaches the graph suites.

use std::collections::HashMap;

use trunk_lib::git::graph::capture;
use trunk_lib::git::graph_input::{CapturedGraph, FixtureInput};

/// The count `RepoView.svelte` passes as `wipCount`. A bare repository has no worktree, so
/// `get_dirty_counts_inner` fails `EBAREREPO` rather than returning zero.
fn wip_count(repo_path: &str) -> usize {
    let repo = git2::Repository::open(repo_path).expect("open repository");
    if repo.is_bare() {
        return 0;
    }

    let state = HashMap::from([(repo_path.to_owned(), std::path::PathBuf::from(repo_path))]);
    let counts = trunk_lib::commands::staging::get_dirty_counts_inner(repo_path, &state)
        .expect("count dirty files");

    counts.staged + counts.unstaged + counts.conflicted
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("usage: graph_capture <repo-path>");
        std::process::exit(2);
    };

    let mut repo = git2::Repository::open(&path).expect("open repository");
    let input = FixtureInput {
        wip_count: wip_count(&path),
        capture: CapturedGraph::from_source(&capture(&mut repo).expect("capture repository")),
    };

    let json = serde_json::to_string_pretty(&input).expect("serialize fixture input");
    println!("{json}");
}

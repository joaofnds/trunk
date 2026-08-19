//! The captured inputs the named-rule placement tests read, in place of building a repository.
//!
//! One file per repository shape, written by `just graph-capture` through
//! `tests/test_graph_capture.rs`. The data is `graph::capture`'s own output, so a test reading
//! it asserts against what the repository really produces; `just graph-fidelity` is what keeps
//! that true. Deliberately outside `tests/inputs/`, which `test_graph_goldens.rs` treats as the
//! snapshot corpus and demands a golden and an export for.

use std::path::{Path, PathBuf};

use trunk_lib::git::graph_input::{self, FixtureInput};
use trunk_lib::git::types::{GraphCommit, GraphResult};

pub fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/rule-inputs")
}

pub fn path(name: &str) -> PathBuf {
    dir().join(format!("{name}.json"))
}

fn read(name: &str) -> FixtureInput {
    let file = path(name);
    let text = std::fs::read_to_string(&file).unwrap_or_else(|e| {
        panic!(
            "read {}: {e} — `just graph-capture` writes it",
            file.display()
        )
    });

    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", file.display()))
}

/// The layout `walk_commits` returns for `name`, taken through the same call it makes.
pub fn walk(name: &str, offset: usize, limit: usize) -> GraphResult {
    graph_input::layout(&read(name).capture.to_source(), offset, limit)
}

pub fn commits(name: &str) -> Vec<GraphCommit> {
    walk(name, 0, usize::MAX).commits
}

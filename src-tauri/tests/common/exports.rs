use std::collections::HashMap;
use std::path::{Path, PathBuf};

use trunk_lib::git::types::GraphResult;

/// One fixture's layout as the app receives it over IPC, plus the `wipCount`
/// `RepoView` derives alongside it. The TypeScript render snapshots mount the
/// graph column against these, so their inputs are placements the backend
/// really produces rather than hand-authored shapes.
#[derive(serde::Serialize)]
struct LayoutExport<'a> {
    #[serde(rename = "wipCount")]
    wip_count: usize,
    layout: &'a GraphResult,
}

pub fn render(result: &GraphResult, wip_count: usize) -> String {
    let export = LayoutExport {
        wip_count,
        layout: result,
    };

    let mut json = serde_json::to_string_pretty(&export).expect("serialize layout export");
    json.push('\n');
    json
}

/// The count `RepoView.svelte` passes as `wipCount`, taken from the same function the
/// app calls so the two cannot drift.
pub fn wip_count(repo_path: &Path) -> usize {
    if git2::Repository::open(repo_path)
        .expect("open fixture")
        .is_bare()
    {
        return 0;
    }

    let path = repo_path.to_string_lossy().into_owned();
    let state = HashMap::from([(path.clone(), repo_path.to_path_buf())]);
    let counts = trunk_lib::commands::staging::get_dirty_counts_inner(&path, &state)
        .expect("count dirty files");

    counts.staged + counts.unstaged + counts.conflicted
}

pub fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/goldens/exports")
}

pub fn path(name: &str) -> PathBuf {
    dir().join(format!("{name}.json"))
}

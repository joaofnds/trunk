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

pub fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/goldens/exports")
}

pub fn path(name: &str) -> PathBuf {
    dir().join(format!("{name}.json"))
}

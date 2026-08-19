use std::path::{Path, PathBuf};

/// Set by `just graph-accept`, never by an ordinary test recipe. A golden that
/// regenerates as a side effect of running the suite pins nothing.
const UPDATE_VAR: &str = "TRUNK_ACCEPT_GRAPH_GOLDENS";

pub const ACCEPT_HINT: &str = "A red graph golden is a suspected defect, not a stale artifact. \
Investigate first. If the new layout is genuinely intended, accept it with \
`just graph-accept \"<reason>\"`, which records the reason in docs/commit-graph-changelog.md.";

pub fn update_requested() -> bool {
    std::env::var_os(UPDATE_VAR).is_some()
}

pub fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/goldens/graph")
}

pub fn path(name: &str) -> PathBuf {
    dir().join(format!("{name}.txt"))
}

pub fn write(path: &Path, contents: &str) {
    std::fs::create_dir_all(path.parent().expect("golden has a parent"))
        .expect("create goldens dir");
    std::fs::write(path, contents).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

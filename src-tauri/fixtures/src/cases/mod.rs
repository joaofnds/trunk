use std::path::{Path, PathBuf};

pub mod commit_message;
pub mod deep_history;
pub mod diff_scenarios;
pub mod graph_lanes;
pub mod graph_merges;
pub mod kitchen_sink;
pub mod merge_conflict;
pub mod nested_conflict;
pub mod remote_branch;
pub mod rendered_markdown;
pub mod staging_ignore_ws;
pub mod stash_lanes;

/// One case of the corpus: the repositories it builds under the output root, and the
/// function that builds them.
pub struct Case {
    pub name: &'static str,
    pub summary: &'static str,
    /// Paths relative to the output root, in the order the oracle lists them.
    pub repos: &'static [&'static str],
    pub build: fn(&Path),
}

/// The catalogue, in case order. There is no discovery: a case exists when it is here.
pub const CASES: &[Case] = &[
    commit_message::CASE,
    diff_scenarios::CASE,
    staging_ignore_ws::CASE,
    graph_lanes::CASE,
    graph_merges::CASE,
    stash_lanes::CASE,
    remote_branch::CASE,
    merge_conflict::CASE,
    kitchen_sink::CASE,
    nested_conflict::CASE,
    rendered_markdown::CASE,
    deep_history::CASE,
];

/// Where `fixtures build` lands without `--out`: `repos/` at the repository root.
pub fn default_out() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("the crate lives two levels below the repository root")
        .join("repos")
}

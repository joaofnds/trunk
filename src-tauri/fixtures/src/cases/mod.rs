use std::path::Path;

pub mod commit_message;
pub mod graph_lanes;
pub mod graph_merges;
pub mod kitchen_sink;
pub mod merge_conflict;
pub mod nested_conflict;
pub mod remote_branch;
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
    graph_lanes::CASE,
    graph_merges::CASE,
    kitchen_sink::CASE,
    merge_conflict::CASE,
    nested_conflict::CASE,
    remote_branch::CASE,
    staging_ignore_ws::CASE,
    stash_lanes::CASE,
];

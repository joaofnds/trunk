use std::path::Path;

pub mod graph_lanes;
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
pub const CASES: &[Case] = &[graph_lanes::CASE, stash_lanes::CASE];

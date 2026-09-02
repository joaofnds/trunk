//! Dump `walk_commits` output for one repository as deterministic text.
//!
//!     cargo run --example graph_probe -- <repo-path>
//!
//! Driven by `scripts/qa-stash-probe.sh`, which runs it over the built
//! `06-stash-lanes` fixtures (`just fixtures 06-stash-lanes`) so two runs can
//! be diffed. Shares `layout_dump` with the golden suite, so a manual QA diff
//! and a red golden read the same.

use trunk_lib::git::graph::walk_commits;
use trunk_lib::git::graph_input::RefVisibility;
use trunk_lib::git::layout_dump;

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        eprintln!("usage: graph_probe <repo-path>");
        std::process::exit(2);
    };

    let mut repo = git2::Repository::open(&path).expect("open repository");
    let result =
        walk_commits(&mut repo, 0, usize::MAX, &RefVisibility::default()).expect("walk_commits");

    print!("{}", layout_dump::render(&result));
}

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use common::{exports, goldens};
use trunk_lib::git::graph_input::{self, FixtureInput};
use trunk_lib::git::layout_dump;
use trunk_lib::git::types::GraphResult;

/// Fixtures that pin a paginated slice as well as the full walk, and the skip and
/// limit that cuts a fork and a merge mid-shape. `layout` lays out the whole
/// graph before paging, so a slice is not the full golden's rows sliced.
const PAGED: [(&str, usize, usize); 1] = [("merge-12-pagination-boundary", 1, 4)];

/// Fixtures laid out a second time with a ref hidden, pinned beside their all-visible pair.
///
/// `lane-05-diverged` is the shape that makes the difference visible: `origin/main` carries
/// two commits `main` does not reach, so hiding it has to drop those rows and leave the rest
/// laid out as before. Each entry is (fixture, full ref name to hide).
const HIDDEN: [(&str, &str); 1] = [("lane-05-diverged", "refs/remotes/origin/main")];

fn hiding(ref_name: &str) -> graph_input::RefVisibility {
    let mut visibility = graph_input::RefVisibility::default();
    visibility.hidden_refs.insert(ref_name.to_owned());
    visibility
}

fn inputs_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/inputs")
}

/// Every committed fixture input, as (name, input), sorted by name. Written by
/// `just graph-capture`; nothing in the test loop builds a repository.
fn fixtures() -> Vec<(String, FixtureInput)> {
    let mut found = Vec::new();

    for entry in std::fs::read_dir(inputs_dir()).expect("read inputs dir") {
        let path = entry.expect("read input entry").path();
        let file_name = path
            .file_name()
            .expect("input has a name")
            .to_string_lossy()
            .into_owned();
        let Some(name) = file_name.strip_suffix(".json") else {
            continue;
        };

        let text = std::fs::read_to_string(&path).expect("read input");
        let input: FixtureInput =
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {file_name}: {e}"));
        found.push((name.to_owned(), input));
    }

    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

fn fixture(name: &str) -> FixtureInput {
    fixtures()
        .into_iter()
        .find(|(n, _)| n == name)
        .unwrap_or_else(|| panic!("no fixture named {name}"))
        .1
}

fn walk(input: &FixtureInput, offset: usize, limit: usize) -> GraphResult {
    graph_input::layout(&input.capture.to_source(), offset, limit)
}

fn layout_of(name: &str) -> String {
    layout_dump::render(&walk(&fixture(name), 0, usize::MAX))
}

/// The names of the artifacts committed in `dir`, with `suffix` stripped.
fn committed_names(dir: &Path, suffix: &str) -> BTreeSet<String> {
    std::fs::read_dir(dir)
        .expect("read artifact dir")
        .filter_map(|entry| {
            let name = entry.expect("read artifact entry").file_name();
            name.to_string_lossy()
                .strip_suffix(suffix)
                .map(str::to_owned)
        })
        .collect()
}

/// Lay every fixture out and compare one rendering of the result against what is
/// committed, or overwrite it when `just graph-accept` asked for that.
fn corpus_drift(
    artifact: fn(&str) -> PathBuf,
    render: impl Fn(&GraphResult, usize) -> String,
) -> Vec<String> {
    let mut drifted = Vec::new();

    for (name, input) in fixtures() {
        let result = walk(&input, 0, usize::MAX);
        let rendered = render(&result, input.wip_count);
        let committed = artifact(&name);

        if goldens::update_requested() {
            goldens::write(&committed, &rendered);
            continue;
        }
        match std::fs::read_to_string(&committed) {
            Ok(found) if found == rendered => {}
            Ok(_) => drifted.push(format!("{name}: changed")),
            Err(_) => drifted.push(format!("{name}: nothing committed")),
        }
    }

    drifted
}

fn assert_no_drift(artifact: &str, drifted: &[String]) {
    assert!(
        drifted.is_empty(),
        "{} fixture(s) drifted from their committed {artifact}:\n  {}\n\n{}",
        drifted.len(),
        drifted.join("\n  "),
        goldens::ACCEPT_HINT,
    );
}

#[test]
fn layout_text_keys_rows_by_summary() {
    let text = layout_of("stash-01-clean-inline");

    assert!(text.contains("Add lib"), "no summary in:\n{text}");
    assert!(!text.contains("oid="), "OID leaked into:\n{text}");
}

#[test]
fn layout_text_names_parents_by_summary() {
    let text = layout_of("stash-01-clean-inline");

    assert!(
        text.contains("parents: Add lib"),
        "no parent link in:\n{text}"
    );
}

#[test]
fn the_export_carries_the_worktree_wip_count() {
    let dirty = fixture("stash-02-dirty-tracked").wip_count;
    let clean = fixture("stash-01-clean-inline").wip_count;

    assert!(dirty > 0, "dirty fixture reported a wip count of {dirty}");
    assert_eq!(clean, 0, "clean fixture reported a wip count of {clean}");
}

#[test]
fn a_bare_fixture_reports_no_wip_rows() {
    assert_eq!(fixture("stash-16-bare-repo.git").wip_count, 0);
}

#[test]
fn every_committed_input_has_a_golden_and_an_export() {
    let names: BTreeSet<String> = fixtures().into_iter().map(|(name, _)| name).collect();

    // A paged slice and a hidden-ref layout are second renderings of an input already in
    // the corpus, not inputs of their own, so each is expected alongside its pair rather
    // than demanding a committed input of its own. A hidden variant carries an export too,
    // which a paged slice does not.
    let mut expected_goldens = names.clone();
    for (name, skip, limit) in PAGED {
        expected_goldens.insert(format!("{name}.rows-{skip}-{limit}"));
    }
    let mut expected_exports = names.clone();
    for (name, _) in HIDDEN {
        expected_goldens.insert(format!("{name}.hidden"));
        expected_exports.insert(format!("{name}.hidden"));
    }

    assert_eq!(committed_names(&goldens::dir(), ".txt"), expected_goldens);
    assert_eq!(committed_names(&exports::dir(), ".json"), expected_exports);
}

#[test]
fn every_fixture_matches_its_committed_layout() {
    let drifted = corpus_drift(goldens::path, |result, _| layout_dump::render(result));

    assert_no_drift("layout", &drifted);
}

#[test]
fn every_fixture_matches_its_committed_export() {
    let drifted = corpus_drift(exports::path, exports::render);

    assert_no_drift("export", &drifted);
}

/// Acceptance #3: hiding a ref drops its pill and every commit only it reaches, and the
/// remaining rows keep a valid layout — which is what the committed golden pins.
#[test]
fn every_hidden_ref_variant_matches_its_committed_layout() {
    let mut drifted = Vec::new();

    for (name, ref_name) in HIDDEN {
        let source = fixture(name).capture.to_source();
        let filtered = graph_input::apply_visibility(&source, &hiding(ref_name));
        let result = graph_input::layout(&filtered, 0, usize::MAX);

        // The layout text and the export move together: the export is what the render
        // goldens mount, and `exportNames()` picks this variant up by its file name.
        for (committed, rendered) in [
            (
                goldens::path(&format!("{name}.hidden")),
                layout_dump::render(&result),
            ),
            (
                exports::path(&format!("{name}.hidden")),
                exports::render(&result, 0),
            ),
        ] {
            if goldens::update_requested() {
                goldens::write(&committed, &rendered);
                continue;
            }
            match std::fs::read_to_string(&committed) {
                Ok(found) if found == rendered => {}
                Ok(_) => drifted.push(format!("{name}: changed")),
                Err(_) => drifted.push(format!("{name}: nothing committed")),
            }
        }
    }

    assert_no_drift("hidden-ref layout", &drifted);
}

/// The golden above only pins bytes. This states what those bytes have to mean, so a wrong
/// golden accepted by mistake still fails here.
#[test]
fn hiding_a_ref_drops_the_rows_only_it_reached() {
    let (name, ref_name) = HIDDEN[0];
    let source = fixture(name).capture.to_source();

    let all = layout_dump::render(&graph_input::layout(&source, 0, usize::MAX));
    let filtered = graph_input::apply_visibility(&source, &hiding(ref_name));
    let hidden = layout_dump::render(&graph_input::layout(&filtered, 0, usize::MAX));

    assert!(all.contains("upstream four"), "fixture changed:\n{all}");
    assert!(
        !hidden.contains("upstream four") && !hidden.contains("upstream three"),
        "a commit only the hidden ref reached survived:\n{hidden}"
    );
    assert!(
        hidden.contains("local six") && hidden.contains("base one"),
        "a commit a visible ref still reaches was dropped:\n{hidden}"
    );
}

#[test]
fn a_paged_walk_renders_only_the_requested_rows() {
    let (name, skip, limit) = PAGED[0];

    let text = layout_dump::render(&walk(&fixture(name), skip, limit));

    assert_eq!(
        text.matches("\nrow ").count(),
        limit,
        "a {limit}-row page rendered:\n{text}"
    );
}

#[test]
fn every_paged_fixture_matches_its_committed_slice() {
    let mut drifted = Vec::new();

    for (name, skip, limit) in PAGED {
        let rendered = layout_dump::render(&walk(&fixture(name), skip, limit));
        let committed = goldens::path(&format!("{name}.rows-{skip}-{limit}"));

        if goldens::update_requested() {
            goldens::write(&committed, &rendered);
            continue;
        }
        match std::fs::read_to_string(&committed) {
            Ok(found) if found == rendered => {}
            Ok(_) => drifted.push(format!("{name}: changed")),
            Err(_) => drifted.push(format!("{name}: nothing committed")),
        }
    }

    assert_no_drift("paginated layout", &drifted);
}

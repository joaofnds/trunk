mod common;

use std::path::{Path, PathBuf};

use common::{exports, fixtures, goldens};
use trunk_lib::git::graph::walk_commits;
use trunk_lib::git::layout_dump;
use trunk_lib::git::types::GraphResult;

/// Fixtures that pin a paginated slice as well as the full walk, and the skip and
/// limit that cuts a fork and a merge mid-shape. `walk_commits` lays out the whole
/// graph before paging, so a slice is not the full golden's rows sliced.
const PAGED: [(&str, usize, usize); 1] = [("merge-12-pagination-boundary", 1, 4)];

fn fixture_path(name: &str) -> PathBuf {
    fixtures::repositories()
        .into_iter()
        .find(|(n, _)| n == name)
        .unwrap_or_else(|| panic!("no fixture named {name}"))
        .1
}

fn layout_of(name: &str) -> String {
    let mut repo = git2::Repository::open(fixture_path(name)).expect("open fixture");

    layout_dump::render(&walk_commits(&mut repo, 0, usize::MAX).expect("walk fixture"))
}

/// Walk every fixture and compare one rendering of the result against what is
/// committed, or overwrite it when `just graph-accept` asked for that.
fn corpus_drift(
    artifact: fn(&str) -> PathBuf,
    render: impl Fn(&GraphResult, &Path) -> String,
) -> Vec<String> {
    let mut drifted = Vec::new();

    for (name, path) in fixtures::repositories() {
        let mut repo = git2::Repository::open(&path).expect("open fixture");
        let result = walk_commits(&mut repo, 0, usize::MAX).expect("walk fixture");
        let rendered = render(&result, &path);
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
fn corpus_holds_fixtures_from_every_script() {
    let root = fixtures::corpus();

    assert!(
        root.join("stash/01-clean-inline").is_dir(),
        "stash corpus missing from {}",
        root.display()
    );
    assert!(
        root.join("lane/01-behind-only").is_dir(),
        "lane corpus missing from {}",
        root.display()
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
    let dirty = exports::wip_count(&fixture_path("stash-02-dirty-tracked"));
    let clean = exports::wip_count(&fixture_path("stash-01-clean-inline"));

    assert!(dirty > 0, "dirty fixture reported a wip count of {dirty}");
    assert_eq!(clean, 0, "clean fixture reported a wip count of {clean}");
}

#[test]
fn a_bare_fixture_reports_no_wip_rows() {
    assert_eq!(
        exports::wip_count(&fixture_path("stash-16-bare-repo.git")),
        0
    );
}

#[test]
fn every_fixture_matches_its_committed_layout() {
    let drifted = corpus_drift(goldens::path, |result, _| layout_dump::render(result));

    assert_no_drift("layout", &drifted);
}

#[test]
fn every_fixture_matches_its_committed_export() {
    let drifted = corpus_drift(exports::path, |result, path| {
        exports::render(result, exports::wip_count(path))
    });

    assert_no_drift("export", &drifted);
}

#[test]
fn a_paged_walk_renders_only_the_requested_rows() {
    let (name, skip, limit) = PAGED[0];
    let mut repo = git2::Repository::open(fixture_path(name)).expect("open fixture");

    let text = layout_dump::render(&walk_commits(&mut repo, skip, limit).expect("walk fixture"));

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
        let mut repo = git2::Repository::open(fixture_path(name)).expect("open fixture");
        let result = walk_commits(&mut repo, skip, limit).expect("walk fixture");
        let rendered = layout_dump::render(&result);
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

#[test]
fn rebuilding_the_corpus_reproduces_every_repository() {
    let rebuilt = tempfile::tempdir().expect("create rebuild dir");
    fixtures::build_into(rebuilt.path());

    for (name, path) in fixtures::repositories() {
        let subdir = name.split_once('-').expect("name carries its corpus").0;
        let twin = rebuilt
            .path()
            .join(subdir)
            .join(path.file_name().expect("fixture has a name"));

        assert_eq!(
            fixtures::reference_fingerprint(&path),
            fixtures::reference_fingerprint(&twin),
            "{name} is not reproducible"
        );
    }
}

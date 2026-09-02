//! Every case is listed with a summary, and every repository a person opens carries its
//! own document saying what to look at.

use trunk_fixtures::cases::CASES;

#[test]
fn every_case_has_a_summary() {
    for case in CASES {
        assert!(
            !case.summary.trim().is_empty(),
            "{} has no summary",
            case.name
        );
    }
}

/// 04 and 05 carry no document of their own (the catalogue is theirs); 06 and 07 carry
/// one for the whole corpus, checked below by name.
fn documented_elsewhere(repo: &str) -> bool {
    [
        "graph-lanes/",
        "graph-merges/",
        "stash-lanes/",
        "remote-branch/",
    ]
    .iter()
    .any(|corpus| repo.starts_with(corpus))
}

#[test]
fn every_built_repository_carries_its_document() {
    trunk_fixtures::isolate();
    let out = tempfile::tempdir().unwrap();
    for case in CASES {
        (case.build)(out.path());
    }

    let mut missing = Vec::new();
    for repo in CASES.iter().flat_map(|case| case.repos.iter()) {
        if documented_elsewhere(repo) {
            continue;
        }
        if !out.path().join(repo).join("SCENARIO.md").is_file() {
            missing.push(format!("{repo}/SCENARIO.md"));
        }
    }
    for document in ["stash-lanes/README.md", "remote-branch/WALKTHROUGH.md"] {
        if !out.path().join(document).is_file() {
            missing.push(document.to_owned());
        }
    }

    assert!(missing.is_empty(), "documents missing: {missing:?}");
}

#[test]
fn every_case_is_listed_in_the_catalogue_document() {
    let doc = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/fixtures.md");
    let text =
        std::fs::read_to_string(&doc).unwrap_or_else(|e| panic!("read {}: {e}", doc.display()));

    let missing: Vec<&str> = CASES
        .iter()
        .map(|case| case.name)
        .filter(|name| !text.contains(&format!("| `{name}` |")))
        .collect();

    assert!(
        missing.is_empty(),
        "cases without a row in docs/fixtures.md: {missing:?}"
    );
}

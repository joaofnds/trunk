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

/// The oracle suite checks each case's build for its documents, so a case without a
/// test there would ship a repository nobody checked.
#[test]
fn every_case_has_an_oracle_test() {
    let suite = include_str!("oracle.rs");
    let missing: Vec<&str> = CASES
        .iter()
        .map(|case| case.name)
        .filter(|name| !suite.contains(&format!("assert_matches_oracle(\"{name}\")")))
        .collect();

    assert!(
        missing.is_empty(),
        "cases without a test in tests/oracle.rs: {missing:?}"
    );
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

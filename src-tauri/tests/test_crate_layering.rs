//! The crates beneath the app stay free of what only the app may use.
//!
//! `trunk-git` and `trunk-review` are what the CLI runs on before any Tauri machinery
//! starts, so neither may depend on Tauri. `trunk-review` also renders the review
//! document without highlighting its code fences (L-10), so neither it nor `trunk-git`,
//! which it builds on, may depend on a highlighter. The compiler refuses a `use` of any
//! of these only while the crate's manifest does not declare it, and this suite is what
//! stops the manifest from declaring it.
use std::path::Path;
use std::process::Command;

/// The packages `package` declares, as normal, build or dev dependencies, on any target.
fn declared_dependencies(package: &str) -> Vec<String> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let output = Command::new(env!("CARGO"))
        .args([
            "metadata",
            "--no-deps",
            "--offline",
            "--format-version",
            "1",
        ])
        .arg("--manifest-path")
        .arg(&manifest)
        .output()
        .expect("run cargo metadata");
    assert!(
        output.status.success(),
        "cargo metadata failed: {}",
        String::from_utf8_lossy(&output.stderr),
    );
    let metadata: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("cargo metadata prints JSON");

    let found = metadata["packages"]
        .as_array()
        .expect("a package list")
        .iter()
        .find(|p| p["name"] == package)
        .unwrap_or_else(|| panic!("{package} is not a workspace member"));
    found["dependencies"]
        .as_array()
        .expect("a dependency list")
        .iter()
        .map(|d| d["name"].as_str().expect("a dependency name").to_string())
        .collect()
}

fn declared_with_prefix(package: &str, prefixes: &[&str]) -> Vec<String> {
    declared_dependencies(package)
        .into_iter()
        .filter(|name| prefixes.iter().any(|prefix| name.starts_with(prefix)))
        .collect()
}

#[test]
fn the_git_plumbing_depends_on_no_tauri_crate() {
    let found = declared_with_prefix("trunk-git", &["tauri"]);

    assert!(found.is_empty(), "trunk-git declares {found:?}");
}

#[test]
fn the_git_plumbing_depends_on_no_highlighter() {
    let found = declared_with_prefix("trunk-git", &["syntect", "two-face"]);

    assert!(found.is_empty(), "trunk-git declares {found:?}");
}

#[test]
fn the_review_domain_depends_on_no_tauri_crate() {
    let found = declared_with_prefix("trunk-review", &["tauri"]);

    assert!(found.is_empty(), "trunk-review declares {found:?}");
}

#[test]
fn the_review_domain_depends_on_no_highlighter() {
    let found = declared_with_prefix("trunk-review", &["syntect", "two-face"]);

    assert!(found.is_empty(), "trunk-review declares {found:?}");
}

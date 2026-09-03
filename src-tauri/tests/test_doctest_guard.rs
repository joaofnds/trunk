//! No doc comment in this workspace carries a runnable example.
//!
//! `just cargo-test` used to run `cargo test --doc` after nextest, because nextest
//! cannot run doctests and the union of the two was what matched `cargo test`. That
//! invocation cost 30s of compile in CI to run nothing: `--doc` needs the `staticlib`
//! and `cdylib` crate types this package declares, which nextest never builds, so it
//! relinked the crate from scratch — and the only fenced block in the tree is an
//! ```ignore example, which no runner executes.
//!
//! Dropping the invocation is only safe while that stays true, and nothing about a
//! doc comment makes it announce itself. This test is the guard: write a runnable
//! example and it fails here, naming the file, rather than going quietly unrun.
//!
//! The fix when it fails is to restore the `--doc` line in `justfile`'s `cargo-test`
//! and delete this test. Paying 30s per CI run to execute a real doctest is a fair
//! trade; paying it to execute nothing is not.

use std::path::{Path, PathBuf};

/// A fenced block inside a doc comment, and the attributes on its opening fence.
struct Fence {
    file: PathBuf,
    line: usize,
    info: String,
}

/// rustdoc runs a fenced block unless its info string says otherwise. `ignore` is not
/// compiled or run at all; `text` and any other unrecognised word means "not Rust", so
/// rustdoc leaves it alone. Everything else — an empty info string, `rust`, `should_panic`,
/// `no_run`, `compile_fail` — is compiled, and all but `no_run` are executed.
fn is_runnable(info: &str) -> bool {
    let attrs: Vec<&str> = info
        .split(',')
        .map(|a| a.trim())
        .filter(|a| !a.is_empty())
        .collect();

    if attrs
        .iter()
        .any(|a| *a == "ignore" || a.starts_with("ignore"))
    {
        return false;
    }
    if attrs.is_empty() {
        return true;
    }
    // Only the words rustdoc knows keep a block Rust. An unknown word (`text`, `json`,
    // `console`) marks it as another language, which rustdoc never runs.
    attrs.iter().any(|a| {
        matches!(
            *a,
            "rust"
                | "should_panic"
                | "no_run"
                | "compile_fail"
                | "edition2015"
                | "edition2018"
                | "edition2021"
                | "edition2024"
        )
    })
}

/// Every fenced block opened inside a `///` or `//!` comment in one file.
///
/// Fences are matched only on doc-comment lines, so a fence inside ordinary code — a
/// string literal holding markdown, of which this repository has several — is never
/// seen. The opening fence's info string is what decides runnability; the closing
/// fence of a pair carries none, so fences alternate and only the odd ones are read.
fn fences(path: &Path) -> Vec<Fence> {
    let text = std::fs::read_to_string(path).expect("read a source file");
    let mut found = Vec::new();
    let mut open: Option<String> = None;

    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim_start();
        let Some(rest) = line
            .strip_prefix("///")
            .or_else(|| line.strip_prefix("//!"))
        else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(info) = rest.strip_prefix("```") else {
            continue;
        };
        // An inline `` ``` `` inside prose is escaped in backticks and never starts a
        // line's content, so reaching here means a real fence.
        match open.take() {
            // This is a closing fence; its info string is not an attribute list.
            Some(_) => {}
            None => {
                open = Some(info.to_string());
                found.push(Fence {
                    file: path.to_path_buf(),
                    line: i + 1,
                    info: info.trim().to_string(),
                });
            }
        }
    }

    found
}

fn rust_sources(root: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(root).expect("read a source directory") {
        let path = entry.expect("a directory entry").path();
        if path.is_dir() {
            if path.file_name().is_some_and(|n| n == "target") {
                continue;
            }
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn no_doc_comment_carries_a_runnable_example() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut sources = Vec::new();
    // Both library crates in the workspace: a doctest in either is one `--doc` would
    // have run and nextest will not.
    rust_sources(&manifest.join("src"), &mut sources);
    rust_sources(&manifest.join("fixtures/src"), &mut sources);
    assert!(
        !sources.is_empty(),
        "found no Rust sources to scan; this guard would pass vacuously",
    );

    let runnable: Vec<String> = sources
        .iter()
        .flat_map(|path| fences(path))
        .filter(|fence| is_runnable(&fence.info))
        .map(|fence| {
            let shown = fence
                .file
                .strip_prefix(manifest)
                .unwrap_or(&fence.file)
                .display()
                .to_string();
            let info = if fence.info.is_empty() {
                "no attributes".to_string()
            } else {
                format!("```{}", fence.info)
            };
            format!("{shown}:{} ({info})", fence.line)
        })
        .collect();

    assert!(
        runnable.is_empty(),
        "a runnable doctest exists, and nothing runs it: nextest cannot, and \
         `just cargo-test` no longer invokes `cargo test --doc`. Restore the `--doc` \
         line in the justfile's `cargo-test` recipe and delete this test. Found:\n  {}",
        runnable.join("\n  "),
    );
}

#[test]
fn the_guard_recognises_which_fences_rustdoc_runs() {
    for info in ["", "rust", "should_panic", "no_run", "compile_fail"] {
        assert!(is_runnable(info), "rustdoc compiles ```{info}");
    }
    for info in ["ignore", "ignore-windows", "text", "json", "console"] {
        assert!(!is_runnable(info), "rustdoc does not run ```{info}");
    }
}

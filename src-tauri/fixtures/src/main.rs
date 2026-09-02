//! `fixtures build [CASE...] [--out DIR]` builds the corpus, `fixtures list` prints the
//! catalogue, `fixtures fingerprint --root DIR PATH...` prints the fingerprint of each
//! repository at PATH under DIR.

use std::path::{Path, PathBuf};

use trunk_fixtures::cases::{CASES, Case, default_out};
use trunk_fixtures::fingerprint;

const USAGE: &str = "usage: fixtures build [CASE...] [--out DIR]
       fixtures list
       fixtures fingerprint --root DIR PATH...";

fn main() {
    trunk_fixtures::isolate();
    let args: Vec<String> = std::env::args().skip(1).collect();

    let outcome = match args.first().map(String::as_str) {
        Some("fingerprint") => print_fingerprint(&args[1..]),
        Some("list") => {
            list();
            Ok(())
        }
        Some("build") => build(&args[1..]),
        _ => Err(USAGE.to_owned()),
    };

    if let Err(message) = outcome {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

/// `build [CASE...] [--out DIR]`: every case, or the ones whose name contains any
/// argument. A repository already under DIR is removed first, as the shell generators
/// did; initialising over one would parent the new history on the old. Every selected
/// case is attempted, and the run fails naming each case that did not build.
fn build(args: &[String]) -> Result<(), String> {
    let mut out = None;
    let mut wanted = Vec::new();
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if arg == "--out" {
            out = Some(PathBuf::from(args.next().ok_or_else(|| USAGE.to_owned())?));
        } else {
            wanted.push(arg.as_str());
        }
    }
    let out = out.unwrap_or_else(default_out);
    let selected = select_cases(&wanted)?;

    let mut failed = Vec::new();
    for case in selected {
        for repo in case.repos {
            remove_stale(&out.join(repo))?;
        }
        if build_case(case, &out) {
            for repo in case.repos {
                println!("{repo}");
            }
        } else {
            failed.push(case.name);
        }
    }
    println!("repositories in {}", out.display());
    if !failed.is_empty() {
        return Err(format!("fixtures build: failed: {}", failed.join(", ")));
    }

    Ok(())
}

/// The cases whose name contains any of `wanted`, in catalogue order; every case when
/// nothing is wanted.
fn select_cases(wanted: &[&str]) -> Result<Vec<&'static Case>, String> {
    if wanted.is_empty() {
        return Ok(CASES.iter().collect());
    }
    for want in wanted {
        if !CASES.iter().any(|case| case.name.contains(want)) {
            return Err(format!("no case matches '{want}'; run `fixtures list`"));
        }
    }

    Ok(CASES
        .iter()
        .filter(|case| wanted.iter().any(|want| case.name.contains(want)))
        .collect())
}

/// `rm -rf` of whatever a previous run left at a repository's path.
fn remove_stale(path: &Path) -> Result<(), String> {
    let removal = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else if path.exists() {
        std::fs::remove_file(path)
    } else {
        return Ok(());
    };

    removal.map_err(|e| format!("remove {}: {e}", path.display()))
}

/// Whether the case built. A verb panics when a fixture cannot be built, and the panic
/// hook has already printed where and why; the case is named at the end.
fn build_case(case: &Case, out: &Path) -> bool {
    std::panic::catch_unwind(|| (case.build)(out)).is_ok()
}

fn list() {
    for case in CASES {
        println!("{:<26} {}", case.name, case.summary);
    }
}

fn print_fingerprint(args: &[String]) -> Result<(), String> {
    let (root, paths) = match args {
        [flag, root, paths @ ..] if flag == "--root" && !paths.is_empty() => {
            (PathBuf::from(root), paths)
        }
        _ => return Err(USAGE.to_owned()),
    };
    let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
    let text = fingerprint::fingerprint(&root, &paths).map_err(|e| e.message().to_owned())?;
    print!("{text}");

    Ok(())
}

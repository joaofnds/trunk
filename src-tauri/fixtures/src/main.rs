//! `fixtures build [CASE...] [--out DIR]` builds the corpus, `fixtures list` prints the
//! catalogue, `fixtures fingerprint --root DIR PATH...` prints the fingerprint of each
//! repository at PATH under DIR.

use std::path::PathBuf;

use trunk_fixtures::cases::{CASES, Case};
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
/// did; initialising over one would parent the new history on the old.
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
    let out = out.ok_or_else(|| "fixtures build: --out DIR is required".to_owned())?;

    let mut selected: Vec<&Case> = Vec::new();
    for want in &wanted {
        let matching: Vec<&Case> = CASES
            .iter()
            .filter(|case| case.name.contains(want))
            .collect();
        if matching.is_empty() {
            return Err(format!("no case matches '{want}'; run `fixtures list`"));
        }
        for case in matching {
            if !selected.iter().any(|chosen| chosen.name == case.name) {
                selected.push(case);
            }
        }
    }
    if wanted.is_empty() {
        selected.extend(CASES.iter());
    }

    for case in selected {
        for repo in case.repos {
            let stale = out.join(repo);
            if stale.exists() {
                std::fs::remove_dir_all(&stale)
                    .map_err(|e| format!("remove {}: {e}", stale.display()))?;
            }
        }
        (case.build)(&out);
        for repo in case.repos {
            println!("{repo}");
        }
    }
    println!("repositories in {}", out.display());

    Ok(())
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

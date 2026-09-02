//! `fixtures build [CASE...] [--out DIR]` builds the corpus, `fixtures list` prints the
//! catalogue, `fixtures fingerprint --root DIR PATH...` prints the fingerprint of each
//! repository at PATH under DIR.

use std::path::PathBuf;

use trunk_fixtures::cases::CASES;
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
        Some("build") => Err("fixtures build: no cases yet".to_owned()),
        _ => Err(USAGE.to_owned()),
    };

    if let Err(message) = outcome {
        eprintln!("{message}");
        std::process::exit(1);
    }
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

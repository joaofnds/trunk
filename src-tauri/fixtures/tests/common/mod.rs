// Each `tests/*.rs` file is a separate crate, so a helper used by only some of them
// shows up as dead_code in the others. This is shared by design.
#![allow(dead_code)]

use std::path::Path;
use std::process::{Command, Output};

use trunk_fixtures::cases::{CASES, Case};

pub fn case(name: &str) -> &'static Case {
    CASES
        .iter()
        .find(|case| case.name == name)
        .unwrap_or_else(|| panic!("{name} is not in CASES"))
}

pub fn oracle(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("oracle")
        .join(format!("{name}.txt"));

    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// The differing lines between two corpus fingerprints, block by block, so a failure
/// names the repository and the line.
pub fn report(expected: &str, actual: &str) -> String {
    let blocks = |text: &str| {
        text.split("\n\n")
            .map(|block| {
                let mut lines = block.lines();
                let name = lines.next().unwrap_or_default().to_owned();
                (name, lines.map(str::to_owned).collect::<Vec<_>>())
            })
            .collect::<Vec<_>>()
    };
    let (expected, actual) = (blocks(expected), blocks(actual));
    let mut out = String::new();
    for (want, got) in expected.iter().zip(&actual) {
        if want == got {
            continue;
        }
        out.push_str(&format!("  {}\n", want.0));
        let longest = want.1.len().max(got.1.len());
        for i in 0..longest {
            let (w, g) = (want.1.get(i), got.1.get(i));
            if w != g {
                out.push_str(&format!(
                    "    expected: {}\n    actual:   {}\n",
                    w.map_or("<none>", String::as_str),
                    g.map_or("<none>", String::as_str)
                ));
            }
        }
    }
    if expected.len() != actual.len() {
        out.push_str(&format!(
            "  expected {} blocks, got {}\n",
            expected.len(),
            actual.len()
        ));
    }

    out
}

/// The `fixtures` binary, ready to run: a caller that needs to set the environment
/// the binary sees keeps that setup at its own call site.
pub fn fixtures_command(args: &[&std::ffi::OsStr]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_fixtures"));
    command.args(args);

    command
}

/// The `fixtures` binary, run with the environment it inherits.
pub fn fixtures(args: &[&std::ffi::OsStr]) -> Output {
    fixtures_command(args).output().unwrap()
}

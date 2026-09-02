//! Nothing in the operator's global git configuration reaches a fixture. libgit2 locates
//! its global and XDG config files through HOME and reads neither GIT_CONFIG_GLOBAL nor
//! GIT_CONFIG_SYSTEM on this crate's open path (TRUNK-109); the binary blanks the search
//! paths before opening any repository, and this test is what proves it for the global and
//! XDG levels. The system level (/etc/gitconfig) cannot be planted from a test and is
//! covered only by the oracle comparison on a machine that has one.
//!
//! The binary is spawned rather than built in-process: libgit2's search paths are
//! process-global and set once, so a HOME set from inside a test process that already
//! opened a repository would prove nothing (doc-45 §7).

use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::process::Command;

use trunk_fixtures::cases::CASES;
use trunk_fixtures::fingerprint;

const CASES_UNDER_TEST: [&str; 3] = ["09-kitchen-sink", "06-stash-lanes", "04-graph-lanes"];

/// A HOME carrying the settings the shell corpus's isolation suite guarded against. Two of
/// them reach libgit2 and would move the corpus: `core.excludesFile` in `.gitconfig`,
/// hiding the file kitchen-sink stashes with -u, and `init.defaultBranch` in the XDG file,
/// which would name the HEAD of every bare remote 04 creates without one. The hook, the
/// signing and the identity never reach libgit2 (it runs no hooks, signs nothing, and every
/// fixture sets its own identity); they stay so the file reads as the whole hostile config.
fn hostile_home(home: &Path) {
    std::fs::write(home.join("ignore"), "src/wip3.ts\n").unwrap();
    let hooks = home.join("hooks");
    std::fs::create_dir(&hooks).unwrap();
    let hook = hooks.join("pre-commit");
    std::fs::write(
        &hook,
        "#!/bin/sh\necho hooked > hooked.txt\ngit add hooked.txt\n",
    )
    .unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(
        home.join(".gitconfig"),
        format!(
            "[core]\n\texcludesFile = {}\n\thooksPath = {}\n[commit]\n\tgpgsign = true\n[user]\n\tname = Hostile Operator\n\temail = hostile@example.invalid\n",
            home.join("ignore").display(),
            hooks.display()
        ),
    )
    .unwrap();
    let xdg = home.join(".config/git");
    std::fs::create_dir_all(&xdg).unwrap();
    std::fs::write(xdg.join("config"), "[init]\n\tdefaultBranch = trunk\n").unwrap();
}

fn build_under(home: &Path, out: &Path) {
    let output = Command::new(env!("CARGO_BIN_EXE_fixtures"))
        .arg("build")
        .args(CASES_UNDER_TEST)
        .arg("--out")
        .arg(out)
        .env("HOME", home)
        .env_remove("XDG_CONFIG_HOME")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "the build under HOME={} failed:\n{}",
        home.display(),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn repos_of(name: &str) -> &'static [&'static str] {
    CASES
        .iter()
        .find(|case| case.name == name)
        .unwrap_or_else(|| panic!("{name} is not in CASES"))
        .repos
}

fn oracle(name: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("oracle")
        .join(format!("{name}.txt"));

    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

#[test]
fn a_hostile_home_builds_the_same_corpus_as_a_clean_one() {
    trunk_fixtures::isolate();
    let hostile = tempfile::tempdir().unwrap();
    hostile_home(hostile.path());
    let clean = tempfile::tempdir().unwrap();
    let hostile_out = tempfile::tempdir().unwrap();
    let clean_out = tempfile::tempdir().unwrap();

    build_under(hostile.path(), hostile_out.path());
    build_under(clean.path(), clean_out.path());

    let mut differences = Vec::new();
    for name in CASES_UNDER_TEST {
        let repos = repos_of(name);
        let under_hostile = fingerprint::fingerprint(hostile_out.path(), repos).unwrap();
        let under_clean = fingerprint::fingerprint(clean_out.path(), repos).unwrap();
        if under_hostile != under_clean {
            differences.push(format!(
                "{name} differs between the clean and the hostile HOME:\n{}",
                first_difference(&under_clean, &under_hostile)
            ));
        }
        if under_hostile != oracle(name) {
            differences.push(format!(
                "{name} under the hostile HOME differs from its oracle:\n{}",
                first_difference(&oracle(name), &under_hostile)
            ));
        }
    }
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}

/// The first line that differs, with the repository block it sits in.
fn first_difference(expected: &str, actual: &str) -> String {
    let expected: Vec<&str> = expected.lines().collect();
    let actual: Vec<&str> = actual.lines().collect();
    let longest = expected.len().max(actual.len());
    let Some(at) = (0..longest).find(|&i| expected.get(i) != actual.get(i)) else {
        return "no line differs".to_owned();
    };
    let block = expected[..at.min(expected.len())]
        .iter()
        .rev()
        .find(|line| line.starts_with("repo "))
        .unwrap_or(&"<no block>");

    format!(
        "  in {block}\n  expected: {}\n  actual:   {}",
        expected.get(at).unwrap_or(&"<end>"),
        actual.get(at).unwrap_or(&"<end>")
    )
}

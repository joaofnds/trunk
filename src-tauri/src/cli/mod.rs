//! The `trunk review` argv branch. It runs before any Tauri machinery — the
//! builder, the single-instance socket, every plugin — so a CLI invocation
//! never activates the GUI, and a running app never sees it (D4).

/// The review-subcommand arguments when `args` is a `trunk review …`
/// invocation, `None` when the process should start the GUI. `args` is the
/// full argv including the program name.
pub fn review_args(args: &[String]) -> Option<&[String]> {
    match args.get(1).map(String::as_str) {
        Some("review") => Some(&args[2..]),
        _ => None,
    }
}

/// Run the review subcommand and return the process exit code. Output goes to
/// stdout, errors to stderr with a nonzero exit and no partial write (§5.1).
pub fn run_review(args: &[String]) -> i32 {
    let _ = args;
    eprintln!("usage: trunk review <list|show|reply|address> [--repo <path>]");
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_argv_branches_on_review() {
        let args = argv(&["trunk", "review", "list"]);

        assert_eq!(review_args(&args), Some(&args[2..]));
    }

    #[test]
    fn parse_argv_ignores_everything_but_review() {
        assert_eq!(review_args(&argv(&["trunk"])), None);
        assert_eq!(review_args(&argv(&["trunk", "some.file"])), None);
    }
}

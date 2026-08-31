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

pub mod review;

/// Run the review subcommand and return the process exit code. Output goes to
/// stdout, errors to stderr with a nonzero exit and no partial write (§5.1).
/// Usage mistakes exit 2, store and repo failures exit 1.
pub fn run_review(args: &[String]) -> i32 {
    // The release binary is `windows_subsystem = "windows"` (main.rs): no
    // console is allocated, so `trunk.exe review list` typed into cmd.exe
    // would print nothing and exit, while a piped invocation still worked.
    // Attaching to the parent's console (when there is one) is what makes
    // the interactive case behave; without it, D4's "packaging dissolves"
    // is false on Windows. Interactive Windows use is unverified on the
    // development host — the CI Windows job compiles this.
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::{ATTACH_PARENT_PROCESS, AttachConsole};
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }

    let cmd = match review::parse(args) {
        Ok(cmd) => cmd,
        Err(usage) => {
            eprintln!("{usage}");
            return 2;
        }
    };

    let identifier = crate::context::<tauri::Wry>().config().identifier.clone();
    match review::run(cmd, &identifier) {
        Ok(out) => {
            print!("{out}");
            0
        }
        Err(e) => {
            eprintln!("{}: {}", e.code, e.message);
            1
        }
    }
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

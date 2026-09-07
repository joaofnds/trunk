//! The `trunk` CLI: the clap definition, process-level concerns (the Windows
//! console attach, printing, exit codes) and dispatch into the review verbs.
//!
//! It runs before any Tauri machinery — the builder, the single-instance
//! socket, every plugin — so a CLI invocation never activates the GUI, and a
//! running app never sees it (D4). `Launch::of` (`crate::launch`) is what
//! routes argv here in the first place.

pub mod lookup;
pub mod render;
pub mod review;
pub mod watch;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "trunk",
    bin_name = "trunk",
    version,
    about = "Trunk, a desktop Git client. Run it with no arguments to open the app."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Read and answer code reviews from the terminal
    Review {
        #[command(subcommand)]
        cmd: review::ReviewCmd,
    },
}

/// Run the CLI and return the process exit code.
///
/// Output goes to stdout, errors to stderr with a nonzero exit and no partial write
/// (§5.1). Usage mistakes exit 2, store and repo failures exit 1, help and version exit 0.
#[must_use]
pub fn run(args: &[String]) -> i32 {
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

    let cli = match Cli::try_parse_from(args) {
        Ok(cli) => cli,
        Err(usage) => {
            let _ = usage.print();
            return usage.exit_code();
        }
    };
    let Command::Review { cmd } = cli.command;

    let identifier = crate::context::<tauri::Wry>().config().identifier.clone();
    match review::run(cmd, &identifier, &mut std::io::stdout()) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{}: {}", e.code, e.message);
            1
        }
    }
}

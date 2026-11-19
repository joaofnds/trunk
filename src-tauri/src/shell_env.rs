use std::io::Read;
use std::sync::OnceLock;
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

static SHELL_PATH: OnceLock<String> = OnceLock::new();

const PATH_BEGIN: &str = "__TRUNK_PATH_BEGIN__";
const PATH_END: &str = "__TRUNK_PATH_END__";

/// How long the user's shell may take to start before git runs with the system
/// PATH instead. The slowest start measured on a developer laptop is 0.56 s.
const LOGIN_SHELL_DEADLINE: Duration = Duration::from_secs(10);

/// PATH that matches what the user gets in their terminal.
///
/// GUI apps launched from Finder/Dock inherit launchd's minimal environment
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), so git subprocesses resolve a different
/// `git`/`gpg`/`ssh` than the user's shell does — on this machine the app would
/// pick Apple's `/usr/bin/git` while the terminal uses the Nix `git`. That
/// divergence makes "Pull" behave unlike `git pull`, the exact surprise we want
/// to avoid.
///
/// We recover the real PATH by sourcing the user's login + interactive shell
/// once — the same `.zprofile`/`.zshrc` (etc.) the terminal sources — and
/// reading back `$PATH`. `path_helper` is a fallback: it only knows
/// `/etc/paths(.d)`, orders system dirs first, and never sees a user's package
/// manager.
pub fn system_path() -> &'static str {
    SHELL_PATH.get_or_init(resolve)
}

/// Resolve [`system_path`] on a thread of its own, so the user's first commit,
/// merge or push does not wait for their shell's startup files.
pub fn resolve_in_background() {
    let resolving = std::thread::Builder::new()
        .name("shell-path".into())
        .spawn(system_path);
    // Without the thread the first git action resolves the PATH itself.
    drop(resolving);
}

fn resolve() -> String {
    if let Some(path) = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
        .and_then(|shell| from_login_shell(&shell))
    {
        return path;
    }
    #[cfg(target_os = "macos")]
    if let Some(path) = from_path_helper() {
        return path;
    }
    std::env::var("PATH").unwrap_or_default()
}

/// Ask the user's login + interactive shell for its `$PATH`.
///
/// `-l -i -c` sources the same startup files the terminal does (login + rc),
/// then runs the print command and exits — `-c` means it never enters a REPL,
/// so it can't hang on input. Markers bracket the value so any banner the rc
/// files write to stdout is discarded; stderr (job-control chatter under `-i`)
/// is dropped. Startup files that never finish are given
/// [`LOGIN_SHELL_DEADLINE`].
fn from_login_shell(shell: &str) -> Option<String> {
    ask_login_shell(shell, |printed| {
        printed.recv_timeout(LOGIN_SHELL_DEADLINE).ok()
    })
}

/// Run `shell` for its `$PATH`, with `wait` returning what it printed or `None`
/// once it is out of time. A shell out of time is stopped.
///
/// The shell stays in the caller's process group, so a fetch worker that is
/// cancelled while it waits here stops the shell along with itself.
fn ask_login_shell(
    shell: &str,
    wait: impl FnOnce(&Receiver<std::io::Result<Vec<u8>>>) -> Option<std::io::Result<Vec<u8>>>,
) -> Option<String> {
    let script = format!("printf '%s%s%s' '{PATH_BEGIN}' \"$PATH\" '{PATH_END}'");
    let mut command = std::process::Command::new(shell);
    command
        .args(["-l", "-i", "-c", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = command.spawn().ok()?;

    let mut stdout = child.stdout.take().expect("the shell's stdout is piped");
    let (sender, printed) = channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        drop(sender.send(stdout.read_to_end(&mut bytes).map(|_| bytes)));
    });

    let Some(Ok(bytes)) = wait(&printed) else {
        drop(child.kill());
        drop(child.wait());
        eprintln!("{shell} gave no PATH; git runs with the system PATH");
        return None;
    };
    if !child.wait().ok()?.success() {
        return None;
    }
    parse_marked_path(&String::from_utf8_lossy(&bytes))
}

/// Extract the PATH the shell printed between our markers. Returns `None` when a
/// marker is missing or the value is empty, so `resolve` falls through.
fn parse_marked_path(stdout: &str) -> Option<String> {
    let start = stdout.find(PATH_BEGIN)? + PATH_BEGIN.len();
    let end = start + stdout[start..].find(PATH_END)?;
    let path = &stdout[start..end];
    if path.is_empty() {
        None
    } else {
        Some(path.to_owned())
    }
}

#[cfg(target_os = "macos")]
fn from_path_helper() -> Option<String> {
    let output = std::process::Command::new("/usr/libexec/path_helper")
        .arg("-s")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_path_helper_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(any(target_os = "macos", test))]
fn parse_path_helper_output(stdout: &str) -> Option<String> {
    // Output format: PATH="<paths>"; export PATH;\n
    let start = stdout.find('"')? + 1;
    let end = start + stdout[start..].find('"')?;
    Some(stdout[start..end].to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A login shell made of `body`, in a directory the test owns.
    #[cfg(unix)]
    fn shell(body: &str) -> (tempfile::TempDir, String) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("shell.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        let path = path.to_str().unwrap().to_owned();

        (directory, path)
    }

    #[cfg(unix)]
    #[test]
    fn a_login_shell_gives_the_path_it_prints() {
        let (_directory, shell) = shell(&format!(
            "printf '{PATH_BEGIN}/opt/user/bin:/usr/bin{PATH_END}'"
        ));

        let path = from_login_shell(&shell);

        assert_eq!(path.as_deref(), Some("/opt/user/bin:/usr/bin"));
    }

    #[cfg(unix)]
    #[test]
    fn a_login_shell_out_of_time_gives_no_path() {
        let (_directory, shell) = shell("exec sleep 86400");

        assert_eq!(ask_login_shell(&shell, |_| None), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_login_shell_out_of_time_is_stopped() {
        let (_directory, shell) = shell("exec 3>\"$0.alive\"\necho started >&3\nexec sleep 86400");
        let alive = format!("{shell}.alive");
        let fifo = std::ffi::CString::new(alive.as_str()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let opening = std::thread::spawn(move || std::fs::File::open(alive).unwrap());
        let mut held = None;

        ask_login_shell(&shell, |_| {
            let mut alive = std::io::BufReader::new(opening.join().unwrap());
            std::io::BufRead::read_line(&mut alive, &mut String::new()).unwrap();
            held = Some(alive);
            None
        });

        // Only the shell holds the fifo open, so it reads to its end only once
        // the shell has exited.
        let mut rest = Vec::new();
        std::io::Read::read_to_end(&mut held.unwrap(), &mut rest).unwrap();
        assert_eq!(rest, b"");
    }

    #[test]
    fn extracts_path_between_markers() {
        let input = format!("{PATH_BEGIN}/opt/homebrew/bin:/usr/bin{PATH_END}");
        assert_eq!(
            parse_marked_path(&input).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn ignores_rc_banner_around_markers() {
        let input =
            format!("Welcome to your shell!\n{PATH_BEGIN}/run/current-system/sw/bin{PATH_END}\n");
        assert_eq!(
            parse_marked_path(&input).as_deref(),
            Some("/run/current-system/sw/bin")
        );
    }

    #[test]
    fn returns_none_when_end_marker_missing() {
        let input = format!("{PATH_BEGIN}/usr/bin");
        assert!(parse_marked_path(&input).is_none());
    }

    #[test]
    fn returns_none_when_begin_marker_missing() {
        let input = format!("/usr/bin{PATH_END}");
        assert!(parse_marked_path(&input).is_none());
    }

    #[test]
    fn returns_none_on_empty_path() {
        let input = format!("{PATH_BEGIN}{PATH_END}");
        assert!(parse_marked_path(&input).is_none());
    }

    #[test]
    fn parses_sh_format() {
        let input = r#"PATH="/usr/bin:/opt/homebrew/bin:/usr/sbin"; export PATH;"#;
        assert_eq!(
            parse_path_helper_output(input).as_deref(),
            Some("/usr/bin:/opt/homebrew/bin:/usr/sbin")
        );
    }

    #[test]
    fn parses_csh_format() {
        // path_helper -c outputs: setenv PATH "/usr/bin:/bin";
        let input = r#"setenv PATH "/usr/bin:/bin";"#;
        assert_eq!(
            parse_path_helper_output(input).as_deref(),
            Some("/usr/bin:/bin")
        );
    }

    #[test]
    fn returns_none_on_empty() {
        assert!(parse_path_helper_output("").is_none());
    }

    #[test]
    fn returns_none_on_no_quotes() {
        assert!(parse_path_helper_output("PATH=/usr/bin").is_none());
    }

    #[test]
    fn returns_none_on_single_quote() {
        assert!(parse_path_helper_output(r#"PATH="/usr/bin"#).is_none());
    }
}

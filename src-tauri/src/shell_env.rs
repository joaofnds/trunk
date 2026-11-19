use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

static SHELL_PATH: OnceLock<String> = OnceLock::new();

const PATH_BEGIN: &str = "__TRUNK_PATH_BEGIN__";
const PATH_END: &str = "__TRUNK_PATH_END__";

const LOGIN_SHELL_DEADLINE: Duration = Duration::from_secs(10);

/// Who stops a login shell whose startup files never finish.
#[derive(Clone, Copy)]
enum Stopper {
    /// The lookup, once [`LOGIN_SHELL_DEADLINE`] passes, along with every process
    /// the shell started.
    Deadline,
    /// The caller's process group, which the app stops when a fetch worker's
    /// fetch is cancelled or out of time.
    CallerGroup,
}

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
    SHELL_PATH.get_or_init(|| resolve(Stopper::Deadline))
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

/// [`system_path`], when it has already been resolved.
pub fn resolved_path() -> Option<&'static str> {
    SHELL_PATH.get().map(String::as_str)
}

/// The terminal's PATH for a fetch worker, whose process group the app stops.
#[must_use]
pub fn worker_path() -> String {
    resolve(Stopper::CallerGroup)
}

fn resolve(stopper: Stopper) -> String {
    let shell = std::env::var("SHELL").unwrap_or_default();
    if !shell.is_empty()
        && let Some(path) = from_login_shell(&shell, stopper)
    {
        return path;
    }

    eprintln!("the login shell gave no PATH, so git runs without the terminal's PATH");
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
/// is dropped.
fn from_login_shell(shell: &str, stopper: Stopper) -> Option<String> {
    match stopper {
        Stopper::Deadline => ask_login_shell(shell, stopper, |answer| {
            answer.recv_timeout(LOGIN_SHELL_DEADLINE).ok()
        }),
        Stopper::CallerGroup => ask_login_shell(shell, stopper, |answer| answer.recv().ok()),
    }
}

/// Run `shell` for its `$PATH`, with `wait` returning the shell's answer, or
/// `None` once the shell is out of time.
fn ask_login_shell(
    shell: &str,
    stopper: Stopper,
    wait: impl FnOnce(&Receiver<Option<String>>) -> Option<Option<String>>,
) -> Option<String> {
    let script = format!("printf '%s%s%s' '{PATH_BEGIN}' \"$PATH\" '{PATH_END}'");
    let mut command = Command::new(shell);
    command
        .args(["-l", "-i", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    if matches!(stopper, Stopper::Deadline) {
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
    }
    let mut child = command.spawn().ok()?;

    let stdout = child.stdout.take().expect("the shell's stdout is piped");
    let (sender, answer) = channel();
    let reading = std::thread::Builder::new()
        .name("shell-path-reader".into())
        .spawn(move || drop(sender.send(read_marked_path(stdout))));
    let path = reading.ok().and_then(|_| wait(&answer)).flatten();

    if path.is_none() {
        stop(&mut child, stopper);
    }
    reap(child);
    path
}

/// Read the shell's output up to the PATH it prints. Reading on to the end
/// would also wait for any process the startup files leave running in the
/// background, since such a process holds the same output open.
fn read_marked_path(mut stdout: impl Read) -> Option<String> {
    let mut printed = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        match stdout.read(&mut chunk) {
            Ok(0) => return None,
            Ok(read) => printed.extend_from_slice(&chunk[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }

        if let Some(path) = parse_marked_path(&String::from_utf8_lossy(&printed)) {
            return Some(path);
        }
    }
}

fn stop(child: &mut Child, stopper: Stopper) {
    match stopper {
        Stopper::Deadline => crate::remote_ops::RemoteProcess::background(child.id()).stop(),
        Stopper::CallerGroup => drop(child.kill()),
    }
}

/// Collect the shell's exit status on a thread of its own, since a shell that
/// printed its PATH may still be running its logout files.
fn reap(mut child: Child) {
    let reaping = std::thread::Builder::new()
        .name("shell-path-reaper".into())
        .spawn(move || drop(child.wait()));
    drop(reaping);
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

        let path = from_login_shell(&shell, Stopper::Deadline);

        assert_eq!(path.as_deref(), Some("/opt/user/bin:/usr/bin"));
    }

    #[cfg(unix)]
    #[test]
    fn a_login_shell_gives_its_path_while_a_job_it_started_still_runs() {
        let (_directory, shell) = shell(&format!(
            "sleep 86400 &\necho $! > \"$0.job\"\nprintf '{PATH_BEGIN}/opt/user/bin{PATH_END}'"
        ));

        let path = from_login_shell(&shell, Stopper::Deadline);

        let job = std::fs::read_to_string(format!("{shell}.job")).unwrap();
        unsafe { libc::kill(job.trim().parse().unwrap(), libc::SIGKILL) };
        assert_eq!(path.as_deref(), Some("/opt/user/bin"));
    }

    #[cfg(unix)]
    #[test]
    fn a_login_shell_out_of_time_gives_no_path() {
        let (_directory, shell) = shell("exec sleep 86400");

        assert_eq!(ask_login_shell(&shell, Stopper::Deadline, |_| None), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_login_shell_out_of_time_is_stopped_with_everything_it_started() {
        let (_directory, shell) =
            shell("exec 3>\"$0.alive\"\nsleep 86400 &\necho started >&3\nwait");
        let alive = format!("{shell}.alive");
        let fifo = std::ffi::CString::new(alive.as_str()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let opening = std::thread::spawn(move || std::fs::File::open(alive).unwrap());
        let mut held = None;

        ask_login_shell(&shell, Stopper::Deadline, |_| {
            let mut alive = std::io::BufReader::new(opening.join().unwrap());
            std::io::BufRead::read_line(&mut alive, &mut String::new()).unwrap();
            held = Some(alive);
            None
        });

        // The shell and its sleep both hold the fifo open, so it reads to its end
        // only once both have exited.
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

use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::process::{Command, ExitStatus, Output, Stdio};
use trunk_git::error::TrunkError;

/// The git the user's terminal runs.
///
/// [`UserGit::output`] returns when git exits. [`Command::output`] reads git's
/// output to its end instead, and a process a hook leaves running in the
/// background holds that output open, so it would wait for that process too.
pub struct UserGit(Command);

impl UserGit {
    #[must_use]
    pub fn in_dir(dir: impl AsRef<Path>) -> Self {
        let mut git = Command::new("git");
        git.current_dir(dir)
            .env("PATH", crate::shell_env::system_path());

        Self(git)
    }

    pub fn arg(&mut self, arg: impl AsRef<OsStr>) -> &mut Self {
        self.0.arg(arg);
        self
    }

    pub fn args<I, S>(&mut self, args: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.0.args(args);
        self
    }

    pub fn env(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> &mut Self {
        self.0.env(key, value);
        self
    }

    /// Runs git for a caller that needs only whether it succeeded.
    ///
    /// # Errors
    ///
    /// Returns `code` with the reason git would not start, or with [`refusal`]
    /// when git ran and failed.
    pub fn run(&mut self, code: &str) -> Result<(), TrunkError> {
        let output = self
            .output()
            .map_err(|e| TrunkError::new(code, e.to_string()))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(TrunkError::new(code, refusal(&output)))
        }
    }

    /// Runs git with no input and returns what it printed, once it exits.
    ///
    /// # Errors
    ///
    /// Returns the error from starting git or from the files that hold its output.
    pub fn output(&mut self) -> io::Result<Output> {
        let mut stdout = tempfile::tempfile()?;
        let mut stderr = tempfile::tempfile()?;

        let status = self
            .0
            .stdin(Stdio::null())
            .stdout(stdout.try_clone()?)
            .stderr(stderr.try_clone()?)
            .status()?;

        Ok(Output {
            status,
            stdout: read_from_start(&mut stdout)?,
            stderr: read_from_start(&mut stderr)?,
        })
    }

    /// Starts git for a caller that shows its progress, read from stderr as git
    /// writes it. Nothing reads stdout, which goes nowhere so a large diffstat
    /// cannot fill a pipe and stall git. Reading stderr to its end also waits
    /// for any process a hook left running.
    ///
    /// # Errors
    ///
    /// Returns the error from starting git.
    pub fn spawn_showing_progress(self) -> io::Result<tokio::process::Child> {
        let mut git = tokio::process::Command::from(self.0);
        git.stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        git.process_group(0);

        git.spawn()
    }
}

/// Why git refused, in its own words where it gave any.
///
/// That is its stderr, else its stdout, where `git commit` says there is
/// nothing to commit, else its exit status, since a hook can refuse without
/// printing a word.
#[must_use]
pub fn refusal(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    [stderr.trim(), stdout.trim()]
        .into_iter()
        .find(|text| !text.is_empty())
        .map_or_else(|| silent_refusal(output.status), str::to_owned)
}

fn silent_refusal(status: ExitStatus) -> String {
    status.code().map_or_else(
        || "git was stopped by a signal and printed no reason.".to_owned(),
        |code| {
            format!(
                "git exited with code {code} and printed no reason. A hook may have refused it."
            )
        },
    )
}

fn read_from_start(file: &mut File) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.seek(SeekFrom::Start(0))?;
    file.read_to_end(&mut bytes)?;

    Ok(bytes)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    const fn silent(status: ExitStatus) -> Output {
        Output {
            status,
            stdout: Vec::new(),
            stderr: Vec::new(),
        }
    }

    #[test]
    fn a_silent_exit_names_its_code_and_the_hook_that_may_have_refused() {
        let refused = silent(ExitStatus::from_raw(1 << 8));

        assert_eq!(
            refusal(&refused),
            "git exited with code 1 and printed no reason. A hook may have refused it."
        );
    }

    #[test]
    fn a_silent_kill_says_a_signal_stopped_git() {
        let killed = silent(ExitStatus::from_raw(9));

        assert_eq!(
            refusal(&killed),
            "git was stopped by a signal and printed no reason."
        );
    }

    #[test]
    fn stderr_wins_over_stdout_and_is_trimmed() {
        let output = Output {
            status: ExitStatus::from_raw(1 << 8),
            stdout: b"nothing to commit\n".to_vec(),
            stderr: b"\n  error: refused\n".to_vec(),
        };

        assert_eq!(refusal(&output), "error: refused");
    }
}

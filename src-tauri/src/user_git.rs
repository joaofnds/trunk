use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::process::{Command, Output, Stdio};

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
    [stderr.trim_end(), stdout.trim_end()]
        .into_iter()
        .find(|text| !text.is_empty())
        .map_or_else(
            || format!("git exited with {} and printed no reason", output.status),
            str::to_owned,
        )
}

fn read_from_start(file: &mut File) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.seek(SeekFrom::Start(0))?;
    file.read_to_end(&mut bytes)?;

    Ok(bytes)
}

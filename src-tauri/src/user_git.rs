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

    /// The command itself, for a caller that reads git's output as it runs.
    #[must_use]
    pub fn into_command(self) -> Command {
        self.0
    }
}

impl AsRef<Command> for UserGit {
    fn as_ref(&self) -> &Command {
        &self.0
    }
}

fn read_from_start(file: &mut File) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.seek(SeekFrom::Start(0))?;
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

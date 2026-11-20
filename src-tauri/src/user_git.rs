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

    /// Starts git in a process group of its own, for a command the user can cancel
    /// while it runs.
    ///
    /// Its stdout and stderr go to files, so waiting for it ends at git's exit and
    /// a large diffstat cannot stall it.
    ///
    /// # Errors
    ///
    /// Returns the error from making the files for git's output or from starting git.
    pub fn spawn(self) -> io::Result<RunningGit> {
        let stdout = tempfile::tempfile()?;
        let stderr = tempfile::tempfile()?;
        let mut git = tokio::process::Command::from(self.0);
        git.stdout(stdout.try_clone()?)
            .stderr(stderr.try_clone()?)
            .kill_on_drop(true);
        #[cfg(unix)]
        git.process_group(0);

        Ok(RunningGit {
            child: git.spawn()?,
            stdout,
            stderr,
        })
    }
}

/// The configuration the user's git reads, which libgit2 can read differently: it
/// skips `GIT_CONFIG_GLOBAL` and the `includeIf` conditions it does not know.
pub struct UserConfig(Vec<(String, Option<String>)>);

impl UserConfig {
    /// Reads the entries whose names match `pattern`, an extended regular expression.
    ///
    /// # Errors
    ///
    /// Returns `code` with the reason git would not start, or with [`refusal`] when
    /// git cannot read the configuration.
    pub fn read(dir: impl AsRef<Path>, pattern: &str, code: &str) -> Result<Self, TrunkError> {
        let output = UserGit::in_dir(dir)
            .args(["config", "--null", "--get-regexp", pattern])
            .output()
            .map_err(|e| TrunkError::new(code, e.to_string()))?;
        if output.status.success() {
            return Ok(Self::parse(&output.stdout));
        }

        match output.status.code() {
            Some(1) => Ok(Self(Vec::new())),
            _ => Err(TrunkError::new(code, refusal(&output))),
        }
    }

    fn parse(listing: &[u8]) -> Self {
        let entries = String::from_utf8_lossy(listing)
            .split_terminator('\0')
            .map(|entry| match entry.split_once('\n') {
                Some((name, value)) => (name.to_owned(), Some(value.to_owned())),
                None => (entry.to_owned(), None),
            })
            .collect();

        Self(entries)
    }

    /// Whether `name` is set at all, with or without a value.
    #[must_use]
    pub fn is_set(&self, name: &str) -> bool {
        self.0.iter().any(|(entry, _)| entry == name)
    }

    /// The value git uses for `name`, the last one set, as `Some(None)` for a name set
    /// with no value, which git reads as true.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<Option<&str>> {
        self.0
            .iter()
            .rev()
            .find(|(entry, _)| entry == name)
            .map(|(_, value)| value.as_deref())
    }
}

/// A git started by [`UserGit::spawn`].
pub struct RunningGit {
    child: tokio::process::Child,
    stdout: File,
    stderr: File,
}

impl RunningGit {
    /// Git's process id, which is also its process group's.
    #[must_use]
    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    /// Waits for git to exit and returns its status and what it printed.
    ///
    /// # Errors
    ///
    /// Returns the error from waiting for git, which kills it, or from reading its
    /// output.
    pub async fn wait(mut self) -> io::Result<Output> {
        let status = match self.child.wait().await {
            Ok(status) => status,
            Err(error) => {
                let _ = self.child.kill().await;
                return Err(error);
            }
        };

        Ok(Output {
            status,
            stdout: read_from_start(&mut self.stdout)?,
            stderr: read_from_start(&mut self.stderr)?,
        })
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
    fn the_last_value_set_is_the_one_git_uses() {
        let config = UserConfig::parse(b"pull.rebase\ntrue\0pull.rebase\nfalse\0");

        assert_eq!(config.get("pull.rebase"), Some(Some("false")));
    }

    #[test]
    fn a_name_set_with_no_value_reads_as_set_without_one() {
        let config = UserConfig::parse(b"pull.rebase\0");

        assert_eq!(config.get("pull.rebase"), Some(None));
    }

    #[test]
    fn a_value_keeps_its_own_line_breaks() {
        let config = UserConfig::parse(b"alias.two\nlog\n-1\0");

        assert_eq!(config.get("alias.two"), Some(Some("log\n-1")));
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

use std::os::unix::fs::PermissionsExt;

use super::context::TestContext;

/// A process a hook started in the background, holding git's output open for as
/// long as the directory it watches exists, which [`LeftRunning::release`] or the
/// drop removes.
pub struct LeftRunning {
    gate: tempfile::TempDir,
}

impl LeftRunning {
    pub fn release(self) {
        self.gate.close().unwrap();
    }
}

/// A hook that says it has started, then waits to be let go.
pub struct PausedHook {
    fifos: tempfile::TempDir,
}

impl PausedHook {
    pub fn install(ctx: &TestContext, name: &str) -> Self {
        let fifos = tempfile::tempdir().unwrap();
        for fifo in ["started", "go"] {
            let made = std::process::Command::new("mkfifo")
                .arg(fifos.path().join(fifo))
                .status()
                .unwrap();
            assert!(made.success(), "mkfifo failed");
        }
        let hook = Self { fifos };
        ctx.install_hook(
            name,
            &format!(
                "echo started > '{}'\nread line < '{}'",
                hook.fifo("started").display(),
                hook.fifo("go").display()
            ),
        );

        hook
    }

    fn fifo(&self, name: &str) -> std::path::PathBuf {
        self.fifos.path().join(name)
    }

    pub fn wait_until_started(&self) {
        std::fs::read_to_string(self.fifo("started")).unwrap();
    }

    pub fn let_go(&self) {
        std::fs::write(self.fifo("go"), "go\n").unwrap();
    }

    /// Lets the hook go from a thread of its own, so a hook that something
    /// killed meanwhile leaves that thread waiting rather than the test.
    pub fn let_go_if_still_running(&self) {
        let go = self.fifo("go");
        std::thread::spawn(move || std::fs::write(go, "go\n"));
    }
}

impl TestContext {
    pub fn install_hook(&self, name: &str, script: &str) {
        let hook = self.repo_path().join(".git").join("hooks").join(name);
        std::fs::write(&hook, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// Installs a `name` hook that starts a process in the background and exits.
    /// Every process each run of the hook starts watches the same directory, so
    /// removing it ends them all, however many runs there were.
    pub fn install_hook_leaving_a_process_running(&self, name: &str) -> LeftRunning {
        let gate = tempfile::tempdir().unwrap();
        let quoted = gate.path().display().to_string().replace('\'', r"'\''");
        self.install_hook(
            name,
            &format!("(while [ -d '{quoted}' ]; do sleep 0.05; done) &"),
        );
        LeftRunning { gate }
    }
}

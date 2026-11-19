use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use super::context::TestContext;

/// A process a hook started in the background, holding git's output open until
/// [`LeftRunning::release`] lets it exit.
pub struct LeftRunning {
    _gate: tempfile::TempDir,
    fifo: PathBuf,
}

impl LeftRunning {
    pub fn release(self) {
        std::fs::write(&self.fifo, "go\n").unwrap();
    }
}

impl TestContext {
    pub fn install_hook(&self, name: &str, script: &str) {
        let hook = self.repo_path().join(".git").join("hooks").join(name);
        std::fs::write(&hook, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// Installs a `name` hook that starts a process in the background and exits.
    pub fn install_hook_leaving_a_process_running(&self, name: &str) -> LeftRunning {
        let gate = tempfile::tempdir().unwrap();
        let fifo = gate.path().join("release");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(made.success(), "mkfifo failed");

        self.install_hook(name, &format!("(read line < '{}') &", fifo.display()));
        LeftRunning { _gate: gate, fifo }
    }
}

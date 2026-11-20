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

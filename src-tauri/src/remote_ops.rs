use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
use trunk_git::error::TrunkError;

#[derive(Clone, Copy, Debug)]
pub struct RemoteProcess {
    pub pid: u32,
    termination: Termination,
}

#[derive(Clone, Copy, Debug)]
enum Termination {
    Graceful,
    Forced,
}

impl RemoteProcess {
    #[must_use]
    pub const fn foreground(pid: u32) -> Self {
        Self {
            pid,
            termination: Termination::Graceful,
        }
    }

    #[must_use]
    pub const fn background(pid: u32) -> Self {
        Self {
            pid,
            termination: Termination::Forced,
        }
    }

    /// Stop the operation and its credential/transport children.
    pub fn stop(self) {
        #[cfg(unix)]
        if let Ok(pid) = i32::try_from(self.pid)
            && pid > 0
        {
            // SAFETY: this group was created by our child with process_group(0).
            unsafe {
                libc::kill(
                    -pid,
                    match self.termination {
                        Termination::Graceful => libc::SIGTERM,
                        Termination::Forced => libc::SIGKILL,
                    },
                );
            }
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .output();
        }
    }

    fn stop_and_wait(self) {
        #[cfg(windows)]
        // Hold a handle before termination so exit, rather than taskkill returning,
        // determines when an aborted executor's reservation can be released.
        let process = unsafe {
            windows_sys::Win32::System::Threading::OpenProcess(
                windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE,
                0,
                self.pid,
            )
        };
        Self::background(self.pid).stop();
        #[cfg(windows)]
        if !process.is_null() {
            // SAFETY: OpenProcess returned this owned handle with wait access.
            unsafe {
                windows_sys::Win32::System::Threading::WaitForSingleObject(
                    process,
                    windows_sys::Win32::System::Threading::INFINITE,
                );
                windows_sys::Win32::Foundation::CloseHandle(process);
            }
        }
        #[cfg(unix)]
        if let Ok(pid) = i32::try_from(self.pid)
            && pid > 0
        {
            // SAFETY: we own the child; a null status pointer is permitted. ECHILD
            // means tokio already reaped it. No reservation is released before exit.
            loop {
                let result = unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
                if result >= 0
                    || std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR)
                {
                    break;
                }
            }
        }
    }
}

#[derive(Debug)]
struct Operation {
    path: String,
    common: String,
    kind: OperationKind,
    process: Option<RemoteProcess>,
    cancelled: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum OperationKind {
    Background,
    Foreground,
}

#[derive(Clone, Copy)]
pub struct RemoteTarget<'a> {
    pub path: &'a str,
    pub common: &'a str,
}

/// Atomic reservations, held through process exit and graph reconciliation.
#[derive(Debug, Default)]
pub struct RemoteOps {
    operations: HashMap<u64, Operation>,
    ref_reconciliations: HashMap<String, usize>,
    sequence: u64,
    changed: Arc<Notify>,
}

impl RemoteOps {
    #[must_use]
    pub fn busy(&self, path: &str) -> bool {
        self.operations
            .values()
            .any(|operation| operation.path == path || operation.common == path)
    }

    /// # Errors
    ///
    /// Returns `op_in_progress` for a shared-repository conflict, or for any operation
    /// while a new background job is trying to acquire the application-wide permit.
    pub fn reserve_background(&mut self, target: RemoteTarget<'_>) -> Result<u64, TrunkError> {
        if !self.operations.is_empty() || self.ref_reconciliations.contains_key(target.common) {
            return Err(operation_in_progress());
        }

        self.reserve(target, OperationKind::Background)
    }

    /// # Errors
    /// Returns `op_in_progress` for a shared-repository conflict.
    pub fn reserve_foreground(&mut self, target: RemoteTarget<'_>) -> Result<u64, TrunkError> {
        self.reserve(target, OperationKind::Foreground)
    }

    fn reserve(
        &mut self,
        target: RemoteTarget<'_>,
        kind: OperationKind,
    ) -> Result<u64, TrunkError> {
        if self.busy(target.path) || self.busy(target.common) {
            return Err(TrunkError::new(
                "op_in_progress",
                "A remote operation is already running",
            ));
        }
        self.sequence += 1;
        self.operations.insert(
            self.sequence,
            Operation {
                path: target.path.to_owned(),
                common: target.common.to_owned(),
                kind,
                process: None,
                cancelled: false,
            },
        );
        Ok(self.sequence)
    }

    /// Request cancellation; the executing owner releases its reservation after exit.
    pub fn cancel(&mut self, path: &str) -> Option<RemoteProcess> {
        let operation = self
            .operations
            .values_mut()
            .find(|operation| operation.path == path)?;
        operation.cancelled = true;
        operation.process
    }

    fn complete(&mut self, id: u64) {
        if self.operations.remove(&id).is_some() {
            self.changed.notify_waiters();
        }
    }
}

/// The owner of one reservation. An identity, rather than a path, controls cleanup.
pub struct RemoteReservation<'a> {
    running: &'a Mutex<RemoteOps>,
    id: u64,
}

impl<'a> RemoteReservation<'a> {
    /// # Errors
    ///
    /// Returns `op_in_progress` when execution cannot be reserved.
    ///
    /// # Panics
    ///
    /// Panics when the registry lock is poisoned.
    #[cfg(any(test, feature = "test-util"))]
    pub fn acquire_background(
        running: &'a Mutex<RemoteOps>,
        target: RemoteTarget<'_>,
    ) -> Result<Self, TrunkError> {
        let id = running.lock().unwrap().reserve_background(target)?;
        Ok(Self { running, id })
    }

    /// Validate the repository session while cancellation and acquisition are excluded.
    ///
    /// # Errors
    ///
    /// Returns `not_open` for a closed session or `op_in_progress` for a conflicting job.
    ///
    /// # Panics
    ///
    /// Panics when the registry lock is poisoned.
    pub fn acquire_background_checked(
        running: &'a Mutex<RemoteOps>,
        target: RemoteTarget<'_>,
        valid: impl FnOnce() -> bool,
    ) -> Result<Self, TrunkError> {
        Self::acquire_checked(running, valid, |registry| {
            registry.reserve_background(target)
        })
    }

    /// # Errors
    /// Returns `not_open` for a closed session or `op_in_progress` for a conflicting job.
    /// # Panics
    /// Panics when the registry lock is poisoned.
    pub fn acquire_foreground_checked(
        running: &'a Mutex<RemoteOps>,
        target: RemoteTarget<'_>,
        valid: impl FnOnce() -> bool,
    ) -> Result<Self, TrunkError> {
        Self::acquire_checked(running, valid, |registry| {
            registry.reserve_foreground(target)
        })
    }

    fn acquire_checked(
        running: &'a Mutex<RemoteOps>,
        valid: impl FnOnce() -> bool,
        reserve: impl FnOnce(&mut RemoteOps) -> Result<u64, TrunkError>,
    ) -> Result<Self, TrunkError> {
        let mut registry = running.lock().unwrap();
        if !valid() {
            return Err(TrunkError::new("not_open", "Repository session was closed"));
        }

        let id = reserve(&mut registry)?;
        drop(registry);
        Ok(Self { running, id })
    }

    /// Attach the child only while the reservation still exists. Cancellation before
    /// spawn is remembered, so it cannot lose the newly created process.
    ///
    /// # Panics
    ///
    /// Panics when the registry lock is poisoned.
    pub fn attach(&self, process: RemoteProcess) {
        let mut running = self.running.lock().unwrap();
        if let Some(operation) = running.operations.get_mut(&self.id) {
            operation.process = Some(process);
            if operation.cancelled {
                process.stop();
            }
        } else {
            process.stop();
        }
    }

    /// # Panics
    ///
    /// Panics when the registry lock is poisoned.
    #[must_use]
    pub fn cancelled(&self) -> bool {
        self.running
            .lock()
            .unwrap()
            .operations
            .get(&self.id)
            .is_none_or(|operation| operation.cancelled)
    }

    /// Record an observed exit while retaining exclusion for graph reconciliation.
    ///
    /// # Panics
    ///
    /// Panics when the registry lock is poisoned.
    pub fn exited(&self) {
        if let Some(operation) = self.running.lock().unwrap().operations.get_mut(&self.id) {
            operation.process = None;
        }
    }
}

impl Drop for RemoteReservation<'_> {
    fn drop(&mut self) {
        let process = self
            .running
            .lock()
            .unwrap()
            .operations
            .get(&self.id)
            .and_then(|operation| operation.process);
        if let Some(process) = process {
            process.stop_and_wait();
        }
        self.running.lock().unwrap().complete(self.id);
    }
}

pub struct RefReconciliation<'a> {
    running: &'a Mutex<RemoteOps>,
    common: String,
}

impl Drop for RefReconciliation<'_> {
    fn drop(&mut self) {
        let mut running = self.running.lock().unwrap();
        let readers = running.ref_reconciliations.get_mut(&self.common).unwrap();
        *readers -= 1;
        if *readers == 0 {
            running.ref_reconciliations.remove(&self.common);
        }
    }
}

/// Await the executing owner and exclude a new background job through reconciliation.
///
/// # Panics
///
/// Panics when the registry lock is poisoned.
pub async fn wait_background_idle<'a>(
    running: &'a Mutex<RemoteOps>,
    common: &str,
) -> RefReconciliation<'a> {
    let changed = Arc::clone(&running.lock().unwrap().changed);
    loop {
        let mut notified = std::pin::pin!(changed.notified());
        notified.as_mut().enable();
        let admitted = {
            let mut registry = running.lock().unwrap();
            let busy = registry.operations.values().any(|operation| {
                operation.common == common && operation.kind == OperationKind::Background
            });
            if !busy {
                *registry
                    .ref_reconciliations
                    .entry(common.to_owned())
                    .or_default() += 1;
            }
            !busy
        };
        if admitted {
            return RefReconciliation {
                running,
                common: common.to_owned(),
            };
        }
        notified.await;
    }
}

fn operation_in_progress() -> TrunkError {
    TrunkError::new("op_in_progress", "A remote operation is already running")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ref_reconciliation_excludes_a_new_background_owner() {
        let running = Mutex::new(RemoteOps::default());
        let target = RemoteTarget {
            path: "/repo",
            common: "/shared.git",
        };
        let observation = wait_background_idle(&running, target.common).await;

        let attempted = running.lock().unwrap().reserve_background(target);

        assert_eq!(attempted.unwrap_err().code, "op_in_progress");
        drop(observation);
        assert!(running.lock().unwrap().reserve_background(target).is_ok());
    }

    #[tokio::test]
    async fn ref_reconciliation_allows_foreground_and_unrelated_background_work() {
        let running = Mutex::new(RemoteOps::default());
        let first = wait_background_idle(&running, "/shared.git").await;
        let second = wait_background_idle(&running, "/shared.git").await;
        let foreground = running
            .lock()
            .unwrap()
            .reserve_foreground(RemoteTarget {
                path: "/repo",
                common: "/shared.git",
            })
            .unwrap();
        running.lock().unwrap().complete(foreground);
        let unrelated = running
            .lock()
            .unwrap()
            .reserve_background(RemoteTarget {
                path: "/other",
                common: "/other.git",
            })
            .unwrap();
        running.lock().unwrap().complete(unrelated);
        drop(first);

        assert!(
            running
                .lock()
                .unwrap()
                .reserve_background(RemoteTarget {
                    path: "/repo",
                    common: "/shared.git",
                })
                .is_err()
        );
        drop(second);
        assert!(
            running
                .lock()
                .unwrap()
                .reserve_background(RemoteTarget {
                    path: "/repo",
                    common: "/shared.git",
                })
                .is_ok()
        );
    }

    #[cfg(unix)]
    #[test]
    fn foreground_cancellation_lets_git_remove_transaction_locks() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};

        let temp = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init_bare(temp.path()).unwrap();
        let tree_oid = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let signature = git2::Signature::now("Test", "test@example.com").unwrap();
        let oid = repo
            .commit(None, &signature, &signature, "Initial", &tree, &[])
            .unwrap();
        let mut child = Command::new("git")
            .args(["update-ref", "--stdin"])
            .current_dir(temp.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        writeln!(input, "start\ncreate refs/heads/topic {oid}\nprepare").unwrap();
        input.flush().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "start: ok");
        line.clear();
        output.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "prepare: ok");
        assert!(repo.path().join("refs/heads/topic.lock").exists());

        RemoteProcess::foreground(child.id()).stop();
        let status = child.wait().unwrap();

        assert!(!status.success());
        assert!(!repo.path().join("refs/heads/topic.lock").exists());
        assert!(repo.find_reference("refs/heads/topic").is_err());
    }

    #[test]
    fn worktree_aliases_share_exclusion_and_old_completion_cannot_release_a_new_owner() {
        let mut operations = RemoteOps::default();
        let first = operations
            .reserve_background(RemoteTarget {
                path: "worktree-a",
                common: "canonical-common",
            })
            .unwrap();
        assert!(
            operations
                .reserve_foreground(RemoteTarget {
                    path: "worktree-b",
                    common: "canonical-common"
                })
                .is_err()
        );
        assert!(
            operations
                .reserve_background(RemoteTarget {
                    path: "another-repo",
                    common: "another-common"
                })
                .is_err()
        );
        operations.complete(first);
        let second = operations
            .reserve_foreground(RemoteTarget {
                path: "worktree-b",
                common: "canonical-common",
            })
            .unwrap();
        operations.complete(first);
        assert!(operations.busy("canonical-common"));
        operations.complete(second);
        assert!(!operations.busy("canonical-common"));
    }
}

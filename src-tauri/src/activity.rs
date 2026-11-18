#[cfg(feature = "test-util")]
use std::sync::Condvar;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, Runtime,
    ipc::{CommandArg, CommandItem, InvokeBody, InvokeError},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActivityError {
    pub code: &'static str,
    pub message: &'static str,
}

impl ActivityError {
    const fn busy() -> Self {
        Self {
            code: "update_busy",
            message: "Trunk is busy or preparing an update",
        }
    }

    const fn invalid() -> Self {
        Self {
            code: "update_permit_invalid",
            message: "Update preparation is no longer current",
        }
    }
}

#[derive(Debug, Default)]
enum Phase {
    #[default]
    Open,
    Preparing(String),
    Installing(String),
    Exiting,
}

#[derive(Debug, Default)]
struct Admission {
    phase: Phase,
    active: usize,
    generation: u64,
}

#[derive(Debug, Default)]
struct Gate {
    admission: Mutex<Admission>,
    #[cfg(feature = "test-util")]
    settled: Condvar,
}

#[derive(Debug, Clone, Default)]
pub struct ActivityState(Arc<Gate>);

impl ActivityState {
    /// Admit ordinary work while update preparation is open.
    /// # Errors
    /// Returns busy once update preparation has begun.
    /// # Panics
    /// Panics if the admission mutex is poisoned.
    pub fn acquire(&self) -> Result<Activity, ActivityError> {
        self.acquire_command("", None)
    }

    fn acquire_command(
        &self,
        command: &str,
        permit: Option<&str>,
    ) -> Result<Activity, ActivityError> {
        let mut state = self.0.admission.lock().unwrap();
        let allowed = match &state.phase {
            Phase::Open => true,
            Phase::Preparing(token) => {
                permit == Some(token.as_str())
                    && matches!(
                        command,
                        "prefs_get" | "prefs_set" | "save_draft" | "get_draft" | "delete_draft"
                    )
            }
            Phase::Installing(_) | Phase::Exiting => false,
        };
        if !allowed {
            return Err(ActivityError::busy());
        }
        state.active += 1;
        drop(state);

        Ok(Activity(Arc::new(Lease(self.clone()))))
    }

    /// Accept a native exit and prevent update preparation from racing shutdown.
    /// # Panics
    /// Panics if the admission mutex is poisoned.
    #[must_use]
    pub fn begin_exit(&self) -> bool {
        let mut state = self.0.admission.lock().unwrap();
        if matches!(state.phase, Phase::Preparing(_) | Phase::Installing(_)) {
            return false;
        }
        state.phase = Phase::Exiting;
        drop(state);

        true
    }

    /// Close ordinary admission only when all previously admitted work has settled.
    /// # Errors
    /// Returns busy if work or another preparation is active.
    /// # Panics
    /// Panics if the admission mutex is poisoned.
    pub fn begin_prepare(&self) -> Result<String, ActivityError> {
        let mut state = self.0.admission.lock().unwrap();
        if state.active != 0 || !matches!(state.phase, Phase::Open) {
            return Err(ActivityError::busy());
        }
        state.generation += 1;
        let token = format!("prepare-{}", state.generation);
        state.phase = Phase::Preparing(token.clone());
        drop(state);

        Ok(token)
    }

    /// Finish preparation after all permit-bearing persistence has settled.
    /// # Errors
    /// Returns invalid for a stale token and busy for unsettled writes.
    /// # Panics
    /// Panics if the admission mutex is poisoned.
    pub fn finish_prepare(&self, token: &str) -> Result<(), ActivityError> {
        let mut state = self.0.admission.lock().unwrap();
        if !matches!(&state.phase, Phase::Preparing(current) if current == token) {
            return Err(ActivityError::invalid());
        }
        if state.active != 0 {
            return Err(ActivityError::busy());
        }
        state.phase = Phase::Installing(token.to_owned());
        drop(state);

        Ok(())
    }

    /// Cancel preparation once its persistence work has settled.
    /// # Errors
    /// Returns invalid after installation begins or for a stale token; busy while flushing.
    /// # Panics
    /// Panics if the admission mutex is poisoned.
    pub fn cancel_prepare(&self, token: &str) -> Result<(), ActivityError> {
        let mut state = self.0.admission.lock().unwrap();
        if !matches!(&state.phase, Phase::Preparing(current) if current == token) {
            return Err(ActivityError::invalid());
        }
        if state.active != 0 {
            return Err(ActivityError::busy());
        }
        state.phase = Phase::Open;
        drop(state);

        Ok(())
    }

    /// Block until no lease is held, so a test can begin preparation once the
    /// background work an earlier command left running has settled.
    /// # Panics
    /// Panics if the admission mutex is poisoned.
    #[cfg(feature = "test-util")]
    pub fn wait_until_settled(&self) {
        let state = self.0.admission.lock().unwrap();
        drop(
            self.0
                .settled
                .wait_while(state, |state| state.active != 0)
                .unwrap(),
        );
    }

    /// Reopen after the installer proves the original executable remains intact.
    /// # Errors
    /// Returns invalid unless this token owns the installing phase.
    /// # Panics
    /// Panics if the admission mutex is poisoned.
    pub fn recover_install(&self, token: &str) -> Result<(), ActivityError> {
        let mut state = self.0.admission.lock().unwrap();
        if !matches!(&state.phase, Phase::Installing(current) if current == token) {
            return Err(ActivityError::invalid());
        }
        state.phase = Phase::Open;
        drop(state);

        Ok(())
    }
}

#[derive(Debug)]
struct Lease(ActivityState);

impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.0.0.admission.lock().unwrap();
        state.active -= 1;
        #[cfg(feature = "test-util")]
        if state.active == 0 {
            self.0.0.settled.notify_all();
        }
    }
}

#[derive(Debug, Clone)]
pub struct Activity(Arc<Lease>);

impl Activity {
    /// Admit an independently scheduled worker.
    /// # Errors
    /// Returns busy while an update owns admission.
    /// # Panics
    /// Panics if managed activity state is missing or its mutex is poisoned.
    pub fn for_app<R: Runtime>(app: &AppHandle<R>) -> Result<Self, ActivityError> {
        app.state::<ActivityState>().acquire()
    }

    /// Keep admission through the real blocking closure even if its caller is dropped.
    pub fn spawn_blocking<F, T>(&self, work: F) -> tauri::async_runtime::JoinHandle<T>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        let lease = Arc::clone(&self.0);
        tauri::async_runtime::spawn_blocking(move || {
            let _lease = lease;
            work()
        })
    }
}

impl<'de, R: Runtime> CommandArg<'de, R> for Activity {
    fn from_command(item: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        let permit = match item.message.payload() {
            InvokeBody::Json(payload) => payload
                .get("__updatePermit")
                .and_then(serde_json::Value::as_str),
            InvokeBody::Raw(_) => None,
        };
        item.message
            .webview_ref()
            .state::<ActivityState>()
            .acquire_command(item.name, permit)
            .map_err(InvokeError::from)
    }
}

/// Refresh observations that external tools may have changed during update preparation.
/// # Errors
/// Returns busy unless ordinary work has reopened.
/// # Panics
/// Panics if managed repository state is missing or a shared state lock is poisoned.
pub fn resume_after_update<R: Runtime>(app: &AppHandle<R>) -> Result<(), ActivityError> {
    let _activity = Activity::for_app(app)?;
    let repositories = app.state::<crate::state::RepoState>().snapshot();
    let cache = app.state::<crate::state::CommitCache>();
    for (path, _) in repositories.locations() {
        cache.invalidate(path);
        let _ = app.emit(
            "repo-changed",
            crate::watcher::RepoChanged::whole_repo(path),
        );
    }
    let _ = app.emit("reviews-changed", ());

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preparation_only_admits_token_bearing_flushes() {
        let state = ActivityState::default();
        let token = state.begin_prepare().unwrap();

        assert!(state.acquire().is_err());
        assert!(state.acquire_command("stage_all", Some(&token)).is_err());
        assert!(state.acquire_command("prefs_set", Some("stale")).is_err());
        assert!(state.acquire_command("prefs_set", None).is_err());
        assert!(state.acquire_command("prefs_set", Some(&token)).is_ok());
        assert!(state.acquire_command("delete_draft", Some(&token)).is_ok());
        assert!(state.acquire_command("clear_draft", Some(&token)).is_err());
    }

    #[test]
    fn flushing_defers_installation_and_cancellation() {
        let state = ActivityState::default();
        let token = state.begin_prepare().unwrap();
        let flush = state.acquire_command("save_draft", Some(&token)).unwrap();

        assert_eq!(state.finish_prepare(&token), Err(ActivityError::busy()));
        assert_eq!(state.cancel_prepare(&token), Err(ActivityError::busy()));
        drop(flush);
        assert_eq!(state.finish_prepare(&token), Ok(()));
        assert_eq!(state.cancel_prepare(&token), Err(ActivityError::invalid()));
        assert!(state.acquire_command("save_draft", Some(&token)).is_err());
    }

    #[test]
    fn stale_preparation_cannot_cancel_a_new_preparation() {
        let state = ActivityState::default();
        let old = state.begin_prepare().unwrap();
        state.cancel_prepare(&old).unwrap();
        let current = state.begin_prepare().unwrap();

        assert_ne!(old, current);
        assert_eq!(state.cancel_prepare(&old), Err(ActivityError::invalid()));
        assert!(state.acquire().is_err());
        state.cancel_prepare(&current).unwrap();
        assert!(state.acquire().is_ok());
    }

    #[test]
    fn dropped_caller_retains_admission_until_blocking_work_exits() {
        let state = ActivityState::default();
        let work = state.acquire().unwrap();
        let (started, running) = std::sync::mpsc::channel();
        let (release, finish) = std::sync::mpsc::channel();
        let task = work.spawn_blocking(move || {
            started.send(()).unwrap();
            finish.recv().unwrap();
        });
        running.recv().unwrap();

        task.abort();
        drop(work);
        assert_eq!(state.begin_prepare(), Err(ActivityError::busy()));
        release.send(()).unwrap();
        tauri::async_runtime::block_on(task).unwrap();
        assert!(state.begin_prepare().is_ok());
    }
    #[test]
    fn only_the_install_owner_can_reopen_after_verified_recovery() {
        let state = ActivityState::default();
        let token = state.begin_prepare().unwrap();
        state.finish_prepare(&token).unwrap();

        assert_eq!(
            state.recover_install("stale"),
            Err(ActivityError::invalid())
        );
        assert!(state.acquire().is_err());
        assert_eq!(state.recover_install(&token), Ok(()));
        assert!(state.acquire().is_ok());
    }
    #[test]
    fn racing_work_and_preparation_have_only_one_admitted_owner() {
        let state = ActivityState::default();
        let start = Arc::new(std::sync::Barrier::new(3));
        let worker_state = state.clone();
        let worker_start = Arc::clone(&start);
        let worker = std::thread::spawn(move || {
            worker_start.wait();
            worker_state.acquire()
        });
        let prepare_start = Arc::clone(&start);
        let preparation = std::thread::spawn(move || {
            prepare_start.wait();
            state.begin_prepare()
        });

        start.wait();
        let work = worker.join().unwrap();
        let preparation = preparation.join().unwrap();

        assert_ne!(work.is_ok(), preparation.is_ok());
    }
    #[test]
    fn an_accepted_exit_permanently_defers_update_preparation() {
        let state = ActivityState::default();
        let work = state.acquire().unwrap();

        assert!(state.begin_exit());
        drop(work);

        assert_eq!(state.begin_prepare(), Err(ActivityError::busy()));
        assert!(state.acquire().is_err());
        assert!(state.begin_exit());
    }

    #[test]
    fn preparation_defers_native_exit_until_cancellation() {
        let state = ActivityState::default();
        let token = state.begin_prepare().unwrap();

        assert!(!state.begin_exit());
        state.cancel_prepare(&token).unwrap();

        assert!(state.begin_exit());
    }

    #[test]
    fn installation_defers_native_exit() {
        let state = ActivityState::default();
        let token = state.begin_prepare().unwrap();
        state.finish_prepare(&token).unwrap();

        assert!(!state.begin_exit());
    }
}

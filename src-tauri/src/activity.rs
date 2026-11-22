use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, Runtime,
    ipc::{CommandArg, CommandItem, InvokeBody, InvokeError, InvokeMessage},
};
use tokio::sync::Notify;

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
    Draining(String),
    Preparing(String),
    Installing(String),
    Exiting,
}

#[derive(Debug, Default)]
struct Admission {
    phase: Phase,
    active: usize,
    active_tab_saves: usize,
    active_menu_saves: usize,
    generation: u64,
    #[cfg(any(test, feature = "test-util"))]
    parked: usize,
}

impl Admission {
    fn next_token(&mut self) -> String {
        self.generation += 1;
        format!("prepare-{}", self.generation)
    }

    fn settle_drain(&mut self) {
        if self.active != 0 {
            return;
        }
        if let Phase::Draining(token) = &self.phase {
            self.phase = Phase::Preparing(token.clone());
        }
    }
}

#[derive(Debug, Default)]
struct Gate {
    admission: Mutex<Admission>,
    changed: Condvar,
    tab_saves_finished: Notify,
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
        let save = (command == "prefs_set_tabs").then_some(PreferenceSave::Tabs);
        self.admit(command, permit, save)
    }

    /// Native settings gestures own their write until it reaches disk, even on quit.
    pub(crate) fn acquire_preference_save(&self) -> Result<Activity, ActivityError> {
        self.admit("", None, Some(PreferenceSave::Menu))
    }

    fn admit(
        &self,
        command: &str,
        permit: Option<&str>,
        preference_save: Option<PreferenceSave>,
    ) -> Result<Activity, ActivityError> {
        let mut state = self.0.admission.lock().unwrap();
        let allowed = match &state.phase {
            Phase::Open => true,
            Phase::Preparing(token) => {
                permit == Some(token.as_str())
                    && matches!(
                        command,
                        "prefs_get"
                            | "prefs_set"
                            | "prefs_set_tabs"
                            | "save_draft"
                            | "get_draft"
                            | "delete_draft"
                    )
            }
            Phase::Draining(_) | Phase::Installing(_) | Phase::Exiting => false,
        };
        if !allowed {
            return Err(ActivityError::busy());
        }
        state.active += 1;
        match preference_save {
            Some(PreferenceSave::Tabs) => state.active_tab_saves += 1,
            Some(PreferenceSave::Menu) => state.active_menu_saves += 1,
            None => {}
        }
        drop(state);

        Ok(Activity(Arc::new(Lease {
            state: self.clone(),
            preference_save,
        })))
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
        self.0.changed.notify_all();

        true
    }

    /// Finish admitted preference writes before the desktop runtime exits.
    pub(crate) fn finish_preference_saves_at_exit(&self) {
        self.0.admission.lock().unwrap().phase = Phase::Exiting;
        self.0.changed.notify_all();
        drop(Self::unparked(
            self.0
                .changed
                .wait_while(self.parked_lock(), |state| {
                    state.active_tab_saves != 0 || state.active_menu_saves != 0
                })
                .unwrap(),
        ));
    }

    /// Wait before taking a blocking worker to read the tab preferences.
    pub(crate) async fn wait_for_tab_saves(&self) {
        loop {
            // notify_waiters also reaches futures created before their first poll.
            let finished = self.0.tab_saves_finished.notified();
            if self.0.admission.lock().unwrap().active_tab_saves == 0 {
                return;
            }
            finished.await;
        }
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
        let token = state.next_token();
        state.phase = Phase::Preparing(token.clone());
        drop(state);

        Ok(token)
    }

    /// Close ordinary admission now and enter preparation once the work admitted
    /// before it has settled.
    /// # Errors
    /// Returns busy unless admission is open.
    /// # Panics
    /// Panics if the admission mutex is poisoned.
    pub fn begin_drain(&self) -> Result<String, ActivityError> {
        let mut state = self.0.admission.lock().unwrap();
        if !matches!(state.phase, Phase::Open) {
            return Err(ActivityError::busy());
        }
        let token = state.next_token();
        state.phase = Phase::Draining(token.clone());
        state.settle_drain();
        drop(state);

        Ok(token)
    }

    /// Block until this drain becomes preparation.
    /// # Errors
    /// Returns invalid once the drain was cancelled or Trunk began to exit.
    /// # Panics
    /// Panics if the admission mutex is poisoned.
    pub fn wait_for_preparation(&self, token: &str) -> Result<(), ActivityError> {
        let state = Self::unparked(
            self.0
                .changed
                .wait_while(
                    self.parked_lock(),
                    |state| matches!(&state.phase, Phase::Draining(current) if current == token),
                )
                .unwrap(),
        );
        let prepared = matches!(&state.phase, Phase::Preparing(current) if current == token);
        drop(state);
        if !prepared {
            return Err(ActivityError::invalid());
        }

        Ok(())
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

    /// End a drain at once, or cancel preparation once its persistence work has settled.
    /// # Errors
    /// Returns invalid after installation begins or for a stale token; busy while flushing.
    /// # Panics
    /// Panics if the admission mutex is poisoned.
    pub fn cancel_prepare(&self, token: &str) -> Result<(), ActivityError> {
        let mut state = self.0.admission.lock().unwrap();
        if matches!(&state.phase, Phase::Draining(current) if current == token) {
            state.phase = Phase::Open;
            drop(state);
            self.0.changed.notify_all();
            return Ok(());
        }
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

    #[cfg(any(test, feature = "test-util"))]
    fn parked_lock(&self) -> MutexGuard<'_, Admission> {
        let mut state = self.0.admission.lock().unwrap();
        state.parked += 1;
        self.0.changed.notify_all();
        state
    }

    #[cfg(not(any(test, feature = "test-util")))]
    fn parked_lock(&self) -> MutexGuard<'_, Admission> {
        self.0.admission.lock().unwrap()
    }

    #[cfg(any(test, feature = "test-util"))]
    fn unparked(mut state: MutexGuard<'_, Admission>) -> MutexGuard<'_, Admission> {
        state.parked -= 1;
        state
    }

    #[cfg(not(any(test, feature = "test-util")))]
    const fn unparked(state: MutexGuard<'_, Admission>) -> MutexGuard<'_, Admission> {
        state
    }

    /// Block until a caller of `wait_for_preparation` is parked on the gate, so a
    /// test can end the drain knowing the wake, not the first check, is what
    /// the waiter observes.
    /// # Panics
    /// Panics if the admission mutex is poisoned.
    #[cfg(any(test, feature = "test-util"))]
    pub fn wait_until_parked(&self) {
        let state = self.0.admission.lock().unwrap();
        drop(
            self.0
                .changed
                .wait_while(state, |state| state.parked == 0)
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreferenceSave {
    Tabs,
    Menu,
}

#[derive(Debug)]
struct Lease {
    state: ActivityState,
    preference_save: Option<PreferenceSave>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.state.0.admission.lock().unwrap();
        state.active -= 1;
        match self.preference_save {
            Some(PreferenceSave::Tabs) => state.active_tab_saves -= 1,
            Some(PreferenceSave::Menu) => state.active_menu_saves -= 1,
            None => {}
        }
        state.settle_drain();
        let activity_finished = state.active == 0;
        let tab_saves_finished =
            self.preference_save == Some(PreferenceSave::Tabs) && state.active_tab_saves == 0;
        let preference_saves_finished = self.preference_save.is_some()
            && state.active_tab_saves == 0
            && state.active_menu_saves == 0;
        drop(state);
        if activity_finished || preference_saves_finished {
            self.state.0.changed.notify_all();
        }
        if tab_saves_finished {
            self.state.0.tab_saves_finished.notify_waiters();
        }
    }
}

#[derive(Debug, Clone)]
pub struct Activity(Arc<Lease>);

impl Activity {
    pub(crate) fn for_invoke<R: Runtime>(
        message: &InvokeMessage<R>,
        command: &str,
    ) -> Result<Self, InvokeError> {
        let permit = match message.payload() {
            InvokeBody::Json(payload) => payload
                .get("__updatePermit")
                .and_then(serde_json::Value::as_str),
            InvokeBody::Raw(_) => None,
        };
        message
            .webview_ref()
            .state::<ActivityState>()
            .acquire_command(command, permit)
            .map_err(InvokeError::from)
    }

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
        Self::for_invoke(item.message, item.name)
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
    for (path, _) in repositories.locations() {
        let _ = crate::watcher::publish_worktree_change(
            app,
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
        assert!(
            state
                .acquire_command("prefs_open_tabs", Some(&token))
                .is_err()
        );
        assert!(
            state
                .acquire_command("prefs_set_tabs", Some("stale"))
                .is_err()
        );
        assert!(state.acquire_command("prefs_set_tabs", None).is_err());
        assert!(
            state
                .acquire_command("prefs_set_tabs", Some(&token))
                .is_ok()
        );
        assert!(state.acquire_command("delete_draft", Some(&token)).is_ok());
        assert!(state.acquire_command("clear_draft", Some(&token)).is_err());
    }

    #[test]
    fn exit_drains_an_accepted_tab_save_without_waiting_for_unrelated_work() {
        let state = ActivityState::default();
        let save = state.acquire_command("prefs_set_tabs", None).unwrap();
        let _unrelated = state.acquire().unwrap();

        let exiting = std::thread::spawn({
            let state = state.clone();
            move || state.finish_preference_saves_at_exit()
        });
        state.wait_until_parked();

        assert!(!exiting.is_finished());
        assert!(state.acquire_command("prefs_set_tabs", None).is_err());
        drop(save);
        exiting.join().unwrap();
    }

    #[test]
    fn exit_drains_a_native_menu_save_even_when_no_tabs_are_being_saved() {
        let state = ActivityState::default();
        let save = state.acquire_preference_save().unwrap();
        let _unrelated = state.acquire().unwrap();

        let exiting = std::thread::spawn({
            let state = state.clone();
            move || state.finish_preference_saves_at_exit()
        });
        state.wait_until_parked();

        assert!(state.acquire_preference_save().is_err());
        drop(save);
        exiting.join().unwrap();
    }

    #[test]
    fn restores_can_wait_asynchronously_for_all_accepted_tab_saves() {
        use std::pin::pin;
        use std::task::{Context, Poll, Waker};

        let state = ActivityState::default();
        let first_save = state.acquire_command("prefs_set_tabs", None).unwrap();
        let second_save = state.acquire_command("prefs_set_tabs", None).unwrap();
        let _pending_menu_save = state.acquire_preference_save().unwrap();
        let _unrelated = state.acquire().unwrap();
        let mut first_restore = pin!(state.wait_for_tab_saves());
        let mut second_restore = pin!(state.wait_for_tab_saves());
        let mut context = Context::from_waker(Waker::noop());

        assert_eq!(first_restore.as_mut().poll(&mut context), Poll::Pending);
        drop(first_save);
        assert_eq!(second_restore.as_mut().poll(&mut context), Poll::Pending);
        drop(second_save);

        assert_eq!(first_restore.as_mut().poll(&mut context), Poll::Ready(()));
        assert_eq!(second_restore.as_mut().poll(&mut context), Poll::Ready(()));
    }

    #[test]
    fn draining_closes_admission_and_prepares_once_earlier_work_settles() {
        let state = ActivityState::default();
        let work = state.acquire().unwrap();

        let token = state.begin_drain().unwrap();

        assert!(state.acquire().is_err());
        assert!(state.acquire_command("prefs_set", Some(&token)).is_err());
        drop(work);
        assert!(state.acquire().is_err());
        assert!(state.acquire_command("prefs_set", Some(&token)).is_ok());
    }

    #[test]
    fn draining_waits_for_work_carried_on_by_a_copy_of_its_lease() {
        let state = ActivityState::default();
        let work = state.acquire().unwrap();
        let carried = work.clone();
        let token = state.begin_drain().unwrap();

        drop(work);

        assert!(state.acquire_command("prefs_set", Some(&token)).is_err());
        drop(carried);
        assert!(state.acquire_command("prefs_set", Some(&token)).is_ok());
    }

    #[test]
    fn a_drain_completes_while_new_work_keeps_asking_for_admission() {
        let state = ActivityState::default();
        let work = state.acquire().unwrap();
        let carried = work.clone();
        let token = state.begin_drain().unwrap();
        let waiter = {
            let state = state.clone();
            let token = token.clone();
            std::thread::spawn(move || state.wait_for_preparation(&token))
        };
        state.wait_until_parked();

        assert!(state.acquire().is_err());
        drop(work);
        assert!(state.acquire().is_err());
        drop(carried);
        assert!(state.acquire().is_err());

        assert_eq!(waiter.join().unwrap(), Ok(()));
        assert!(state.acquire_command("prefs_set", Some(&token)).is_ok());
    }

    #[test]
    fn a_drain_waits_for_blocking_work_whose_caller_was_dropped() {
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
        let token = state.begin_drain().unwrap();

        assert!(state.acquire_command("prefs_set", Some(&token)).is_err());
        release.send(()).unwrap();
        tauri::async_runtime::block_on(task).unwrap();
        assert_eq!(state.wait_for_preparation(&token), Ok(()));
    }

    #[test]
    fn an_accepted_exit_refuses_a_later_drain() {
        let state = ActivityState::default();

        assert!(state.begin_exit());

        assert_eq!(state.begin_drain(), Err(ActivityError::busy()));
    }

    #[test]
    fn cancelling_a_drain_reopens_admission_while_earlier_work_runs() {
        let state = ActivityState::default();
        let _work = state.acquire().unwrap();
        let token = state.begin_drain().unwrap();

        assert_eq!(state.cancel_prepare(&token), Ok(()));

        assert!(state.acquire().is_ok());
    }

    #[test]
    fn a_drain_accepts_native_exit() {
        let state = ActivityState::default();
        let _work = state.acquire().unwrap();
        state.begin_drain().unwrap();

        assert!(state.begin_exit());
    }

    #[test]
    fn waiting_on_a_drain_returns_once_preparation_begins() {
        let state = ActivityState::default();
        let work = state.acquire().unwrap();
        let token = state.begin_drain().unwrap();
        let waiter = {
            let state = state.clone();
            std::thread::spawn(move || state.wait_for_preparation(&token))
        };
        state.wait_until_parked();

        drop(work);

        assert_eq!(waiter.join().unwrap(), Ok(()));
    }

    #[test]
    fn waiting_on_a_drain_reports_it_ended_when_cancelled() {
        let state = ActivityState::default();
        let _work = state.acquire().unwrap();
        let token = state.begin_drain().unwrap();
        let waiter = {
            let state = state.clone();
            let token = token.clone();
            std::thread::spawn(move || state.wait_for_preparation(&token))
        };
        state.wait_until_parked();

        state.cancel_prepare(&token).unwrap();

        assert_eq!(waiter.join().unwrap(), Err(ActivityError::invalid()));
    }

    #[test]
    fn waiting_on_a_drain_reports_it_ended_when_trunk_exits() {
        let state = ActivityState::default();
        let _work = state.acquire().unwrap();
        let token = state.begin_drain().unwrap();
        let waiter = {
            let state = state.clone();
            std::thread::spawn(move || state.wait_for_preparation(&token))
        };
        state.wait_until_parked();

        assert!(state.begin_exit());

        assert_eq!(waiter.join().unwrap(), Err(ActivityError::invalid()));
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

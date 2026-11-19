use tauri::{AppHandle, Manager, Runtime};

use super::{Candidate, Phase, UpdateState, UpdateStatus, persistence};
use crate::activity::{Activity, ActivityState};

pub fn prepare<R: Runtime>(app: &AppHandle<R>, version: &str) -> Result<String, String> {
    let state = app.state::<UpdateState>();
    let mut coordinator = state.0.lock().unwrap();
    if coordinator.status.phase != Phase::Ready
        || coordinator.status.version.as_deref() != Some(version)
        || coordinator.bytes.is_none()
    {
        return Err("The downloaded update is no longer ready".into());
    }
    let token = app
        .state::<ActivityState>()
        .begin_drain()
        .map_err(|error| error.message)?;
    coordinator.preparation = Some(token.clone());
    coordinator.status.phase = Phase::Preparing;
    coordinator.status.message = None;
    coordinator.emit(app);
    drop(coordinator);
    Ok(token)
}

/// Wait until the work admitted before preparation began has settled.
/// # Errors
/// Returns an error once preparation was aborted or Trunk began to exit.
pub fn drained<R: Runtime>(app: &AppHandle<R>, token: &str) -> Result<(), String> {
    app.state::<ActivityState>()
        .wait_for_preparation(token)
        .map_err(|error| error.message.into())
}

pub fn abort<R: Runtime>(app: &AppHandle<R>, token: &str) -> Result<UpdateStatus, String> {
    let state = app.state::<UpdateState>();
    let mut coordinator = state.0.lock().unwrap();
    if coordinator.preparation.as_deref() != Some(token) {
        return Err("Update preparation is no longer current".into());
    }
    app.state::<ActivityState>()
        .cancel_prepare(token)
        .map_err(|error| error.message)?;
    coordinator.preparation = None;
    coordinator.settle(None);
    let status = coordinator.emit(app);
    drop(coordinator);
    crate::activity::resume_after_update(app).map_err(|error| error.message)?;
    Ok(status)
}

fn preflight<R: Runtime>(
    app: &AppHandle<R>,
    candidate: &Candidate,
    bytes: &[u8],
) -> Result<(), String> {
    candidate
        .update
        .verify(bytes)
        .map_err(|_| "The downloaded update failed verification")?;
    #[cfg(not(feature = "drive"))]
    {
        use tauri_plugin_window_state::AppHandleExt;
        let (saved, result) = std::sync::mpsc::sync_channel(1);
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let result = handle.save_window_state(tauri_plugin_window_state::StateFlags::all());
            let _ = saved.send(result);
        })
        .map_err(|_| "Window state could not be scheduled for saving")?;
        result
            .recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "Window state saving did not finish; the update was not installed")?
            .map_err(|_| "Window state could not be saved; the update was not installed")?;
    }
    let state = app.state::<UpdateState>();
    let mut coordinator = state.0.lock().unwrap();
    let intent = persistence::Intent {
        from_version: coordinator.status.current_version.clone(),
        to_version: candidate.update.version.clone(),
        target: candidate.update.target.clone(),
        artifact_sha256: candidate.hash.clone(),
    };
    coordinator.record.intent = Some(intent);
    if let Err(error) = persistence::save(
        &crate::commands::resolve_data_dir(app)?,
        &coordinator.record,
    ) {
        coordinator.record.intent = None;
        return Err(error);
    }
    drop(coordinator);
    Ok(())
}

pub fn install<R: Runtime>(app: &AppHandle<R>, version: &str, token: &str) -> Result<(), String> {
    let (candidate, bytes) = {
        let state = app.state::<UpdateState>();
        let mut coordinator = state.0.lock().unwrap();
        if coordinator.status.phase != Phase::Preparing
            || coordinator.preparation.as_deref() != Some(token)
            || coordinator.status.version.as_deref() != Some(version)
        {
            return Err("Update preparation is no longer current".into());
        }
        app.state::<ActivityState>()
            .finish_prepare(token)
            .map_err(|error| error.message)?;
        coordinator.status.phase = Phase::Installing;
        coordinator.emit(app);
        (
            coordinator.candidate.as_ref().unwrap().clone(),
            coordinator.bytes.as_ref().unwrap().clone(),
        )
    };
    if let Err(error) = preflight(app, &candidate, &bytes) {
        let state = app.state::<UpdateState>();
        let mut coordinator = state.0.lock().unwrap();
        app.state::<ActivityState>()
            .recover_install(token)
            .map_err(|error| error.message)?;
        coordinator.preparation = None;
        coordinator.settle(Some(error.clone()));
        coordinator.emit(app);
        drop(coordinator);
        crate::activity::resume_after_update(app).map_err(|error| error.message)?;
        return Err(error);
    }
    // Admission remains closed through the real installer and process restart.
    // A failed installer may already have replaced part of the bundle. Do not
    // resume writes based only on an executable hash or the plugin's error.
    if candidate.update.install(bytes.as_slice()).is_err() {
        let state = app.state::<UpdateState>();
        let mut coordinator = state.0.lock().unwrap();
        coordinator.status.phase = Phase::Recovery;
        coordinator.status.message = Some(format!(
            "The installer did not finish. Quit Trunk and install version {} or a newer stable release using the same installation method. Your saved data is outside the application bundle.",
            candidate.update.version
        ));
        coordinator.emit(app);
        drop(coordinator);
        return Err("Installation could not be confirmed; manual recovery is required".into());
    }
    app.restart();
}

pub fn ready<R: Runtime>(app: &AppHandle<R>) -> Result<UpdateStatus, String> {
    let _activity = Activity::for_app(app).map_err(|error| error.message)?;
    let state = app.state::<UpdateState>();
    let mut coordinator = state.0.lock().unwrap();
    let Some(intent) = &coordinator.record.intent else {
        return Ok(coordinator.status.clone());
    };
    if let Some(error) = &coordinator.startup_error {
        return Err(error.clone());
    }
    if let Err(error) = check_saved_data(app) {
        // Recovery requires quitting. Exit admission closes atomically even while
        // this readiness check owns its lease, before another command can enter.
        let _ = app.state::<ActivityState>().begin_exit();
        coordinator.startup_error = Some(error.clone());
        coordinator.status.phase = Phase::Recovery;
        coordinator.status.message = Some(format!(
            "{error}. Quit Trunk and recover the saved data before continuing."
        ));
        coordinator.emit(app);
        return Err(error);
    }
    let actual_target = persistence::installation().map(|(target, _)| target);
    if !readiness_matches(
        &coordinator.status.current_version,
        actual_target.as_deref(),
        intent,
    ) {
        let expected_version = intent.to_version.clone();
        coordinator.status.phase = Phase::Recovery;
        coordinator.status.message = Some(format!(
            "The previous update expected version {expected_version}. Quit Trunk and install that version or a newer stable release using the same installation method; saved data will be retained."
        ));
        return Ok(coordinator.emit(app));
    }
    let data_dir = crate::commands::resolve_data_dir(app)?;
    let previous = coordinator.record.intent.take();
    if let Err(error) = persistence::save(&data_dir, &coordinator.record) {
        coordinator.record.intent = previous;
        return Err(error);
    }
    coordinator.settle(Some(
        "Update installed and saved data opened successfully".into(),
    ));
    Ok(coordinator.emit(app))
}

pub(super) fn readiness_matches(
    version: &str,
    target: Option<&str>,
    intent: &persistence::Intent,
) -> bool {
    let (Ok(actual), Ok(expected)) = (
        semver::Version::parse(version),
        semver::Version::parse(&intent.to_version),
    ) else {
        return false;
    };
    actual.pre.is_empty() && actual >= expected && target == Some(intent.target.as_str())
}

pub(super) fn check_saved_data<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let data_dir = crate::commands::resolve_data_dir(app)?;
    let prefs = data_dir.join("trunk-prefs.json");
    if prefs.exists() {
        let bytes = std::fs::read(&prefs).map_err(|_| "Saved preferences could not be read")?;
        serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&bytes)
            .map_err(|_| "Saved preferences could not be verified")?;
    }
    let review_dir = crate::commands::store_data_dir(app)?;
    trunk_review::reviewdb::verify_readable(&review_dir)
        .map_err(|_| "The saved review database could not be verified".into())
}

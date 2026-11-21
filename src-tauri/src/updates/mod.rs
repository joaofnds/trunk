mod install;
mod network;
mod persistence;
mod releases;
#[cfg(test)]
mod tests;

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};
use trunk_update_release::{MAX_ARTIFACT_BYTES, MAX_MANIFEST_BYTES, TargetRegistry};

use network::Cancellation;
use persistence::Record;

const FEED: &str = "https://github.com/joaofnds/trunk/releases/latest/download/latest.json";
const MANUAL: &str = "Use the installer or package manager that installed Trunk. In-app updates are not enabled for this installation.";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    #[default]
    Manual,
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Preparing,
    Installing,
    Recovery,
}

#[derive(Clone, Serialize)]
pub struct UpdateStatus {
    phase: Phase,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    message: Option<String>,
    downloaded: u64,
    total: Option<u64>,
    eligible: bool,
    adopted: bool,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            phase: Phase::Manual,
            current_version: env!("CARGO_PKG_VERSION").into(),
            version: None,
            notes: None,
            message: None,
            downloaded: 0,
            total: None,
            eligible: false,
            adopted: false,
        }
    }
}

#[derive(Clone)]
struct Candidate {
    update: Update,
    hash: String,
    size: u64,
}

#[derive(Default)]
struct Coordinator {
    status: UpdateStatus,
    installation: Option<(String, String)>,
    record: Record,
    candidate: Option<Candidate>,
    release: Option<releases::Release>,
    bytes: Option<Arc<Vec<u8>>>,
    cancellation: Option<Cancellation>,
    preparation: Option<String>,
    startup_error: Option<String>,
}

impl Coordinator {
    const fn resting_phase(&self) -> Phase {
        if self.record.intent.is_some() {
            Phase::Recovery
        } else if self.bytes.is_some() {
            Phase::Ready
        } else if self.candidate.is_some() || self.release.is_some() {
            Phase::Available
        } else if self.status.eligible {
            Phase::Idle
        } else {
            Phase::Manual
        }
    }

    fn available(&self) -> Result<(), String> {
        if matches!(
            self.status.phase,
            Phase::Manual | Phase::Idle | Phase::Available | Phase::Ready
        ) {
            Ok(())
        } else {
            Err(
                "Another update action is active, or this installation requires a manual update"
                    .into(),
            )
        }
    }

    fn begin(&mut self, phase: Phase) -> Result<Cancellation, String> {
        self.available()?;
        if !self.status.eligible || !self.status.adopted {
            return Err("Enable updates for this installation first".into());
        }
        let cancellation = Cancellation::default();
        self.cancellation = Some(cancellation.clone());
        self.status.phase = phase;
        self.status.message = None;
        Ok(cancellation)
    }

    fn settle(&mut self, message: Option<String>) {
        self.cancellation = None;
        self.status.phase = self.resting_phase();
        self.status.message = message;
    }

    fn emit<R: Runtime>(&self, app: &AppHandle<R>) -> UpdateStatus {
        let snapshot = self.status.clone();
        let _ = app.emit("updates-changed", &snapshot);
        snapshot
    }
}

/// Lets a download's progress through when the whole percent the update panel
/// shows for it changes, so a download sends about a hundred updates rather
/// than one for every chunk the network hands over.
struct ProgressGate(AtomicU64);

impl Default for ProgressGate {
    fn default() -> Self {
        Self(AtomicU64::new(u64::MAX))
    }
}

impl ProgressGate {
    /// The percent to show for `downloaded` of `total`, rounded as the panel
    /// rounds it, or `None` when the panel already shows it.
    fn admit(&self, downloaded: u64, total: u64) -> Option<u64> {
        let percent = if total == 0 {
            0
        } else {
            (downloaded.saturating_mul(200).saturating_add(total) / total.saturating_mul(2))
                .min(100)
        };

        (self.0.swap(percent, Ordering::Relaxed) != percent).then_some(percent)
    }
}

#[derive(Default)]
pub struct UpdateState(Mutex<Coordinator>);

type ReleaseFuture = Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send>>;

#[derive(Clone)]
pub struct ReleaseSource(Arc<dyn Fn() -> ReleaseFuture + Send + Sync>);

impl ReleaseSource {
    pub fn new<F, Fut>(fetch: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Vec<u8>, String>> + Send + 'static,
    {
        Self(Arc::new(move || Box::pin(fetch())))
    }
}

impl Default for ReleaseSource {
    fn default() -> Self {
        Self::new(network::github_latest)
    }
}

pub fn initialize<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<UpdateState>();
    let mut coordinator = state.0.lock().unwrap();
    coordinator.status.current_version = app.package_info().version.to_string();
    let result = (|| {
        let registry = TargetRegistry::parse(include_str!("../../updater-targets.json"))
            .map_err(|_| "The installed update policy is invalid".to_string())?;
        let data_dir = crate::commands::resolve_data_dir(app)?;
        coordinator.record = persistence::load(&data_dir)?;
        coordinator.installation =
            persistence::installation().filter(|(target, _)| registry.targets.contains_key(target));
        coordinator.status.eligible = coordinator.installation.is_some();
        coordinator.status.adopted = coordinator
            .installation
            .as_ref()
            .is_some_and(|(_, path)| coordinator.record.adopted_for.as_ref() == Some(path));
        coordinator.status.phase = coordinator.resting_phase();
        if coordinator.record.intent.is_some() {
            coordinator.startup_error = install::check_saved_data(app).err();
            coordinator.status.message = Some("An earlier update has not confirmed a successful launch. Checking saved data before resuming updates.".into());
            if let Some(error) = &coordinator.startup_error {
                coordinator.status.message = Some(format!(
                    "{error}. Quit Trunk and recover the saved data before continuing."
                ));
                // Stop normal startup from quarantining a store that readiness
                // just rejected, then mistaking a newly empty store for recovery.
                coordinator.preparation = app
                    .state::<crate::activity::ActivityState>()
                    .begin_prepare()
                    .ok();
            }
        } else if coordinator.status.eligible {
            coordinator.status.message = None;
        }
        Ok::<_, String>(())
    })();
    if let Err(error) = result {
        coordinator.status.phase = Phase::Manual;
        coordinator.status.eligible = false;
        coordinator.status.adopted = false;
        coordinator.status.message = Some(error);
    }
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> UpdateStatus {
    app.state::<UpdateState>().0.lock().unwrap().status.clone()
}

pub fn allow_exit<R: Runtime>(app: &AppHandle<R>) -> bool {
    if app.state::<crate::activity::ActivityState>().begin_exit() {
        return true;
    }
    let state = app.state::<UpdateState>();
    // Native window queries can wait for the event loop. Never make that loop
    // wait for a coordinator lock held by the worker doing those queries.
    state
        .0
        .try_lock()
        .is_ok_and(|coordinator| coordinator.status.phase == Phase::Recovery)
}

pub fn enable<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<UpdateStatus, String> {
    let state = app.state::<UpdateState>();
    let mut coordinator = state.0.lock().unwrap();
    coordinator.available()?;
    let (_, path) = coordinator.installation.as_ref().ok_or(MANUAL)?;
    let previous = coordinator.record.adopted_for.clone();
    coordinator.record.adopted_for = enabled.then(|| path.clone());
    if let Err(error) = persistence::save(
        &crate::commands::resolve_data_dir(app)?,
        &coordinator.record,
    ) {
        coordinator.record.adopted_for = previous;
        return Err(error);
    }
    coordinator.status.adopted = enabled;
    if !enabled || coordinator.release.is_some() {
        coordinator.candidate = None;
        coordinator.release = None;
        coordinator.bytes = None;
        coordinator.status.version = None;
        coordinator.status.notes = None;
        coordinator.status.downloaded = 0;
        coordinator.status.total = None;
    }
    coordinator.settle(None);
    Ok(coordinator.emit(app))
}

pub fn cancel<R: Runtime>(app: &AppHandle<R>) -> UpdateStatus {
    let state = app.state::<UpdateState>();
    let coordinator = state.0.lock().unwrap();
    if let Some(cancellation) = &coordinator.cancellation {
        cancellation.cancel();
    }
    coordinator.emit(app)
}

fn manifest_identity(raw: &Value, target: &str, baseline: &str) -> Result<(String, u64), String> {
    let fail = || "The release metadata does not match the installed update policy".to_string();
    let version = raw["version"].as_str().ok_or_else(fail)?;
    let parsed = semver::Version::parse(version).map_err(|_| fail())?;
    let artifact = &raw["platforms"][target];
    let hash = artifact["sha256"].as_str().ok_or_else(fail)?;
    let size = artifact["size"].as_u64().ok_or_else(fail)?;
    let url = artifact["url"].as_str().ok_or_else(fail)?;
    let prefix = format!("https://github.com/joaofnds/trunk/releases/download/v{version}/");
    let filename = url.strip_prefix(&prefix).ok_or_else(fail)?;
    if !parsed.pre.is_empty()
        || !parsed.build.is_empty()
        || parsed.to_string() != version
        || artifact["minimumOsVersion"].as_str() != Some(baseline)
        || size == 0
        || size > MAX_ARTIFACT_BYTES
        || hash.len() != 64
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || filename.is_empty()
        || !filename
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(fail());
    }
    Ok((hash.to_owned(), size))
}

async fn discover<R: Runtime>(
    app: &AppHandle<R>,
    target: &str,
    cancel: Cancellation,
) -> Result<Option<Candidate>, String> {
    let bytes = network::fetch(FEED, MAX_MANIFEST_BYTES, cancel, |_, _| {}).await?;
    let raw: Value =
        serde_json::from_slice(&bytes).map_err(|_| "The update feed is not valid JSON")?;
    let registry = TargetRegistry::parse(include_str!("../../updater-targets.json"))
        .map_err(|_| "Invalid installed update policy")?;
    let policy = registry.targets.get(target).ok_or(MANUAL)?;
    let (hash, size) = manifest_identity(&raw, target, &policy.minimum_os_version)?;
    let updater = configured_updater(app, target, &policy.public_key)?;
    let candidate = updater
        .restore_update(raw)
        .map_err(|_| "The update feed is invalid for this installation")?;
    Ok(candidate.map(|update| Candidate { update, hash, size }))
}

fn configured_updater<R: Runtime>(
    app: &AppHandle<R>,
    target: &str,
    key: &str,
) -> Result<tauri_plugin_updater::Updater, String> {
    app.updater_builder()
        .target(target)
        .pubkey(key)
        .endpoints(vec![FEED.parse().expect("static release URL")])
        .and_then(tauri_plugin_updater::UpdaterBuilder::build)
        .map_err(|_| "Could not initialize the updater".into())
}

pub async fn check<R: Runtime>(app: AppHandle<R>) -> Result<UpdateStatus, String> {
    let source = app.state::<ReleaseSource>().inner().clone();

    check_with_sources(
        app,
        |cancel| async move { network::latest_release(&source, cancel).await },
        |app, target, cancel| async move { discover(&app, &target, cancel).await },
    )
    .await
}

async fn check_with_sources<R, ReleaseFuture, CandidateFuture>(
    app: AppHandle<R>,
    fetch: impl FnOnce(Cancellation) -> ReleaseFuture,
    discovery: impl FnOnce(AppHandle<R>, String, Cancellation) -> CandidateFuture,
) -> Result<UpdateStatus, String>
where
    R: Runtime,
    ReleaseFuture: std::future::Future<Output = Result<Vec<u8>, String>>,
    CandidateFuture: std::future::Future<Output = Result<Option<Candidate>, String>>,
{
    let automatic = {
        let state = app.state::<UpdateState>();
        let coordinator = state.0.lock().unwrap();

        coordinator.status.eligible && coordinator.status.adopted
    };

    if !automatic {
        return check_release_with_fetch(app, fetch).await;
    }

    check_with_discovery(app, discovery).await
}

async fn check_release_with_fetch<R, F, Fut>(
    app: AppHandle<R>,
    fetch: F,
) -> Result<UpdateStatus, String>
where
    R: Runtime,
    F: FnOnce(Cancellation) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<u8>, String>>,
{
    let (cancel, current) = {
        let state = app.state::<UpdateState>();
        let mut coordinator = state.0.lock().unwrap();
        coordinator.available()?;
        if coordinator.status.eligible && coordinator.status.adopted {
            return Err("Update settings changed. Check for updates again.".into());
        }

        let cancel = Cancellation::default();
        coordinator.cancellation = Some(cancel.clone());
        coordinator.status.phase = Phase::Checking;
        coordinator.status.message = None;
        coordinator.emit(&app);

        (cancel, coordinator.status.current_version.clone())
    };
    let result = fetch(cancel)
        .await
        .and_then(|bytes| releases::newer(&bytes, &current));
    let failure = result.as_ref().err().cloned();
    let state = app.state::<UpdateState>();
    let mut coordinator = state.0.lock().unwrap();
    let message = match result {
        Ok(release) => {
            coordinator.status.version = release.as_ref().map(|release| release.version.clone());
            coordinator.status.notes = release.as_ref().and_then(|release| release.notes.clone());
            coordinator.status.downloaded = 0;
            coordinator.status.total = None;
            coordinator.release = release;

            coordinator
                .release
                .is_none()
                .then(|| "Trunk is up to date".into())
        }
        Err(error) => Some(error),
    };
    coordinator.settle(message);
    let snapshot = coordinator.emit(&app);
    drop(coordinator);

    failure.map_or(Ok(snapshot), Err)
}

async fn check_with_discovery<R, F, Fut>(
    app: AppHandle<R>,
    discovery: F,
) -> Result<UpdateStatus, String>
where
    R: Runtime,
    F: FnOnce(AppHandle<R>, String, Cancellation) -> Fut,
    Fut: std::future::Future<Output = Result<Option<Candidate>, String>>,
{
    let (cancel, target) = {
        let state = app.state::<UpdateState>();
        let mut coordinator = state.0.lock().unwrap();
        let cancel = coordinator.begin(Phase::Checking)?;
        let target = coordinator.installation.as_ref().ok_or(MANUAL)?.0.clone();
        coordinator.emit(&app);
        drop(coordinator);
        (cancel, target)
    };
    let result = discovery(app.clone(), target, cancel).await;
    let failure = result.as_ref().err().cloned();
    let state = app.state::<UpdateState>();
    let mut coordinator = state.0.lock().unwrap();
    let message = match result {
        Ok(Some(candidate)) if coordinator.bytes.is_none() => {
            coordinator.status.version = Some(candidate.update.version.clone());
            coordinator.status.notes = candidate
                .update
                .body
                .as_ref()
                .map(|body| body.chars().take(4096).collect());
            coordinator.status.downloaded = 0;
            coordinator.status.total = Some(candidate.size);
            coordinator.candidate = Some(candidate);
            coordinator.release = None;
            None
        }
        Ok(None) if coordinator.bytes.is_none() => {
            coordinator.candidate = None;
            coordinator.release = None;
            coordinator.status.version = None;
            coordinator.status.notes = None;
            coordinator.status.downloaded = 0;
            coordinator.status.total = None;
            Some("Trunk is up to date".into())
        }
        Ok(_) => Some("The downloaded update is ready to install".into()),
        Err(error) => Some(error),
    };
    coordinator.settle(message);
    let snapshot = coordinator.emit(&app);
    drop(coordinator);

    failure.map_or(Ok(snapshot), Err)
}

pub async fn download<R: Runtime>(
    app: AppHandle<R>,
    version: &str,
) -> Result<UpdateStatus, String> {
    let (cancel, candidate) = {
        let state = app.state::<UpdateState>();
        let mut coordinator = state.0.lock().unwrap();
        let candidate = coordinator
            .candidate
            .as_ref()
            .filter(|candidate| candidate.update.version == version)
            .ok_or("Check for updates again before downloading")?
            .clone();
        if coordinator.bytes.is_some() {
            return Err("An update is already downloaded".into());
        }
        let cancel = coordinator.begin(Phase::Downloading)?;
        coordinator.status.downloaded = 0;
        coordinator.emit(&app);
        drop(coordinator);
        (cancel, candidate)
    };
    let gate = ProgressGate::default();
    let result = network::fetch(
        candidate.update.download_url.as_str(),
        usize::try_from(MAX_ARTIFACT_BYTES).unwrap(),
        cancel,
        |downloaded, total| {
            let total = total.unwrap_or(candidate.size);
            let state = app.state::<UpdateState>();
            let mut coordinator = state.0.lock().unwrap();
            coordinator.status.downloaded = downloaded;
            coordinator.status.total = Some(total);
            if gate.admit(downloaded, total).is_some() {
                coordinator.emit(&app);
            }
        },
    )
    .await
    .and_then(|bytes| {
        if bytes.len() as u64 != candidate.size
            || trunk_update_release::sha256(&bytes) != candidate.hash
        {
            return Err("The downloaded update does not match the release metadata".into());
        }
        candidate
            .update
            .verify(&bytes)
            .map_err(|_| "The update signature or signed version is invalid".to_string())?;
        Ok(bytes)
    });
    let state = app.state::<UpdateState>();
    let mut coordinator = state.0.lock().unwrap();
    let message = match result {
        Ok(bytes) => {
            coordinator.bytes = Some(Arc::new(bytes));
            None
        }
        Err(error) => Some(error),
    };
    coordinator.settle(message);
    Ok(coordinator.emit(&app))
}

pub use install::{abort, drained, install, prepare, ready};

//! Background execution is isolated so a deadline also covers DNS and credential helpers.
use std::collections::HashMap;
use std::hash::BuildHasher;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use trunk_git::error::TrunkError;

use crate::fetch_worker::{WorkerRequest, WorkerResult};
use crate::ref_state::RefState;
use crate::remote_ops::{RemoteProcess, RemoteReservation, RemoteTarget};
use crate::state::{CommitCache, GraphRebuild, RefVisibilityState, RepoState, RunningOp};
use crate::watcher::RepoChanged;

const WORKER_DEADLINE: Duration = Duration::from_secs(60);
const MAX_BACKOFF_MS: u64 = 15 * 60_000;
pub const DEFAULT_FETCH_INTERVAL_MS: u64 = 60_000;

struct Clock {
    started: Instant,
    epoch: u64,
    #[cfg(any(test, feature = "test-util"))]
    fixed: Mutex<Option<u64>>,
}

impl Default for Clock {
    fn default() -> Self {
        Self {
            started: Instant::now(),
            epoch: now_ms(),
            #[cfg(any(test, feature = "test-util"))]
            fixed: Mutex::default(),
        }
    }
}

impl Clock {
    fn now(&self) -> u64 {
        #[cfg(any(test, feature = "test-util"))]
        {
            let fixed = *self.fixed.lock().unwrap();
            if let Some(now) = fixed {
                return now;
            }
        }
        self.epoch
            .saturating_add(u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX))
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Changed,
    #[default]
    Unchanged,
    SkippedFresh,
    SkippedBusy,
    SkippedOperation,
    SkippedBackoff,
    Failed,
    Unsupported,
    Cancelled,
    TimedOut,
}

#[derive(Clone, Debug, Serialize)]
pub struct RemoteOutcome {
    pub remote: String,
    pub outcome: Outcome,
    pub last_attempt_ms: Option<u64>,
    pub last_success_ms: Option<u64>,
    pub retry_at_ms: Option<u64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub metadata_error_code: Option<String>,
    pub metadata_error_message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FetchReport {
    pub outcome: Outcome,
    pub remotes: Vec<RemoteOutcome>,
    pub graph_error: Option<String>,
    pub graph_rebuilds: u32,
}

impl FetchReport {
    const fn skipped(outcome: Outcome) -> Self {
        Self {
            outcome,
            remotes: Vec::new(),
            graph_error: None,
            graph_rebuilds: 0,
        }
    }
}

#[derive(Default)]
struct Freshness {
    outcome: Outcome,
    interval: u64,
    manual_fresh_until: u64,
    attempt: Option<u64>,
    success: Option<u64>,
    failures: u32,
    retry: u64,
    unsupported_config: Option<Vec<String>>,
    failure: Option<FetchFailure>,
    jitter: std::collections::hash_map::RandomState,
}

struct FetchFailure {
    primary: TrunkError,
    metadata: Option<TrunkError>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct FreshnessKey {
    path: String,
    session: u64,
    remote: String,
}

impl Freshness {
    fn record(
        &mut self,
        now: u64,
        interval: u64,
        outcome: Outcome,
        failure: Option<FetchFailure>,
        config: Vec<String>,
    ) {
        self.outcome = outcome;
        self.interval = interval;
        self.manual_fresh_until = 0;
        self.attempt = Some(now);
        self.failure = failure;
        if matches!(outcome, Outcome::Changed | Outcome::Unchanged) {
            self.success = Some(now);
            self.failures = 0;
            self.retry = 0;
            self.unsupported_config = None;
        } else if outcome == Outcome::Unsupported {
            self.unsupported_config = Some(config);
            self.retry =
                now.saturating_add(self.retry_delay(MAX_BACKOFF_MS.max(interval), interval, now));
        } else if outcome != Outcome::Cancelled {
            self.unsupported_config = None;
            self.failures = self.failures.saturating_add(1);
            let factor = 1_u64 << self.failures.min(20);
            let ceiling = interval
                .saturating_mul(factor)
                .min(MAX_BACKOFF_MS.max(interval));
            self.retry = now.saturating_add(self.retry_delay(ceiling, interval, now));
        }
    }

    fn retry_delay(&self, ceiling: u64, interval: u64, now: u64) -> u64 {
        let floor = ceiling.saturating_sub(ceiling / 5).max(interval);
        let spread = ceiling - floor;
        floor + self.jitter.hash_one((now, self.failures)) % (spread + 1)
    }

    fn response(&self, remote: &str, outcome: Outcome) -> RemoteOutcome {
        RemoteOutcome {
            remote: remote.to_owned(),
            outcome,
            last_attempt_ms: self.attempt,
            last_success_ms: self.success,
            retry_at_ms: (self.retry > 0).then_some(self.retry),
            error_code: self
                .failure
                .as_ref()
                .map(|failure| failure.primary.code.clone()),
            error_message: self
                .failure
                .as_ref()
                .map(|failure| failure.primary.message.clone()),
            metadata_error_code: self
                .failure
                .as_ref()
                .and_then(|failure| failure.metadata.as_ref())
                .map(|error| error.code.clone()),
            metadata_error_message: self
                .failure
                .as_ref()
                .and_then(|failure| failure.metadata.as_ref())
                .map(|error| error.message.clone()),
        }
    }

    fn deferred(&self, now: u64, config: &[String]) -> Option<Outcome> {
        if self.manual_fresh_until > now {
            Some(Outcome::SkippedFresh)
        } else if self.retry > now && self.unsupported_config.as_deref() == Some(config) {
            Some(Outcome::Unsupported)
        } else if self.retry > now && self.unsupported_config.is_none() {
            Some(Outcome::SkippedBackoff)
        } else {
            None
        }
    }
}

pub struct BackgroundFetch {
    executable: Option<PathBuf>,
    freshness: Mutex<HashMap<FreshnessKey, Freshness>>,
    clock: Clock,
}

impl Default for BackgroundFetch {
    fn default() -> Self {
        Self {
            executable: std::env::current_exe().ok(),
            freshness: Mutex::default(),
            clock: Clock::default(),
        }
    }
}

impl BackgroundFetch {
    #[must_use]
    pub fn new(executable: PathBuf) -> Self {
        Self {
            executable: Some(executable),
            freshness: Mutex::default(),
            clock: Clock::default(),
        }
    }

    /// Drive retry and manual freshness observations without a wall-clock wait.
    ///
    /// # Panics
    ///
    /// Panics when the clock lock is poisoned.
    #[cfg(any(test, feature = "test-util"))]
    pub fn set_time_ms(&self, now: u64) {
        *self.clock.fixed.lock().unwrap() = Some(now);
    }

    /// # Panics
    ///
    /// Panics when the freshness lock is poisoned.
    pub fn forget(&self, path: &str) {
        self.freshness
            .lock()
            .unwrap()
            .retain(|key, _| key.path != path);
    }

    /// A manual fetch checks all remotes; a pull checks only its upstream remote.
    ///
    /// # Panics
    ///
    /// Panics when the freshness lock is poisoned.
    pub fn checked(&self, path: &str, session: u64, remote: Option<&str>, cache: &CommitCache) {
        let now = self.clock.now();
        let mut freshness = self.freshness.lock().unwrap();
        if cache.session_id(path) != Some(session) {
            return;
        }
        if let Some(remote) = remote {
            freshness
                .entry(FreshnessKey {
                    path: path.to_owned(),
                    session,
                    remote: remote.to_owned(),
                })
                .or_default();
        }
        for (key, value) in &mut *freshness {
            if key.path == path
                && key.session == session
                && remote.is_none_or(|remote| remote == key.remote)
            {
                let interval = if value.interval == 0 {
                    DEFAULT_FETCH_INTERVAL_MS
                } else {
                    value.interval
                };
                value.record(now, interval, Outcome::Unchanged, None, Vec::new());
                value.manual_fresh_until = now.saturating_add(interval);
            }
        }
        drop(freshness);
    }

    /// The current per-remote freshness, including a just-completed manual check.
    ///
    /// # Panics
    ///
    /// Panics when the freshness lock is poisoned.
    #[must_use]
    pub fn report(&self, path: &str, session: u64) -> FetchReport {
        let mut remotes = self
            .freshness
            .lock()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.path == path && key.session == session)
            .map(|(key, value)| value.response(&key.remote, value.outcome))
            .collect::<Vec<_>>();
        remotes.sort_by(|left, right| left.remote.cmp(&right.remote));
        FetchReport {
            outcome: combined_outcome(&remotes),
            remotes,
            graph_error: None,
            graph_rebuilds: 0,
        }
    }

    async fn execute(
        &self,
        request: &WorkerRequest,
        reservation: &RemoteReservation<'_>,
        deadline: Duration,
    ) -> Result<crate::fetch_worker::FetchOutcome, TrunkError> {
        if reservation.cancelled() {
            return Err(TrunkError::new("cancelled", "Automatic fetch cancelled"));
        }
        let executable = self
            .executable
            .as_ref()
            .ok_or_else(|| TrunkError::new("worker_unavailable", "Fetch worker is unavailable"))?;
        let mut command = Command::new(executable);
        command
            .arg("--background-fetch-worker")
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .map_err(|_| TrunkError::new("worker_unavailable", "Fetch worker could not start"))?;
        let process = RemoteProcess::background(child.id().ok_or_else(|| {
            TrunkError::new("worker_unavailable", "Fetch worker has no process identity")
        })?);
        reservation.attach(process);
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| TrunkError::new("worker_protocol", "Fetch worker input unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| TrunkError::new("worker_protocol", "Fetch worker output unavailable"))?;
        let input = serde_json::to_vec(request).map_err(|_| {
            TrunkError::new("worker_protocol", "Fetch request could not be encoded")
        })?;
        let output = async move {
            let mut bytes = Vec::new();
            stdout
                .take(65_536)
                .read_to_end(&mut bytes)
                .await
                .map(|_| bytes)
                .map_err(|_| {
                    TrunkError::new("worker_output", "Fetch worker output could not be read")
                })
        };
        let completed = tokio::time::timeout(deadline, async {
            stdin.write_all(&input).await.map_err(|_| {
                TrunkError::new("worker_input", "Fetch worker input could not be written")
            })?;
            drop(stdin);
            tokio::try_join!(
                async {
                    child.wait().await.map_err(|_| {
                        TrunkError::new("worker_wait", "Fetch worker exit could not be observed")
                    })
                },
                output
            )
        })
        .await;
        if !matches!(completed, Ok(Ok(_))) {
            process.stop();
            let _ = child.wait().await;
        }
        reservation.exited();
        if reservation.cancelled() {
            return Err(TrunkError::new("cancelled", "Automatic fetch cancelled"));
        }
        let (status, bytes) = match completed {
            Err(_) => {
                return Err(TrunkError::new(
                    "timed_out",
                    "Automatic fetch exceeded its deadline",
                ));
            }
            Ok(result) => result?,
        };
        if !status.success() {
            return Err(TrunkError::new(
                "worker_failed",
                "Fetch worker did not exit normally",
            ));
        }
        let result: WorkerResult = serde_json::from_slice(&bytes).map_err(|_| {
            TrunkError::new("worker_protocol", "Fetch worker returned an invalid result")
        })?;
        Ok(crate::fetch_worker::FetchOutcome {
            result: result.error.map_or(Ok(()), |error| {
                Err(TrunkError::new(error.code, error.message))
            }),
            metadata_written: result.metadata_written,
        })
    }
}

fn combined_outcome(remotes: &[RemoteOutcome]) -> Outcome {
    [
        Outcome::Cancelled,
        Outcome::TimedOut,
        Outcome::Failed,
        Outcome::Unsupported,
        Outcome::Changed,
        Outcome::Unchanged,
        Outcome::SkippedBackoff,
        Outcome::SkippedFresh,
    ]
    .into_iter()
    .find(|outcome| remotes.iter().any(|remote| remote.outcome == *outcome))
    .unwrap_or(Outcome::Unchanged)
}

fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

async fn fetch_head_prefix(path: PathBuf) -> Result<Vec<u8>, TrunkError> {
    tauri::async_runtime::spawn_blocking(move || match std::fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err(TrunkError::new(
            "fetch_head_error",
            "Fetch metadata could not be read",
        )),
    })
    .await
    .map_err(|_| TrunkError::new("spawn_error", "Fetch metadata could not be read"))?
}

/// A killed worker cannot run its append cleanup. Repair only after joining it.
async fn restore_fetch_head(path: PathBuf, prefix: Vec<u8>) -> Result<(), TrunkError> {
    if prefix.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let current = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(_) => {
                return Err(TrunkError::new(
                    "fetch_head_error",
                    "Fetch metadata could not be restored",
                ));
            }
        };
        if current.starts_with(&prefix) {
            return Ok(());
        }
        let parent = path.parent().ok_or_else(|| {
            TrunkError::new("fetch_head_error", "Fetch metadata has no directory")
        })?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| {
            TrunkError::new("fetch_head_error", "Fetch metadata could not be restored")
        })?;
        file.write_all(&prefix)
            .and_then(|()| file.write_all(&current))
            .map_err(|_| {
                TrunkError::new("fetch_head_error", "Fetch metadata could not be restored")
            })?;
        file.persist(&path).map_err(|_| {
            TrunkError::new("fetch_head_error", "Fetch metadata could not be restored")
        })?;
        Ok(())
    })
    .await
    .map_err(|_| TrunkError::new("spawn_error", "Fetch metadata could not be restored"))?
}

async fn ref_state(path: PathBuf) -> Result<RefState, TrunkError> {
    tauri::async_runtime::spawn_blocking(move || RefState::read(&git2::Repository::open(path)?))
        .await
        .map_err(|_| TrunkError::new("spawn_error", "Ref state could not be read"))?
}

/// Shared application state used while checking remotes and publishing refs.
pub struct FetchContext<'a, R: Runtime> {
    pub state: &'a RepoState,
    pub cache: &'a CommitCache,
    pub running: &'a RunningOp,
    pub visibility: &'a RefVisibilityState,
    pub service: &'a BackgroundFetch,
    pub app: &'a AppHandle<R>,
}

/// Check configured remotes and reconcile affected open worktrees.
///
/// # Errors
/// Returns an error for a closed session or unreadable initial configuration.
/// Failures after a worker starts are reported after reconciling partial updates.
///
/// # Panics
/// Panics when a shared state lock is poisoned.
pub async fn fetch<R: Runtime>(
    path: &str,
    interval_ms: u64,
    context: FetchContext<'_, R>,
) -> Result<FetchReport, TrunkError> {
    let FetchContext {
        state,
        cache,
        running,
        visibility,
        service,
        app,
    } = context;
    let session = cache
        .session_id(path)
        .ok_or_else(|| TrunkError::new("not_open", "Repository is closed"))?;
    let open = state.snapshot();
    let opening_sessions = open
        .locations()
        .filter_map(|(key, _)| {
            cache
                .session_id(key)
                .map(|session| (key.to_owned(), session))
        })
        .collect::<HashMap<_, _>>();
    let location = open.path_for(path)?.to_path_buf();
    let probe = location.clone();
    let info = tauri::async_runtime::spawn_blocking(move || trunk_git::fetch::preflight(&probe))
        .await
        .map_err(|_| TrunkError::new("spawn_error", "Fetch configuration could not be read"))??;
    if !info.clean {
        return Ok(FetchReport::skipped(Outcome::SkippedOperation));
    }
    let reservation = match RemoteReservation::acquire_background_checked(
        &running.0,
        RemoteTarget {
            path,
            common: &info.common,
        },
        || cache.session_id(path) == Some(session),
    ) {
        Ok(reservation) => reservation,
        Err(error) if error.code == "op_in_progress" => {
            return Ok(FetchReport::skipped(Outcome::SkippedBusy));
        }
        Err(error) => return Err(error),
    };
    let mut report = FetchReport::skipped(Outcome::Unchanged);
    let mut appended = false;
    for (name, config) in info.remotes {
        let key = FreshnessKey {
            path: path.to_owned(),
            session,
            remote: name.clone(),
        };
        let now = service.clock.now();
        {
            let mut records = service.freshness.lock().unwrap();
            if cache.session_id(path) != Some(session) {
                report.outcome = Outcome::Cancelled;
                break;
            }
            let record = records.entry(key.clone()).or_default();
            if let Some(outcome) = record.deferred(now, &config) {
                report.remotes.push(record.response(&name, outcome));
                continue;
            }
            drop(records);
        }
        let before = match ref_state(location.clone()).await {
            Ok(before) => before,
            Err(error) => {
                report.graph_error = Some(error.code.clone());
                let mut records = service.freshness.lock().unwrap();
                if cache.session_id(path) == Some(session) {
                    let record = records.entry(key).or_default();
                    record.record(
                        now,
                        interval_ms.max(1),
                        Outcome::Failed,
                        Some(FetchFailure {
                            primary: error,
                            metadata: None,
                        }),
                        config,
                    );
                    report.remotes.push(record.response(&name, Outcome::Failed));
                }
                drop(records);
                break;
            }
        };
        let request = WorkerRequest {
            path: location.to_string_lossy().into_owned(),
            remote: name.clone(),
            append_fetch_head: appended,
        };
        let prefix = if appended {
            fetch_head_prefix(info.fetch_head.clone()).await
        } else {
            Ok(Vec::new())
        };
        let mut metadata_error = None;
        let result = match prefix {
            Ok(prefix) => {
                let result = service
                    .execute(&request, &reservation, WORKER_DEADLINE)
                    .await;
                match result {
                    Ok(receipt) => {
                        appended |= receipt.metadata_written;
                        receipt.result
                    }
                    Err(error) => {
                        metadata_error = restore_fetch_head(info.fetch_head.clone(), prefix)
                            .await
                            .err();
                        Err(error)
                    }
                }
            }
            Err(error) => Err(error),
        };
        let after = ref_state(location.clone()).await;
        let changed = after.as_ref().is_ok_and(|after| after != &before);
        let (outcome, failure) = match result {
            Ok(()) => (
                if changed {
                    Outcome::Changed
                } else {
                    Outcome::Unchanged
                },
                None,
            ),
            Err(error) => (
                match error.code.as_str() {
                    "cancelled" => Outcome::Cancelled,
                    "timed_out" => Outcome::TimedOut,
                    "unsupported_transport" => Outcome::Unsupported,
                    _ => Outcome::Failed,
                },
                Some(FetchFailure {
                    primary: error,
                    metadata: metadata_error,
                }),
            ),
        };
        let mut records = service.freshness.lock().unwrap();
        if cache.session_id(path) != Some(session) {
            report.outcome = Outcome::Cancelled;
            break;
        }
        let record = records.entry(key).or_default();
        record.record(
            service.clock.now(),
            interval_ms.max(1),
            outcome,
            failure,
            config,
        );
        report.remotes.push(record.response(&name, outcome));
        drop(records);
        if outcome == Outcome::Cancelled {
            report.outcome = Outcome::Cancelled;
            break;
        }
    }

    if report.outcome != Outcome::Cancelled {
        report.outcome = combined_outcome(&report.remotes);
    }

    // Reconcile every affected open worktree after success OR partial failure. Cheap
    // input comparisons also fold the watcher's later notifications into this revision.
    let open_keys = open
        .locations()
        .map(|(key, _)| key.to_owned())
        .collect::<Vec<_>>();
    let common = info.common;
    let affected = tauri::async_runtime::spawn_blocking(move || {
        open.locations()
            .map(|(key, location)| {
                let resolved = (|| -> Result<Option<PathBuf>, TrunkError> {
                    let repo = git2::Repository::open(location)?;
                    let directory = repo.commondir().canonicalize().map_err(|_| {
                        TrunkError::new("git_error", "Shared Git directory is unavailable")
                    })?;
                    Ok((directory.to_string_lossy() == common).then(|| location.to_path_buf()))
                })();
                (key.to_owned(), resolved)
            })
            .collect::<Vec<_>>()
    })
    .await;
    let Ok(affected) = affected else {
        report.graph_error = Some("spawn_error".to_owned());
        for key in open_keys {
            if opening_sessions.get(&key) == cache.session_id(&key).as_ref()
                && opening_sessions.contains_key(&key)
            {
                let _ = app.emit("repo-changed", RepoChanged::whole_repo(key));
            }
        }
        return Ok(report);
    };
    let rebuild = GraphRebuild::new(cache, visibility);
    for (key, location) in affected {
        let Some(&opening_session) = opening_sessions.get(&key) else {
            continue;
        };
        if cache.session_id(&key) != Some(opening_session) {
            continue;
        }

        let location = match location {
            Ok(Some(location)) => location,
            Ok(None) => continue,
            Err(error) => {
                report.graph_error = Some(error.code);
                if cache.session_id(&key) == Some(opening_session) {
                    let _ = app.emit("repo-changed", RepoChanged::whole_repo(key));
                }
                continue;
            }
        };
        match rebuild
            .reconcile_refs_in_session(key.clone(), location, opening_session)
            .await
        {
            Ok(Some(graph)) => {
                report.graph_rebuilds += 1;
                if report.outcome == Outcome::Unchanged {
                    report.outcome = Outcome::Changed;
                }
                let _ = app.emit("repo-changed", RepoChanged::reconciled(key, &graph));
            }
            Ok(None) => {}
            Err(error) if error.code == "not_open" => {}
            Err(error) => {
                report.graph_error = Some(error.code);
                if cache.session_id(&key) == Some(opening_session) {
                    let _ = app.emit("repo-changed", RepoChanged::whole_repo(key));
                }
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_preserves_success_and_resets_only_on_a_successful_check() {
        let mut freshness = Freshness::default();
        freshness.record(10, 100, Outcome::Unchanged, None, Vec::new());
        freshness.record(
            20,
            100,
            Outcome::Failed,
            Some(FetchFailure {
                primary: TrunkError::new("auth", "fixture"),
                metadata: None,
            }),
            Vec::new(),
        );
        assert_eq!(freshness.success, Some(10));
        let first_retry = freshness.retry;
        assert!((160..=200).contains(&(first_retry - 20)));
        freshness.record(
            first_retry,
            100,
            Outcome::Failed,
            Some(FetchFailure {
                primary: TrunkError::new("auth", "fixture"),
                metadata: None,
            }),
            Vec::new(),
        );
        let second_retry = freshness.retry;
        assert!((320..=400).contains(&(second_retry - first_retry)));
        freshness.record(second_retry, 100, Outcome::Changed, None, Vec::new());
        assert_eq!(freshness.success, Some(second_retry));
        assert_eq!(freshness.retry, 0);
        freshness.record(second_retry + 1, 100, Outcome::Failed, None, Vec::new());
        assert!((160..=200).contains(&(freshness.retry - second_retry - 1)));
    }

    #[test]
    fn repeated_failures_cap_the_retry_delay() {
        let mut freshness = Freshness::default();
        let mut now = 1_000;
        for _ in 0..14 {
            freshness.record(
                now,
                100,
                Outcome::Failed,
                Some(FetchFailure {
                    primary: TrunkError::new("network", "fixture"),
                    metadata: None,
                }),
                Vec::new(),
            );
            now = freshness.retry;
        }
        let delay = freshness.retry - freshness.attempt.unwrap();
        assert!((MAX_BACKOFF_MS - MAX_BACKOFF_MS / 5..=MAX_BACKOFF_MS).contains(&delay));
        freshness.record(now, 100, Outcome::Unchanged, None, Vec::new());
        assert_eq!(freshness.retry, 0);
        assert_eq!(freshness.success, Some(now));

        let interval = MAX_BACKOFF_MS + 100;
        let mut long_interval = Freshness::default();
        long_interval.record(10, interval, Outcome::Failed, None, Vec::new());
        assert_eq!(long_interval.retry - 10, interval);
    }

    #[test]
    fn deferred_checks_observe_capability_configuration_backoff_and_success_reset() {
        let mut freshness = Freshness::default();
        let config_a = vec!["config-a".to_owned()];
        let config_b = vec!["config-b".to_owned()];
        freshness.record(
            10,
            100,
            Outcome::Unsupported,
            Some(FetchFailure {
                primary: TrunkError::new("unsupported_transport", "fixture"),
                metadata: None,
            }),
            config_a.clone(),
        );
        let capability_retry = freshness.retry;
        assert_eq!(
            freshness.deferred(20, &config_a),
            Some(Outcome::Unsupported)
        );
        assert_eq!(freshness.deferred(20, &config_b), None);
        assert_eq!(
            freshness.deferred(capability_retry - 1, &config_a),
            Some(Outcome::Unsupported)
        );
        assert_eq!(freshness.deferred(capability_retry, &config_a), None);

        freshness.record(
            capability_retry,
            100,
            Outcome::Failed,
            Some(FetchFailure {
                primary: TrunkError::new("network", "fixture"),
                metadata: None,
            }),
            config_b.clone(),
        );
        let failed_retry = freshness.retry;
        assert!((160..=200).contains(&(failed_retry - capability_retry)));
        assert_eq!(
            freshness.deferred(failed_retry - 1, &config_a),
            Some(Outcome::SkippedBackoff)
        );
        assert_eq!(
            freshness.deferred(failed_retry - 1, &config_b),
            Some(Outcome::SkippedBackoff)
        );
        assert_eq!(freshness.deferred(failed_retry, &config_b), None);
        freshness.record(
            failed_retry,
            100,
            Outcome::Unchanged,
            None,
            config_b.clone(),
        );
        assert!(freshness.unsupported_config.is_none());
        assert_eq!(freshness.retry, 0);
        assert_eq!(freshness.deferred(failed_retry + 1, &config_a), None);
        assert_eq!(freshness.deferred(failed_retry + 1, &config_b), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_deadline_kills_and_joins_the_worker_before_its_reservation_can_be_reused() {
        use std::io::BufRead;
        use std::os::unix::fs::PermissionsExt;
        use tokio::sync::oneshot;

        let directory = tempfile::tempdir().unwrap();
        let ready = directory.path().join("ready");
        let blocked = directory.path().join("blocked-input");
        for fifo in [&ready, &blocked] {
            let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
            // SAFETY: the CString lives through the call and the path is isolated.
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        }
        let script = directory.path().join("blocked-worker");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$$\" > '{}'\nexec /bin/cat '{}'\n",
                ready.display(),
                blocked.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let worker = BackgroundFetch::new(script);
        let running = std::sync::Arc::new(Mutex::new(crate::remote_ops::RemoteOps::default()));
        let request = WorkerRequest {
            path: "repo".into(),
            remote: "origin".into(),
            append_fetch_head: false,
        };
        let (ready_tx, ready_rx) = oneshot::channel();
        let reader = std::thread::spawn(move || {
            let mut line = String::new();
            let file = std::fs::File::open(ready).unwrap();
            std::io::BufReader::new(file).read_line(&mut line).unwrap();
            ready_tx.send(line.trim().parse::<i32>().unwrap()).unwrap();
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (executed_tx, executed_rx) = oneshot::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let owner = std::sync::Arc::clone(&running);
            let job = tokio::spawn(async move {
                let reservation = RemoteReservation::acquire_background(
                    &owner,
                    RemoteTarget {
                        path: "repo",
                        common: "common",
                    },
                )
                .unwrap();
                let error = worker
                    .execute(&request, &reservation, Duration::from_secs(60))
                    .await
                    .unwrap_err();
                executed_tx.send(error).unwrap();
                release_rx.await.unwrap();
                drop(reservation);
            });
            let pid = ready_rx.await.unwrap();
            reader.join().unwrap();
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(60)).await;
            let error = executed_rx.await.unwrap();
            assert_eq!(error.code, "timed_out");

            // A zombie still has a PID. ECHILD proves execute waited for the
            // actual child before its owner is allowed to release the permit.
            let reaped = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
            assert_eq!(reaped, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ECHILD)
            );
            assert!(running.lock().unwrap().busy("common"));
            assert_eq!(
                RemoteReservation::acquire_background(
                    &running,
                    RemoteTarget {
                        path: "repo",
                        common: "common"
                    }
                )
                .err()
                .unwrap()
                .code,
                "op_in_progress"
            );
            release_tx.send(()).unwrap();
            job.await.unwrap();
            let next = RemoteReservation::acquire_background(
                &running,
                RemoteTarget {
                    path: "repo",
                    common: "common",
                },
            )
            .unwrap();
            drop(next);
        });
    }

    #[cfg(unix)]
    #[test]
    fn a_deadline_covers_stdout_held_open_after_the_worker_exits() {
        use std::io::{BufRead, Read};
        use std::os::unix::fs::PermissionsExt;
        use tokio::sync::oneshot;

        let directory = tempfile::tempdir().unwrap();
        let parent_ready = directory.path().join("parent-ready");
        let descendant_ready = directory.path().join("descendant-ready");
        let blocked = directory.path().join("blocked-input");
        for fifo in [&parent_ready, &descendant_ready, &blocked] {
            let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
            // SAFETY: the CString lives through the call and the path is isolated.
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        }
        let script = directory.path().join("exited-worker-with-open-stdout");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n/bin/cat > /dev/null\nprintf '%s\\n' \"$$\" > '{}'\n/bin/sh -c 'exec 3>\"$1\"; printf \"%s\\n\" \"$$\" >&3; read ignored < \"$2\"' sh '{}' '{}' &\nexit 0\n",
                parent_ready.display(),
                descendant_ready.display(),
                blocked.display(),
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();

        let (parent_tx, parent_rx) = oneshot::channel();
        let parent_reader = std::thread::spawn(move || {
            let file = std::fs::File::open(parent_ready).unwrap();
            let mut line = String::new();
            std::io::BufReader::new(file).read_line(&mut line).unwrap();
            parent_tx.send(line.trim().parse::<i32>().unwrap()).unwrap();
        });
        let (descendant_tx, descendant_rx) = oneshot::channel();
        let (closed_tx, closed_rx) = oneshot::channel();
        let descendant_reader = std::thread::spawn(move || {
            let file = std::fs::File::open(descendant_ready).unwrap();
            let mut reader = std::io::BufReader::new(file);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            descendant_tx
                .send(line.trim().parse::<i32>().unwrap())
                .unwrap();
            let mut trailing = Vec::new();
            reader.read_to_end(&mut trailing).unwrap();
            closed_tx.send(trailing).unwrap();
        });
        let worker = BackgroundFetch::new(script);
        let running = std::sync::Arc::new(Mutex::new(crate::remote_ops::RemoteOps::default()));
        let request = WorkerRequest {
            path: "repo".into(),
            remote: "origin".into(),
            append_fetch_head: false,
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (executed_tx, executed_rx) = oneshot::channel();
            let (release_tx, release_rx) = oneshot::channel();
            let owner = std::sync::Arc::clone(&running);
            let job = tokio::spawn(async move {
                let reservation = RemoteReservation::acquire_background(
                    &owner,
                    RemoteTarget {
                        path: "repo",
                        common: "common",
                    },
                )
                .unwrap();
                let error = worker
                    .execute(&request, &reservation, Duration::from_secs(60))
                    .await
                    .unwrap_err();
                executed_tx.send(error).unwrap();
                release_rx.await.unwrap();
                drop(reservation);
            });
            let parent_pid = tokio::time::timeout(Duration::from_secs(10), parent_rx)
                .await
                .expect("worker must report its PID")
                .unwrap();
            let descendant_pid = tokio::time::timeout(Duration::from_secs(10), descendant_rx)
                .await
                .expect("descendant must report its PID")
                .unwrap();
            parent_reader.join().unwrap();
            assert!(descendant_pid > 0);
            tokio::task::yield_now().await;
            tokio::time::pause();
            tokio::time::advance(Duration::from_secs(60)).await;
            tokio::time::resume();
            let error = tokio::time::timeout(Duration::from_secs(10), executed_rx)
                .await
                .expect("deadline must also bound the stdout drain")
                .unwrap();
            assert_eq!(error.code, "timed_out");

            let reaped = unsafe { libc::waitpid(parent_pid, std::ptr::null_mut(), libc::WNOHANG) };
            assert_eq!(reaped, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ECHILD)
            );
            // This shell holds fd 3 while blocked on input; EOF proves the
            // descendant exited instead of merely dropping its stdout pipe.
            let trailing = tokio::time::timeout(Duration::from_secs(10), closed_rx)
                .await
                .expect("descendant must release its open FIFO on termination")
                .unwrap();
            assert!(trailing.is_empty());
            descendant_reader.join().unwrap();
            assert!(running.lock().unwrap().busy("common"));
            assert_eq!(
                RemoteReservation::acquire_background(
                    &running,
                    RemoteTarget {
                        path: "repo",
                        common: "common"
                    }
                )
                .err()
                .unwrap()
                .code,
                "op_in_progress"
            );
            release_tx.send(()).unwrap();
            job.await.unwrap();
            let next = RemoteReservation::acquire_background(
                &running,
                RemoteTarget {
                    path: "repo",
                    common: "common",
                },
            )
            .unwrap();
            drop(next);
        });
    }
}

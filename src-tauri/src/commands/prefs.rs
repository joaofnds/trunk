//! Persistent user preferences (`trunk-prefs.json`) — in-house replacement for
//! tauri-plugin-store, whose `save()` was a non-atomic whole-file `fs::write`.
//!
//! Thin **async** `#[tauri::command]`s over testable `_inner(data_dir, ...)`
//! functions, mirroring review.rs. Each wrapper hands the disk work to
//! `spawn_blocking`, so neither the first-access load nor the `sync_all` write
//! pins a tokio worker while another call waits on the same lock. The whole map
//! is loaded from disk on first access and held in `PrefsState`; every set
//! updates the map and atomically rewrites the file under the same lock, so the
//! file always matches the map.
//!
//! That last guarantee holds only because one process owns the file: a second
//! instance would rewrite the whole map from its own stale copy. What makes the
//! premise an invariant rather than an assumption is `tauri-plugin-single-instance`
//! (registered first in `lib.rs`), whose lock is keyed on the app identifier —
//! so dev and the installed app still run side by side, each alone with
//! its own state dir. The drive build has no such lock. Its instances share
//! nothing because the drive plugin refuses to start without a
//! `TRUNK_DATA_DIR`, and its launcher gives each instance a directory of its own.
//!
//! The on-disk contract is unchanged from the plugin: a flat JSON object
//! (`{"key": value, ...}`) at the same name and location, so existing user
//! prefs load as-is. An unparseable file is quarantined to a `.corrupt`
//! sidecar — never deleted — and the store proceeds empty (D-15 posture).

use super::resolve_data_dir;
use crate::activity::{Activity, ActivityState};
use crate::storage::{atomic_write_json, quarantine_corrupt};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::ipc::{Invoke, InvokeBody, InvokeError};
use tauri::{AppHandle, Manager, Runtime};
use trunk_git::error::TrunkError;

const PREFS_FILE: &str = "trunk-prefs.json";
const OPEN_TABS: &str = "open_tabs";
const ACTIVE_TAB_ID: &str = "active_tab_id";

#[derive(Default)]
pub struct PrefsState(Mutex<Preferences>);

#[derive(Default)]
struct Preferences {
    values: Option<HashMap<String, Value>>,
    issued_tab_writer: u64,
    last_tab_save: (u64, u64),
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSession {
    writer: u64,
    tabs: Option<Value>,
    active_tab_id: Option<Value>,
}

fn prefs_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PREFS_FILE)
}

/// First-access load: missing file → empty map; unparseable file → quarantine
/// to a `.corrupt` sidecar and start empty.
fn load_from_disk(data_dir: &Path) -> Result<HashMap<String, Value>, TrunkError> {
    let path = prefs_path(data_dir);
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(TrunkError::new("io", e.to_string())),
    };
    if let Ok(map) = serde_json::from_str(&raw) {
        Ok(map)
    } else {
        quarantine_corrupt(&path)?;
        Ok(HashMap::new())
    }
}

fn ensure_loaded<'a>(
    data_dir: &Path,
    cache: &'a mut Option<HashMap<String, Value>>,
) -> Result<&'a mut HashMap<String, Value>, TrunkError> {
    if cache.is_none() {
        *cache = Some(load_from_disk(data_dir)?);
    }
    Ok(cache.as_mut().expect("filled by the branch above"))
}

/// One preference value, or `None` when the key is unset.
///
/// # Errors
///
/// Returns `io` when the preferences file exists but will not read. An
/// unparseable file is not an error: it is quarantined and the map starts empty.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
pub fn prefs_get_inner(
    data_dir: &Path,
    state: &PrefsState,
    key: &str,
) -> Result<Option<Value>, TrunkError> {
    let mut cache = state.0.lock().unwrap();
    let value = ensure_loaded(data_dir, &mut cache.values)?
        .get(key)
        .cloned();
    drop(cache);

    Ok(value)
}

/// Store one preference, rolling the in-memory value back if the write fails.
///
/// # Errors
///
/// Returns `serialize` when the map will not encode, and the filesystem error
/// when the preferences file will not write.
///
/// # Panics
///
/// Panics when one of the shared state locks it takes is poisoned.
pub fn prefs_set_inner(
    data_dir: &Path,
    state: &PrefsState,
    key: String,
    value: Value,
) -> Result<(), TrunkError> {
    // The lock is held across the write so the rollback below restores the
    // value this call replaced, not one a concurrent write left behind.
    let mut cache = state.0.lock().unwrap();
    let map = ensure_loaded(data_dir, &mut cache.values)?;
    let written = write_preferences(data_dir, map, [(key, value)]);
    drop(cache);

    written
}

fn prefs_open_tabs_inner(data_dir: &Path, state: &PrefsState) -> Result<TabSession, TrunkError> {
    let mut cache = state.0.lock().unwrap();
    let map = ensure_loaded(data_dir, &mut cache.values)?;
    let tabs = map.get(OPEN_TABS).cloned();
    let active_tab_id = map.get(ACTIVE_TAB_ID).cloned();
    cache.issued_tab_writer += 1;
    let writer = cache.issued_tab_writer;
    drop(cache);
    Ok(TabSession {
        writer,
        tabs,
        active_tab_id,
    })
}

fn prefs_set_tabs_inner(
    data_dir: &Path,
    state: &PrefsState,
    writer: u64,
    revision: u64,
    tabs: Value,
    active_tab_id: String,
) -> Result<(), TrunkError> {
    let mut cache = state.0.lock().unwrap();
    // Reads can finish from a disposed mount. Only a newer writer's first
    // save makes an older writer stale.
    if writer == 0 || writer > cache.issued_tab_writer || writer < cache.last_tab_save.0 {
        return Err(TrunkError::new(
            "tab_session_replaced",
            "The tab session has changed",
        ));
    }
    if (writer, revision) <= cache.last_tab_save {
        return Ok(());
    }
    // Remember the latest intent even if its disk write fails. A late command
    // from an earlier choice must not replace the last successful snapshot.
    cache.last_tab_save = (writer, revision);
    let map = ensure_loaded(data_dir, &mut cache.values)?;
    let written = write_preferences(
        data_dir,
        map,
        [
            (OPEN_TABS.to_owned(), tabs),
            (ACTIVE_TAB_ID.to_owned(), Value::String(active_tab_id)),
        ],
    );
    drop(cache);
    written
}

fn write_preferences<const N: usize>(
    data_dir: &Path,
    map: &mut HashMap<String, Value>,
    changes: [(String, Value); N],
) -> Result<(), TrunkError> {
    let previous = changes.map(|(key, value)| {
        let previous = map.insert(key.clone(), value);
        (key, previous)
    });
    let written = serde_json::to_string_pretty(&*map)
        .map_err(|e| TrunkError::new("serialize", e.to_string()))
        .and_then(|json| atomic_write_json(&prefs_path(data_dir), &json));
    if written.is_err() {
        for (key, value) in previous {
            match value {
                Some(value) => map.insert(key, value),
                None => map.remove(&key),
            };
        }
    }
    written
}

fn join_error(e: tauri::Error) -> String {
    TrunkError::new("join", e.to_string()).to_json()
}

/// # Errors
///
/// Returns the inner error as JSON, and `join` when the blocking task cannot be
/// joined.
#[tauri::command]
pub async fn prefs_get<R: Runtime>(
    activity: crate::activity::Activity,
    key: String,
    app: AppHandle<R>,
) -> Result<Option<Value>, String> {
    let data_dir = resolve_data_dir(&app)?;
    activity
        .spawn_blocking(move || {
            prefs_get_inner(&data_dir, &app.state::<PrefsState>(), &key).map_err(|e| e.to_json())
        })
        .await
        .map_err(join_error)?
}

/// # Errors
///
/// Returns the inner error as JSON, and `join` when the blocking task cannot be
/// joined.
#[tauri::command]
pub async fn prefs_set<R: Runtime>(
    activity: crate::activity::Activity,
    key: String,
    value: Value,
    app: AppHandle<R>,
) -> Result<(), String> {
    let data_dir = resolve_data_dir(&app)?;
    activity
        .spawn_blocking(move || {
            prefs_set_inner(&data_dir, &app.state::<PrefsState>(), key, value)
                .map_err(|e| e.to_json())
        })
        .await
        .map_err(join_error)?
}

/// Restore both tab preferences and give the mounting frontend a new writer ID.
///
/// # Errors
/// Returns the preferences read error as JSON, or `join` on task failure.
#[tauri::command]
pub async fn prefs_open_tabs<R: Runtime>(
    activity: crate::activity::Activity,
    app: AppHandle<R>,
) -> Result<TabSession, String> {
    let data_dir = resolve_data_dir(&app)?;
    app.state::<ActivityState>().wait_for_tab_saves().await;
    activity
        .spawn_blocking(move || {
            prefs_open_tabs_inner(&data_dir, &app.state::<PrefsState>()).map_err(|e| e.to_json())
        })
        .await
        .map_err(join_error)?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabSave {
    writer: u64,
    revision: u64,
    tabs: Value,
    active_tab_id: String,
}

/// Accept at IPC dispatch so restore and exit see the lease even if the worker
/// has yet to start. The usual async command wrapper first admits in its task.
pub(crate) fn prefs_set_tabs<R: Runtime>(invoke: Invoke<R>) -> bool {
    let request = Activity::for_invoke(&invoke.message, "prefs_set_tabs").and_then(|activity| {
        let InvokeBody::Json(payload) = invoke.message.payload() else {
            return Err(
                TrunkError::new("invalid_args", "Expected a JSON tab snapshot")
                    .to_json()
                    .into(),
            );
        };
        let request = TabSave::deserialize(payload)
            .map_err(|error| TrunkError::new("invalid_args", error.to_string()).to_json())?;
        Ok((activity, request))
    });
    match request {
        Err(error) => invoke.resolver.respond::<()>(Err(error)),
        Ok((activity, request)) => {
            let app = invoke.message.webview_ref().app_handle().clone();
            let worker = activity.spawn_blocking(move || {
                let data_dir = resolve_data_dir(&app)?;
                prefs_set_tabs_inner(
                    &data_dir,
                    &app.state::<PrefsState>(),
                    request.writer,
                    request.revision,
                    request.tabs,
                    request.active_tab_id,
                )
                .map_err(|error| error.to_json())
            });
            invoke.resolver.respond_async(async move {
                worker.await.map_err(join_error)?.map_err(InvokeError::from)
            });
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    #[test]
    fn get_on_an_empty_dir_returns_none_without_creating_a_file() {
        let dir = TempDir::new().unwrap();

        let got = prefs_get_inner(dir.path(), &PrefsState::default(), "zoom_level").unwrap();

        assert_eq!(got, None);
        assert!(!dir.path().join(PREFS_FILE).exists());
    }

    #[test]
    fn round_trips_a_set_value_within_one_state() {
        let dir = TempDir::new().unwrap();
        let state = PrefsState::default();

        prefs_set_inner(dir.path(), &state, "zoom_level".into(), json!(1.5)).unwrap();

        let got = prefs_get_inner(dir.path(), &state, "zoom_level").unwrap();
        assert_eq!(got, Some(json!(1.5)));
    }

    #[test]
    fn a_fresh_state_reads_the_value_a_previous_state_persisted() {
        let dir = TempDir::new().unwrap();
        prefs_set_inner(
            dir.path(),
            &PrefsState::default(),
            "zoom_level".into(),
            json!(2.0),
        )
        .unwrap();

        let got = prefs_get_inner(dir.path(), &PrefsState::default(), "zoom_level").unwrap();

        assert_eq!(got, Some(json!(2.0)));
    }

    #[test]
    fn serves_values_from_a_plugin_written_flat_json_file() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join(PREFS_FILE),
            r#"{"column_visibility":{"sha":false},"zoom_level":1.25}"#,
        )
        .unwrap();

        let got = prefs_get_inner(dir.path(), &PrefsState::default(), "column_visibility").unwrap();

        assert_eq!(got, Some(json!({"sha": false})));
    }

    #[test]
    fn a_stored_null_round_trips_as_null() {
        let dir = TempDir::new().unwrap();
        let state = PrefsState::default();

        prefs_set_inner(dir.path(), &state, "open_repo".into(), Value::Null).unwrap();

        let got = prefs_get_inner(dir.path(), &PrefsState::default(), "open_repo").unwrap();
        assert_eq!(got, Some(Value::Null));
    }

    #[test]
    fn quarantines_an_unparseable_file_and_proceeds_empty() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(PREFS_FILE), "{not json").unwrap();
        let state = PrefsState::default();

        let got = prefs_get_inner(dir.path(), &state, "zoom_level").unwrap();

        assert_eq!(got, None);
        assert!(!dir.path().join(PREFS_FILE).exists());
        assert!(dir.path().join("trunk-prefs.json.corrupt").exists());

        prefs_set_inner(dir.path(), &state, "zoom_level".into(), json!(1.0)).unwrap();
        let reread = prefs_get_inner(dir.path(), &PrefsState::default(), "zoom_level").unwrap();
        assert_eq!(reread, Some(json!(1.0)));
    }

    #[cfg(unix)]
    fn set_dir_mode(dir: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_file_reports_an_error_instead_of_serving_an_empty_map() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(PREFS_FILE);
        fs::write(&path, r#"{"zoom_level":1.5}"#).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();

        let err = prefs_get_inner(dir.path(), &PrefsState::default(), "zoom_level").unwrap_err();

        assert_eq!(err.code, "io");
        assert!(!dir.path().join("trunk-prefs.json.corrupt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_does_not_leave_the_value_readable() {
        let dir = TempDir::new().unwrap();
        let state = PrefsState::default();
        set_dir_mode(dir.path(), 0o555);

        let result = prefs_set_inner(dir.path(), &state, "zoom_level".into(), json!(1.5));
        set_dir_mode(dir.path(), 0o755);

        assert!(result.is_err());
        let got = prefs_get_inner(dir.path(), &state, "zoom_level").unwrap();
        assert_eq!(got, None);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_keeps_serving_the_previously_persisted_value() {
        let dir = TempDir::new().unwrap();
        let state = PrefsState::default();
        prefs_set_inner(dir.path(), &state, "zoom_level".into(), json!(1.0)).unwrap();
        set_dir_mode(dir.path(), 0o555);

        let result = prefs_set_inner(dir.path(), &state, "zoom_level".into(), json!(2.0));
        set_dir_mode(dir.path(), 0o755);

        assert!(result.is_err());
        let got = prefs_get_inner(dir.path(), &state, "zoom_level").unwrap();
        assert_eq!(got, Some(json!(1.0)));
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_tab_save_leaves_the_last_good_snapshot_and_allows_a_retry() {
        let dir = TempDir::new().unwrap();
        let state = PrefsState::default();
        let writer = prefs_open_tabs_inner(dir.path(), &state).unwrap().writer;
        let saved = json!([{ "id": "stay", "repoPath": null, "repoName": "Stay" }]);
        let closed = json!([{ "id": "new", "repoPath": null, "repoName": "New Tab" }]);
        prefs_set_tabs_inner(dir.path(), &state, writer, 1, saved.clone(), "stay".into()).unwrap();
        set_dir_mode(dir.path(), 0o555);

        let failed =
            prefs_set_tabs_inner(dir.path(), &state, writer, 3, closed.clone(), "new".into());
        set_dir_mode(dir.path(), 0o755);
        prefs_set_tabs_inner(dir.path(), &state, writer, 2, json!([]), "earlier".into()).unwrap();

        assert!(failed.is_err());
        assert_eq!(
            prefs_get_inner(dir.path(), &state, OPEN_TABS).unwrap(),
            Some(saved.clone())
        );
        assert_eq!(
            prefs_get_inner(dir.path(), &state, ACTIVE_TAB_ID).unwrap(),
            Some(json!("stay"))
        );
        let on_disk = load_from_disk(dir.path()).unwrap();
        assert_eq!(on_disk.get(OPEN_TABS), Some(&saved));
        assert_eq!(on_disk.get(ACTIVE_TAB_ID), Some(&json!("stay")));

        prefs_set_tabs_inner(dir.path(), &state, writer, 4, closed.clone(), "new".into()).unwrap();

        let restarted = prefs_open_tabs_inner(dir.path(), &PrefsState::default()).unwrap();
        assert_eq!(restarted.tabs, Some(closed));
        assert_eq!(restarted.active_tab_id, Some(json!("new")));
    }

    #[test]
    fn a_remount_can_save_its_first_choice_and_rejects_the_previous_writer() {
        let dir = TempDir::new().unwrap();
        let state = PrefsState::default();
        let before = prefs_open_tabs_inner(dir.path(), &state).unwrap().writer;
        let tabs = json!([
            { "id": "first", "repoPath": "/repo", "repoName": "First" },
            { "id": "second", "repoPath": null, "repoName": "Second" },
        ]);
        prefs_set_tabs_inner(dir.path(), &state, before, 5, tabs.clone(), "first".into()).unwrap();
        let after = prefs_open_tabs_inner(dir.path(), &state).unwrap();

        prefs_set_tabs_inner(
            dir.path(),
            &state,
            after.writer,
            1,
            tabs.clone(),
            "second".into(),
        )
        .unwrap();
        let old = prefs_set_tabs_inner(dir.path(), &state, before, 6, tabs.clone(), "first".into());

        assert_eq!(after.tabs, Some(tabs));
        assert_eq!(after.active_tab_id, Some(json!("first")));
        assert_eq!(old.unwrap_err().code, "tab_session_replaced");
        assert_eq!(
            load_from_disk(dir.path()).unwrap().get(ACTIVE_TAB_ID),
            Some(&json!("second"))
        );
    }

    #[test]
    fn leaves_no_tmp_file_after_a_set() {
        let dir = TempDir::new().unwrap();

        prefs_set_inner(dir.path(), &PrefsState::default(), "k".into(), json!(true)).unwrap();

        let tmp_leftovers: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| {
                std::path::Path::new(name)
                    .extension()
                    .is_some_and(|e| e.eq_ignore_ascii_case("tmp"))
            })
            .collect();
        assert_eq!(tmp_leftovers, Vec::<String>::new());
    }
}

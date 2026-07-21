//! Persistent user preferences (`trunk-prefs.json`) — in-house replacement for
//! tauri-plugin-store, whose `save()` was a non-atomic whole-file `fs::write`.
//!
//! Two thin **async** `#[tauri::command]`s over testable `_inner(data_dir, ...)`
//! functions, mirroring review.rs. Both wrappers hand the disk work to
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
//! so dev, e2e, and the installed app still run side by side, each alone with
//! its own state dir.
//!
//! The on-disk contract is unchanged from the plugin: a flat JSON object
//! (`{"key": value, ...}`) at the same name and location, so existing user
//! prefs load as-is. An unparseable file is quarantined to a `.corrupt`
//! sidecar — never deleted — and the store proceeds empty (D-15 posture).

use super::resolve_data_dir;
use crate::error::TrunkError;
use crate::storage::{atomic_write_json, quarantine_corrupt};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const PREFS_FILE: &str = "trunk-prefs.json";

/// The whole prefs map; `None` until the first get/set loads the file.
#[derive(Default)]
pub struct PrefsState(pub Mutex<Option<HashMap<String, Value>>>);

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
    match serde_json::from_str(&raw) {
        Ok(map) => Ok(map),
        Err(_) => {
            quarantine_corrupt(&path)?;
            Ok(HashMap::new())
        }
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

pub fn prefs_get_inner(
    data_dir: &Path,
    state: &PrefsState,
    key: &str,
) -> Result<Option<Value>, TrunkError> {
    let mut cache = state.0.lock().unwrap();
    let map = ensure_loaded(data_dir, &mut cache)?;
    Ok(map.get(key).cloned())
}

pub fn prefs_set_inner(
    data_dir: &Path,
    state: &PrefsState,
    key: String,
    value: Value,
) -> Result<(), TrunkError> {
    let mut cache = state.0.lock().unwrap();
    let map = ensure_loaded(data_dir, &mut cache)?;
    let previous = map.insert(key.clone(), value);
    let written = serde_json::to_string_pretty(&*map)
        .map_err(|e| TrunkError::new("serialize", e.to_string()))
        .and_then(|json| atomic_write_json(&prefs_path(data_dir), &json));
    if written.is_err() {
        match previous {
            Some(v) => map.insert(key, v),
            None => map.remove(&key),
        };
    }
    written
}

fn join_error(e: tauri::Error) -> String {
    TrunkError::new("join", e.to_string()).to_json()
}

#[tauri::command]
pub async fn prefs_get(key: String, app: AppHandle) -> Result<Option<Value>, String> {
    let data_dir = resolve_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        prefs_get_inner(&data_dir, &app.state::<PrefsState>(), &key).map_err(|e| e.to_json())
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub async fn prefs_set(key: String, value: Value, app: AppHandle) -> Result<(), String> {
    let data_dir = resolve_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        prefs_set_inner(&data_dir, &app.state::<PrefsState>(), key, value).map_err(|e| e.to_json())
    })
    .await
    .map_err(join_error)?
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

    #[test]
    fn leaves_no_tmp_file_after_a_set() {
        let dir = TempDir::new().unwrap();

        prefs_set_inner(dir.path(), &PrefsState::default(), "k".into(), json!(true)).unwrap();

        let tmp_leftovers: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert_eq!(tmp_leftovers, Vec::<String>::new());
    }
}

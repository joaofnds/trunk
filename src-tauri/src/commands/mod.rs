use crate::error::TrunkError;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

/// Resolve `app_data_dir`, JSON-stringifying the error like the other commands.
pub(crate) fn resolve_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| TrunkError::new("app_data_dir", e.to_string()).to_json())
}

/// The review store's directory. `TRUNK_DATA_DIR` is authoritative on both
/// sides (see `reviewdb::data_dir_for`); otherwise the identifier derivation
/// must agree with Tauri's resolver — a disagreement means the app and the
/// CLI would silently run two stores, so it is refused, never papered over.
pub(crate) fn store_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let derived = crate::reviewdb::data_dir_for(&app.config().identifier);
    if std::env::var_os("TRUNK_DATA_DIR").is_some() {
        return Ok(derived);
    }

    let resolved = resolve_data_dir(app)?;
    if derived != resolved {
        return Err(TrunkError::new(
            "data_dir_disagreement",
            format!(
                "identifier derives {}, the app resolves {}",
                derived.display(),
                resolved.display()
            ),
        )
        .to_json());
    }

    Ok(resolved)
}

pub mod branches;
pub mod commit;
pub mod commit_actions;
pub mod diff;
pub mod fs;
pub mod history;
pub mod interactive_rebase;
pub mod markdown;
pub mod merge_editor;
pub mod operation_state;
pub mod perf;
pub mod prefs;
pub mod remote;
pub mod repo;
pub mod review;
pub mod staging;
pub mod stash;

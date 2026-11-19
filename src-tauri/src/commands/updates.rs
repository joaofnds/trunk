//! The frontend can request transitions, never choose a key, URL or installer.
use tauri::{AppHandle, Runtime};

use crate::updates::{self, UpdateStatus};

#[tauri::command]
pub async fn updates_resume<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::activity::resume_after_update(&app).map_err(|error| error.message.to_owned())
    })
    .await
    .map_err(|_| "Repositories could not be refreshed after the update was deferred")?
}

#[tauri::command]
pub fn updates_status<R: Runtime>(app: AppHandle<R>) -> UpdateStatus {
    updates::status(&app)
}

#[tauri::command]
pub async fn updates_enable<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<UpdateStatus, String> {
    tauri::async_runtime::spawn_blocking(move || updates::enable(&app, enabled))
        .await
        .map_err(|_| "Update settings could not be saved")?
}

#[tauri::command]
pub async fn updates_check<R: Runtime>(app: AppHandle<R>) -> Result<UpdateStatus, String> {
    // The owned task settles its state even when a webview drops its IPC caller.
    tauri::async_runtime::spawn(updates::check(app))
        .await
        .map_err(|_| "The update check stopped unexpectedly")?
}

#[tauri::command]
pub async fn updates_download<R: Runtime>(
    app: AppHandle<R>,
    version: String,
) -> Result<UpdateStatus, String> {
    tauri::async_runtime::spawn(async move { updates::download(app, &version).await })
        .await
        .map_err(|_| "The update download stopped unexpectedly")?
}

#[tauri::command]
pub fn updates_cancel<R: Runtime>(app: AppHandle<R>) -> UpdateStatus {
    updates::cancel(&app)
}

#[tauri::command]
pub fn updates_prepare<R: Runtime>(app: AppHandle<R>, version: String) -> Result<String, String> {
    updates::prepare(&app, &version)
}

#[tauri::command]
pub async fn updates_drained<R: Runtime>(app: AppHandle<R>, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || updates::drained(&app, &token))
        .await
        .map_err(|_| "Preparation stopped unexpectedly")?
}

#[tauri::command]
pub fn updates_abort<R: Runtime>(app: AppHandle<R>, token: String) -> Result<UpdateStatus, String> {
    updates::abort(&app, &token)
}

#[tauri::command]
pub async fn updates_install<R: Runtime>(
    app: AppHandle<R>,
    version: String,
    token: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || updates::install(&app, &version, &token))
        .await
        .map_err(|_| "The installer stopped unexpectedly; quit Trunk and reinstall manually")?
}

#[tauri::command]
pub async fn updates_ready<R: Runtime>(app: AppHandle<R>) -> Result<UpdateStatus, String> {
    tauri::async_runtime::spawn_blocking(move || updates::ready(&app))
        .await
        .map_err(|_| "The updated application could not confirm readiness")?
}

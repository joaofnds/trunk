mod commands;
mod error;
mod git;
mod state;
mod watcher;

use state::{CommitCache, RepoState};
use watcher::WatcherState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(RepoState(Default::default()))
        .manage(CommitCache(Default::default()))
        .manage(WatcherState(Default::default()))
        .invoke_handler(tauri::generate_handler![
            commands::repo::open_repo,
            commands::repo::close_repo,
            commands::history::get_commit_graph,
            commands::history::refresh_commit_graph,
            commands::branches::list_refs,
            commands::branches::checkout_branch,
            commands::branches::create_branch,
            commands::staging::get_dirty_counts,
            commands::staging::get_status,
            commands::staging::stage_file,
            commands::staging::unstage_file,
            commands::staging::stage_all,
            commands::staging::unstage_all,
            commands::commit::create_commit,
            commands::commit::amend_commit,
            commands::commit::get_head_commit_message,
            commands::diff::diff_unstaged,
            commands::diff::diff_staged,
            commands::diff::diff_commit,
            commands::diff::get_commit_detail,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

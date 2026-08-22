pub mod commands;
pub mod error;
pub mod git;
#[cfg(target_os = "macos")]
mod macos_traffic_lights;
pub mod review_types;
pub mod reviewdb;
pub mod shell_env;
pub mod state;
mod storage;
pub mod watcher;

use git::token_cache::{DEFAULT_TOKEN_CACHE_BUDGET_BYTES, SyntaxTokenCache};
use state::{CommitCache, CommitStatsCache, RepoState, ReviewStoreState, RunningOp};
use tauri::Emitter;
use tauri::Manager;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use watcher::WatcherState;

/// Report the current webview zoom so the macOS traffic lights (fixed on-screen
/// size) stay centered in the zoom-scaled top bar.
#[tauri::command]
fn set_traffic_light_zoom(window: tauri::WebviewWindow, zoom: f64) {
    #[cfg(target_os = "macos")]
    {
        macos_traffic_lights::set_zoom(zoom);
        if let Ok(ns_window) = window.ns_window() {
            macos_traffic_lights::reposition(ns_window);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, zoom);
}

/// Internal origins the webview may navigate to in-app: the Tauri/IPC schemes
/// and the dev/prod localhost origins. `trunk-asset` is intentionally excluded —
/// it is a fetchable image subresource, never a navigable document (a top-level
/// nav to an `.svg` would otherwise execute its embedded script outside the CSP).
fn is_internal_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "ipc" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("localhost") | Some("tauri.localhost") | Some("ipc.localhost")
        ),
        _ => false,
    }
}

/// Navigation guard: any off-origin link (a rendered-markdown `<a href>`, say) is
/// cancelled in-app and handed to the OS browser via the opener. This is the
/// authoritative link boundary — even if the sanitizer ever let a dangerous href
/// through, the webview still can't be navigated away from the app.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_opener::OpenerExt;
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            if is_internal_url(url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
                let _ = webview.opener().open_url(url.to_string(), None::<&str>);
            }
            false
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(navigation_guard())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_uri_scheme_protocol("trunk-asset", |ctx, request| {
            let uri = request.uri().to_string();
            match commands::markdown::resolve_trunk_asset(ctx.app_handle(), &uri) {
                Ok((bytes, mime)) => tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::OK)
                    .header(tauri::http::header::CONTENT_TYPE, mime)
                    // Custom-protocol responses don't inherit the app CSP: pin the
                    // declared MIME (no content sniffing) and neuter any script an
                    // SVG might carry, so a served asset can't execute as a document.
                    .header(tauri::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
                    .header(
                        tauri::http::header::CONTENT_SECURITY_POLICY,
                        "script-src 'none'; sandbox",
                    )
                    .body(std::borrow::Cow::Owned(bytes))
                    .expect("building a byte-body response cannot fail"),
                Err(_) => tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::NOT_FOUND)
                    .body(std::borrow::Cow::Borrowed(&b""[..]))
                    .expect("building an empty response cannot fail"),
            }
        })
        .on_window_event(|_window, _event| {
            // Live resize is handled flicker-free by the NSWindowDidResize observer
            // (see macos_traffic_lights); here we cover the other title-bar relayouts:
            // appearance change and monitor-to-monitor scale changes.
            #[cfg(target_os = "macos")]
            {
                use tauri::WindowEvent;
                if matches!(
                    _event,
                    WindowEvent::ThemeChanged(_) | WindowEvent::ScaleFactorChanged { .. }
                ) && let Ok(ns_window) = _window.ns_window()
                {
                    macos_traffic_lights::reposition(ns_window);
                }
            }
        })
        .setup(|app| {
            let find = MenuItemBuilder::with_id("find", "Find")
                .accelerator("CmdOrCtrl+F")
                .build(app)?;

            // View → Start/End Code Review menu item; emits `review-toggle` so the
            // frontend can flip review mode. No keyboard accelerator — user UAT
            // surfaced a clash with launcher-tool shortcuts (Phase 72 gap closure).
            let review_item =
                MenuItemBuilder::with_id("review-toggle", "Toggle Review Panel").build(app)?;

            let app_menu = SubmenuBuilder::new(app, "Trunk")
                .about(None)
                .separator()
                .quit()
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .separator()
                .item(&find)
                .build()?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&review_item)
                .fullscreen()
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window").minimize().build()?;

            let menu = MenuBuilder::new(app)
                .item(&app_menu)
                .item(&edit_menu)
                .item(&view_menu)
                .item(&window_menu)
                .build()?;

            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                if event.id().as_ref() == "find" {
                    let _ = app.emit("search-toggle", ());
                } else if event.id().as_ref() == "review-toggle" {
                    let _ = app.emit("review-toggle", ());
                }
            });

            // Re-inset on every live resize (flicker-free), and position once before
            // the first paint. The frontend reports the restored zoom on mount via
            // set_traffic_light_zoom; other relayouts go through on_window_event.
            #[cfg(target_os = "macos")]
            {
                macos_traffic_lights::observe_resize();
                if let Some(window) = app.get_webview_window("main")
                    && let Ok(ns_window) = window.ns_window()
                {
                    macos_traffic_lights::reposition(ns_window);
                }
            }

            Ok(())
        })
        .manage(RepoState(Default::default()))
        .manage(CommitCache(Default::default()))
        .manage(CommitStatsCache(Default::default()))
        .manage(RunningOp(Default::default()))
        .manage(WatcherState(Default::default()))
        .manage(ReviewStoreState(Default::default()))
        .manage(commands::prefs::PrefsState::default())
        .manage(commands::markdown::MarkdownDiffCache(Default::default()))
        .manage(SyntaxTokenCache::new(DEFAULT_TOKEN_CACHE_BUDGET_BYTES))
        .invoke_handler(tauri::generate_handler![
            set_traffic_light_zoom,
            commands::perf::perf_append,
            commands::perf::perf_reset,
            commands::prefs::prefs_get,
            commands::prefs::prefs_set,
            commands::repo::open_repo,
            commands::repo::close_repo,
            commands::repo::force_close_repo,
            commands::fs::validate_recent_path,
            commands::markdown::read_file_at,
            commands::markdown::render_markdown_diff,
            commands::history::get_commit_graph,
            commands::history::refresh_commit_graph,
            commands::history::get_commit_stats,
            commands::history::get_wip_diff_stats,
            commands::history::search_commits,
            commands::branches::list_refs,
            commands::branches::resolve_ref,
            commands::branches::checkout_branch,
            commands::branches::fast_forward_to,
            commands::branches::create_branch,
            commands::branches::delete_branch,
            commands::branches::rename_branch,
            commands::staging::get_dirty_counts,
            commands::staging::get_status,
            commands::staging::stage_file,
            commands::staging::unstage_file,
            commands::staging::stage_files,
            commands::staging::unstage_files,
            commands::staging::stage_all,
            commands::staging::unstage_all,
            commands::staging::discard_file,
            commands::staging::discard_all,
            commands::staging::stage_hunk,
            commands::staging::unstage_hunk,
            commands::staging::discard_hunk,
            commands::staging::stage_lines,
            commands::staging::unstage_lines,
            commands::staging::discard_lines,
            commands::commit::create_commit,
            commands::commit::amend_commit,
            commands::commit::get_head_commit_message,
            commands::diff::diff_unstaged,
            commands::diff::diff_staged,
            commands::diff::list_commit_files,
            commands::diff::diff_commit_file,
            commands::diff::warm_diff,
            commands::diff::get_commit_detail,
            commands::stash::list_stashes,
            commands::stash::stash_save,
            commands::stash::stash_pop,
            commands::stash::stash_apply,
            commands::stash::stash_drop,
            commands::review::seed_review_range,
            commands::review::add_review_commit,
            commands::review::remove_review_commit,
            commands::review::list_session_commits,
            commands::review::add_thread,
            commands::review::add_commit_thread,
            commands::review::edit_thread,
            commands::review::delete_thread,
            commands::review::add_reply,
            commands::review::edit_reply,
            commands::review::delete_reply,
            commands::review::set_thread_state,
            commands::review::list_threads,
            commands::review::list_reviews,
            commands::review::create_review,
            commands::review::get_active_review,
            commands::review::set_active_review,
            commands::review::rename_review,
            commands::review::publish_review,
            commands::review::delete_review,
            commands::review::save_draft,
            commands::review::get_draft,
            commands::review::delete_draft,
            commands::review::get_review_snapshots,
            commands::review::resolve_threads,
            commands::review::generate_review_doc,
            commands::review::ensure_review_snapshot,
            commands::review::canonical_repo_path,
            commands::commit_actions::checkout_commit,
            commands::commit_actions::create_tag,
            commands::commit_actions::delete_tag,
            commands::commit_actions::cherry_pick,
            commands::commit_actions::revert_commit_begin,
            commands::commit_actions::cherry_pick_continue,
            commands::commit_actions::cherry_pick_abort,
            commands::commit_actions::revert_continue,
            commands::commit_actions::revert_abort,
            commands::commit_actions::reset_to_commit,
            commands::commit_actions::undo_commit,
            commands::commit_actions::redo_commit,
            commands::commit_actions::check_undo_available,
            commands::remote::git_fetch,
            commands::remote::git_fetch_background,
            commands::remote::git_pull,
            commands::remote::git_push,
            commands::remote::git_push_force,
            commands::remote::get_push_target,
            commands::remote::delete_remote_branch,
            commands::remote::cancel_remote_op,
            commands::operation_state::get_operation_state,
            commands::operation_state::get_merge_message,
            commands::operation_state::merge_continue,
            commands::operation_state::merge_abort,
            commands::operation_state::rebase_continue,
            commands::operation_state::rebase_skip,
            commands::operation_state::rebase_abort,
            commands::operation_state::merge_branch_begin,
            commands::operation_state::rebase_branch,
            commands::merge_editor::get_merge_sides,
            commands::merge_editor::save_merge_result,
            commands::interactive_rebase::get_rebase_todo,
            commands::interactive_rebase::get_fork_point,
            commands::interactive_rebase::start_interactive_rebase,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

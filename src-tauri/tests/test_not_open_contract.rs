//! Every command seam resolves its repo path through `repo_path_from_state`, so
//! they all owe the frontend the same `not_open` code. `repo_path_from_state` is
//! `pub(crate)`, so this crate pins the contract one layer out, at each seam.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
use trunk_lib::commands::branches::{
    checkout_branch_inner, create_branch_inner, delete_branch_inner, fast_forward_to_inner,
    rename_branch_inner,
};
use trunk_lib::commands::commit_actions::{
    checkout_commit_inner, cherry_pick_inner, create_tag_inner, delete_tag_inner,
    reset_to_commit_inner, revert_abort_inner, revert_commit_begin_inner, revert_continue_inner,
    undo_commit_inner,
};
use trunk_lib::commands::history::refresh_commit_graph;
use trunk_lib::commands::interactive_rebase::{
    get_fork_point_inner, start_interactive_rebase_blocking,
};
use trunk_lib::commands::operation_state::{
    merge_abort_inner, merge_branch_begin_inner, merge_continue_inner, rebase_abort_inner,
    rebase_branch_inner, rebase_continue_inner, rebase_skip_inner,
};
use trunk_lib::commands::remote::{git_pull_inner, git_push_force_inner, git_push_inner};
use trunk_lib::error::TrunkError;
use trunk_lib::git::graph_input::RefVisibility;
use trunk_lib::state::{CommitCache, RefVisibilityState, RepoState};

const UNREGISTERED: &str = "/not/a/registered/repo";

fn assert_reports_not_open<T: std::fmt::Debug>(
    seam: impl Fn(&str, &HashMap<String, PathBuf>) -> Result<T, TrunkError>,
) {
    let err = seam(UNREGISTERED, &HashMap::new()).unwrap_err();

    assert_eq!(err.code, "not_open");
}

macro_rules! not_open_contract {
    ($($name:ident => $seam:expr;)*) => {
        $(
            #[test]
            fn $name() {
                assert_reports_not_open($seam);
            }
        )*
    };
}

not_open_contract! {
    merge_continue_reports_not_open_for_an_unregistered_repo =>
        |path, state| merge_continue_inner(path, None, state, &RefVisibility::default());
    merge_abort_reports_not_open_for_an_unregistered_repo =>
        |path, state| merge_abort_inner(path, state, &RefVisibility::default());
    merge_branch_begin_reports_not_open_for_an_unregistered_repo =>
        |path, state| merge_branch_begin_inner(path, "main", state, &RefVisibility::default());
    rebase_continue_reports_not_open_for_an_unregistered_repo =>
        |path, state| rebase_continue_inner(path, None, state, &RefVisibility::default());
    rebase_skip_reports_not_open_for_an_unregistered_repo =>
        |path, state| rebase_skip_inner(path, state, &RefVisibility::default());
    rebase_abort_reports_not_open_for_an_unregistered_repo =>
        |path, state| rebase_abort_inner(path, state, &RefVisibility::default());
    rebase_branch_reports_not_open_for_an_unregistered_repo =>
        |path, state| rebase_branch_inner(path, "main", state, &RefVisibility::default());
    cherry_pick_reports_not_open_for_an_unregistered_repo =>
        |path, state| cherry_pick_inner(path, "HEAD", state, &RefVisibility::default());
    revert_commit_begin_reports_not_open_for_an_unregistered_repo =>
        |path, state| revert_commit_begin_inner(path, "HEAD", state, &RefVisibility::default());
    revert_continue_reports_not_open_for_an_unregistered_repo =>
        |path, state| revert_continue_inner(path, "a message", state, &RefVisibility::default());
    revert_abort_reports_not_open_for_an_unregistered_repo =>
        |path, state| revert_abort_inner(path, state, &RefVisibility::default());
    reset_to_commit_reports_not_open_for_an_unregistered_repo =>
        |path, state| reset_to_commit_inner(path, "HEAD", "hard", state, &RefVisibility::default());
    fast_forward_to_reports_not_open_for_an_unregistered_repo =>
        |path, state| fast_forward_to_inner(path, "HEAD", state, &mut HashMap::new(), &RefVisibility::default());
    get_fork_point_reports_not_open_for_an_unregistered_repo =>
        |path, state| get_fork_point_inner(path, "main", state);
    delete_branch_reports_not_open_for_an_unregistered_repo =>
        |path, state| delete_branch_inner(path, "feature", state, &mut HashMap::new(), &RefVisibility::default());
    rename_branch_reports_not_open_for_an_unregistered_repo =>
        |path, state| rename_branch_inner(path, "feature", "renamed", state, &mut HashMap::new(), &RefVisibility::default());
    checkout_branch_reports_not_open_for_an_unregistered_repo =>
        |path, state| checkout_branch_inner(path, "feature", state, &mut HashMap::new(), &RefVisibility::default());
    create_branch_reports_not_open_for_an_unregistered_repo =>
        |path, state| create_branch_inner(path, "feature", None, state, &mut HashMap::new(), &RefVisibility::default());
    checkout_commit_reports_not_open_for_an_unregistered_repo =>
        |path, state| checkout_commit_inner(path, "HEAD", state, &RefVisibility::default());
    create_tag_reports_not_open_for_an_unregistered_repo =>
        |path, state| create_tag_inner(path, "HEAD", "v1", "a message", state, &RefVisibility::default());
    delete_tag_reports_not_open_for_an_unregistered_repo =>
        |path, state| delete_tag_inner(path, "v1", state, &RefVisibility::default());
    undo_commit_reports_not_open_for_an_unregistered_repo =>
        undo_commit_inner;
    start_interactive_rebase_reports_not_open_for_an_unregistered_repo =>
        |path, state| start_interactive_rebase_blocking(path, Some("HEAD"), &[], Path::new("/tmp"), state, &RefVisibility::default());
}

#[test]
fn git_pull_reports_not_open_for_an_unregistered_repo() {
    let app = tauri::test::mock_app();
    let cache = CommitCache(Mutex::new(HashMap::new()));
    let running = Mutex::new(HashMap::new());

    let err = tauri::async_runtime::block_on(git_pull_inner(
        UNREGISTERED,
        None,
        &HashMap::new(),
        &cache,
        &running,
        &RefVisibilityState::default(),
        app.handle(),
    ))
    .unwrap_err();

    assert_eq!(err.code, "not_open");
}

#[test]
fn git_push_reports_not_open_for_an_unregistered_repo() {
    let app = tauri::test::mock_app();
    let cache = CommitCache(Mutex::new(HashMap::new()));
    let running = Mutex::new(HashMap::new());

    let err = tauri::async_runtime::block_on(git_push_inner(
        UNREGISTERED,
        &HashMap::new(),
        &cache,
        &running,
        &RefVisibilityState::default(),
        app.handle(),
    ))
    .unwrap_err();

    assert_eq!(err.code, "not_open");
}

#[test]
fn git_push_force_reports_not_open_for_an_unregistered_repo() {
    let app = tauri::test::mock_app();
    let cache = CommitCache(Mutex::new(HashMap::new()));
    let running = Mutex::new(HashMap::new());

    let err = tauri::async_runtime::block_on(git_push_force_inner(
        UNREGISTERED,
        trunk_lib::commands::remote::ConfirmedPush {
            remote: "origin",
            branch: "main",
        },
        &HashMap::new(),
        &cache,
        &running,
        &RefVisibilityState::default(),
        app.handle(),
    ))
    .unwrap_err();

    assert_eq!(err.code, "not_open");
}

/// The `#[tauri::command]` wrappers hand the frontend a JSON string, not a
/// `TrunkError`, and that string is where `CommitGraph.svelte` reads `code` from.
#[test]
fn a_command_wrapper_carries_not_open_through_its_json() {
    let app = tauri::test::mock_app();
    app.manage(RepoState(Mutex::new(HashMap::new())));
    app.manage(CommitCache(Mutex::new(HashMap::new())));
    app.manage(RefVisibilityState::default());

    let json = tauri::async_runtime::block_on(refresh_commit_graph(
        UNREGISTERED.to_owned(),
        0,
        app.state(),
        app.state(),
        app.state(),
    ))
    .unwrap_err();

    let payload: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(payload["code"], "not_open");
}

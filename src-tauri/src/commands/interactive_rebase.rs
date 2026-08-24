use crate::error::TrunkError;
use crate::git::{graph, types::RebaseTodoItem};
use crate::shell_env;
use crate::state::{CommitCache, RepoState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RebaseTodoAction {
    pub oid: String,
    pub action: String, // "pick", "squash", "reword", "drop"
    pub summary: String,
    pub new_message: Option<String>,
}

/// The listing and the base it was built from, so a rebase started from this
/// listing cannot pick the commit it replays onto. `base_oid` is `None` when the
/// clicked commit is the repository root, which rebases from `--root`.
#[derive(Debug, Serialize)]
pub struct RebaseTodo {
    pub base_oid: Option<String>,
    pub items: Vec<RebaseTodoItem>,
}

pub fn get_rebase_todo_inner(
    path: &str,
    base_oid: &str,
    inclusive: bool,
    state_map: &HashMap<String, PathBuf>,
) -> Result<RebaseTodo, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;

    let base =
        git2::Oid::from_str(base_oid).map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;

    let mut revwalk = repo.revwalk().map_err(TrunkError::from)?;
    revwalk
        .set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(TrunkError::from)?;
    revwalk.push_head().map_err(TrunkError::from)?;

    let resolved_base = if inclusive {
        let commit = repo.find_commit(base).map_err(TrunkError::from)?;
        if commit.parent_count() == 0 {
            None
        } else {
            let parent = commit.parent_id(0).map_err(TrunkError::from)?;
            revwalk.hide(parent).map_err(TrunkError::from)?;
            Some(parent)
        }
    } else {
        revwalk.hide(base).map_err(TrunkError::from)?;
        Some(base)
    };

    let mut items: Vec<RebaseTodoItem> = Vec::new();
    for oid_result in revwalk {
        let oid = oid_result.map_err(TrunkError::from)?;
        let commit = repo.find_commit(oid).map_err(TrunkError::from)?;
        let oid_str = oid.to_string();
        let short_oid = oid_str.chars().take(7).collect();
        let summary = commit.summary().ok().flatten().unwrap_or("").to_owned();
        let author_name = commit.author().name().unwrap_or("").to_owned();
        let author_timestamp = commit.time().seconds();

        items.push(RebaseTodoItem {
            oid: oid_str,
            short_oid,
            summary,
            author_name,
            author_timestamp,
        });
    }

    // Revwalk returns newest-first; rebase todo needs oldest-first
    items.reverse();

    Ok(RebaseTodo {
        base_oid: resolved_base.map(|oid| oid.to_string()),
        items,
    })
}

pub fn get_fork_point_inner(
    path: &str,
    branch: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<String, TrunkError> {
    let path_buf = crate::commands::repo_path_from_state(path, state_map)?;

    let output = std::process::Command::new("git")
        .args(["merge-base", "--", branch, "HEAD"])
        .current_dir(path_buf)
        .env("PATH", shell_env::system_path())
        .output()
        .map_err(|e| TrunkError::new("fork_point_error", e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(TrunkError::new("fork_point_error", stderr.to_string()));
    }

    let oid = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Ok(oid)
}

/// How a started rebase ended. `Stopped` is a pause the staging panel's banner
/// owns, not a failure, so it stays on the `Ok` path and keeps the graph insert
/// and the `repo-changed` emit the conflict-resolution UI needs.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RebaseStartResult {
    Completed,
    Stopped,
}

pub fn start_interactive_rebase_blocking(
    path: &str,
    base_oid: Option<&str>,
    todo_items: &[RebaseTodoAction],
    session_dir: &std::path::Path,
    state_map: &HashMap<String, PathBuf>,
) -> Result<(crate::git::types::GraphResult, RebaseStartResult), TrunkError> {
    let path_buf = crate::commands::repo_path_from_state(path, state_map)?;

    // 1. Write todo file (drop = omit from list, not the 'drop' keyword)
    let todo_path = session_dir.join("trunk-rebase-todo");
    let todo_content: String = todo_items
        .iter()
        .filter(|item| item.action != "drop")
        .map(|item| format!("{} {} {}", item.action, item.oid, item.summary))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    std::fs::write(&todo_path, &todo_content)
        .map_err(|e| TrunkError::new("io_error", e.to_string()))?;

    // 2. Write GIT_SEQUENCE_EDITOR script (script file for reliable $1 handling)
    let seq_editor_path = session_dir.join("trunk-seq-editor.sh");
    // T-75-T04 parity: POSIX single-quote the path so $TMPDIR-controlled `"` or `'` cannot
    // terminate the quoted segment. Shared helper lives in `git::editor`.
    let seq_editor_script = format!(
        "#!/bin/sh\ncp {} \"$1\"\n",
        crate::git::editor::shell_single_quote(&todo_path.display().to_string()),
    );
    std::fs::write(&seq_editor_path, &seq_editor_script)
        .map_err(|e| TrunkError::new("io_error", e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&seq_editor_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| TrunkError::new("io_error", e.to_string()))?;
    }

    // 3. File each pre-edited message under the commit git will name when it opens
    //    the editor. These live in the repository's git dir rather than the session
    //    dir, because a rebase that stops on a conflict outlives this call and
    //    `rebase --continue` still has messages left to deliver.
    let msg_dir = {
        let repo = git2::Repository::open(path_buf)?;
        repo.path().join(crate::git::editor::MESSAGE_DIR)
    };
    // Clearing first is load-bearing: a message left over from an earlier rebase is
    // named for a commit this one could touch without editing.
    let _ = std::fs::remove_dir_all(&msg_dir);
    let bindings = message_bindings(todo_items);
    if !bindings.is_empty() {
        std::fs::create_dir_all(&msg_dir)
            .map_err(|e| TrunkError::new("io_error", e.to_string()))?;
        for (oid, message) in &bindings {
            std::fs::write(msg_dir.join(oid), message)
                .map_err(|e| TrunkError::new("io_error", e.to_string()))?;
        }
    }

    // 4. The editor that reads them, keyed by the commit git is working on.
    let editor = crate::git::editor::keyed_rebase_editor()?;

    // 5. Run git rebase -i (blocking — waits for completion)
    let mut args = vec!["rebase", "-i"];
    match base_oid {
        Some(base) => args.extend(["--", base]),
        None => args.push("--root"),
    }

    let output = std::process::Command::new("git")
        .args(&args)
        .current_dir(path_buf)
        .env("PATH", shell_env::system_path())
        .env("GIT_SEQUENCE_EDITOR", seq_editor_path.to_str().unwrap())
        .env("GIT_EDITOR", editor.script_path())
        .output()
        .map_err(|e| TrunkError::new("rebase_error", e.to_string()))?;

    // 6. Handle result
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        // Conflicts leave the repo in rebase-in-progress state — that's expected
        if !stderr.to_lowercase().contains("conflict")
            && !stderr.to_lowercase().contains("could not apply")
        {
            return Err(TrunkError::new("rebase_error", stderr));
        }
    }

    let mut repo = git2::Repository::open(path_buf)?;
    let rebase_still_running = repo.path().join("rebase-merge").exists();
    if !rebase_still_running {
        let _ = std::fs::remove_dir_all(&msg_dir);
    }

    let graph = graph::walk_commits(&mut repo, 0, usize::MAX)?;

    Ok((graph, RebaseStartResult::Completed))
}

/// Which commit gets which pre-edited message.
///
/// `git rebase -i` opens the editor once per reword, and once per *run* of
/// squashes — at the run's last item, whatever the run's length. It opens it not
/// at all for an item that turns out empty and gets skipped. So a message belongs
/// to a commit, never to a position in a queue.
///
/// Within a run, the winning message is the last squash the user actually edited;
/// a run nobody edited binds nothing and keeps git's combined default. A reword
/// heading a run keeps its own message for its own invocation and does not carry
/// it into the run, whose default is built on the reworded text anyway.
fn message_bindings(todo_items: &[RebaseTodoAction]) -> Vec<(String, String)> {
    let mut bindings: Vec<(String, String)> = Vec::new();
    let mut run_last_oid: Option<String> = None;
    let mut run_message: Option<String> = None;

    for item in todo_items.iter().filter(|i| i.action != "drop") {
        if item.action == "squash" {
            run_last_oid = Some(item.oid.clone());
            if let Some(new_msg) = item.new_message.clone() {
                run_message = Some(new_msg);
            }
            continue;
        }

        if let (Some(oid), Some(message)) = (run_last_oid.take(), run_message.take()) {
            bindings.push((oid, message));
        }

        if item.action == "reword"
            && let Some(new_msg) = item.new_message.clone()
        {
            bindings.push((item.oid.clone(), new_msg));
        }
    }

    if let (Some(oid), Some(message)) = (run_last_oid, run_message) {
        bindings.push((oid, message));
    }

    bindings
}

#[tauri::command]
pub async fn get_rebase_todo(
    path: String,
    base_oid: String,
    inclusive: Option<bool>,
    state: State<'_, RepoState>,
) -> Result<RebaseTodo, String> {
    let state_map = state.0.lock().unwrap().clone();
    let incl = inclusive.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        get_rebase_todo_inner(&path, &base_oid, incl, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e: TrunkError| e.to_json())
}

#[tauri::command]
pub async fn get_fork_point(
    path: String,
    branch: String,
    state: State<'_, RepoState>,
) -> Result<String, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || get_fork_point_inner(&path, &branch, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e: TrunkError| e.to_json())
}

/// One scratch directory per invocation, removed when this value drops.
///
/// Keying it by process id shared it across every concurrent rebase in an app
/// whose RepoState holds many repositories: a second todo write replaced the
/// first while git may not have read it yet, and whichever rebase finished
/// first deleted the other's editor scripts mid-run. Dropping rather than an
/// explicit remove also covers the early returns, which leaked an executable
/// script directory at a guessable path.
fn new_session_dir() -> Result<tempfile::TempDir, TrunkError> {
    tempfile::Builder::new()
        .prefix("trunk-rebase-")
        .tempdir()
        .map_err(|e| TrunkError::new("io_error", e.to_string()))
}

#[tauri::command]
pub async fn start_interactive_rebase(
    path: String,
    base_oid: Option<String>,
    todo_items: Vec<RebaseTodoAction>,
    state: State<'_, RepoState>,
    cache: State<'_, CommitCache>,
    app: AppHandle,
) -> Result<RebaseStartResult, String> {
    let state_map = state.0.lock().unwrap().clone();
    let path_clone = path.clone();

    let session = new_session_dir().map_err(|e| e.to_json())?;
    let session_dir = session.path().to_path_buf();

    let (graph_result, outcome) = tauri::async_runtime::spawn_blocking(move || {
        start_interactive_rebase_blocking(
            &path_clone,
            base_oid.as_deref(),
            &todo_items,
            &session_dir,
            &state_map,
        )
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e: TrunkError| e.to_json())?;

    cache.0.lock().unwrap().insert(path.clone(), graph_result);
    let _ = app.emit("repo-changed", path);
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(oid: &str, action: &str, new_message: Option<&str>) -> RebaseTodoAction {
        RebaseTodoAction {
            oid: oid.to_string(),
            action: action.to_string(),
            summary: "summary".to_string(),
            new_message: new_message.map(str::to_string),
        }
    }

    #[test]
    fn a_reword_binds_its_message_to_its_own_commit() {
        let bindings = message_bindings(&[
            item("aaa", "pick", None),
            item("bbb", "reword", Some("New title")),
        ]);

        assert_eq!(bindings, vec![("bbb".to_string(), "New title".to_string())]);
    }

    #[test]
    fn a_squash_run_binds_one_message_to_the_commit_git_opens_the_editor_for() {
        // Git opens the editor once for the whole run, at its last item.
        let bindings = message_bindings(&[
            item("aaa", "pick", None),
            item("bbb", "squash", Some("Combined A")),
            item("ccc", "squash", Some("Combined B")),
        ]);

        assert_eq!(
            bindings,
            vec![("ccc".to_string(), "Combined B".to_string())]
        );
    }

    #[test]
    fn a_squash_run_keeps_the_last_edited_message_even_when_later_squashes_have_none() {
        let bindings = message_bindings(&[
            item("aaa", "pick", None),
            item("bbb", "squash", Some("Combined A")),
            item("ccc", "squash", None),
        ]);

        assert_eq!(
            bindings,
            vec![("ccc".to_string(), "Combined A".to_string())]
        );
    }

    #[test]
    fn an_unedited_squash_run_binds_nothing_and_keeps_gits_default() {
        let bindings = message_bindings(&[item("aaa", "pick", None), item("bbb", "squash", None)]);

        assert!(bindings.is_empty(), "got {bindings:?}");
    }

    #[test]
    fn a_reword_heading_a_run_keeps_its_message_for_its_own_invocation() {
        let bindings = message_bindings(&[
            item("aaa", "reword", Some("Reworded head")),
            item("bbb", "squash", None),
        ]);

        assert_eq!(
            bindings,
            vec![("aaa".to_string(), "Reworded head".to_string())],
            "the run's own default is built on the reworded text, so nothing carries into it"
        );
    }

    #[test]
    fn a_squash_without_a_message_cannot_take_a_later_rewords_message() {
        let bindings = message_bindings(&[
            item("aaa", "pick", None),
            item("bbb", "squash", None),
            item("ccc", "reword", Some("New title")),
        ]);

        assert_eq!(bindings, vec![("ccc".to_string(), "New title".to_string())]);
    }

    #[test]
    fn dropped_items_bind_nothing() {
        let bindings = message_bindings(&[
            item("aaa", "pick", None),
            item("bbb", "drop", Some("Never applied")),
            item("ccc", "reword", Some("New title")),
        ]);

        assert_eq!(bindings, vec![("ccc".to_string(), "New title".to_string())]);
    }

    #[test]
    fn each_rebase_gets_its_own_scratch_directory() {
        let first = new_session_dir().unwrap();
        let second = new_session_dir().unwrap();

        assert_ne!(first.path(), second.path());
    }

    #[test]
    fn the_scratch_directory_goes_away_when_the_rebase_ends() {
        let path = {
            let session = new_session_dir().unwrap();
            assert!(session.path().exists());
            session.path().to_path_buf()
        };

        assert!(
            !path.exists(),
            "a rebase that returns early must not leak its executable editor scripts"
        );
    }
}

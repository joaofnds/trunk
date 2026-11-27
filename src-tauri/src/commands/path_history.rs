use crate::state::{CommitCache, OpenRepos, RepoState};
use crate::types::GitPath;
use git2::{Commit, ObjectType, Oid, Repository, Tree};
use serde::Serialize;
use tauri::State;
use trunk_git::error::TrunkError;
use trunk_git::graph_input::GraphSnapshot;

// Bound even a search that finds nothing. Closing the picker abandons at most one chunk.
const COMMITS_PER_READ: usize = 128;
const MATCHES_PER_READ: usize = 32;

#[derive(Debug, Serialize)]
pub struct PathHistoryRow {
    pub oid: String,
    pub summary: String,
}

#[derive(Debug, Serialize)]
pub struct PathHistoryPage {
    pub commits: Vec<PathHistoryRow>,
    pub next: Option<usize>,
    pub revision: u64,
}

fn file_entry<'repo>(
    repo: &'repo Repository,
    mut tree: Tree<'repo>,
    path: &[u8],
) -> Result<Option<(Oid, i32)>, git2::Error> {
    let mut parts = path.split(|byte| *byte == b'/');
    let name = parts.next_back().unwrap_or_default();
    for dir in parts {
        let subtree = tree
            .get_name_bytes(dir)
            .filter(|entry| entry.kind() == Some(ObjectType::Tree))
            .map(|entry| entry.id());
        let Some(subtree) = subtree else {
            return Ok(None);
        };
        tree = repo.find_tree(subtree)?;
    }
    Ok(tree
        .get_name_bytes(name)
        .filter(|entry| entry.kind() != Some(ObjectType::Tree))
        .map(|entry| (entry.id(), entry.filemode())))
}

// Match the first-parent comparison used when opening the result. Tree entries
// capture edits and mode changes without reading blob contents or constructing patches.
fn touches_path(repo: &Repository, commit: &Commit<'_>, path: &[u8]) -> Result<bool, git2::Error> {
    let tree = commit.tree()?;
    if commit.parent_count() == 0 {
        return Ok(file_entry(repo, tree, path)?.is_some());
    }
    let parent = commit.parent(0)?;
    if parent.tree_id() == tree.id() {
        return Ok(false);
    }
    Ok(file_entry(repo, tree, path)? != file_entry(repo, parent.tree()?, path)?)
}

/// Search one bounded slice of a captured graph, returning the offset to resume.
///
/// # Errors
/// Returns a repository or object-read error if the snapshot cannot be inspected.
///
/// # Panics
/// The captured graph requires facts for every visible OID.
pub fn path_history_inner(
    repos: &OpenRepos,
    repo_path: &str,
    graph: &GraphSnapshot,
    file_path: &[u8],
    offset: usize,
    revision: u64,
) -> Result<PathHistoryPage, TrunkError> {
    let repo = repos.open(repo_path)?;
    if file_path.contains(&0) {
        return Err(TrunkError::new(
            "invalid_path",
            "Git paths cannot contain NUL",
        ));
    }
    let oids = graph.oids();
    let mut cursor = offset.min(oids.len());
    let end = cursor.saturating_add(COMMITS_PER_READ).min(oids.len());
    let mut commits = Vec::new();
    while cursor < end && commits.len() < MATCHES_PER_READ {
        let oid = oids[cursor];
        cursor += 1;
        let commit = repo.find_commit(oid)?;
        if touches_path(&repo, &commit, file_path)? {
            commits.push(PathHistoryRow {
                oid: oid.to_string(),
                summary: graph.captured_commits()[&oid].summary.clone(),
            });
        }
    }
    Ok(PathHistoryPage {
        commits,
        next: (cursor < oids.len()).then_some(cursor),
        revision,
    })
}

/// A bounded scan of the visible graph for changes to this exact Git path.
///
/// # Errors
/// Returns the repository, object-read or graph-revision error to the picker.
#[tauri::command]
pub async fn path_history(
    activity: crate::activity::Activity,
    path: String,
    file_path: GitPath,
    offset: usize,
    revision: Option<u64>,
    cache: State<'_, CommitCache>,
    state: State<'_, RepoState>,
) -> Result<PathHistoryPage, String> {
    let (graph, version) = cache
        .read_versioned(&path, revision, |graph, version| (graph.clone(), version))
        .map_err(|e| e.to_json())?;
    let repos: OpenRepos = state.snapshot();
    let repo_path = path.clone();
    let page = activity
        .spawn_blocking(move || {
            path_history_inner(
                &repos,
                &repo_path,
                &graph,
                file_path.as_ref(),
                offset,
                version.revision,
            )
        })
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())?;
    cache
        .require_revision(&path, version.revision)
        .map_err(|e| e.to_json())?;
    Ok(page)
}

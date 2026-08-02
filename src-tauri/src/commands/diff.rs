// Diff commands — Phase 6 implementation

use crate::error::TrunkError;
use crate::git::syntax;
use crate::git::types::{
    CommitDetail, DiffHunk, DiffLine, DiffOrigin, DiffRequestOptions, DiffStatus, FileDiff,
    WordSpan,
};
use crate::state::RepoState;
use similar::{ChangeTag, TextDiff};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::State;

pub(crate) fn is_head_unborn(repo: &git2::Repository) -> bool {
    match repo.head() {
        Err(e) => e.code() == git2::ErrorCode::UnbornBranch,
        Ok(_) => false,
    }
}

fn apply_request_options(opts: &mut git2::DiffOptions, req: &DiffRequestOptions) {
    let context = if req.show_full_file {
        100_000 // practical cap for full-file view
    } else {
        req.context_lines
    };
    opts.context_lines(context);
    opts.ignore_whitespace(req.ignore_whitespace);
}

/// Compute word spans for a paired delete/add line.
/// Returns (delete_spans, add_spans) — byte-offset ranges of the *changed* words,
/// each flagged `emphasized`. A word-level diff (`from_words`) is used so only the
/// words that actually differ are emphasized; a line-level diff would treat the
/// single line as one token and emphasize the whole line.
fn compute_word_spans_for_pair(
    old_content: &str,
    new_content: &str,
) -> (Vec<WordSpan>, Vec<WordSpan>) {
    let diff = TextDiff::from_unicode_words(old_content, new_content);
    let mut del_spans = Vec::new();
    let mut add_spans = Vec::new();
    let mut del_offset: u32 = 0;
    let mut add_offset: u32 = 0;

    for change in diff.iter_all_changes() {
        let len = change.value().len() as u32;
        match change.tag() {
            ChangeTag::Delete => {
                if len > 0 {
                    del_spans.push(WordSpan {
                        start: del_offset,
                        end: del_offset + len,
                        emphasized: true,
                    });
                }
                del_offset += len;
            }
            ChangeTag::Insert => {
                if len > 0 {
                    add_spans.push(WordSpan {
                        start: add_offset,
                        end: add_offset + len,
                        emphasized: true,
                    });
                }
                add_offset += len;
            }
            ChangeTag::Equal => {
                del_offset += len;
                add_offset += len;
            }
        }
    }

    (del_spans, add_spans)
}

/// Compute word spans for all paired Delete/Add lines within a hunk.
/// Returns a Vec parallel to `lines`, each entry being the word_spans for that line index.
/// Pairs consecutive Delete runs with following Add runs positionally (D-03, D-04).
/// Skips lines over 500 chars (WORD-02) and dissimilar pairs with ratio < 0.4 (WORD-02).
fn compute_word_spans_for_hunk(lines: &[DiffLine]) -> Vec<Vec<WordSpan>> {
    let mut word_spans: Vec<Vec<WordSpan>> = vec![Vec::new(); lines.len()];
    let mut i = 0;
    while i < lines.len() {
        // Find start of a Delete run
        if !matches!(lines[i].origin, DiffOrigin::Delete) {
            i += 1;
            continue;
        }

        // Collect consecutive Deletes
        let del_start = i;
        while i < lines.len() && matches!(lines[i].origin, DiffOrigin::Delete) {
            i += 1;
        }
        let del_end = i;

        // Collect consecutive Adds following the Deletes
        let add_start = i;
        while i < lines.len() && matches!(lines[i].origin, DiffOrigin::Add) {
            i += 1;
        }
        let add_end = i;

        // Pair positionally
        let pairs = (del_end - del_start).min(add_end - add_start);

        // Skip word diff entirely for large change blocks (likely a rewrite)
        if pairs > 40 {
            continue;
        }

        for p in 0..pairs {
            let del_idx = del_start + p;
            let add_idx = add_start + p;

            let del_content = &lines[del_idx].content;
            let add_content = &lines[add_idx].content;

            // Length threshold (WORD-02): skip lines over 500 chars
            if del_content.len() > 500 || add_content.len() > 500 {
                continue;
            }

            // Quick dissimilarity check: skip if lengths differ by >3x
            // or if character overlap is too low (cheap O(n) check vs O(n*m) from_chars)
            let (short, long) = if del_content.len() <= add_content.len() {
                (del_content.len(), add_content.len())
            } else {
                (add_content.len(), del_content.len())
            };
            if short == 0 || long > short * 3 {
                continue;
            }
            // Count shared characters as a cheap similarity proxy
            let mut del_chars = [0u16; 128];
            let mut shared = 0usize;
            for &b in del_content.as_bytes() {
                if (b as usize) < 128 {
                    del_chars[b as usize] = del_chars[b as usize].saturating_add(1);
                }
            }
            for &b in add_content.as_bytes() {
                if (b as usize) < 128 && del_chars[b as usize] > 0 {
                    del_chars[b as usize] -= 1;
                    shared += 1;
                }
            }
            // If less than 40% of chars are shared, lines are too dissimilar
            if shared * 5 < long * 2 {
                continue;
            }

            let (del_ws, add_ws) = compute_word_spans_for_pair(del_content, add_content);
            word_spans[del_idx] = del_ws;
            word_spans[add_idx] = add_ws;
        }
    }
    word_spans
}

/// Collect diff lines from git2 and enrich with syntax highlighting + word-level diff.
/// Single pass: git2 walk → word diff → syntax → merge spans. Returns complete data.
fn walk_diff(diff: git2::Diff<'_>) -> Result<Vec<FileDiff>, TrunkError> {
    use std::cell::RefCell;

    let file_diffs: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());

    diff.foreach(
        &mut |delta, _progress| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let is_binary = delta.old_file().is_binary() || delta.new_file().is_binary();
            let status = match delta.status() {
                git2::Delta::Added => DiffStatus::Added,
                git2::Delta::Deleted => DiffStatus::Deleted,
                git2::Delta::Modified => DiffStatus::Modified,
                git2::Delta::Renamed => DiffStatus::Renamed,
                git2::Delta::Copied => DiffStatus::Copied,
                git2::Delta::Untracked => DiffStatus::Untracked,
                _ => DiffStatus::Unknown,
            };
            file_diffs.borrow_mut().push(FileDiff {
                path,
                status,
                is_binary,
                hunks: Vec::new(),
            });
            true
        },
        None, // skip binary callbacks
        Some(&mut |_delta, hunk| {
            if let Some(fd) = file_diffs.borrow_mut().last_mut() {
                fd.hunks.push(DiffHunk {
                    header: String::from_utf8_lossy(hunk.header()).into_owned(),
                    old_start: hunk.old_start(),
                    old_lines: hunk.old_lines(),
                    new_start: hunk.new_start(),
                    new_lines: hunk.new_lines(),
                    lines: Vec::new(),
                });
            }
            true
        }),
        Some(&mut |_delta, _hunk, line| {
            let origin = match line.origin() {
                '+' => DiffOrigin::Add,
                '-' => DiffOrigin::Delete,
                _ => DiffOrigin::Context,
            };
            let content = String::from_utf8_lossy(line.content()).into_owned();
            let mut diffs = file_diffs.borrow_mut();
            if let Some(fd) = diffs.last_mut()
                && let Some(hunk) = fd.hunks.last_mut()
            {
                hunk.lines.push(DiffLine {
                    origin,
                    content,
                    old_lineno: line.old_lineno(),
                    new_lineno: line.new_lineno(),
                    spans: vec![],
                });
            }
            true
        }),
    )
    .map_err(TrunkError::from)?;

    let mut file_diffs = file_diffs.into_inner();
    enrich_file_diffs(&mut file_diffs);
    Ok(file_diffs)
}

/// Enrich file diffs with word-level diff spans and syntax highlighting.
/// Creates ONE highlighter per file (not per line) for dramatically better performance.
pub fn enrich_file_diffs(file_diffs: &mut [FileDiff]) {
    for fd in file_diffs.iter_mut() {
        let ext = syntax::extension_from_path(&fd.path);
        let mut highlighter = syntax::create_highlighter(ext);
        for hunk in &mut fd.hunks {
            let word_spans_per_line = compute_word_spans_for_hunk(&hunk.lines);
            for (i, line) in hunk.lines.iter_mut().enumerate() {
                let ws = &word_spans_per_line[i];
                let syntax_tokens = if let Some(ref mut hl) = highlighter {
                    syntax::highlight_line_with(hl, &line.content)
                } else {
                    vec![]
                };
                if !syntax_tokens.is_empty() || !ws.is_empty() {
                    line.spans = syntax::merge_spans(&syntax_tokens, ws, line.content.len() as u32);
                }
            }
        }
    }
}

/// Raw walk without enrichment — exposed for benchmarking only.
#[doc(hidden)]
pub fn walk_diff_raw_for_bench(diff: git2::Diff<'_>) -> Result<Vec<FileDiff>, TrunkError> {
    use std::cell::RefCell;
    let file_diffs: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());
    diff.foreach(
        &mut |delta, _progress| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let is_binary = delta.old_file().is_binary() || delta.new_file().is_binary();
            let status = match delta.status() {
                git2::Delta::Added => DiffStatus::Added,
                git2::Delta::Deleted => DiffStatus::Deleted,
                git2::Delta::Modified => DiffStatus::Modified,
                git2::Delta::Renamed => DiffStatus::Renamed,
                git2::Delta::Copied => DiffStatus::Copied,
                git2::Delta::Untracked => DiffStatus::Untracked,
                _ => DiffStatus::Unknown,
            };
            file_diffs.borrow_mut().push(FileDiff {
                path,
                status,
                is_binary,
                hunks: Vec::new(),
            });
            true
        },
        None,
        Some(&mut |_delta, hunk| {
            if let Some(fd) = file_diffs.borrow_mut().last_mut() {
                fd.hunks.push(DiffHunk {
                    header: String::from_utf8_lossy(hunk.header()).into_owned(),
                    old_start: hunk.old_start(),
                    old_lines: hunk.old_lines(),
                    new_start: hunk.new_start(),
                    new_lines: hunk.new_lines(),
                    lines: Vec::new(),
                });
            }
            true
        }),
        Some(&mut |_delta, _hunk, line| {
            let origin = match line.origin() {
                '+' => DiffOrigin::Add,
                '-' => DiffOrigin::Delete,
                _ => DiffOrigin::Context,
            };
            let content = String::from_utf8_lossy(line.content()).into_owned();
            let mut diffs = file_diffs.borrow_mut();
            if let Some(fd) = diffs.last_mut()
                && let Some(hunk) = fd.hunks.last_mut()
            {
                hunk.lines.push(DiffLine {
                    origin,
                    content,
                    old_lineno: line.old_lineno(),
                    new_lineno: line.new_lineno(),
                    spans: vec![],
                });
            }
            true
        }),
    )
    .map_err(TrunkError::from)?;
    Ok(file_diffs.into_inner())
}

/// Diff unstaged changes without enrichment — for benchmarking.
#[doc(hidden)]
pub fn diff_unstaged_raw_for_bench(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
    options: &DiffRequestOptions,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file_path);
    opts.disable_pathspec_match(true);
    apply_request_options(&mut opts, options);
    let diff = repo.diff_index_to_workdir(None, Some(&mut opts))?;
    walk_diff_raw_for_bench(diff)
}

pub fn diff_unstaged_inner(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
    options: &DiffRequestOptions,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file_path);
    opts.disable_pathspec_match(true);
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.show_untracked_content(true);
    apply_request_options(&mut opts, options);
    let diff = repo.diff_index_to_workdir(None, Some(&mut opts))?;
    walk_diff(diff)
}

pub fn diff_staged_inner(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
    options: &DiffRequestOptions,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file_path);
    opts.disable_pathspec_match(true);
    apply_request_options(&mut opts, options);
    let diff = if is_head_unborn(&repo) {
        repo.diff_tree_to_index(None, None, Some(&mut opts))?
    } else {
        let head_tree = repo.head()?.peel_to_tree()?;
        repo.diff_tree_to_index(Some(&head_tree), None, Some(&mut opts))?
    };
    walk_diff(diff)
}

pub fn diff_commit_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
    options: &DiffRequestOptions,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let oid =
        git2::Oid::from_str(oid).map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
    let commit = repo.find_commit(oid)?;
    let commit_tree = commit.tree()?;
    let mut opts = git2::DiffOptions::new();
    apply_request_options(&mut opts, options);
    let diff = if commit.parent_count() == 0 {
        repo.diff_tree_to_tree(None, Some(&commit_tree), Some(&mut opts))?
    } else {
        let parent_tree = commit.parent(0)?.tree()?;
        repo.diff_tree_to_tree(Some(&parent_tree), Some(&commit_tree), Some(&mut opts))?
    };
    walk_diff(diff)
}

/// Lightweight commit file listing — returns only metadata (path, status, is_binary),
/// no hunks/lines/spans. Used for the commit detail sidebar file list.
pub fn list_commit_files_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let oid =
        git2::Oid::from_str(oid).map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
    let commit = repo.find_commit(oid)?;
    let commit_tree = commit.tree()?;
    let opts = git2::DiffOptions::new();
    let diff = if commit.parent_count() == 0 {
        repo.diff_tree_to_tree(None, Some(&commit_tree), Some(&mut { opts }))?
    } else {
        let parent_tree = commit.parent(0)?.tree()?;
        repo.diff_tree_to_tree(Some(&parent_tree), Some(&commit_tree), Some(&mut { opts }))?
    };

    let mut file_diffs = Vec::new();
    for delta_idx in 0..diff.deltas().len() {
        let delta = diff.get_delta(delta_idx).unwrap();
        let file_path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_binary = delta.old_file().is_binary() || delta.new_file().is_binary();
        let status = match delta.status() {
            git2::Delta::Added => DiffStatus::Added,
            git2::Delta::Deleted => DiffStatus::Deleted,
            git2::Delta::Modified => DiffStatus::Modified,
            git2::Delta::Renamed => DiffStatus::Renamed,
            git2::Delta::Copied => DiffStatus::Copied,
            git2::Delta::Untracked => DiffStatus::Untracked,
            _ => DiffStatus::Unknown,
        };
        file_diffs.push(FileDiff {
            path: file_path,
            status,
            is_binary,
            hunks: Vec::new(),
        });
    }
    Ok(file_diffs)
}

/// Diff a single file from a commit — used when user clicks a file in commit detail.
pub fn diff_commit_file_inner(
    path: &str,
    oid: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
    options: &DiffRequestOptions,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let oid =
        git2::Oid::from_str(oid).map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
    let commit = repo.find_commit(oid)?;
    let commit_tree = commit.tree()?;
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file_path);
    opts.disable_pathspec_match(true);
    apply_request_options(&mut opts, options);
    let diff = if commit.parent_count() == 0 {
        repo.diff_tree_to_tree(None, Some(&commit_tree), Some(&mut opts))?
    } else {
        let parent_tree = commit.parent(0)?.tree()?;
        repo.diff_tree_to_tree(Some(&parent_tree), Some(&commit_tree), Some(&mut opts))?
    };
    walk_diff(diff)
}

pub fn get_commit_detail_inner(
    path: &str,
    oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<CommitDetail, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let oid =
        git2::Oid::from_str(oid).map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
    let commit = repo.find_commit(oid)?;
    let author = commit.author();
    let committer = commit.committer();
    Ok(CommitDetail {
        oid: commit.id().to_string(),
        short_oid: commit.id().to_string()[..7].to_owned(),
        summary: commit.summary().ok().flatten().unwrap_or("").to_owned(),
        body: commit.body().ok().flatten().map(str::to_owned),
        author_name: author.name().unwrap_or("").to_owned(),
        author_email: author.email().unwrap_or("").to_owned(),
        author_timestamp: author.when().seconds(),
        committer_name: committer.name().unwrap_or("").to_owned(),
        committer_email: committer.email().unwrap_or("").to_owned(),
        committer_timestamp: committer.when().seconds(),
        parent_oids: commit.parent_ids().map(|id| id.to_string()).collect(),
    })
}

#[tauri::command]
pub async fn diff_unstaged(
    path: String,
    file_path: String,
    options: DiffRequestOptions,
    state: State<'_, RepoState>,
) -> Result<Vec<FileDiff>, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        diff_unstaged_inner(&path, &file_path, &state_map, &options)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn diff_staged(
    path: String,
    file_path: String,
    options: DiffRequestOptions,
    state: State<'_, RepoState>,
) -> Result<Vec<FileDiff>, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        diff_staged_inner(&path, &file_path, &state_map, &options)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn list_commit_files(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
) -> Result<Vec<FileDiff>, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || list_commit_files_inner(&path, &oid, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn diff_commit_file(
    path: String,
    oid: String,
    file_path: String,
    options: DiffRequestOptions,
    state: State<'_, RepoState>,
) -> Result<Vec<FileDiff>, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        diff_commit_file_inner(&path, &oid, &file_path, &state_map, &options)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn get_commit_detail(
    path: String,
    oid: String,
    state: State<'_, RepoState>,
) -> Result<CommitDetail, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || get_commit_detail_inner(&path, &oid, &state_map))
        .await
        .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
        .map_err(|e| e.to_json())
}

#[cfg(test)]
mod word_span_tests {
    use super::*;

    fn emphasized(content: &str, spans: &[WordSpan]) -> Vec<String> {
        spans
            .iter()
            .filter(|s| s.emphasized)
            .map(|s| content[s.start as usize..s.end as usize].to_string())
            .collect()
    }

    #[test]
    fn emphasizes_only_the_changed_word() {
        let old = "expect(cat.permissions.length).toBe(64);";
        let new = "expect(cat.permissions.length).toBe(63);";

        let (del, add) = compute_word_spans_for_pair(old, new);

        assert_eq!(emphasized(old, &del), vec!["64"]);
        assert_eq!(emphasized(new, &add), vec!["63"]);
    }

    #[test]
    fn emphasizes_nothing_for_identical_lines() {
        let line = "let total = sum(values);";

        let (del, add) = compute_word_spans_for_pair(line, line);

        assert!(emphasized(line, &del).is_empty());
        assert!(emphasized(line, &add).is_empty());
    }

    #[test]
    fn emphasizes_each_changed_word_independently() {
        let old = "const a = foo(1);";
        let new = "const b = foo(2);";

        let (del, add) = compute_word_spans_for_pair(old, new);

        assert_eq!(emphasized(old, &del), vec!["a", "1"]);
        assert_eq!(emphasized(new, &add), vec!["b", "2"]);
    }
}

#[cfg(test)]
mod enrich_tests {
    use super::*;

    fn line(origin: DiffOrigin, content: &str) -> DiffLine {
        DiffLine {
            origin,
            content: content.to_string(),
            old_lineno: None,
            new_lineno: None,
            spans: vec![],
        }
    }

    // A changed markdown line mixing **bold** and `code` is exactly the shape
    // that made syntect's Markdown grammar backtrack. Enrichment must now leave
    // the syntax class empty (grammar never built) while keeping the word-diff
    // emphasis that makes the change legible.
    #[test]
    fn enrich_drops_markdown_syntax_but_keeps_word_emphasis() {
        let mut file_diffs = vec![FileDiff {
            path: "notes.md".to_string(),
            status: DiffStatus::Modified,
            is_binary: false,
            hunks: vec![DiffHunk {
                header: "@@ -1 +1 @@".to_string(),
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 1,
                lines: vec![
                    line(DiffOrigin::Delete, "the value is plain here\n"),
                    line(DiffOrigin::Add, "the value is **bold** `code` here\n"),
                ],
            }],
        }];

        enrich_file_diffs(&mut file_diffs);

        let added = &file_diffs[0].hunks[0].lines[1];
        assert!(
            added.spans.iter().all(|s| s.syntax_class.is_empty()),
            "markdown line must carry no syntax_class spans"
        );
        assert!(
            added.spans.iter().any(|s| s.emphasized),
            "word-diff emphasis must survive the dropped highlighting"
        );
    }
}

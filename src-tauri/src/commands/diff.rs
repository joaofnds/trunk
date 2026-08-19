// Diff commands — Phase 6 implementation

use crate::error::TrunkError;
use crate::git::syntax;
use crate::git::types::{
    CommitDetail, DiffHunk, DiffLine, DiffOrigin, DiffRequestOptions, DiffStatus, FileDiff,
    SyntaxToken, WordSpan,
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

/// Where `walk_diff` should read a delta's *new*-side content from. The old
/// side is always ODB-backed (index or a tree); the new side depends on what
/// the diff is against — workdir-backed diffs (`diff_index_to_workdir`) must
/// read disk, everything else (tree-to-tree, tree-to-index) is ODB-backed too.
#[derive(Debug, Clone, Copy)]
enum NewSideSource {
    Workdir,
    Odb,
}

/// One delta's old/new (oid, path) pair, captured inside a `foreach` file
/// callback. Delta OIDs populate lazily: `diff.get_delta(i)` read *before* any
/// `foreach` call reports a zero id for untracked/workdir deltas, while the
/// same delta inside a file callback carries the real one (probed, git2
/// 0.21) — so this struct is only ever built from inside a callback.
struct DeltaSides {
    old_oid: git2::Oid,
    new_oid: git2::Oid,
    new_path: Option<PathBuf>,
}

/// Run the diff's file callback only, to capture each delta's real oids/path
/// for `resolve_side_content` — separate from the full walk below so the
/// bench's raw path can reuse it without touching `walk_diff_raw_for_bench`.
fn collect_delta_sides(diff: &git2::Diff<'_>) -> Result<Vec<DeltaSides>, TrunkError> {
    use std::cell::RefCell;

    let sides: RefCell<Vec<DeltaSides>> = RefCell::new(Vec::new());
    diff.foreach(
        &mut |delta, _progress| {
            sides.borrow_mut().push(DeltaSides {
                old_oid: delta.old_file().id(),
                new_oid: delta.new_file().id(),
                new_path: delta.new_file().path().map(|p| p.to_path_buf()),
            });
            true
        },
        None,
        None,
        None,
    )
    .map_err(TrunkError::from)?;
    Ok(sides.into_inner())
}

/// Resolve one delta's real old/new file content, keyed by the diff's backing
/// rather than OID zero-ness: workdir-backed deltas — modified and untracked
/// alike — carry real, non-zero content OIDs that are *not* in the ODB
/// (probed, git2 0.21), so "zero OID → disk" never fires and `find_blob`
/// would fail on them. `old_oid`/`new_oid` come straight from the delta, never
/// derived from `FileDiff.path` (which prefers the new path), so renames
/// resolve the old side correctly too. Any failure (missing blob, unreadable
/// file, bare repo) yields `None` for that side.
fn resolve_side_content(
    repo: &git2::Repository,
    delta: &DeltaSides,
    new_side: NewSideSource,
) -> SideContent {
    let old = if delta.old_oid.is_zero() {
        None
    } else {
        repo.find_blob(delta.old_oid)
            .ok()
            .map(|b| b.content().to_vec())
    };

    let new = match new_side {
        NewSideSource::Workdir => delta
            .new_path
            .as_ref()
            .and_then(|p| repo.workdir().and_then(|wd| std::fs::read(wd.join(p)).ok())),
        NewSideSource::Odb => {
            if delta.new_oid.is_zero() {
                None
            } else {
                repo.find_blob(delta.new_oid)
                    .ok()
                    .map(|b| b.content().to_vec())
            }
        }
    };

    SideContent { old, new }
}

/// Collect diff lines from git2 and enrich with syntax highlighting + word-level diff.
/// Single pass: git2 walk → word diff → syntax → merge spans. Returns complete data.
fn walk_diff(
    diff: git2::Diff<'_>,
    repo: &git2::Repository,
    new_side: NewSideSource,
) -> Result<Vec<FileDiff>, TrunkError> {
    use std::cell::RefCell;

    let delta_sides = collect_delta_sides(&diff)?;

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
            let raw_origin = line.origin();
            let origin = match raw_origin {
                '+' => DiffOrigin::Add,
                '-' => DiffOrigin::Delete,
                _ => DiffOrigin::Context,
            };
            let content = String::from_utf8_lossy(line.content()).into_owned();
            // EOFNL markers ('<', '>', '=') carry line numbers too (probed,
            // git2 0.21), which would paint real-code spans onto them; null
            // both linenos for any origin the frontend doesn't treat as a
            // real diff line, so pick_side_line naturally skips them.
            let (old_lineno, new_lineno) = if matches!(raw_origin, '+' | '-' | ' ') {
                (line.old_lineno(), line.new_lineno())
            } else {
                (None, None)
            };
            let mut diffs = file_diffs.borrow_mut();
            if let Some(fd) = diffs.last_mut()
                && let Some(hunk) = fd.hunks.last_mut()
            {
                hunk.lines.push(DiffLine {
                    origin,
                    content,
                    old_lineno,
                    new_lineno,
                    spans: vec![],
                });
            }
            true
        }),
    )
    .map_err(TrunkError::from)?;

    let mut file_diffs = file_diffs.into_inner();
    let sides: Vec<SideContent> = delta_sides
        .iter()
        .map(|d| resolve_side_content(repo, d, new_side))
        .collect();
    enrich_file_diffs(&mut file_diffs, &sides);
    Ok(file_diffs)
}

/// Real content of a file's old and new version, keyed by the same index as the
/// `FileDiff` it enriches. `None` means that side's content could not be resolved
/// (missing blob, unreadable file, bare repo, binary, or over the highlight cap) —
/// that side contributes no syntax tokens, but word-diff emphasis is unaffected.
#[derive(Debug, Default, Clone)]
pub struct SideContent {
    pub old: Option<Vec<u8>>,
    pub new: Option<Vec<u8>>,
}

impl SideContent {
    pub fn none() -> Self {
        Self::default()
    }
}

/// Side content beyond this many displayed lines skips syntax highlighting for
/// that side entirely (word-diff emphasis still applies). Release-mode probe
/// measurements (`/tmp/hl-probe`, bin `perf`, a 2 399-line Rust file): 32–44 ms
/// on a quiet machine across six runs in two sessions (~60–75k lines/s), 173–196
/// ms on a loaded machine during one gate-review run (~14k lines/s). At this cap:
/// ~85 ms/side quiet, ~360 ms/side loaded, per render, off the UI thread, and
/// only for hunks past this line.
const MAX_SYNTAX_HIGHLIGHT_LINE: u32 = 5_000;

/// One line of a side's real file content, with the syntax tokens computed for
/// it by a highlighter fed every preceding line of that same side.
struct SideLine {
    content: String,
    tokens: Vec<SyntaxToken>,
}

fn collect_linenos(
    hunks: &[DiffHunk],
    pick: impl Fn(&DiffLine) -> Option<u32>,
) -> std::collections::BTreeSet<u32> {
    hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .filter_map(pick)
        .collect()
}

/// Parse `bytes` line by line through one highlighter, in order, so parser state
/// at line N reflects the real content of lines `1..N` — the fix for the
/// diagnosed defect where a per-hunk highlighter starts fresh mid-construct.
/// Only lines in `needed` are kept; parsing still walks every line up to the
/// highest needed one, since that is what makes the kept lines' state correct.
fn build_side_lines(
    bytes: &[u8],
    ext: &str,
    needed: &std::collections::BTreeSet<u32>,
) -> HashMap<u32, SideLine> {
    let mut result = HashMap::new();
    let Some(&max_line) = needed.iter().max() else {
        return result;
    };
    if max_line > MAX_SYNTAX_HIGHLIGHT_LINE {
        return result;
    }
    let Some(mut hl) = syntax::create_highlighter(ext) else {
        return result;
    };

    let text = String::from_utf8_lossy(bytes);
    for (idx, raw_line) in text.split('\n').enumerate() {
        let lineno = (idx + 1) as u32;
        if lineno > max_line {
            break;
        }
        let tokens = syntax::highlight_line_with(&mut hl, raw_line);
        if needed.contains(&lineno) {
            result.insert(
                lineno,
                SideLine {
                    content: raw_line.to_string(),
                    tokens,
                },
            );
        }
    }
    result
}

/// The diff line's content with its one trailing `\n` stripped, so it can be
/// compared against a side line's content (never newline-terminated).
fn strip_diff_newline(content: &str) -> &str {
    content.strip_suffix('\n').unwrap_or(content)
}

/// Picks the side line a `DiffLine` should take syntax tokens from: its own side
/// by origin, except a Context line falls back to the old side when the new
/// side's content is entirely unavailable (§3: a whole-side fallback, not a
/// per-line one — a per-line miss degrades to no spans via the alignment guard
/// below, never a fallback).
fn pick_side_line<'a>(
    line: &DiffLine,
    old_lines: Option<&'a HashMap<u32, SideLine>>,
    new_lines: Option<&'a HashMap<u32, SideLine>>,
    new_available: bool,
) -> Option<&'a SideLine> {
    let lookup = |lines: Option<&'a HashMap<u32, SideLine>>, lineno: Option<u32>| {
        lineno.and_then(|n| lines.and_then(|m| m.get(&n)))
    };
    match line.origin {
        DiffOrigin::Delete => lookup(old_lines, line.old_lineno),
        DiffOrigin::Add => lookup(new_lines, line.new_lineno),
        DiffOrigin::Context => {
            if new_available {
                lookup(new_lines, line.new_lineno)
            } else {
                lookup(old_lines, line.old_lineno)
            }
        }
    }
}

/// Enrich file diffs with word-level diff spans and syntax highlighting.
/// Syntax tokens come from each side's real file content (`sides`, parallel to
/// `file_diffs`), parsed by its own highlighter — never from the diff line
/// stream, which is not either file version's real content.
pub fn enrich_file_diffs(file_diffs: &mut [FileDiff], sides: &[SideContent]) {
    for (fd, side) in file_diffs.iter_mut().zip(sides.iter()) {
        let ext = syntax::extension_from_path(&fd.path);

        let old_needed = collect_linenos(&fd.hunks, |l| l.old_lineno);
        let new_needed = collect_linenos(&fd.hunks, |l| l.new_lineno);
        let old_lines = side
            .old
            .as_deref()
            .map(|bytes| build_side_lines(bytes, ext, &old_needed));
        let new_lines = side
            .new
            .as_deref()
            .map(|bytes| build_side_lines(bytes, ext, &new_needed));
        let new_available = side.new.is_some();

        for hunk in &mut fd.hunks {
            let word_spans_per_line = compute_word_spans_for_hunk(&hunk.lines);
            for (i, line) in hunk.lines.iter_mut().enumerate() {
                let ws = &word_spans_per_line[i];
                let syntax_tokens =
                    pick_side_line(line, old_lines.as_ref(), new_lines.as_ref(), new_available)
                        .filter(|sl| sl.content == strip_diff_newline(&line.content))
                        .map(|sl| sl.tokens.clone())
                        .unwrap_or_default();

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

/// Diff unstaged changes without enrichment — for benchmarking. Also resolves
/// each file's real side content, so the caller can measure `enrich_file_diffs`
/// against real content without paying side-resolution cost inside `b.iter`.
#[doc(hidden)]
pub fn diff_unstaged_raw_for_bench(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
    options: &DiffRequestOptions,
) -> Result<(Vec<FileDiff>, Vec<SideContent>), TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file_path);
    opts.disable_pathspec_match(true);
    apply_request_options(&mut opts, options);
    let diff = repo.diff_index_to_workdir(None, Some(&mut opts))?;
    let delta_sides = collect_delta_sides(&diff)?;
    let sides: Vec<SideContent> = delta_sides
        .iter()
        .map(|d| resolve_side_content(&repo, d, NewSideSource::Workdir))
        .collect();
    let file_diffs = walk_diff_raw_for_bench(diff)?;
    Ok((file_diffs, sides))
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
    walk_diff(diff, &repo, NewSideSource::Workdir)
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
    walk_diff(diff, &repo, NewSideSource::Odb)
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
    walk_diff(diff, &repo, NewSideSource::Odb)
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
    walk_diff(diff, &repo, NewSideSource::Odb)
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

    // A changed markdown line mixing **bold** and `code` is exactly the shape
    // that made syntect's Markdown grammar backtrack. Enrichment must now leave
    // the syntax class empty (grammar never built) while keeping the word-diff
    // emphasis that makes the change legible.
    #[test]
    fn enrich_drops_markdown_syntax_but_keeps_word_emphasis() {
        let old_content = "the value is plain here\n";
        let new_content = "the value is **bold** `code` here\n";
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
                    DiffLine {
                        origin: DiffOrigin::Delete,
                        content: old_content.to_string(),
                        old_lineno: Some(1),
                        new_lineno: None,
                        spans: vec![],
                    },
                    DiffLine {
                        origin: DiffOrigin::Add,
                        content: new_content.to_string(),
                        old_lineno: None,
                        new_lineno: Some(1),
                        spans: vec![],
                    },
                ],
            }],
        }];
        // Real, matching side content: proves the empty syntax_class comes from
        // the Markdown grammar refusal, not from missing/unavailable content.
        let sides = vec![SideContent {
            old: Some(old_content.as_bytes().to_vec()),
            new: Some(new_content.as_bytes().to_vec()),
        }];

        enrich_file_diffs(&mut file_diffs, &sides);

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

    // Reproduces the diagnosed defect (F1): a hunk starting mid multi-line string.
    // A fresh per-hunk highlighter parses "FROM t\";" from a default top-level
    // state and misreads it; seeded with the real preceding file content, the
    // parser is inside the string where it should be, and resumes as code once
    // the string actually closes.
    #[test]
    fn enrich_highlights_a_hunk_that_starts_mid_string_from_real_side_content() {
        let new_content = concat!(
            "fn build_sql() -> String {\n",
            "    let sql = \"SELECT *\n",
            "FROM t\";\n",
            "    let mut stmt = sql;\n",
            "    stmt\n",
            "}\n",
        );
        let mut file_diffs = vec![FileDiff {
            path: "example.rs".to_string(),
            status: DiffStatus::Modified,
            is_binary: false,
            hunks: vec![DiffHunk {
                header: "@@ -3,0 +3,2 @@".to_string(),
                old_start: 3,
                old_lines: 1,
                new_start: 3,
                new_lines: 2,
                lines: vec![
                    DiffLine {
                        origin: DiffOrigin::Context,
                        content: "FROM t\";\n".to_string(),
                        old_lineno: Some(3),
                        new_lineno: Some(3),
                        spans: vec![],
                    },
                    DiffLine {
                        origin: DiffOrigin::Add,
                        content: "    let mut stmt = sql;\n".to_string(),
                        old_lineno: None,
                        new_lineno: Some(4),
                        spans: vec![],
                    },
                ],
            }],
        }];
        let sides = vec![SideContent {
            old: Some(new_content.as_bytes().to_vec()),
            new: Some(new_content.as_bytes().to_vec()),
        }];

        enrich_file_diffs(&mut file_diffs, &sides);

        let context_line = &file_diffs[0].hunks[0].lines[0];
        assert!(
            context_line
                .spans
                .iter()
                .any(|s| s.syntax_class == "syn-string"),
            "context line inside the real string should carry syn-string, got {:?}",
            context_line.spans
        );

        let add_line = &file_diffs[0].hunks[0].lines[1];
        assert!(
            add_line
                .spans
                .iter()
                .any(|s| s.syntax_class == "syn-keyword"),
            "add line after the string closes should carry syn-keyword, got {:?}",
            add_line.spans
        );
    }

    // F3: old and new lines must not share one highlighter. A Delete line that
    // opens an unclosed block comment must not bleed comment state into the
    // neighboring Add line — they are parsed by two independent highlighters,
    // one per side's real content.
    #[test]
    fn enrich_does_not_let_a_deleted_comment_opener_corrupt_the_neighboring_add_line() {
        let old_content = "fn main() {\n    let x = 1; /*\n}\n";
        let new_content = "fn main() {\n    let y = 2;\n}\n";
        let mut file_diffs = vec![FileDiff {
            path: "combo.rs".to_string(),
            status: DiffStatus::Modified,
            is_binary: false,
            hunks: vec![DiffHunk {
                header: "@@ -2 +2 @@".to_string(),
                old_start: 2,
                old_lines: 1,
                new_start: 2,
                new_lines: 1,
                lines: vec![
                    DiffLine {
                        origin: DiffOrigin::Delete,
                        content: "    let x = 1; /*\n".to_string(),
                        old_lineno: Some(2),
                        new_lineno: None,
                        spans: vec![],
                    },
                    DiffLine {
                        origin: DiffOrigin::Add,
                        content: "    let y = 2;\n".to_string(),
                        old_lineno: None,
                        new_lineno: Some(2),
                        spans: vec![],
                    },
                ],
            }],
        }];
        let sides = vec![SideContent {
            old: Some(old_content.as_bytes().to_vec()),
            new: Some(new_content.as_bytes().to_vec()),
        }];

        enrich_file_diffs(&mut file_diffs, &sides);

        let add_line = &file_diffs[0].hunks[0].lines[1];
        assert!(
            add_line
                .spans
                .iter()
                .any(|s| s.syntax_class == "syn-keyword"),
            "add line must highlight as code, not inherit the old side's open comment, got {:?}",
            add_line.spans
        );
        assert!(
            add_line
                .spans
                .iter()
                .all(|s| s.syntax_class != "syn-comment"),
            "add line must carry no comment spans from the deleted line's neighbor, got {:?}",
            add_line.spans
        );
    }

    // F2: state must not bleed across hunks. The gap between two hunks in this
    // file opens and closes a multi-line string; the second hunk starts after
    // the gap closes it, so its line must highlight as code, not string.
    #[test]
    fn enrich_does_not_bleed_state_across_the_gap_between_two_hunks() {
        let content = concat!(
            "fn main() {\n",                     // 1
            "    let a = 1;\n",                  // 2 - hunk 1
            "    let sql = \"SELECT * FROM t\n", // 3 - gap (opens string)
            "WHERE x = 1\";\n",                  // 4 - gap (closes string)
            "    let mut z = 9;\n",              // 5 - hunk 2
            "}\n",                               // 6
        );
        let mut file_diffs = vec![FileDiff {
            path: "gap.rs".to_string(),
            status: DiffStatus::Modified,
            is_binary: false,
            hunks: vec![
                DiffHunk {
                    header: "@@ -2 +2 @@".to_string(),
                    old_start: 2,
                    old_lines: 1,
                    new_start: 2,
                    new_lines: 1,
                    lines: vec![DiffLine {
                        origin: DiffOrigin::Context,
                        content: "    let a = 1;\n".to_string(),
                        old_lineno: Some(2),
                        new_lineno: Some(2),
                        spans: vec![],
                    }],
                },
                DiffHunk {
                    header: "@@ -5 +5 @@".to_string(),
                    old_start: 5,
                    old_lines: 1,
                    new_start: 5,
                    new_lines: 1,
                    lines: vec![DiffLine {
                        origin: DiffOrigin::Context,
                        content: "    let mut z = 9;\n".to_string(),
                        old_lineno: Some(5),
                        new_lineno: Some(5),
                        spans: vec![],
                    }],
                },
            ],
        }];
        let sides = vec![SideContent {
            old: Some(content.as_bytes().to_vec()),
            new: Some(content.as_bytes().to_vec()),
        }];

        enrich_file_diffs(&mut file_diffs, &sides);

        let second_hunk_line = &file_diffs[0].hunks[1].lines[0];
        assert!(
            second_hunk_line
                .spans
                .iter()
                .any(|s| s.syntax_class == "syn-keyword"),
            "line after the gap closes the string must highlight as code, got {:?}",
            second_hunk_line.spans
        );
        assert!(
            second_hunk_line
                .spans
                .iter()
                .all(|s| s.syntax_class != "syn-string"),
            "line after the gap closes the string must not still read as string, got {:?}",
            second_hunk_line.spans
        );
    }

    // Fallback: a side whose content could not be resolved at all (missing blob,
    // unreadable file, bare repo, binary) contributes no syntax tokens — the
    // precedent the markdown test already asserts for grammar refusal, pinned
    // here for the "no content" reason instead.
    #[test]
    fn enrich_produces_no_syntax_spans_when_side_content_is_unavailable() {
        let mut file_diffs = vec![FileDiff {
            path: "missing.rs".to_string(),
            status: DiffStatus::Modified,
            is_binary: false,
            hunks: vec![DiffHunk {
                header: "@@ -1 +1 @@".to_string(),
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 1,
                lines: vec![
                    DiffLine {
                        origin: DiffOrigin::Delete,
                        content: "let x = 1;\n".to_string(),
                        old_lineno: Some(1),
                        new_lineno: None,
                        spans: vec![],
                    },
                    DiffLine {
                        origin: DiffOrigin::Add,
                        content: "let y = 2;\n".to_string(),
                        old_lineno: None,
                        new_lineno: Some(1),
                        spans: vec![],
                    },
                ],
            }],
        }];
        let sides = vec![SideContent::none()];

        enrich_file_diffs(&mut file_diffs, &sides);

        for hunk in &file_diffs[0].hunks {
            for line in &hunk.lines {
                assert!(
                    line.spans.iter().all(|s| s.syntax_class.is_empty()),
                    "unavailable side content must carry no syntax spans, got {:?}",
                    line.spans
                );
                assert!(
                    line.spans.iter().any(|s| s.emphasized),
                    "word-diff emphasis must survive missing side content"
                );
            }
        }
    }

    // Cap: a side whose last displayed line exceeds the highlight cap skips
    // syntax entirely for that side. The cap check runs on the referenced line
    // number alone, so a short real-content fixture is enough to exercise it.
    #[test]
    fn enrich_skips_syntax_when_a_sides_last_displayed_line_exceeds_the_cap() {
        let over_cap = MAX_SYNTAX_HIGHLIGHT_LINE + 1;
        let mut file_diffs = vec![FileDiff {
            path: "huge.rs".to_string(),
            status: DiffStatus::Modified,
            is_binary: false,
            hunks: vec![DiffHunk {
                header: "@@ huge @@".to_string(),
                old_start: 1,
                old_lines: 0,
                new_start: over_cap,
                new_lines: 1,
                lines: vec![DiffLine {
                    origin: DiffOrigin::Add,
                    content: "let x = 1;\n".to_string(),
                    old_lineno: None,
                    new_lineno: Some(over_cap),
                    spans: vec![],
                }],
            }],
        }];
        let sides = vec![SideContent {
            old: None,
            new: Some(b"let x = 1;\n".to_vec()),
        }];

        enrich_file_diffs(&mut file_diffs, &sides);

        let add_line = &file_diffs[0].hunks[0].lines[0];
        assert!(
            add_line.spans.iter().all(|s| s.syntax_class.is_empty()),
            "a side past the highlight cap must carry no syntax spans, got {:?}",
            add_line.spans
        );
    }

    // Alignment guard: a side line that disagrees with DiffLine.content (a
    // filter or TOCTOU drift) loses syntax spans on that line alone — a
    // correctly aligned neighbor is unaffected, and nothing panics.
    #[test]
    fn enrich_drops_syntax_only_on_the_line_that_disagrees_with_side_content() {
        let new_content = "fn main() {\n    let x = 1;\n    let y = 2;\n}\n";
        let mut file_diffs = vec![FileDiff {
            path: "drift.rs".to_string(),
            status: DiffStatus::Modified,
            is_binary: false,
            hunks: vec![DiffHunk {
                header: "@@ -2,2 +2,2 @@".to_string(),
                old_start: 2,
                old_lines: 2,
                new_start: 2,
                new_lines: 2,
                lines: vec![
                    DiffLine {
                        origin: DiffOrigin::Add,
                        content: "    let x = 1;\n".to_string(),
                        old_lineno: None,
                        new_lineno: Some(2),
                        spans: vec![],
                    },
                    DiffLine {
                        origin: DiffOrigin::Add,
                        // Real line 3 is "    let y = 2;\n" — this drifted copy
                        // simulates a checkin-filter/TOCTOU mismatch.
                        content: "    let z = 2;\n".to_string(),
                        old_lineno: None,
                        new_lineno: Some(3),
                        spans: vec![],
                    },
                ],
            }],
        }];
        let sides = vec![SideContent {
            old: None,
            new: Some(new_content.as_bytes().to_vec()),
        }];

        enrich_file_diffs(&mut file_diffs, &sides);

        let aligned_line = &file_diffs[0].hunks[0].lines[0];
        assert!(
            aligned_line
                .spans
                .iter()
                .any(|s| s.syntax_class == "syn-keyword"),
            "correctly aligned line must still get syntax spans, got {:?}",
            aligned_line.spans
        );

        let drifted_line = &file_diffs[0].hunks[0].lines[1];
        assert!(
            drifted_line.spans.iter().all(|s| s.syntax_class.is_empty()),
            "a line that disagrees with its side content must carry no syntax spans, got {:?}",
            drifted_line.spans
        );
    }
}

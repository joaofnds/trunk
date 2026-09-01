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

/// Every diff Trunk computes starts here. The indent heuristic matches git
/// CLI's default hunk boundaries; staging builds from the same base so its
/// hunk indices agree with the view under default view options (view-only
/// options like ignore-whitespace are applied on top and staging does not
/// see them — TRUNK-73 tracks that mismatch).
pub(crate) fn new_diff_options() -> git2::DiffOptions {
    let mut opts = git2::DiffOptions::new();
    opts.indent_heuristic(true);
    opts
}

/// Diff options for one file's workdir diff, untracked content included.
/// Display (`diff_unstaged_inner`) and staging both build from here; the two
/// must see the same deltas for staging's hunk indices to match the view.
pub(crate) fn workdir_diff_opts(file_path: &str) -> git2::DiffOptions {
    let mut opts = new_diff_options();
    opts.pathspec(file_path);
    opts.disable_pathspec_match(true);
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.show_untracked_content(true);
    opts
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

/// Capture one delta's oids and new path from inside a `foreach` file callback.
fn delta_sides_of(delta: &git2::DiffDelta<'_>) -> DeltaSides {
    DeltaSides {
        old_oid: delta.old_file().id(),
        new_oid: delta.new_file().id(),
        new_path: delta.new_file().path().map(|p| p.to_path_buf()),
    }
}

/// Resolve the real side content each `FileDiff` needs for highlighting.
/// A file with no hunks (binary, or nothing displayed) and a path syntect has
/// no grammar for are both highlighted from neither side, so reading their
/// blobs would buy nothing: those files resolve to `none()` without touching
/// the ODB or the disk.
fn resolve_sides(
    repo: &git2::Repository,
    file_diffs: &[FileDiff],
    delta_sides: &[DeltaSides],
    new_side: NewSideSource,
) -> Vec<SideContent> {
    file_diffs
        .iter()
        .zip(delta_sides.iter())
        .map(|(fd, delta)| {
            let highlightable = !fd.hunks.is_empty()
                && syntax::can_highlight_extension(syntax::extension_from_path(&fd.path));

            if highlightable {
                resolve_side_content(repo, delta, new_side)
            } else {
                SideContent::none()
            }
        })
        .collect()
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

    let file_diffs: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());
    let delta_sides: RefCell<Vec<DeltaSides>> = RefCell::new(Vec::new());

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
            delta_sides.borrow_mut().push(delta_sides_of(&delta));
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
    let sides = resolve_sides(repo, &file_diffs, &delta_sides.into_inner(), new_side);

    enrich_file_diffs(&mut file_diffs, &sides);
    Ok(file_diffs)
}

/// Real content of a file's old and new version, keyed by the same index as the
/// `FileDiff` it enriches. `None` means that side's content could not be resolved
/// (missing blob, unreadable file, bare repo, or binary) — that side contributes
/// no syntax tokens, but word-diff emphasis is unaffected. A side whose window
/// runs past `MAX_SYNTAX_PARSE_LINES` resolves its content and then yields no
/// tokens, which is the same outcome by a different route.
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

/// A side whose window would run longer than this skips syntax highlighting
/// entirely (word-diff emphasis still applies). The bound is on lines parsed,
/// not on how deep the deepest one sits: a narrow hunk anywhere in a file costs
/// its span plus the lookback, while an added file or a full-file view needs
/// every line and its window is the whole file. Release-mode probe measurements
/// (`/tmp/hl-probe`, bin `perf`, a 2 399-line Rust file): 32–44 ms on a quiet
/// machine across six runs in two sessions (~60–75k lines/s), 173–196 ms on a
/// loaded machine during one gate-review run (~14k lines/s). At this cap:
/// ~85 ms/side quiet, ~360 ms/side loaded, per render, off the UI thread.
const MAX_SYNTAX_PARSE_LINES: u32 = 5_000;

/// One line of a side's real file content, with the syntax tokens computed for
/// it by a highlighter fed every preceding line of that same side.
struct SideLine<'a> {
    content: &'a str,
    tokens: Vec<SyntaxToken>,
}

/// The side and line number a `DiffLine` takes its syntax tokens from: its own
/// side by origin, except a Context line falls back to the old side when the new
/// side's content is entirely unavailable (§3: a whole-side fallback, not a
/// per-line one — a per-line miss degrades to no spans via the alignment guard
/// in `enrich_file_diffs`, never a fallback).
///
/// Both the needed-line collection and the token lookup answer from this one
/// rule, so a side is never parsed up to a line nothing will read.
enum TokenSource {
    Old(u32),
    New(u32),
}

fn token_source(line: &DiffLine, new_available: bool) -> Option<TokenSource> {
    match line.origin {
        DiffOrigin::Delete => line.old_lineno.map(TokenSource::Old),
        DiffOrigin::Add => line.new_lineno.map(TokenSource::New),
        DiffOrigin::Context => {
            if new_available {
                line.new_lineno.map(TokenSource::New)
            } else {
                line.old_lineno.map(TokenSource::Old)
            }
        }
    }
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

/// How many lines above a side's first needed line the highlighter starts from.
/// Parser state at a line is set by the nearest enclosing construct, not by
/// line 1, so a bounded window reproduces a full parse: measured against this
/// repo's own TypeScript and Rust, 0.059% of lines differ at this size.
const SYNTAX_LOOKBACK_LINES: u32 = 250;

/// Parse a bounded window of `text` through one highlighter, in order, so the
/// parser state at each needed line reflects the real content of the lines
/// above it. Lines in the window that nothing displays are parsed for their
/// state and dropped; lines outside it are never parsed at all.
fn build_side_lines<'a>(
    text: &'a str,
    ext: &str,
    needed: &std::collections::BTreeSet<u32>,
) -> HashMap<u32, SideLine<'a>> {
    let mut result = HashMap::new();
    let (Some(&min_line), Some(&max_line)) = (needed.first(), needed.last()) else {
        return result;
    };

    let start = min_line.saturating_sub(SYNTAX_LOOKBACK_LINES).max(1);
    if max_line - start + 1 > MAX_SYNTAX_PARSE_LINES {
        return result;
    }
    let Some(mut highlighter) = syntax::create_highlighter(ext) else {
        return result;
    };

    for (idx, raw_line) in text.split('\n').enumerate() {
        let lineno = (idx + 1) as u32;
        if lineno < start {
            continue;
        }
        if lineno > max_line {
            break;
        }

        let tokens = syntax::highlight_line_with(&mut highlighter, raw_line);
        if needed.contains(&lineno) {
            result.insert(
                lineno,
                SideLine {
                    content: raw_line,
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

/// Picks the side line a `DiffLine` should take syntax tokens from.
fn pick_side_line<'a, 'b>(
    line: &DiffLine,
    old_lines: Option<&'a HashMap<u32, SideLine<'b>>>,
    new_lines: Option<&'a HashMap<u32, SideLine<'b>>>,
    new_available: bool,
) -> Option<&'a SideLine<'b>> {
    let (lines, lineno) = match token_source(line, new_available)? {
        TokenSource::Old(n) => (old_lines, n),
        TokenSource::New(n) => (new_lines, n),
    };
    lines.and_then(|m| m.get(&lineno))
}

/// Enrich file diffs with word-level diff spans and syntax highlighting.
/// Syntax tokens come from each side's real file content (`sides`, parallel to
/// `file_diffs`), parsed by its own highlighter — never from the diff line
/// stream, which is not either file version's real content.
pub fn enrich_file_diffs(file_diffs: &mut [FileDiff], sides: &[SideContent]) {
    for (fd, side) in file_diffs.iter_mut().zip(sides.iter()) {
        let ext = syntax::extension_from_path(&fd.path);

        let new_available = side.new.is_some();
        let old_needed = collect_linenos(&fd.hunks, |l| match token_source(l, new_available) {
            Some(TokenSource::Old(n)) => Some(n),
            _ => None,
        });
        let new_needed = collect_linenos(&fd.hunks, |l| match token_source(l, new_available) {
            Some(TokenSource::New(n)) => Some(n),
            _ => None,
        });
        let old_text = side.old.as_deref().map(String::from_utf8_lossy);
        let new_text = side.new.as_deref().map(String::from_utf8_lossy);
        let old_lines = old_text
            .as_deref()
            .map(|text| build_side_lines(text, ext, &old_needed));
        let new_lines = new_text
            .as_deref()
            .map(|text| build_side_lines(text, ext, &new_needed));

        for hunk in &mut fd.hunks {
            let word_spans_per_line = compute_word_spans_for_hunk(&hunk.lines);
            for (i, line) in hunk.lines.iter_mut().enumerate() {
                let ws = &word_spans_per_line[i];
                let syntax_tokens =
                    pick_side_line(line, old_lines.as_ref(), new_lines.as_ref(), new_available)
                        .filter(|sl| sl.content == strip_diff_newline(&line.content))
                        .map(|sl| sl.tokens.as_slice())
                        .unwrap_or_default();

                if !syntax_tokens.is_empty() || !ws.is_empty() {
                    line.spans = syntax::merge_spans(syntax_tokens, ws, line.content.len() as u32);
                }
            }
        }
    }
}

/// Raw walk without enrichment — for benchmarking only.
fn walk_diff_raw_for_bench(
    diff: git2::Diff<'_>,
) -> Result<(Vec<FileDiff>, Vec<DeltaSides>), TrunkError> {
    use std::cell::RefCell;
    let file_diffs: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());
    let delta_sides: RefCell<Vec<DeltaSides>> = RefCell::new(Vec::new());
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
            delta_sides.borrow_mut().push(delta_sides_of(&delta));
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
    Ok((file_diffs.into_inner(), delta_sides.into_inner()))
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
    let mut opts = workdir_diff_opts(file_path);
    apply_request_options(&mut opts, options);
    let diff = repo.diff_index_to_workdir(None, Some(&mut opts))?;
    let (file_diffs, delta_sides) = walk_diff_raw_for_bench(diff)?;
    let sides = resolve_sides(&repo, &file_diffs, &delta_sides, NewSideSource::Workdir);
    Ok((file_diffs, sides))
}

pub fn diff_unstaged_inner(
    path: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
    options: &DiffRequestOptions,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let mut opts = workdir_diff_opts(file_path);
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
    let mut opts = new_diff_options();
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
    let mut opts = new_diff_options();
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
    let opts = new_diff_options();
    let diff = if commit.parent_count() == 0 {
        repo.diff_tree_to_tree(None, Some(&commit_tree), Some(&mut { opts }))?
    } else {
        let parent_tree = commit.parent(0)?.tree()?;
        repo.diff_tree_to_tree(Some(&parent_tree), Some(&commit_tree), Some(&mut { opts }))?
    };
    Ok(file_metadata_list(&diff))
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
    let mut opts = new_diff_options();
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

/// Resolve a commit OID to its tree for a compare side; `None` is the empty
/// tree, which the range gesture needs when its oldest commit is a root.
fn compare_tree<'r>(
    repo: &'r git2::Repository,
    oid: Option<&str>,
) -> Result<Option<git2::Tree<'r>>, TrunkError> {
    let Some(oid) = oid else { return Ok(None) };
    let oid =
        git2::Oid::from_str(oid).map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
    Ok(Some(repo.find_commit(oid)?.tree()?))
}

/// Lightweight Base → Target file listing (TRUNK-1 compare). Two-tree diff
/// with no ancestry requirement — unlike a review range, any pair of commits
/// compares. Metadata only, like `list_commit_files_inner`.
pub fn list_compare_files_inner(
    path: &str,
    base_oid: Option<&str>,
    target_oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let base_tree = compare_tree(&repo, base_oid)?;
    let target_tree = compare_tree(&repo, Some(target_oid))?;
    let diff = repo.diff_tree_to_tree(
        base_tree.as_ref(),
        target_tree.as_ref(),
        Some(&mut new_diff_options()),
    )?;
    Ok(file_metadata_list(&diff))
}

/// Diff a single file between Base and Target — used when the user clicks a
/// file in the compare view.
pub fn diff_compare_file_inner(
    path: &str,
    base_oid: Option<&str>,
    target_oid: &str,
    file_path: &str,
    state_map: &HashMap<String, PathBuf>,
    options: &DiffRequestOptions,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let base_tree = compare_tree(&repo, base_oid)?;
    let target_tree = compare_tree(&repo, Some(target_oid))?;
    let mut opts = new_diff_options();
    opts.pathspec(file_path);
    opts.disable_pathspec_match(true);
    apply_request_options(&mut opts, options);
    let diff = repo.diff_tree_to_tree(base_tree.as_ref(), target_tree.as_ref(), Some(&mut opts))?;
    walk_diff(diff, &repo, NewSideSource::Odb)
}

/// Whole-compare totals via the cheap `Diff::stats()` path, mirroring
/// `history::commit_stat_from_repo`: renames collapsed, no line walking.
pub fn compare_stat_inner(
    path: &str,
    base_oid: Option<&str>,
    target_oid: &str,
    state_map: &HashMap<String, PathBuf>,
) -> Result<crate::git::types::DiffStat, TrunkError> {
    let repo = crate::commands::open_repo_from_state(path, state_map)?;
    let base_tree = compare_tree(&repo, base_oid)?;
    let target_tree = compare_tree(&repo, Some(target_oid))?;
    let mut diff = repo.diff_tree_to_tree(
        base_tree.as_ref(),
        target_tree.as_ref(),
        Some(&mut new_diff_options()),
    )?;
    diff.find_similar(None)?;
    let stats = diff.stats()?;
    Ok(crate::git::types::DiffStat {
        insertions: stats.insertions(),
        deletions: stats.deletions(),
        files_changed: stats.files_changed(),
    })
}

/// The delta → metadata-only `FileDiff` mapping shared by the commit and
/// compare file listings.
fn file_metadata_list(diff: &git2::Diff) -> Vec<FileDiff> {
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
    file_diffs
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
pub async fn list_compare_files(
    path: String,
    base_oid: Option<String>,
    target_oid: String,
    state: State<'_, RepoState>,
) -> Result<Vec<FileDiff>, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_compare_files_inner(&path, base_oid.as_deref(), &target_oid, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn diff_compare_file(
    path: String,
    base_oid: Option<String>,
    target_oid: String,
    file_path: String,
    options: DiffRequestOptions,
    state: State<'_, RepoState>,
) -> Result<Vec<FileDiff>, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        diff_compare_file_inner(
            &path,
            base_oid.as_deref(),
            &target_oid,
            &file_path,
            &state_map,
            &options,
        )
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn compare_stat(
    path: String,
    base_oid: Option<String>,
    target_oid: String,
    state: State<'_, RepoState>,
) -> Result<crate::git::types::DiffStat, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        compare_stat_inner(&path, base_oid.as_deref(), &target_oid, &state_map)
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

    const LET_LINE: &str = "let total = 1;";

    /// `count` lines of plain Rust, with `overrides` replacing the 1-based lines
    /// they name. A window test proves nothing unless its side content really
    /// reaches the line the test names.
    fn rust_side(count: u32, overrides: &[(u32, &str)]) -> Vec<u8> {
        let mut lines: Vec<String> = (1..=count).map(|_| LET_LINE.to_string()).collect();

        for (lineno, content) in overrides {
            lines[(*lineno - 1) as usize] = (*content).to_string();
        }

        lines.join("\n").into_bytes()
    }

    /// One hunk holding one line, numbered on the side its origin reads from.
    fn one_line_hunk(origin: DiffOrigin, lineno: u32, content: &str) -> DiffHunk {
        let (old_lineno, new_lineno) = match origin {
            DiffOrigin::Delete => (Some(lineno), None),
            _ => (None, Some(lineno)),
        };

        DiffHunk {
            header: format!("@@ -{lineno},1 +{lineno},1 @@"),
            old_start: lineno,
            old_lines: 1,
            new_start: lineno,
            new_lines: 1,
            lines: vec![DiffLine {
                origin,
                content: format!("{content}\n"),
                old_lineno,
                new_lineno,
                spans: vec![],
            }],
        }
    }

    fn rust_file_diff(hunks: Vec<DiffHunk>) -> FileDiff {
        FileDiff {
            path: "window.rs".to_string(),
            status: DiffStatus::Modified,
            is_binary: false,
            hunks,
        }
    }

    fn syntax_classes(line: &DiffLine) -> Vec<&str> {
        line.spans
            .iter()
            .map(|s| s.syntax_class.as_str())
            .filter(|c| !c.is_empty())
            .collect()
    }

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

    // A block comment opened at line 1 is 400 lines above the only line the diff
    // needs. The window starts 250 lines above that line, so the parser never
    // sees the comment open and the line highlights as the code it looks like.
    #[test]
    fn a_construct_opened_above_the_lookback_window_does_not_reach_the_highlighted_line() {
        let needed = 400;
        let mut file_diffs = vec![rust_file_diff(vec![one_line_hunk(
            DiffOrigin::Add,
            needed,
            LET_LINE,
        )])];
        let sides = vec![SideContent {
            old: None,
            new: Some(rust_side(600, &[(1, "/* an unterminated block comment")])),
        }];

        enrich_file_diffs(&mut file_diffs, &sides);

        let line = &file_diffs[0].hunks[0].lines[0];
        assert!(
            !syntax_classes(line).contains(&"syn-comment"),
            "a construct opened above the window must not reach the line, got {:?}",
            line.spans
        );
        assert!(
            syntax_classes(line).contains(&"syn-keyword"),
            "the line must still be highlighted from its own side, got {:?}",
            line.spans
        );
    }

    // The mirror: a block comment opened 100 lines above the needed line sits
    // inside the window, so the parser is still inside it when it gets there.
    #[test]
    fn a_construct_opened_inside_the_lookback_window_does_reach_the_highlighted_line() {
        let needed = 400;
        let mut file_diffs = vec![rust_file_diff(vec![one_line_hunk(
            DiffOrigin::Add,
            needed,
            LET_LINE,
        )])];
        let sides = vec![SideContent {
            old: None,
            new: Some(rust_side(600, &[(300, "/* an unterminated block comment")])),
        }];

        enrich_file_diffs(&mut file_diffs, &sides);

        let line = &file_diffs[0].hunks[0].lines[0];
        assert!(
            syntax_classes(line).contains(&"syn-comment"),
            "a construct opened inside the window must reach the line, got {:?}",
            line.spans
        );
    }

    // Each side's window is anchored on that side's own first needed line. A
    // window computed from the other side's minimum would start below the line
    // this side needs, and the alignment guard would drop its spans in silence.
    #[test]
    fn each_side_takes_its_window_from_its_own_needed_lines() {
        let mut file_diffs = vec![rust_file_diff(vec![
            one_line_hunk(DiffOrigin::Delete, 300, LET_LINE),
            one_line_hunk(DiffOrigin::Add, 900, LET_LINE),
        ])];
        let sides = vec![SideContent {
            old: Some(rust_side(1000, &[])),
            new: Some(rust_side(1000, &[])),
        }];

        enrich_file_diffs(&mut file_diffs, &sides);

        let deleted = &file_diffs[0].hunks[0].lines[0];
        let added = &file_diffs[0].hunks[1].lines[0];
        assert!(
            syntax_classes(deleted).contains(&"syn-keyword"),
            "the old side must be parsed from its own needed minimum, got {:?}",
            deleted.spans
        );
        assert!(
            syntax_classes(added).contains(&"syn-keyword"),
            "the new side must be parsed from its own needed minimum, got {:?}",
            added.spans
        );
    }

    // The cap bounds how many lines a side parses, not how deep the deepest one
    // sits, so one narrow hunk past the old 5,000-line limit is highlighted
    // where it used to be served plain.
    #[test]
    fn a_narrow_change_far_below_the_old_cap_is_still_highlighted() {
        let mut file_diffs = vec![rust_file_diff(vec![one_line_hunk(
            DiffOrigin::Add,
            6_000,
            LET_LINE,
        )])];
        let sides = vec![SideContent {
            old: None,
            new: Some(rust_side(6_200, &[])),
        }];

        enrich_file_diffs(&mut file_diffs, &sides);

        let line = &file_diffs[0].hunks[0].lines[0];
        assert!(
            syntax_classes(line).contains(&"syn-keyword"),
            "a narrow change past the old cap must be highlighted, got {:?}",
            line.spans
        );
    }

    // The other direction, and the reason the cap survives at all: an added
    // file and a full-file view both need every line, so the window is the
    // whole file and the parse it would cost is the one the cap refuses.
    #[test]
    fn a_side_whose_needed_lines_span_more_than_the_parse_cap_skips_syntax() {
        let lines: Vec<DiffLine> = (1..=6_000)
            .map(|lineno| DiffLine {
                origin: DiffOrigin::Add,
                content: format!("{LET_LINE}\n"),
                old_lineno: None,
                new_lineno: Some(lineno),
                spans: vec![],
            })
            .collect();
        let mut file_diffs = vec![rust_file_diff(vec![DiffHunk {
            header: "@@ -0,0 +1,6000 @@".to_string(),
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: 6_000,
            lines,
        }])];
        let sides = vec![SideContent {
            old: None,
            new: Some(rust_side(6_000, &[])),
        }];

        enrich_file_diffs(&mut file_diffs, &sides);

        let deepest = file_diffs[0].hunks[0].lines.last().unwrap();
        assert!(
            syntax_classes(deepest).is_empty(),
            "a side spanning more than the cap must carry no syntax spans, got {:?}",
            deepest.spans
        );
    }
}

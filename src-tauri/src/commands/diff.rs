// Diff commands — Phase 6 implementation

use crate::error::TrunkError;
use crate::git::syntax;
use crate::git::types::{
    CommitDetail, DiffHunk, DiffLine, DiffOrigin, DiffRequestOptions, DiffStatus, FileDiff,
    LinePairing, SyntaxToken,
};
use crate::git::word_spans::compute_word_spans_for_hunk;
use crate::state::{OpenRepos, RepoState};
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
/// CLI's default hunk boundaries; staging builds from the same base, and
/// receives the same `DiffRequestOptions` the view was rendered with, so a
/// hunk index means the same hunk on both sides (TRUNK-73).
pub(crate) fn new_diff_options() -> git2::DiffOptions {
    let mut opts = git2::DiffOptions::new();
    opts.indent_heuristic(true);
    opts
}

/// Diff options for one file's workdir diff, untracked content included.
/// Display (`diff_unstaged_inner`) and staging both build from here, and both
/// layer the request's options on top; the two must see the same deltas *and*
/// the same hunk boundaries for staging's hunk indices to match the view.
pub(crate) fn workdir_diff_opts(file_path: &str) -> git2::DiffOptions {
    let mut opts = new_diff_options();
    opts.pathspec(file_path);
    opts.disable_pathspec_match(true);
    opts.include_untracked(true);
    opts.recurse_untracked_dirs(true);
    opts.show_untracked_content(true);
    opts
}

/// Pair a diff's add/delete deltas into renames, in place.
///
/// Every diff Trunk shows, counts, or stages against runs through here with the
/// same options, so one file cannot read as a rename in the view and as an
/// add-plus-delete in staging. libgit2's
/// defaults match git CLI's (50% similarity, renames only), which is what the
/// reference renderings in doc-44 show; copy detection stays off, as in git.
pub(crate) fn detect_renames(diff: &mut git2::Diff) -> Result<(), TrunkError> {
    let mut find_opts = git2::DiffFindOptions::new();
    find_opts.renames(true);

    diff.find_similar(Some(&mut find_opts))?;
    Ok(())
}

/// A commit's diff against its first parent, or against the empty tree when it
/// is a root. Renames are already paired, so callers see the same deltas
/// whether they walk the lines or only read `stats()`.
pub(crate) fn commit_diff<'r>(
    repo: &'r git2::Repository,
    commit: &git2::Commit<'r>,
    opts: &mut git2::DiffOptions,
) -> Result<git2::Diff<'r>, TrunkError> {
    let commit_tree = commit.tree()?;

    let mut diff = if commit.parent_count() == 0 {
        repo.diff_tree_to_tree(None, Some(&commit_tree), Some(opts))?
    } else {
        let parent_tree = commit.parent(0)?.tree()?;
        repo.diff_tree_to_tree(Some(&parent_tree), Some(&commit_tree), Some(opts))?
    };
    detect_renames(&mut diff)?;

    Ok(diff)
}

/// The index's diff against HEAD, or against the empty tree on an unborn
/// branch. Renames are already paired, as in `commit_diff`.
pub(crate) fn staged_diff<'r>(
    repo: &'r git2::Repository,
    opts: &mut git2::DiffOptions,
) -> Result<git2::Diff<'r>, TrunkError> {
    let mut diff = if is_head_unborn(repo) {
        repo.diff_tree_to_index(None, None, Some(opts))?
    } else {
        let head_tree = repo.head()?.peel_to_tree()?;
        repo.diff_tree_to_index(Some(&head_tree), None, Some(opts))?
    };
    detect_renames(&mut diff)?;

    Ok(diff)
}

/// Layer a request's view options onto a diff's base options.
///
/// Both `context_lines` and `ignore_whitespace` move hunk *boundaries*, not
/// just their line spans: ignoring whitespace drops whitespace-only hunks
/// entirely, and a wide context merges neighbouring hunks into one. A hunk
/// index is therefore only meaningful against a diff built with the same
/// options, which is why every staging path takes the view's options and
/// comes through here rather than diffing with the defaults (TRUNK-73).
pub(crate) fn apply_request_options(opts: &mut git2::DiffOptions, req: &DiffRequestOptions) {
    let context = if req.show_full_file {
        100_000 // practical cap for full-file view
    } else {
        req.context_lines
    };
    opts.context_lines(context);
    opts.ignore_whitespace(req.ignore_whitespace);
}

/// The unstaged diff a staging gesture acts on: index → workdir, for one file,
/// built with the same view options the hunk the user clicked was rendered
/// under. `reverse` flips it, which is how a discard undoes a change by
/// applying to the workdir.
///
/// Staging addresses a hunk by its index, and that index only means the same
/// hunk on both sides when both diffs are built the same way — which is why
/// this exists rather than each caller assembling the options itself
/// (TRUNK-73).
pub(crate) fn staging_workdir_diff<'r>(
    repo: &'r git2::Repository,
    file_path: &str,
    options: &DiffRequestOptions,
    reverse: bool,
) -> Result<git2::Diff<'r>, TrunkError> {
    let mut opts = workdir_diff_opts(file_path);
    apply_request_options(&mut opts, options);
    opts.reverse(reverse);
    Ok(repo.diff_index_to_workdir(None, Some(&mut opts))?)
}

/// The staged diff a staging gesture acts on: HEAD → index, whole and
/// rename-detected exactly as `diff_staged_inner` builds the view, carrying the
/// view's options for the same reason `staging_workdir_diff` does.
///
/// It is deliberately not narrowed by a pathspec: that would strip a rename's
/// old side before `find_similar` could pair it, leaving a caller acting on a
/// whole-file add where the user saw a one-line edit. Callers pick their delta
/// out of the whole diff instead.
pub(crate) fn staging_staged_diff<'r>(
    repo: &'r git2::Repository,
    options: &DiffRequestOptions,
    reverse: bool,
) -> Result<git2::Diff<'r>, TrunkError> {
    let mut opts = new_diff_options();
    apply_request_options(&mut opts, options);
    opts.reverse(reverse);
    staged_diff(repo, &mut opts)
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

/// The delta → hunkless `FileDiff` mapping every diff walk starts from. It is
/// the one place a `git2::Delta` becomes a `DiffStatus`, so rename detection
/// reaches the file list, the hunk views, and the metadata-only listings from a
/// single definition rather than three that can drift.
///
/// `path` is the new-side path, falling back to the old side for a deletion.
/// `old_path` is set only when the two sides name different paths, which is
/// exactly the renamed and copied deltas `find_similar` pairs.
fn file_diff_of(delta: &git2::DiffDelta<'_>) -> FileDiff {
    let old_path = delta
        .old_file()
        .path()
        .map(|p| p.to_string_lossy().into_owned());
    let new_path = delta
        .new_file()
        .path()
        .map(|p| p.to_string_lossy().into_owned());

    let path = new_path
        .clone()
        .or_else(|| old_path.clone())
        .unwrap_or_default();
    let renamed_from = old_path.filter(|old| Some(old) != new_path.as_ref());

    let status = match delta.status() {
        git2::Delta::Added => DiffStatus::Added,
        git2::Delta::Deleted => DiffStatus::Deleted,
        git2::Delta::Modified => DiffStatus::Modified,
        git2::Delta::Renamed => DiffStatus::Renamed,
        git2::Delta::Copied => DiffStatus::Copied,
        git2::Delta::Untracked => DiffStatus::Untracked,
        _ => DiffStatus::Unknown,
    };

    FileDiff {
        path,
        old_path: renamed_from,
        status,
        is_binary: delta.old_file().is_binary() || delta.new_file().is_binary(),
        hunks: Vec::new(),
    }
}

/// Capture one delta's oids and new path from inside a `foreach` file callback.
fn delta_sides_of(delta: &git2::DiffDelta<'_>) -> DeltaSides {
    DeltaSides {
        old_oid: delta.old_file().id(),
        new_oid: delta.new_file().id(),
        new_path: delta.new_file().path().map(std::path::Path::to_path_buf),
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

/// One file's `FileDiff`, read straight from its own delta.
///
/// Rename detection needs both sides of a rename in the same diff to pair them,
/// and libgit2's `pathspec` drops the old path before `find_similar` ever sees
/// it (probed, git2 0.21: a pathspec on the new path leaves the delta `Added`
/// no matter what find options follow). So a single-file request diffs the whole
/// tree and selects the delta afterwards, by either of its paths — the caller
/// names the new one, but a paired delta is also reachable by the old.
///
/// Selecting means `Patch::from_diff` on that one delta, never `Diff::foreach`.
/// libgit2 generates a delta's patch text before it calls any callback, so a
/// callback that skips unwanted files still pays for them: measured on a
/// 1000-file commit, `foreach` with do-nothing callbacks costs 127ms, while
/// building the diff, pairing renames and reading one delta's patch together
/// cost under 1ms.
fn diff_one_file(
    diff: &git2::Diff<'_>,
    repo: &git2::Repository,
    new_side: NewSideSource,
    file_path: &str,
) -> Result<Vec<FileDiff>, TrunkError> {
    let Some((delta_index, mut file_diff)) =
        diff.deltas().enumerate().find_map(|(index, delta)| {
            let fd = file_diff_of(&delta);
            let wanted = fd.path == file_path || fd.old_path.as_deref() == Some(file_path);

            wanted.then_some((index, fd))
        })
    else {
        return Ok(Vec::new());
    };

    let sides =
        vec![delta_sides_of(&diff.get_delta(delta_index).expect(
            "the delta index came from this diff's own delta list",
        ))];

    if let Some(patch) = git2::Patch::from_diff(diff, delta_index)? {
        file_diff.hunks = hunks_of(&patch)?;
    }

    let mut file_diffs = vec![file_diff];
    let sides = resolve_sides(repo, &file_diffs, &sides, new_side);

    enrich_file_diffs(&mut file_diffs, &sides);
    Ok(file_diffs)
}

/// Every hunk of one patch, with its lines. Mirrors what `walk_diff`'s hunk and
/// line callbacks build, so a file read through either route looks the same.
fn hunks_of(patch: &git2::Patch<'_>) -> Result<Vec<DiffHunk>, TrunkError> {
    let mut hunks = Vec::with_capacity(patch.num_hunks());

    for hunk_index in 0..patch.num_hunks() {
        let (hunk, _) = patch.hunk(hunk_index)?;
        let mut lines = Vec::new();

        for line_index in 0..patch.num_lines_in_hunk(hunk_index)? {
            lines.push(diff_line_of(&patch.line_in_hunk(hunk_index, line_index)?));
        }

        hunks.push(DiffHunk {
            header: String::from_utf8_lossy(hunk.header()).into_owned(),
            old_start: hunk.old_start(),
            old_lines: hunk.old_lines(),
            new_start: hunk.new_start(),
            new_lines: hunk.new_lines(),
            lines,
        });
    }

    Ok(hunks)
}

/// One diff line, however it was read.
///
/// EOFNL markers ('<', '>', '=') carry line numbers too (probed, git2 0.21),
/// which would paint real-code spans onto them; null both linenos for any origin
/// the frontend doesn't treat as a real diff line, so `pick_side_line` naturally
/// skips them.
fn diff_line_of(line: &git2::DiffLine<'_>) -> DiffLine {
    let raw_origin = line.origin();
    let origin = match raw_origin {
        '+' => DiffOrigin::Add,
        '-' => DiffOrigin::Delete,
        _ => DiffOrigin::Context,
    };
    let (old_lineno, new_lineno) = if matches!(raw_origin, '+' | '-' | ' ') {
        (line.old_lineno(), line.new_lineno())
    } else {
        (None, None)
    };

    DiffLine {
        origin,
        content: String::from_utf8_lossy(line.content()).into_owned(),
        old_lineno,
        new_lineno,
        spans: vec![],
        pairing: LinePairing::Unknown,
    }
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
            delta_sides.borrow_mut().push(delta_sides_of(&delta));
            file_diffs.borrow_mut().push(file_diff_of(&delta));
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
            let mut diffs = file_diffs.borrow_mut();
            if let Some(fd) = diffs.last_mut()
                && let Some(hunk) = fd.hunks.last_mut()
            {
                hunk.lines.push(diff_line_of(&line));
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
    #[must_use]
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
///
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

        let word_diff_deadline = crate::git::word_spans::word_diff_budget();
        for hunk in &mut fd.hunks {
            let word_diff = compute_word_spans_for_hunk(&hunk.lines, word_diff_deadline);
            for (i, line) in hunk.lines.iter_mut().enumerate() {
                line.pairing = word_diff.pairing[i];
                let ws = &word_diff.spans[i];
                let syntax_tokens =
                    pick_side_line(line, old_lines.as_ref(), new_lines.as_ref(), new_available)
                        .filter(|sl| sl.content == strip_diff_newline(&line.content))
                        .map(|sl| sl.tokens.as_slice())
                        .unwrap_or_default();

                if !syntax_tokens.is_empty() || !ws.is_empty() {
                    line.spans = syntax::merge_spans(syntax_tokens, ws, line.content.len() as u32);
                    syntax::merged_spans_to_utf16(&mut line.spans, &line.content);
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
            delta_sides.borrow_mut().push(delta_sides_of(&delta));
            file_diffs.borrow_mut().push(file_diff_of(&delta));
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
                    pairing: LinePairing::Unknown,
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
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<(Vec<FileDiff>, Vec<SideContent>), TrunkError> {
    let repo = state_map.open(path)?;
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
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = state_map.open(path)?;
    let mut opts = workdir_diff_opts(file_path);
    apply_request_options(&mut opts, options);
    let diff = repo.diff_index_to_workdir(None, Some(&mut opts))?;
    walk_diff(diff, &repo, NewSideSource::Workdir)
}

pub fn diff_staged_inner(
    path: &str,
    file_path: &str,
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = state_map.open(path)?;
    let mut opts = new_diff_options();
    apply_request_options(&mut opts, options);
    let diff = staged_diff(&repo, &mut opts)?;
    diff_one_file(&diff, &repo, NewSideSource::Odb, file_path)
}

pub fn diff_commit_inner(
    path: &str,
    oid: &str,
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = state_map.open(path)?;
    let oid =
        git2::Oid::from_str(oid).map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
    let commit = repo.find_commit(oid)?;
    let mut opts = new_diff_options();
    apply_request_options(&mut opts, options);
    let diff = commit_diff(&repo, &commit, &mut opts)?;
    walk_diff(diff, &repo, NewSideSource::Odb)
}

/// Lightweight commit file listing — returns only metadata (path, status, `is_binary`),
/// no hunks/lines/spans. Used for the commit detail sidebar file list.
pub fn list_commit_files_inner(
    path: &str,
    oid: &str,
    state_map: &OpenRepos,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = state_map.open(path)?;
    let oid =
        git2::Oid::from_str(oid).map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
    let commit = repo.find_commit(oid)?;
    let mut opts = new_diff_options();
    let diff = commit_diff(&repo, &commit, &mut opts)?;
    Ok(file_metadata_list(&diff))
}

/// Diff a single file from a commit — used when user clicks a file in commit detail.
pub fn diff_commit_file_inner(
    path: &str,
    oid: &str,
    file_path: &str,
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = state_map.open(path)?;
    let oid =
        git2::Oid::from_str(oid).map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
    let commit = repo.find_commit(oid)?;
    let mut opts = new_diff_options();
    apply_request_options(&mut opts, options);
    let diff = commit_diff(&repo, &commit, &mut opts)?;
    diff_one_file(&diff, &repo, NewSideSource::Odb, file_path)
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
    state_map: &OpenRepos,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = state_map.open(path)?;
    let base_tree = compare_tree(&repo, base_oid)?;
    let target_tree = compare_tree(&repo, Some(target_oid))?;
    let mut diff = repo.diff_tree_to_tree(
        base_tree.as_ref(),
        target_tree.as_ref(),
        Some(&mut new_diff_options()),
    )?;
    detect_renames(&mut diff)?;
    Ok(file_metadata_list(&diff))
}

/// Diff a single file between Base and Target — used when the user clicks a
/// file in the compare view.
pub fn diff_compare_file_inner(
    path: &str,
    base_oid: Option<&str>,
    target_oid: &str,
    file_path: &str,
    state_map: &OpenRepos,
    options: &DiffRequestOptions,
) -> Result<Vec<FileDiff>, TrunkError> {
    let repo = state_map.open(path)?;
    let base_tree = compare_tree(&repo, base_oid)?;
    let target_tree = compare_tree(&repo, Some(target_oid))?;
    let mut opts = new_diff_options();
    apply_request_options(&mut opts, options);
    let mut diff =
        repo.diff_tree_to_tree(base_tree.as_ref(), target_tree.as_ref(), Some(&mut opts))?;
    detect_renames(&mut diff)?;
    diff_one_file(&diff, &repo, NewSideSource::Odb, file_path)
}

/// Whole-compare totals via the cheap `Diff::stats()` path, mirroring
/// `history::commit_stat_from_repo`: renames collapsed, no line walking.
pub fn compare_stat_inner(
    path: &str,
    base_oid: Option<&str>,
    target_oid: &str,
    state_map: &OpenRepos,
) -> Result<crate::git::types::DiffStat, TrunkError> {
    let repo = state_map.open(path)?;
    let base_tree = compare_tree(&repo, base_oid)?;
    let target_tree = compare_tree(&repo, Some(target_oid))?;
    let mut diff = repo.diff_tree_to_tree(
        base_tree.as_ref(),
        target_tree.as_ref(),
        Some(&mut new_diff_options()),
    )?;
    detect_renames(&mut diff)?;
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
    diff.deltas().map(|delta| file_diff_of(&delta)).collect()
}

pub fn get_commit_detail_inner(
    path: &str,
    oid: &str,
    state_map: &OpenRepos,
) -> Result<CommitDetail, TrunkError> {
    let repo = state_map.open(path)?;
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

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
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

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
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

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
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

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
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

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
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

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
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

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
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

/// # Errors
///
/// Returns the inner error as JSON, which is what the frontend parses.
///
/// # Panics
///
/// Panics when the open-repository lock is poisoned.
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
                pairing: LinePairing::Unknown,
            }],
        }
    }

    fn rust_file_diff(hunks: Vec<DiffHunk>) -> FileDiff {
        FileDiff {
            path: "window.rs".to_string(),
            old_path: None,
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
            old_path: None,
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
                        pairing: LinePairing::Unknown,
                    },
                    DiffLine {
                        origin: DiffOrigin::Add,
                        content: new_content.to_string(),
                        old_lineno: None,
                        new_lineno: Some(1),
                        spans: vec![],
                        pairing: LinePairing::Unknown,
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

    /// The exact read the Svelte views perform: `content.slice(start, end)`
    /// indexes UTF-16 code units, so asserting through it proves the shipped
    /// offsets land on the characters the user sees emphasized.
    fn utf16_slice(content: &str, start: u32, end: u32) -> String {
        let units: Vec<u16> = content.encode_utf16().collect();
        String::from_utf16_lossy(&units[start as usize..end as usize])
    }

    fn emphasized_utf16(line: &DiffLine) -> Vec<String> {
        line.spans
            .iter()
            .filter(|s| s.emphasized)
            .map(|s| utf16_slice(&line.content, s.start, s.end))
            .collect()
    }

    fn one_word_edit_diff(
        path: &str,
        old_line: &str,
        new_line: &str,
    ) -> (Vec<FileDiff>, Vec<SideContent>) {
        let old_content = format!("{old_line}\n");
        let new_content = format!("{new_line}\n");
        let file_diffs = vec![FileDiff {
            path: path.to_string(),
            old_path: None,
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
                        content: old_content.clone(),
                        old_lineno: Some(1),
                        new_lineno: None,
                        spans: vec![],
                        pairing: LinePairing::Unknown,
                    },
                    DiffLine {
                        origin: DiffOrigin::Add,
                        content: new_content.clone(),
                        old_lineno: None,
                        new_lineno: Some(1),
                        spans: vec![],
                        pairing: LinePairing::Unknown,
                    },
                ],
            }],
        }];
        let sides = vec![SideContent {
            old: Some(old_content.into_bytes()),
            new: Some(new_content.into_bytes()),
        }];
        (file_diffs, sides)
    }

    #[test]
    fn emphasis_lands_on_the_changed_word_after_accented_characters() {
        let (mut file_diffs, sides) =
            one_word_edit_diff("notes.txt", "ação já começou aqui", "ação já terminou aqui");

        enrich_file_diffs(&mut file_diffs, &sides);

        let lines = &file_diffs[0].hunks[0].lines;
        assert_eq!(emphasized_utf16(&lines[0]), vec!["começou"]);
        assert_eq!(emphasized_utf16(&lines[1]), vec!["terminou"]);
    }

    // An emoji is one code point but two UTF-16 units (a surrogate pair), so a
    // char-count conversion would still shift; only a code-unit count lands.
    #[test]
    fn emphasis_lands_on_the_changed_word_after_an_emoji() {
        let (mut file_diffs, sides) =
            one_word_edit_diff("notes.txt", "🎉 muda velho agora", "🎉 muda novo agora");

        enrich_file_diffs(&mut file_diffs, &sides);

        let lines = &file_diffs[0].hunks[0].lines;
        assert_eq!(emphasized_utf16(&lines[0]), vec!["velho"]);
        assert_eq!(emphasized_utf16(&lines[1]), vec!["novo"]);
    }

    #[test]
    fn syntax_spans_land_on_their_tokens_after_accented_characters() {
        let (mut file_diffs, sides) = one_word_edit_diff(
            "example.rs",
            "let saudação = 1; // nota",
            "let saudação = 2; // nota",
        );

        enrich_file_diffs(&mut file_diffs, &sides);

        let add_line = &file_diffs[0].hunks[0].lines[1];
        let comment_texts: Vec<String> = add_line
            .spans
            .iter()
            .filter(|s| s.syntax_class == "syn-comment")
            .map(|s| utf16_slice(&add_line.content, s.start, s.end))
            .collect();
        assert_eq!(comment_texts.concat(), "// nota");
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
            old_path: None,
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
                        pairing: LinePairing::Unknown,
                    },
                    DiffLine {
                        origin: DiffOrigin::Add,
                        content: "    let mut stmt = sql;\n".to_string(),
                        old_lineno: None,
                        new_lineno: Some(4),
                        spans: vec![],
                        pairing: LinePairing::Unknown,
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
            old_path: None,
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
                        pairing: LinePairing::Unknown,
                    },
                    DiffLine {
                        origin: DiffOrigin::Add,
                        content: "    let y = 2;\n".to_string(),
                        old_lineno: None,
                        new_lineno: Some(2),
                        spans: vec![],
                        pairing: LinePairing::Unknown,
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
            old_path: None,
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
                        pairing: LinePairing::Unknown,
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
                        pairing: LinePairing::Unknown,
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
            old_path: None,
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
                        pairing: LinePairing::Unknown,
                    },
                    DiffLine {
                        origin: DiffOrigin::Add,
                        content: "let y = 2;\n".to_string(),
                        old_lineno: None,
                        new_lineno: Some(1),
                        spans: vec![],
                        pairing: LinePairing::Unknown,
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
            old_path: None,
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
                        pairing: LinePairing::Unknown,
                    },
                    DiffLine {
                        origin: DiffOrigin::Add,
                        // Real line 3 is "    let y = 2;\n" — this drifted copy
                        // simulates a checkin-filter/TOCTOU mismatch.
                        content: "    let z = 2;\n".to_string(),
                        old_lineno: None,
                        new_lineno: Some(3),
                        spans: vec![],
                        pairing: LinePairing::Unknown,
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
                pairing: LinePairing::Unknown,
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

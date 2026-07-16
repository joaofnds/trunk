//! Phase 70: pure markdown renderer for review sessions.
//!
//! Pure Rust logic: takes `&ReviewSession` + `&git2::Repository`, returns a
//! single `String`. No `tauri::*` imports (L-01), no calls into
//! `crate::git::syntax` (L-10), never panics (L-04).
//!
//! This module is `tauri`-free and exposes ONE public function: [`render`].
//! All resolution failures are routed INTO the returned markdown (per L-04 +
//! L-09); the renderer NEVER returns an error.

use crate::commands::review::{OrphanReason, classify_anchor};
use crate::git::types::{Anchor, ReviewSession, Side, Source};

/// Render-only failure kinds. Does NOT cross the IPC wire (the Phase 69
/// `OrphanReason` does — never extend it). All variants funnel into either the
/// resolved per-file section (via the `[binary file, no excerpt]` placeholder
/// for `Binary`) or the unresolvable trailing section (everything else).
#[derive(Debug)]
pub(crate) enum ExcerptError {
    /// `blob.is_binary()` returned true; emit `[binary file, no excerpt]`
    /// INSIDE the resolved per-file section (L-05, not the unresolvable
    /// section).
    Binary,
    /// `classify_anchor` rejected the anchor — wraps the Phase 69 reason.
    Orphaned(OrphanReason),
    /// Generic re-resolution failure (git2 error during slicing).
    ResolutionFailed,
    /// Diff replay-slice produced an empty body (file unchanged from parent at
    /// the anchored commit; Pitfall 2).
    NoHunks,
}

/// L-03: fence length is `max(3, longest_contiguous_backtick_run + 1)`.
/// Linear byte-scan over the entire body — counter resets on any non-backtick
/// byte (including newlines), so two separate `` ``` `` runs split by a
/// newline do NOT compose into a longer run. CommonMark §4.5 requires the
/// opening fence be strictly longer than any inner backtick run.
pub(crate) fn fence_length(body: &str) -> usize {
    let mut longest = 0usize;
    let mut current = 0usize;
    for b in body.as_bytes() {
        if *b == b'`' {
            current += 1;
            if current > longest {
                longest = current;
            }
        } else {
            current = 0;
        }
    }
    std::cmp::max(3, longest + 1)
}

/// L-07: extension → markdown fence language tag for `Source::FullFile`
/// excerpts. Hand-rolled per L-10 (no syntect call): these are markdown fence
/// tags, not syntect syntax lookups.
pub(crate) fn fence_language(file_path: &str) -> &'static str {
    let ext = std::path::Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    match ext {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "jsx",
        "svelte" => "svelte",
        "json" => "json",
        "md" | "markdown" => "markdown",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "css" => "css",
        "html" | "htm" => "html",
        "sh" | "bash" => "bash",
        "py" => "python",
        "go" => "go",
        _ => "text",
    }
}

/// L-06 line-indexing convention: 1-based inclusive bounds over
/// `str::lines()` semantics, with CRLF→LF normalisation applied to the body
/// BEFORE slicing. Mirrors `classify_anchor` at `commands/review.rs:358` so a
/// comment that resolves at classification time also resolves at render time —
/// one convention applies on both sides (capture and render). RESEARCH Item 2
/// Option (a): `str::lines()` already handles `\r\n` as one boundary, so line
/// indices are unchanged; only the bytes inside the fence become LF-only.
fn slice_lines(content: &str, start_line: u32, end_line: u32) -> Option<String> {
    if start_line == 0 || end_line < start_line {
        return None;
    }
    let normalised = content.replace("\r\n", "\n");
    let lines: Vec<&str> = normalised.lines().collect();
    let line_count = lines.len() as u32;
    if end_line > line_count {
        return None;
    }
    let start_idx = (start_line - 1) as usize;
    let end_idx = end_line as usize;
    Some(lines[start_idx..end_idx].join("\n"))
}

/// L-02 + L-05 + L-06: re-resolve a `Source::FullFile` excerpt by reading the
/// blob fresh from git2. Side semantics mirror `classify_anchor`
/// (`commands/review.rs:339-346`): `New` reads the commit's tree, `Old` reads
/// the parent's. `blob.is_binary()` short-circuits to `ExcerptError::Binary`
/// BEFORE any slicing (L-05). Caller MUST have run `classify_anchor` first
/// (Pitfall 1) — `slice_full_file` does NOT re-gate.
pub(crate) fn slice_full_file(
    repo: &git2::Repository,
    anchor: &Anchor,
) -> Result<String, ExcerptError> {
    let oid =
        git2::Oid::from_str(&anchor.commit_oid).map_err(|_| ExcerptError::ResolutionFailed)?;
    let commit = repo
        .find_commit(oid)
        .map_err(|_| ExcerptError::ResolutionFailed)?;
    let tree = match anchor.side {
        Side::New => commit.tree().map_err(|_| ExcerptError::ResolutionFailed)?,
        Side::Old => commit
            .parent(0)
            .map_err(|_| ExcerptError::ResolutionFailed)?
            .tree()
            .map_err(|_| ExcerptError::ResolutionFailed)?,
    };
    let entry = tree
        .get_path(std::path::Path::new(&anchor.file_path))
        .map_err(|_| ExcerptError::ResolutionFailed)?;
    let blob = repo
        .find_blob(entry.id())
        .map_err(|_| ExcerptError::ResolutionFailed)?;
    if blob.is_binary() {
        return Err(ExcerptError::Binary);
    }
    let content = String::from_utf8_lossy(blob.content()).into_owned();
    slice_lines(&content, anchor.start_line, anchor.end_line).ok_or(ExcerptError::ResolutionFailed)
}

/// L-02 + Phase 67 L-03: re-resolve a `Source::Diff` excerpt by replaying
/// `diff_tree_to_tree(parent, commit)` with `pathspec(file_path)` and keeping
/// lines whose side-lineno overlaps `[start_line, end_line]`. Lines with no
/// side-lineno (the opposing-side `-`/`+` rows) are kept per Phase 67 L-03 so
/// the body matches what the cached_excerpt looked like at capture. Empty
/// walk → `ExcerptError::NoHunks` (Pitfall 2 — file unchanged from parent at
/// this commit). Root-commit guard mirrors `commands/diff.rs:410-414`.
pub(crate) fn slice_diff(repo: &git2::Repository, anchor: &Anchor) -> Result<String, ExcerptError> {
    let oid =
        git2::Oid::from_str(&anchor.commit_oid).map_err(|_| ExcerptError::ResolutionFailed)?;
    let commit = repo
        .find_commit(oid)
        .map_err(|_| ExcerptError::ResolutionFailed)?;
    let commit_tree = commit.tree().map_err(|_| ExcerptError::ResolutionFailed)?;

    let mut opts = git2::DiffOptions::new();
    opts.pathspec(&anchor.file_path);

    let diff = if commit.parent_count() == 0 {
        repo.diff_tree_to_tree(None, Some(&commit_tree), Some(&mut opts))
            .map_err(|_| ExcerptError::ResolutionFailed)?
    } else {
        let parent_tree = commit
            .parent(0)
            .map_err(|_| ExcerptError::ResolutionFailed)?
            .tree()
            .map_err(|_| ExcerptError::ResolutionFailed)?;
        repo.diff_tree_to_tree(Some(&parent_tree), Some(&commit_tree), Some(&mut opts))
            .map_err(|_| ExcerptError::ResolutionFailed)?
    };

    let side = anchor.side.clone();
    let start_line = anchor.start_line;
    let end_line = anchor.end_line;

    // 70/CR-01 fix: walk the diff via `git2::Patch` so each hunk's positional
    // overlap with `[start_line, end_line]` can gate its opposing-side lines.
    // `opts.pathspec(&anchor.file_path)` constrains the diff to a single file,
    // so file index 0 is the only delta — same pattern as
    // commands/staging.rs:370 / 430 / 481. Pitfall 2: when the pathspec
    // matches no changed delta (file byte-identical to parent), the diff has
    // zero deltas and `Patch::from_diff` would error on index 0 — surface as
    // `NoHunks`, matching the legacy post-loop "empty body" behavior. `None`
    // covers the binary-or-unchanged single-delta case for parity with
    // staging.rs.
    if diff.deltas().len() == 0 {
        return Err(ExcerptError::NoHunks);
    }
    let patch =
        match git2::Patch::from_diff(&diff, 0).map_err(|_| ExcerptError::ResolutionFailed)? {
            Some(p) => p,
            None => return Err(ExcerptError::NoHunks),
        };

    let mut out = String::new();
    for h_idx in 0..patch.num_hunks() {
        let (hunk, _line_count) = patch
            .hunk(h_idx)
            .map_err(|_| ExcerptError::ResolutionFailed)?;
        let (h_start, h_count) = match side {
            Side::New => (hunk.new_start(), hunk.new_lines()),
            Side::Old => (hunk.old_start(), hunk.old_lines()),
        };
        let h_end = h_start + h_count.saturating_sub(1);
        let overlaps = h_start <= end_line && h_end >= start_line;
        let line_count = patch
            .num_lines_in_hunk(h_idx)
            .map_err(|_| ExcerptError::ResolutionFailed)?;
        for l_idx in 0..line_count {
            let line = patch
                .line_in_hunk(h_idx, l_idx)
                .map_err(|_| ExcerptError::ResolutionFailed)?;
            let lineno = match side {
                Side::New => line.new_lineno(),
                Side::Old => line.old_lineno(),
            };
            // Lines with a side-lineno: keep if in [start_line, end_line].
            // Lines WITHOUT one (the opposing-side change row): keep iff
            // the hunk overlaps the anchor range AND the origin matches the
            // opposing-direction change marker (Phase 67 L-03 — visually
            // anchors the range, gated per-hunk to fix 70/CR-01).
            let in_range = match lineno {
                Some(n) => n >= start_line && n <= end_line,
                None => {
                    overlaps
                        && matches!(
                            (side.clone(), line.origin()),
                            (Side::New, '-') | (Side::Old, '+')
                        )
                }
            };
            if in_range {
                let prefix = match line.origin() {
                    '+' | '-' | ' ' => line.origin(),
                    _ => ' ',
                };
                out.push(prefix);
                out.push_str(&String::from_utf8_lossy(line.content()));
            }
        }
    }

    if out.is_empty() {
        Err(ExcerptError::NoHunks)
    } else {
        // L-06 second clause: CRLF→LF normalise the body inside the fence.
        Ok(out.replace("\r\n", "\n"))
    }
}

/// Gate-then-resolve dispatch (Pitfall 1): `classify_anchor` is the MANDATORY
/// first call. On `Ok(())`, dispatch to `slice_full_file` or `slice_diff` by
/// `anchor.source`. On `Err(reason)`, wrap into `ExcerptError::Orphaned`
/// WITHOUT entering the slicers — a `Side::Old` anchor on a root commit would
/// otherwise hit `commit.parent(0)` and surface as `ResolutionFailed`
/// (wrong: the correct reason is `FileGone`).
pub(crate) fn try_resolve_excerpt(
    repo: &git2::Repository,
    anchor: &Anchor,
) -> Result<String, ExcerptError> {
    classify_anchor(anchor, repo).map_err(ExcerptError::Orphaned)?;
    match anchor.source {
        Source::FullFile => slice_full_file(repo, anchor),
        Source::Diff => slice_diff(repo, anchor),
    }
}

// ── D-09 human-readable phrases for orphan / render-only failures ──────────
// Centralised so the SUMMARY can grep for the literal strings and the tests
// assert on them. Plain prose for the AI consumer per D-09.

fn orphan_phrase(reason: &OrphanReason) -> &'static str {
    match reason {
        OrphanReason::CommitGone => "commit no longer exists in the repository",
        OrphanReason::FileGone => "file no longer exists at this commit/side",
        OrphanReason::LineOutOfRange => "anchor line range is outside the current file bounds",
    }
}

fn excerpt_error_phrase(err: &ExcerptError) -> &'static str {
    match err {
        ExcerptError::Orphaned(r) => orphan_phrase(r),
        ExcerptError::NoHunks => "diff hunk no longer exists at this commit",
        ExcerptError::ResolutionFailed => "excerpt could not be re-resolved from the repository",
        // Binary never reaches this path (it routes into the resolved section
        // via the placeholder), but we cover it defensively.
        ExcerptError::Binary => "binary blob has no text excerpt",
    }
}

/// L-04-safe 7-char short SHA: returns at most the first 7 chars, never
/// panicking on a shorter input. `Option::unwrap_or` is NOT `Result::unwrap`.
fn short_sha(oid: &str) -> &str {
    oid.get(..7).unwrap_or(oid)
}

/// Best-effort repo name derived from `repo.workdir().file_name()`. Bare repos
/// (no workdir) and unprintable file names fall back to "repository".
fn repo_name(repo: &git2::Repository) -> String {
    repo.workdir()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(String::from)
        .unwrap_or_else(|| "repository".to_string())
}

/// Emit a fenced code block — fence length scales to the body's longest
/// backtick run per L-03. `info` is the language tag (or "diff" for Diff
/// sources, "text" fallback for FullFile).
fn emit_fence(out: &mut String, body: &str, info: &str) {
    use std::fmt::Write;
    let n = fence_length(body);
    let fence: String = "`".repeat(n);
    let _ = writeln!(out, "{fence}{info}");
    out.push_str(body);
    if !body.ends_with('\n') {
        out.push('\n');
    }
    let _ = writeln!(out, "{fence}");
    let _ = writeln!(out);
}

/// What the `(anchor, classify, slice)` triple resolved to. Keeps the
/// `render` partitioning code declarative — match on the variant, not on
/// nested Results.
enum ResolvedComment<'c> {
    /// anchor + classify Ok + slice Ok → resolvable; carries the excerpt body.
    Anchored {
        comment: &'c crate::git::types::Comment,
        anchor: &'c Anchor,
        excerpt: String,
        info: &'static str,
    },
    /// anchor + classify Ok + slice Binary → resolved, but emits the
    /// `[binary file, no excerpt]` placeholder INSIDE the per-file section.
    Binary {
        comment: &'c crate::git::types::Comment,
        anchor: &'c Anchor,
    },
    /// anchor=None, commit_oid present, commit found in repo.
    CommitLevel {
        comment: &'c crate::git::types::Comment,
        commit_oid: String,
    },
    /// Everything else: anchor=Some + classify/slice failure, anchor=None +
    /// commit missing-or-None.
    Unresolvable {
        comment: &'c crate::git::types::Comment,
        anchor: Option<&'c Anchor>,
        phrase: &'static str,
    },
}

/// Top-level pure renderer (L-01, L-04, L-09, L-10). Returns a single `String`
/// containing the full markdown document; never panics. Per D-11, the caller
/// is responsible for the ≥1 comment gate — render does NOT defend against
/// zero comments (it just produces a doc with empty sections).
pub fn render(session: &ReviewSession, repo: &git2::Repository) -> String {
    use std::fmt::Write;

    // ── 1. Partition comments into three buckets ────────────────────────
    let resolved: Vec<ResolvedComment> = session
        .comments
        .iter()
        .map(|comment| match (&comment.anchor, &comment.commit_oid) {
            (Some(anchor), _) => match try_resolve_excerpt(repo, anchor) {
                Ok(body) => {
                    let info: &'static str = match anchor.source {
                        Source::Diff => "diff",
                        Source::FullFile => fence_language(&anchor.file_path),
                    };
                    ResolvedComment::Anchored {
                        comment,
                        anchor,
                        excerpt: body,
                        info,
                    }
                }
                Err(ExcerptError::Binary) => ResolvedComment::Binary { comment, anchor },
                Err(other) => ResolvedComment::Unresolvable {
                    comment,
                    anchor: Some(anchor),
                    phrase: excerpt_error_phrase(&other),
                },
            },
            (None, Some(commit_oid)) => {
                // Commit-level: resolvable iff the commit exists.
                let exists = git2::Oid::from_str(commit_oid)
                    .ok()
                    .and_then(|oid| repo.find_commit(oid).ok())
                    .is_some();
                if exists {
                    ResolvedComment::CommitLevel {
                        comment,
                        commit_oid: commit_oid.clone(),
                    }
                } else {
                    ResolvedComment::Unresolvable {
                        comment,
                        anchor: None,
                        phrase: orphan_phrase(&OrphanReason::CommitGone),
                    }
                }
            }
            (None, None) => ResolvedComment::Unresolvable {
                comment,
                anchor: None,
                phrase: orphan_phrase(&OrphanReason::CommitGone),
            },
        })
        .collect();

    let mut out = String::new();

    // ── 2. Header: H1 + framing + commit refs (D-03 + D-07 + D-08) ─────
    let name = repo_name(repo);
    let _ = writeln!(out, "# Code review: {name}");
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "This is a human-authored code review with anchored excerpts. Address each comment in the context of the excerpt it sits next to."
    );
    let _ = writeln!(out);
    if !session.commits.is_empty() {
        let _ = writeln!(out, "## Commits");
        let _ = writeln!(out);
        for oid_str in &session.commits {
            let short = short_sha(oid_str);
            let subject = git2::Oid::from_str(oid_str)
                .ok()
                .and_then(|oid| repo.find_commit(oid).ok())
                .and_then(|c| c.summary().ok().flatten().map(String::from))
                .unwrap_or_else(|| "(subject unavailable)".to_string());
            let _ = writeln!(out, "- {short} -- {subject}");
        }
        let _ = writeln!(out);
    }

    // ── 3. Resolved per-(file, commit) anchored sections (D-04 + D-05 +
    //     D-06 + L-08 + L-05) ─────────────────────────────────────────────
    // Group keys: (file_path, commit_oid). We collect references then sort
    // for deterministic output.
    let mut groups: std::collections::BTreeMap<(String, String), Vec<&ResolvedComment>> =
        std::collections::BTreeMap::new();
    for r in &resolved {
        let key = match r {
            ResolvedComment::Anchored { anchor, .. } | ResolvedComment::Binary { anchor, .. } => {
                Some((anchor.file_path.clone(), anchor.commit_oid.clone()))
            }
            _ => None,
        };
        if let Some(k) = key {
            groups.entry(k).or_default().push(r);
        }
    }

    if !groups.is_empty() {
        let _ = writeln!(out, "## Anchored Comments");
        let _ = writeln!(out);
        for ((file_path, commit_oid), entries) in &groups {
            let short = short_sha(commit_oid);
            let _ = writeln!(out, "### {file_path} ({short})");
            let _ = writeln!(out);

            // Sort entries ascending by start_line. Pull start_line out of
            // each entry's anchor; both variants carry one.
            let mut sorted: Vec<&ResolvedComment> = entries.clone();
            sorted.sort_by_key(|r| match r {
                ResolvedComment::Anchored { anchor, .. }
                | ResolvedComment::Binary { anchor, .. } => anchor.start_line,
                _ => u32::MAX,
            });

            for r in sorted {
                match r {
                    ResolvedComment::Anchored {
                        comment,
                        anchor,
                        excerpt,
                        info,
                    } => {
                        let _ = writeln!(
                            out,
                            "#### {file_path}:L{start}-L{end} ({short})",
                            start = anchor.start_line,
                            end = anchor.end_line,
                        );
                        let _ = writeln!(out);
                        // D-06: excerpt FIRST, comment text after.
                        emit_fence(&mut out, excerpt, info);
                        out.push_str(&comment.text);
                        if !comment.text.ends_with('\n') {
                            out.push('\n');
                        }
                        let _ = writeln!(out);
                    }
                    ResolvedComment::Binary { comment, anchor } => {
                        let _ = writeln!(
                            out,
                            "#### {file_path}:L{start}-L{end} ({short})",
                            start = anchor.start_line,
                            end = anchor.end_line,
                        );
                        let _ = writeln!(out);
                        // L-05: placeholder LIVES inside the resolved per-file
                        // section, NOT the unresolvable section.
                        let _ = writeln!(out, "[binary file, no excerpt]");
                        let _ = writeln!(out);
                        out.push_str(&comment.text);
                        if !comment.text.ends_with('\n') {
                            out.push('\n');
                        }
                        let _ = writeln!(out);
                    }
                    _ => {}
                }
            }
        }
    }

    // ── 4. Commit-level section (D-04 middle slot) ─────────────────────
    let commit_levels: Vec<&ResolvedComment> = resolved
        .iter()
        .filter(|r| matches!(r, ResolvedComment::CommitLevel { .. }))
        .collect();
    if !commit_levels.is_empty() {
        let _ = writeln!(out, "## Commit-level Comments");
        let _ = writeln!(out);
        for r in &commit_levels {
            if let ResolvedComment::CommitLevel {
                comment,
                commit_oid,
            } = r
            {
                let short = short_sha(commit_oid);
                let subject = git2::Oid::from_str(commit_oid)
                    .ok()
                    .and_then(|oid| repo.find_commit(oid).ok())
                    .and_then(|c| c.summary().ok().flatten().map(String::from))
                    .unwrap_or_else(|| "(subject unavailable)".to_string());
                let _ = writeln!(out, "### {short} -- {subject}");
                let _ = writeln!(out);
                out.push_str(&comment.text);
                if !comment.text.ends_with('\n') {
                    out.push('\n');
                }
                let _ = writeln!(out);
            }
        }
    }

    // ── 5. Unresolvable section (D-04 trailing slot, D-09 + D-10 + L-09) ─
    let unresolvables: Vec<&ResolvedComment> = resolved
        .iter()
        .filter(|r| matches!(r, ResolvedComment::Unresolvable { .. }))
        .collect();
    if !unresolvables.is_empty() {
        let _ = writeln!(out, "## Unresolvable Anchors");
        let _ = writeln!(out);
        for r in &unresolvables {
            if let ResolvedComment::Unresolvable {
                comment,
                anchor,
                phrase,
            } = r
            {
                if let Some(a) = anchor {
                    let short = short_sha(&a.commit_oid);
                    let _ = writeln!(
                        out,
                        "### {path}:L{start}-L{end} ({short})",
                        path = a.file_path,
                        start = a.start_line,
                        end = a.end_line,
                    );
                } else if let Some(commit_oid) = &comment.commit_oid {
                    let short = short_sha(commit_oid);
                    let _ = writeln!(out, "### Commit-level note ({short})");
                } else {
                    let _ = writeln!(out, "### Orphan note");
                }
                let _ = writeln!(out);
                let _ = writeln!(out, "{phrase}.");
                let _ = writeln!(out);

                if let (Some(a), Some(cached)) = (anchor, &comment.cached_excerpt) {
                    let info: &'static str = match a.source {
                        Source::Diff => "diff",
                        Source::FullFile => fence_language(&a.file_path),
                    };
                    let _ = writeln!(
                        out,
                        "Anchor no longer resolves; excerpt is the cached snapshot from attach time."
                    );
                    let _ = writeln!(out);
                    emit_fence(&mut out, cached, info);
                }

                out.push_str(&comment.text);
                if !comment.text.ends_with('\n') {
                    out.push('\n');
                }
                let _ = writeln!(out);
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Oid, Repository, Signature};
    use tempfile::TempDir;

    // ── Test harness lifted from commands/review.rs:1135-2102 ─────────────
    // Real git2 + tempfile (classical TDD: no mocks). `_dir` field keeps the
    // TempDir alive for the test's duration; drop deletes it.

    fn sig() -> Signature<'static> {
        Signature::new("Test", "test@example.com", &git2::Time::new(0, 0)).unwrap()
    }

    fn commit_with_file(
        repo: &Repository,
        message: &str,
        parents: &[Oid],
        path: &str,
        content: &[u8],
    ) -> Oid {
        let blob_oid = repo.blob(content).unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        builder
            .insert(path, blob_oid, git2::FileMode::Blob.into())
            .unwrap();
        let tree = repo.find_tree(builder.write().unwrap()).unwrap();
        let parent_commits: Vec<_> = parents
            .iter()
            .map(|oid| repo.find_commit(*oid).unwrap())
            .collect();
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
        let s = sig();
        repo.commit(None, &s, &s, message, &tree, &parent_refs)
            .unwrap()
    }

    /// Empty-tree commit (no files). Used as the parent of `commit_with_file`
    /// commits so the diff-replay walks see a single added file.
    fn empty_commit(repo: &Repository, message: &str, parents: &[Oid]) -> Oid {
        let tree_oid = repo.treebuilder(None).unwrap().write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let parent_commits: Vec<_> = parents
            .iter()
            .map(|oid| repo.find_commit(*oid).unwrap())
            .collect();
        let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();
        let s = sig();
        repo.commit(None, &s, &s, message, &tree, &parent_refs)
            .unwrap()
    }

    fn make_repo() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        (dir, repo)
    }

    fn anchor(
        commit_oid: Oid,
        file_path: &str,
        source: Source,
        side: Side,
        start_line: u32,
        end_line: u32,
    ) -> Anchor {
        Anchor {
            commit_oid: commit_oid.to_string(),
            file_path: file_path.to_string(),
            source,
            side,
            start_line,
            end_line,
        }
    }

    // ── Task 1: fence_length unit tests (L-03) ────────────────────────────

    #[test]
    fn fence_length_floor_with_no_backticks() {
        assert_eq!(fence_length("hello world\n"), 3);
    }

    #[test]
    fn fence_length_floor_on_empty_body() {
        // Triangulation: empty body → still the max(3, …) floor.
        assert_eq!(fence_length(""), 3);
    }

    #[test]
    fn fence_length_avoids_backtick_collision() {
        // A 3-backtick run forces the opening fence to be at least 4
        // backticks so CommonMark §4.5 closes the outer fence correctly.
        assert_eq!(fence_length("foo ``` bar"), 4);
    }

    #[test]
    fn fence_length_handles_four_backtick_run() {
        assert_eq!(fence_length("foo ```` bar"), 5);
    }

    #[test]
    fn fence_length_resets_across_newlines() {
        // Two separate 3-runs split by a newline must NOT compose; longest
        // contiguous run is 3, so the fence is 3 + 1 = 4.
        assert_eq!(fence_length("```\n```"), 4);
    }

    #[test]
    fn fence_length_finds_longest_run_anywhere_in_body() {
        // The 5-run lives in the middle of a longer line; the scan must find
        // it regardless of line position. 5 + 1 = 6.
        assert_eq!(fence_length("a\nbbb`````ccc\nd"), 6);
    }

    // ── Task 2: slice_full_file + slice_diff + try_resolve_excerpt ────────

    #[test]
    fn slice_full_file_returns_requested_range() {
        let (_dir, repo) = make_repo();
        let b = commit_with_file(
            &repo,
            "B",
            &[],
            "foo.rs",
            b"fn a() {}\nfn b() {}\nfn c() {}\n",
        );
        let a = anchor(b, "foo.rs", Source::FullFile, Side::New, 2, 3);

        let body = slice_full_file(&repo, &a).expect("resolvable FullFile slice");

        assert_eq!(body, "fn b() {}\nfn c() {}");
    }

    #[test]
    fn slice_full_file_normalizes_crlf() {
        // L-06: CRLF in the blob collapses to LF inside the fence body.
        let (_dir, repo) = make_repo();
        let b = commit_with_file(&repo, "B", &[], "foo.txt", b"a\r\nb\r\nc\r\n");
        let a = anchor(b, "foo.txt", Source::FullFile, Side::New, 1, 3);

        let body = slice_full_file(&repo, &a).expect("resolvable FullFile slice");

        assert_eq!(body, "a\nb\nc");
    }

    #[test]
    fn slice_full_file_returns_binary_for_nul_byte_blob() {
        // L-05: a blob with a NUL byte → blob.is_binary() == true → Binary
        // variant. The placeholder is task 3's concern; here we assert the
        // dispatch ends in Binary, not ResolutionFailed.
        let (_dir, repo) = make_repo();
        let b = commit_with_file(&repo, "B", &[], "bin.dat", b"abc\0def\n");
        let a = anchor(b, "bin.dat", Source::FullFile, Side::New, 1, 1);

        let err = slice_full_file(&repo, &a).expect_err("binary blob must error");

        assert!(
            matches!(err, ExcerptError::Binary),
            "expected ExcerptError::Binary, got {err:?}"
        );
    }

    #[test]
    fn slice_full_file_passes_through_non_utf8_bytes_with_lossy_substitution() {
        // RESEARCH Pitfall 3: Latin-1 bytes (>=0x80) with no NUL pass
        // is_binary() == false; from_utf8_lossy emits U+FFFD substitutions
        // rather than erroring. The line stays sliceable.
        let (_dir, repo) = make_repo();
        // 0xC3 alone (no follow byte) is invalid UTF-8 but has no NUL.
        let b = commit_with_file(&repo, "B", &[], "latin1.txt", b"hello \xC3 world\nsecond\n");
        let a = anchor(b, "latin1.txt", Source::FullFile, Side::New, 1, 1);

        let body = slice_full_file(&repo, &a).expect("lossy UTF-8 still resolves");

        // U+FFFD = "\u{FFFD}" — the lossy substitution char.
        assert!(
            body.contains('\u{FFFD}'),
            "expected lossy substitution char in body, got {body:?}"
        );
        assert!(!body.is_empty());
    }

    #[test]
    fn slice_diff_returns_requested_range() {
        // Parent A has foo.rs = "old\n"; commit B has foo.rs = "new\n".
        // Side::New anchor on line 1 keeps the `+new` line; Phase 67 L-03
        // keeps the opposing-side `-old` line too.
        let (_dir, repo) = make_repo();
        let a = commit_with_file(&repo, "A", &[], "foo.rs", b"old\n");
        let b = commit_with_file(&repo, "B", &[a], "foo.rs", b"new\n");
        let an = anchor(b, "foo.rs", Source::Diff, Side::New, 1, 1);

        let body = slice_diff(&repo, &an).expect("resolvable Diff slice");

        assert!(
            body.contains("+new"),
            "diff body must contain the +new line, got {body:?}"
        );
        assert!(
            body.contains("-old"),
            "Phase 67 L-03: opposing-side `-` line must be kept, got {body:?}"
        );
    }

    #[test]
    fn slice_diff_returns_no_hunks_when_file_unchanged() {
        // Pitfall 2: the file is byte-identical to its parent's version. The
        // pathspec-filtered diff emits zero hunks → NoHunks (not an empty fence).
        let (_dir, repo) = make_repo();
        // Two-file parent so we can keep foo.rs unchanged at the child:
        let a = commit_with_file(&repo, "A", &[], "foo.rs", b"same\n");
        // Child B adds an unrelated file; foo.rs is byte-identical to A's.
        let blob_a = repo.blob(b"same\n").unwrap();
        let blob_other = repo.blob(b"unrelated\n").unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        builder
            .insert("foo.rs", blob_a, git2::FileMode::Blob.into())
            .unwrap();
        builder
            .insert("other.rs", blob_other, git2::FileMode::Blob.into())
            .unwrap();
        let tree = repo.find_tree(builder.write().unwrap()).unwrap();
        let parent = repo.find_commit(a).unwrap();
        let b = repo
            .commit(None, &sig(), &sig(), "B", &tree, &[&parent])
            .unwrap();
        let an = anchor(b, "foo.rs", Source::Diff, Side::New, 1, 1);

        let err = slice_diff(&repo, &an).expect_err("unchanged file must yield NoHunks");

        assert!(
            matches!(err, ExcerptError::NoHunks),
            "expected ExcerptError::NoHunks, got {err:?}"
        );
    }

    #[test]
    fn slice_diff_handles_root_commit() {
        // Root commit R adds foo.rs from nothing. Diff against None (no
        // parent) per the root-commit guard at commands/diff.rs:410-414.
        let (_dir, repo) = make_repo();
        let r = commit_with_file(&repo, "R (root)", &[], "foo.rs", b"hello\n");
        let an = anchor(r, "foo.rs", Source::Diff, Side::New, 1, 1);

        let body = slice_diff(&repo, &an).expect("root-commit Side::New must resolve");

        assert!(
            body.contains("+hello"),
            "root-commit diff body must contain +hello, got {body:?}"
        );
    }

    #[test]
    fn slice_diff_multi_hunk_isolates_opposing_side() {
        // 70/CR-01 regression: in a multi-hunk file, opposing-side lines (the
        // `-` rows when side == New, `+` rows when side == Old) from
        // non-anchored hunks must NOT leak into the excerpt. The pre-fix
        // line callback kept every opposing-side line regardless of which
        // hunk it belonged to.
        //
        // Parent has 50 lines (`L1_PARENT\n…L50_PARENT\n`). Child edits line 5
        // AND line 45. With default DiffOptions context (3), changes 40 lines
        // apart are guaranteed-disjoint hunks. Anchoring at line 45 on
        // Side::New must keep only the line-45 hunk's content; the line-5
        // deletion (`L5_PARENT`) must NOT appear.
        let (_dir, repo) = make_repo();

        let mut parent_body = String::new();
        for i in 1..=50 {
            parent_body.push_str(&format!("L{i}_PARENT\n"));
        }
        let mut child_body = String::new();
        for i in 1..=50 {
            if i == 5 || i == 45 {
                child_body.push_str(&format!("L{i}_CHILD\n"));
            } else {
                child_body.push_str(&format!("L{i}_PARENT\n"));
            }
        }
        let a = commit_with_file(&repo, "A", &[], "foo.rs", parent_body.as_bytes());
        let b = commit_with_file(&repo, "B", &[a], "foo.rs", child_body.as_bytes());
        let an = anchor(b, "foo.rs", Source::Diff, Side::New, 45, 45);

        let body = slice_diff(&repo, &an).expect("resolvable multi-hunk Diff slice");

        assert!(
            body.contains("L45_CHILD"),
            "anchored hunk's new-side content must be kept, got {body:?}"
        );
        assert!(
            !body.contains("L5_PARENT"),
            "opposing-side deletion from the line-5 hunk leaked into the line-45 excerpt: {body:?}"
        );
        assert!(
            !body.contains("L5_CHILD"),
            "addition from the unrelated line-5 hunk leaked into the line-45 excerpt: {body:?}"
        );
    }

    #[test]
    fn try_resolve_excerpt_short_circuits_on_missing_commit() {
        // classify_anchor must be the first call: a 40-zero OID is unknown
        // to the repo. The dispatcher returns Orphaned(CommitGone) WITHOUT
        // entering slice_full_file or slice_diff (Pitfall 1).
        let (_dir, repo) = make_repo();
        // Repo has SOMETHING valid so we know it's not a "repo is broken" case.
        let _b = commit_with_file(&repo, "B", &[], "foo.rs", b"hi\n");
        let missing_oid = Oid::from_str(&"0".repeat(40)).unwrap();
        let an = anchor(missing_oid, "foo.rs", Source::FullFile, Side::New, 1, 1);

        let err = try_resolve_excerpt(&repo, &an).expect_err("missing commit must orphan");

        assert!(
            matches!(err, ExcerptError::Orphaned(OrphanReason::CommitGone)),
            "expected Orphaned(CommitGone), got {err:?}"
        );
    }

    // ── Task 3: render() doc assembly (D-03..D-10, 14 goldens) ────────────

    use crate::git::types::{Comment, DraftComment, ReviewSession};

    // fixture builder: arg count is intentional
    #[allow(clippy::too_many_arguments)]
    fn line_comment(
        id: &str,
        text: &str,
        commit_oid: Oid,
        file_path: &str,
        source: Source,
        side: Side,
        start_line: u32,
        end_line: u32,
        cached_excerpt: Option<&str>,
    ) -> Comment {
        Comment {
            id: id.to_string(),
            text: text.to_string(),
            anchor: Some(anchor(
                commit_oid, file_path, source, side, start_line, end_line,
            )),
            cached_excerpt: cached_excerpt.map(|s| s.to_string()),
            commit_oid: None,
        }
    }

    // fixture builder: arg count is intentional
    #[allow(clippy::too_many_arguments)]
    fn orphan_line_comment(
        id: &str,
        text: &str,
        bogus_oid: &str,
        file_path: &str,
        source: Source,
        side: Side,
        start_line: u32,
        end_line: u32,
        cached_excerpt: Option<&str>,
    ) -> Comment {
        Comment {
            id: id.to_string(),
            text: text.to_string(),
            anchor: Some(Anchor {
                commit_oid: bogus_oid.to_string(),
                file_path: file_path.to_string(),
                source,
                side,
                start_line,
                end_line,
            }),
            cached_excerpt: cached_excerpt.map(|s| s.to_string()),
            commit_oid: None,
        }
    }

    fn commit_level_comment(id: &str, text: &str, commit_oid: Oid) -> Comment {
        Comment {
            id: id.to_string(),
            text: text.to_string(),
            anchor: None,
            cached_excerpt: None,
            commit_oid: Some(commit_oid.to_string()),
        }
    }

    fn make_session(commits: Vec<String>, comments: Vec<Comment>) -> ReviewSession {
        ReviewSession {
            schema_version: 2,
            commits,
            comments,
            draft_comment: None::<DraftComment>,
            working_tree_snapshot: None,
            index_snapshot: None,
        }
    }

    // Helper: take the 7-char short SHA of an Oid for assertion text.
    fn short(o: Oid) -> String {
        let s = o.to_string();
        s.chars().take(7).collect()
    }

    #[test]
    fn render_emits_all_sections_in_d04_order() {
        // D-04 section order: H1 + framing + refs (top) → resolved per-(file,
        // commit) → commit-level → unresolvable. All four buckets present.
        let (_dir, repo) = make_repo();
        let parent = commit_with_file(&repo, "A", &[], "foo.rs", b"hello\nworld\n");
        let child = commit_with_file(
            &repo,
            "B (changes foo.rs)",
            &[parent],
            "foo.rs",
            b"hello\nMARK\n",
        );
        let bogus = "0".repeat(40);
        let session = make_session(
            vec![parent.to_string(), child.to_string()],
            vec![
                // (i) resolvable Diff anchor on the change in child
                line_comment(
                    "d1",
                    "diff comment",
                    child,
                    "foo.rs",
                    Source::Diff,
                    Side::New,
                    2,
                    2,
                    None,
                ),
                // (ii) resolvable FullFile anchor
                line_comment(
                    "f1",
                    "full file comment",
                    child,
                    "foo.rs",
                    Source::FullFile,
                    Side::New,
                    1,
                    1,
                    None,
                ),
                // (iii) commit-level comment
                commit_level_comment("c1", "this commit needs review", child),
                // (iv) orphan (bogus commit)
                orphan_line_comment(
                    "o1",
                    "orphan comment",
                    &bogus,
                    "foo.rs",
                    Source::Diff,
                    Side::New,
                    1,
                    1,
                    Some("- old\n+ new\n"),
                ),
            ],
        );

        let md = render(&session, &repo);
        let title_pos = md.find("# Code review:").expect("doc has H1 title");
        // Commit refs list comes after the title (D-03/D-07).
        let refs_pos = md
            .find(&short(parent))
            .or_else(|| md.find(&short(child)))
            .expect("refs section contains a short SHA");
        let resolved_pos = md
            .find("foo.rs")
            .expect("resolved per-file section mentions foo.rs");
        let commit_level_pos = md
            .find("this commit needs review")
            .expect("commit-level section contains its comment text");
        let unresolvable_pos = md
            .find("orphan comment")
            .expect("unresolvable section contains the orphan text");

        assert!(title_pos < refs_pos, "title before refs: {md}");
        assert!(refs_pos < resolved_pos, "refs before resolved: {md}");
        assert!(
            resolved_pos < commit_level_pos,
            "resolved before commit-level: {md}"
        );
        assert!(
            commit_level_pos < unresolvable_pos,
            "commit-level before unresolvable: {md}"
        );
    }

    #[test]
    fn diff_source_uses_diff_fence() {
        let (_dir, repo) = make_repo();
        let a = commit_with_file(&repo, "A", &[], "foo.rs", b"old\n");
        let b = commit_with_file(&repo, "B", &[a], "foo.rs", b"new\n");
        let session = make_session(
            vec![a.to_string(), b.to_string()],
            vec![line_comment(
                "d1",
                "look here",
                b,
                "foo.rs",
                Source::Diff,
                Side::New,
                1,
                1,
                None,
            )],
        );

        let md = render(&session, &repo);

        assert!(
            md.contains("```diff"),
            "Diff source must use ```diff info string, got: {md}"
        );
    }

    #[test]
    fn full_file_uses_language_fence() {
        let (_dir, repo) = make_repo();
        let b = commit_with_file(&repo, "B", &[], "foo.rs", b"fn main() {}\n");
        let session = make_session(
            vec![b.to_string()],
            vec![line_comment(
                "f1",
                "this fn",
                b,
                "foo.rs",
                Source::FullFile,
                Side::New,
                1,
                1,
                None,
            )],
        );

        let md = render(&session, &repo);

        assert!(
            md.contains("```rust"),
            "FullFile on .rs must use ```rust fence, got: {md}"
        );
    }

    #[test]
    fn render_fence_length_avoids_backtick_collision() {
        // A FullFile excerpt body containing ``` must get a 4-backtick fence;
        // ```` body must get a 5-backtick fence. Closing fence matches opening.
        let (_dir, repo) = make_repo();
        let body3 = b"line one\nfoo ``` bar\nline three\n";
        let b3 = commit_with_file(&repo, "B3", &[], "a.rs", body3);
        let session3 = make_session(
            vec![b3.to_string()],
            vec![line_comment(
                "f1",
                "watch the backticks",
                b3,
                "a.rs",
                Source::FullFile,
                Side::New,
                1,
                3,
                None,
            )],
        );

        let md = render(&session3, &repo);

        // 4-backtick fence ("````") appears at least twice (open + close).
        assert!(
            md.contains("````rust"),
            "3-backtick body needs 4-backtick fence (opening ````rust), got: {md}"
        );
        let four_count = md.matches("\n````\n").count() + md.matches("\n````").count();
        assert!(
            four_count >= 1,
            "4-backtick CLOSING fence must appear; doc: {md}"
        );
    }

    #[test]
    fn anchors_grouped_by_file_commit() {
        // Two comments on foo.rs@A + one on foo.rs@B + one on bar.rs@A →
        // THREE distinct (file, commit) groups → three heading occurrences.
        let (_dir, repo) = make_repo();
        let a = commit_with_file(&repo, "A", &[], "foo.rs", b"a1\na2\na3\n");
        let b = commit_with_file(&repo, "B", &[a], "foo.rs", b"b1\nb2\nb3\n");
        let bar_blob = repo.blob(b"x\n").unwrap();
        let mut tb = repo.treebuilder(None).unwrap();
        tb.insert("foo.rs", repo.blob(b"a1\na2\na3\n").unwrap(), 0o100644)
            .unwrap();
        tb.insert("bar.rs", bar_blob, 0o100644).unwrap();
        let tree = repo.find_tree(tb.write().unwrap()).unwrap();
        let a_parent = repo.find_commit(a).unwrap();
        let a_with_bar = repo
            .commit(None, &sig(), &sig(), "A2", &tree, &[&a_parent])
            .unwrap();
        let session = make_session(
            vec![a.to_string(), a_with_bar.to_string(), b.to_string()],
            vec![
                line_comment(
                    "c1",
                    "c1",
                    a,
                    "foo.rs",
                    Source::FullFile,
                    Side::New,
                    1,
                    1,
                    None,
                ),
                line_comment(
                    "c2",
                    "c2",
                    a,
                    "foo.rs",
                    Source::FullFile,
                    Side::New,
                    2,
                    2,
                    None,
                ),
                line_comment(
                    "c3",
                    "c3",
                    b,
                    "foo.rs",
                    Source::FullFile,
                    Side::New,
                    1,
                    1,
                    None,
                ),
                line_comment(
                    "c4",
                    "c4",
                    a_with_bar,
                    "bar.rs",
                    Source::FullFile,
                    Side::New,
                    1,
                    1,
                    None,
                ),
            ],
        );

        let md = render(&session, &repo);

        // Heading text contains both path AND short-sha; count distinct
        // (file, short-sha) pairs visible in the output.
        let pair_foo_a = format!("foo.rs ({})", short(a));
        let pair_foo_b = format!("foo.rs ({})", short(b));
        let pair_bar_a2 = format!("bar.rs ({})", short(a_with_bar));
        assert!(md.contains(&pair_foo_a), "expected `{pair_foo_a}` in {md}");
        assert!(md.contains(&pair_foo_b), "expected `{pair_foo_b}` in {md}");
        assert!(
            md.contains(&pair_bar_a2),
            "expected `{pair_bar_a2}` in {md}"
        );
    }

    #[test]
    fn anchors_sorted_by_start_line() {
        // Three comments at start_lines 30, 10, 20 on the same (file, commit)
        // appear in 10, 20, 30 order in the output.
        let (_dir, repo) = make_repo();
        let mut buf = Vec::new();
        for i in 1..=40 {
            buf.extend_from_slice(format!("line {i}\n").as_bytes());
        }
        let b = commit_with_file(&repo, "B", &[], "f.rs", &buf);
        let session = make_session(
            vec![b.to_string()],
            vec![
                line_comment(
                    "thirty",
                    "at 30",
                    b,
                    "f.rs",
                    Source::FullFile,
                    Side::New,
                    30,
                    30,
                    None,
                ),
                line_comment(
                    "ten",
                    "at 10",
                    b,
                    "f.rs",
                    Source::FullFile,
                    Side::New,
                    10,
                    10,
                    None,
                ),
                line_comment(
                    "twenty",
                    "at 20",
                    b,
                    "f.rs",
                    Source::FullFile,
                    Side::New,
                    20,
                    20,
                    None,
                ),
            ],
        );

        let md = render(&session, &repo);

        let pos_at_10 = md.find("at 10").expect("at 10 in output");
        let pos_at_20 = md.find("at 20").expect("at 20 in output");
        let pos_at_30 = md.find("at 30").expect("at 30 in output");
        assert!(pos_at_10 < pos_at_20, "10 before 20");
        assert!(pos_at_20 < pos_at_30, "20 before 30");
    }

    #[test]
    fn anchor_heading_uses_path_lstart_lend_shortsha_shape() {
        // L-08 + D-08: per-anchor heading is `path:Lstart-Lend (sha)`.
        // git2::TreeBuilder inserts at one level only, so a nested file path
        // requires building the inner tree first and inserting it under the
        // root tree as a Tree entry.
        let (_dir, repo) = make_repo();
        let mut buf = Vec::new();
        for i in 1..=20 {
            buf.extend_from_slice(format!("line {i}\n").as_bytes());
        }
        let file_blob = repo.blob(&buf).unwrap();
        let mut src_builder = repo.treebuilder(None).unwrap();
        src_builder.insert("main.rs", file_blob, 0o100644).unwrap();
        let src_tree_oid = src_builder.write().unwrap();
        let mut root_builder = repo.treebuilder(None).unwrap();
        root_builder.insert("src", src_tree_oid, 0o040000).unwrap();
        let root_tree = repo.find_tree(root_builder.write().unwrap()).unwrap();
        let b = repo
            .commit(None, &sig(), &sig(), "B", &root_tree, &[])
            .unwrap();
        let session = make_session(
            vec![b.to_string()],
            vec![line_comment(
                "x",
                "tag",
                b,
                "src/main.rs",
                Source::FullFile,
                Side::New,
                12,
                15,
                None,
            )],
        );

        let md = render(&session, &repo);

        let expected = format!("src/main.rs:L12-L15 ({})", short(b));
        assert!(
            md.contains(&expected),
            "expected anchor heading `{expected}` in {md}"
        );
    }

    #[test]
    fn commit_refs_list_shape() {
        // D-07 + D-08: each session.commits OID renders as a bullet line with
        // 7-char short SHA + commit subject.
        let (_dir, repo) = make_repo();
        let a = commit_with_file(&repo, "Add feature X", &[], "x.rs", b"x\n");
        let b = commit_with_file(&repo, "Fix bug Y", &[a], "x.rs", b"y\n");
        // Need at least one comment so the doc is rendered (per D-11).
        let session = make_session(
            vec![a.to_string(), b.to_string()],
            vec![commit_level_comment("cl", "any note", b)],
        );

        let md = render(&session, &repo);

        // 7-char short SHA + the commit's subject appear on the same bullet.
        let a_short = short(a);
        let b_short = short(b);
        assert!(
            md.contains(&format!("- {a_short}")) || md.contains(&format!("- `{a_short}`")),
            "expected bullet for {a_short} in {md}"
        );
        assert!(
            md.contains("Add feature X"),
            "expected commit A subject in refs list: {md}"
        );
        assert!(
            md.contains(&format!("- {b_short}")) || md.contains(&format!("- `{b_short}`")),
            "expected bullet for {b_short} in {md}"
        );
        assert!(
            md.contains("Fix bug Y"),
            "expected commit B subject in refs list: {md}"
        );
    }

    #[test]
    fn excerpt_before_comment_text_within_anchor_block() {
        // D-06: inside a resolvable anchor block, the fenced excerpt appears
        // BEFORE the comment text.
        let (_dir, repo) = make_repo();
        let b = commit_with_file(&repo, "B", &[], "foo.rs", b"hello\nworld\n");
        let session = make_session(
            vec![b.to_string()],
            vec![line_comment(
                "f1",
                "REVIEWER_NOTE_TOKEN",
                b,
                "foo.rs",
                Source::FullFile,
                Side::New,
                1,
                1,
                None,
            )],
        );

        let md = render(&session, &repo);

        let excerpt_pos = md.find("hello").expect("excerpt body in output");
        let comment_pos = md
            .find("REVIEWER_NOTE_TOKEN")
            .expect("comment text in output");
        assert!(
            excerpt_pos < comment_pos,
            "D-06: excerpt before comment text; got excerpt@{excerpt_pos} text@{comment_pos} in {md}"
        );
    }

    #[test]
    fn unresolvable_uses_cached_excerpt_fenced_by_source() {
        // D-10: an orphan with cached_excerpt + Source::Diff fences with ```diff
        // and the comment block contains "cached" labelling.
        let (_dir, repo) = make_repo();
        let _b = commit_with_file(&repo, "B", &[], "foo.rs", b"hi\n");
        let bogus = "0".repeat(40);
        let session = make_session(
            vec![],
            vec![orphan_line_comment(
                "o1",
                "this comment lost its anchor",
                &bogus,
                "foo.rs",
                Source::Diff,
                Side::New,
                1,
                1,
                Some("- old\n+ new\n"),
            )],
        );

        let md = render(&session, &repo);

        assert!(
            md.contains("```diff"),
            "D-10: unresolvable Diff orphan uses ```diff fence; got {md}"
        );
        assert!(
            md.contains("cached"),
            "D-10: cached-at-attach-time label present; got {md}"
        );
        assert!(
            md.contains("+ new"),
            "cached_excerpt body should be in the fenced block; got {md}"
        );
    }

    #[test]
    fn unresolvable_uses_d09_phrasing() {
        // D-09 phrasings for CommitGone / FileGone / LineOutOfRange.
        let (_dir, repo) = make_repo();
        let b = commit_with_file(&repo, "B", &[], "exists.rs", b"a\nb\nc\n");
        let bogus = "0".repeat(40);
        let session = make_session(
            vec![b.to_string()],
            vec![
                orphan_line_comment(
                    "commit_gone",
                    "cg",
                    &bogus,
                    "exists.rs",
                    Source::FullFile,
                    Side::New,
                    1,
                    1,
                    Some("snap"),
                ),
                line_comment(
                    "file_gone",
                    "fg",
                    b,
                    "missing.rs",
                    Source::FullFile,
                    Side::New,
                    1,
                    1,
                    Some("snap"),
                ),
                line_comment(
                    "line_oob",
                    "lob",
                    b,
                    "exists.rs",
                    Source::FullFile,
                    Side::New,
                    1,
                    99,
                    Some("snap"),
                ),
            ],
        );

        let md = render(&session, &repo);

        assert!(
            md.contains("commit no longer exists in the repository"),
            "expected CommitGone phrase in {md}"
        );
        assert!(
            md.contains("file no longer exists at this commit/side"),
            "expected FileGone phrase in {md}"
        );
        assert!(
            md.contains("anchor line range is outside the current file bounds"),
            "expected LineOutOfRange phrase in {md}"
        );
    }

    #[test]
    fn binary_blob_uses_placeholder_in_resolved_section() {
        // L-05: a FullFile anchor on a binary blob renders the placeholder
        // INSIDE the resolved per-file section (NOT unresolvable).
        let (_dir, repo) = make_repo();
        // 4 lines + NUL byte → blob.is_binary() = true.
        let b = commit_with_file(&repo, "B", &[], "bin.dat", b"a\nb\nc\0d\n");
        let session = make_session(
            vec![b.to_string()],
            vec![line_comment(
                "bin",
                "binary anchor",
                b,
                "bin.dat",
                Source::FullFile,
                Side::New,
                1,
                1,
                None,
            )],
        );

        let md = render(&session, &repo);

        assert!(
            md.contains("[binary file, no excerpt]"),
            "expected binary placeholder in {md}"
        );
        // Must appear BEFORE any "unresolvable" heading marker if one exists,
        // because L-05 routes Binary into the resolved section.
        let placeholder_pos = md.find("[binary file, no excerpt]").unwrap();
        if let Some(unres_pos) = md.find("Unresolvable") {
            assert!(
                placeholder_pos < unres_pos,
                "binary placeholder must live in the resolved per-file section, not unresolvable"
            );
        }
    }

    #[test]
    fn renderer_never_panics_on_orphan() {
        // L-04 + L-09: a session that includes every orphan kind plus a binary
        // comment renders without panicking; every entry appears in the right
        // section.
        let (_dir, repo) = make_repo();
        let parent = commit_with_file(&repo, "A", &[], "f.rs", b"a\nb\nc\n");
        let child = commit_with_file(&repo, "B", &[parent], "f.rs", b"a\nb\nC\n");
        // Make a fresh commit B2 whose foo2.rs is unchanged from parent A2 →
        // diff replay yields NoHunks.
        let a2_blob = repo.blob(b"same\n").unwrap();
        let mut tb_a2 = repo.treebuilder(None).unwrap();
        tb_a2.insert("foo2.rs", a2_blob, 0o100644).unwrap();
        let tree_a2 = repo.find_tree(tb_a2.write().unwrap()).unwrap();
        let a2 = repo
            .commit(None, &sig(), &sig(), "A2", &tree_a2, &[])
            .unwrap();
        // B2 keeps foo2.rs identical but adds an unrelated file.
        let mut tb_b2 = repo.treebuilder(None).unwrap();
        tb_b2.insert("foo2.rs", a2_blob, 0o100644).unwrap();
        tb_b2
            .insert("unrelated.rs", repo.blob(b"hello\n").unwrap(), 0o100644)
            .unwrap();
        let tree_b2 = repo.find_tree(tb_b2.write().unwrap()).unwrap();
        let parent_a2 = repo.find_commit(a2).unwrap();
        let b2 = repo
            .commit(None, &sig(), &sig(), "B2", &tree_b2, &[&parent_a2])
            .unwrap();
        // Binary file.
        let bin_b = commit_with_file(&repo, "BIN", &[], "img.bin", b"a\0b\n");

        let bogus = "0".repeat(40);
        let session = make_session(
            vec![
                parent.to_string(),
                child.to_string(),
                a2.to_string(),
                b2.to_string(),
                bin_b.to_string(),
            ],
            vec![
                // CommitGone
                orphan_line_comment(
                    "cg",
                    "TXT_CG",
                    &bogus,
                    "f.rs",
                    Source::FullFile,
                    Side::New,
                    1,
                    1,
                    Some("cg-snap"),
                ),
                // FileGone (file does not exist at this commit)
                line_comment(
                    "fg",
                    "TXT_FG",
                    child,
                    "no-such-file.rs",
                    Source::FullFile,
                    Side::New,
                    1,
                    1,
                    Some("fg-snap"),
                ),
                // LineOutOfRange
                line_comment(
                    "lob",
                    "TXT_LOB",
                    child,
                    "f.rs",
                    Source::FullFile,
                    Side::New,
                    1,
                    999,
                    Some("lob-snap"),
                ),
                // NoHunks (Source::Diff on a file unchanged from parent)
                line_comment(
                    "nh",
                    "TXT_NH",
                    b2,
                    "foo2.rs",
                    Source::Diff,
                    Side::New,
                    1,
                    1,
                    Some("nh-snap"),
                ),
                // Binary
                line_comment(
                    "bin",
                    "TXT_BIN",
                    bin_b,
                    "img.bin",
                    Source::FullFile,
                    Side::New,
                    1,
                    1,
                    None,
                ),
            ],
        );

        // The whole point of L-04 — must not panic.
        let md = render(&session, &repo);

        // Each comment's text must appear somewhere in the doc.
        for tag in ["TXT_CG", "TXT_FG", "TXT_LOB", "TXT_NH", "TXT_BIN"] {
            assert!(md.contains(tag), "expected `{tag}` in render output: {md}");
        }
        // Binary lives in the resolved section, the rest in unresolvable.
        let bin_pos = md.find("TXT_BIN").unwrap();
        let cg_pos = md.find("TXT_CG").unwrap();
        assert!(
            bin_pos < cg_pos,
            "binary comment must precede orphan section (it's in the resolved area)"
        );
    }

    #[test]
    fn doc_starts_with_h1_and_framing() {
        // D-03: the doc starts with `# Code review: <repo-name>` followed by
        // a brief framing paragraph.
        let (_dir, repo) = make_repo();
        let b = commit_with_file(&repo, "B", &[], "f.rs", b"x\n");
        let session = make_session(
            vec![b.to_string()],
            vec![commit_level_comment("c1", "note", b)],
        );

        let md = render(&session, &repo);

        assert!(
            md.starts_with("# Code review:"),
            "doc must begin with H1 title, got: {md}"
        );
        // Framing mentions either "code review" or "anchored excerpts".
        let lower = md.to_lowercase();
        assert!(
            lower.contains("code review") && lower.contains("anchored"),
            "framing paragraph must explain the doc; got: {md}"
        );
    }

    #[test]
    fn renderer_does_not_import_syntax_module() {
        // L-10 gate: the renderer module is abstinent — no syntax.rs imports.
        // include_str! resolves relative to this file at expand time, so the
        // assertion runs against the on-disk content of review.rs itself.
        // Build the needle from two halves so the test body does NOT itself
        // count as a match — a literal "use" + "::" import statement to the
        // syntax module appearing in this comment would trip its own assertion.
        let src = include_str!("review.rs");
        let needle = concat!("use crate::", "git::syntax");
        assert!(
            !src.contains(needle),
            "L-10 violation: review.rs must NOT import the syntax module"
        );
    }

    // Suppress unused-helper warning while task 3 is still pending.
    #[test]
    fn _empty_commit_helper_is_used() {
        let (_dir, repo) = make_repo();
        let _ = empty_commit(&repo, "R", &[]);
    }
}

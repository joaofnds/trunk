// Markdown rendering, plus the Tauri-facing half of the blob reads it depends on.
// The sandboxed resolver itself — `RevSpec` and the working-tree path-escape
// guard — is `git::blob_reader`, so the security boundary can be read on its own.
// What stays here needs the adapter layer: `read_file_at_from_state` resolves an
// open repo out of `RepoState`, and `parse_asset_uri` / `resolve_trunk_asset`
// decode the `trunk-asset://` URLs the protocol handler (wired in lib.rs) serves
// for local images.

use crate::error::TrunkError;
use crate::git::blob_reader::{RevSpec, read_file_at_inner};
use crate::git::syntax;
use crate::state::RepoState;
use comrak::adapters::SyntaxHighlighterAdapter;
use comrak::nodes::NodeValue;
use serde::Serialize;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fmt::Write as FmtWrite;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

/// Block-diff cache keyed `(repo, file, before-oid, after-oid)`. Only commit-vs-
/// commit diffs are cached (both revs immutable); any working-tree/index side is
/// recomputed on every `repo-changed`. `cache_put` bounds it at cap-128, dropping
/// the whole map on overflow. Registered as Tauri managed state in lib.rs.
#[derive(Default)]
pub struct MarkdownDiffCache(pub Mutex<HashMap<String, MarkdownDiff>>);

const MARKDOWN_CACHE_CAP: usize = 128;

/// Insert into the render cache, bounding its size. Rendered HTML is cheap to
/// recompute, so on overflow we drop the whole cache rather than track LRU order
/// (no dependency, fewest elements) — a rare full miss beats unbounded growth.
fn cache_put<V>(map: &mut HashMap<String, V>, key: String, value: V) {
    if map.len() >= MARKDOWN_CACHE_CAP {
        map.clear();
    }
    map.insert(key, value);
}

/// The `syn-*` CSS classes `syntax::color_to_css_class` emits. Ammonia is told to
/// allow exactly these on `<span>` so fenced-code highlighting survives sanitization
/// while any other class an attacker injects is stripped.
const SYN_CLASSES: &[&str] = &[
    "syn-keyword",
    "syn-string",
    "syn-comment",
    "syn-number",
    "syn-function",
    "syn-type",
    "syn-variable",
    "syn-punctuation",
    "syn-attribute",
];

/// The tint classes the table/list post-pass injects onto `<tr>`/`<li>` inside a
/// changed container fragment. Allowlisted so they survive sanitization; the
/// fixed strings can't smuggle anything else past ammonia. Block-level tints live
/// on the frontend wrapper, outside the sanitized fragment (grill §D4). Mirrors
/// Source: a modified leaf is removed-on-before / added-on-after, no third state.
const MD_TINT_CLASSES: &[&str] = &["md-added", "md-removed"];

/// The word-level diff classes the `html_token_merge` emission injects onto
/// `<del>`/`<ins>`. `del`/`ins` are in ammonia's default tag set, but the class
/// attribute is stripped without this allowlist — so the fixed strings survive
/// while any other class is dropped. Keyed strictly on these classes (never bare
/// `<del>`/`<ins>`) so an author's `~~strikethrough~~` is never tinted (invariant §5).
const MD_WORD_CLASSES: &[&str] = &["md-word-delete", "md-word-add"];

/// One row of a rendered-markdown block diff, in document reading order. Mirrors
/// the frontend `DiffRow` union (serde `kind` tag). `Changed` always carries its
/// before/after fragments (the split columns / stacked inline fallback) and, for a
/// single-leaf block that word-merges, an inline `word_html` with `md-word-*`
/// del/ins marks. `word_html` is `None` for containers, code blocks, and rewrites.
///
/// Every row carries its 1-based inclusive source-line span so the frontend can
/// budget hunk context by line distance, matching Source's `diff_context_lines`.
/// Spans live on the AFTER axis; `Removed` has no after side, so it carries its
/// before span plus `after_anchor` — the after-side line the deletion sits at —
/// keeping all context math on one axis.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DiffRow {
    Unchanged {
        html: String,
        after_start: u32,
        after_end: u32,
    },
    Added {
        html: String,
        after_start: u32,
        after_end: u32,
    },
    Removed {
        html: String,
        before_start: u32,
        before_end: u32,
        after_anchor: u32,
    },
    Changed {
        before_html: String,
        after_html: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        word_html: Option<String>,
        after_start: u32,
        after_end: u32,
    },
}

/// A rendered-markdown diff crossing IPC: the aligned rows plus whether the
/// line diff found only changes the rendered view cannot represent (whitespace
/// between blocks) — every row `Unchanged` yet the sources differ. The frontend
/// then explains the untinted state instead of claiming "No changes".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownDiff {
    pub rows: Vec<DiffRow>,
    pub whitespace_only: bool,
}

/// A top-level block reduced to what the diff needs: its node kind (the pairing
/// gate — a paragraph never merges with a heading), its rendered, sanitized HTML
/// fragment, and its 1-based inclusive sourcepos line span (how the line diff's
/// dirty lines map onto blocks). Multi-leaf containers (table, list) also carry
/// their leaf rows/items and a sourcepos-annotated fragment, so a container
/// classified `Changed` can tint just the changed `<tr>`/`<li>` inside.
struct Block {
    kind: String,
    html: String,
    /// Raw (pre-sanitize) comrak HTML for the word-level merge. Populated only for
    /// single-leaf blocks (paragraph, heading); empty for containers, which merge
    /// via their `sourcepos_html` leaf-tint path instead. Never serialized.
    raw_html: String,
    /// The block's raw markdown lines — its rev-INDEPENDENT identity. Anchor
    /// matching compares this, never `html`: rendered html embeds each side's
    /// rev in image URLs, so identical markdown renders differently per side.
    source: String,
    leaves: Vec<Leaf>,
    sourcepos_html: String,
    start_line: u32,
    end_line: u32,
}

/// A direct-child leaf of a container (a table row or list item): its signature
/// for the inner diff and its `data-sourcepos` value, which uniquely identifies its
/// element in the sourcepos-annotated fragment so the tint lands on the right row.
struct Leaf {
    signature: String,
    sourcepos: String,
}

/// Diff two markdown documents, returning an aligned row per top-level block in
/// reading order. Row semantics derive from the plain-text LINE diff of the two
/// sources — the same diff Source mode shows — mapped onto blocks via sourcepos:
/// a block is dirty iff its line span intersects its side's changed lines. Both
/// texts are front-matter-rewritten BEFORE the line diff so line numbers and
/// sourcepos share one coordinate system. `repo`/`file`/`rev` are needed only to
/// resolve each side's images. The frontend projects every layout from the rows.
/// `ignore_whitespace` compares line keys with ALL whitespace stripped — git's
/// `-w`, matching Source's GIT_DIFF_IGNORE_WHITESPACE — while the original
/// lines still classify blocks and render.
pub fn diff_markdown_blocks(
    before_md: &str,
    after_md: &str,
    repo_path: &str,
    file_path: &str,
    before_rev: &RevSpec,
    after_rev: &RevSpec,
    ignore_whitespace: bool,
) -> MarkdownDiff {
    let differs = before_md != after_md;
    // comrak counts a lone \r as a line ending (CommonMark); str::lines() and
    // similar::from_lines split on \n only. Normalizing BEFORE the line diff and
    // extraction is what keeps all three in one line coordinate system — without
    // it a CR-only file panics the source slice in extract_blocks.
    let before_md = normalize_line_endings(before_md);
    let after_md = normalize_line_endings(after_md);
    let before_text = front_matter_as_table(&before_md);
    let after_text = front_matter_as_table(&after_md);
    let before = extract_blocks(&before_text, repo_path, file_path, before_rev);
    let after = extract_blocks(&after_text, repo_path, file_path, after_rev);

    let ops = if ignore_whitespace {
        line_diff_ops(
            &strip_line_whitespace(&before_text),
            &strip_line_whitespace(&after_text),
        )
    } else {
        line_diff_ops(&before_text, &after_text)
    };
    let (before_lines, after_lines) = dirty_lines(&ops);
    let (mut before_dirty, before_dropped) = dirty_blocks(&before, &before_lines, &before_text);
    let (mut after_dirty, after_dropped) = dirty_blocks(&after, &after_lines, &after_text);
    propagate_dirty(
        &mut before_dirty,
        &mut after_dirty,
        &counterpart_pairs(&ops, &before, &after),
    );

    let rows = emit_rows(
        &before,
        &before_dirty,
        &after,
        &after_dirty,
        ignore_whitespace,
    );
    let whitespace_only = differs
        && !before_dropped
        && !after_dropped
        && rows.iter().all(|r| matches!(r, DiffRow::Unchanged { .. }));
    MarkdownDiff {
        rows,
        whitespace_only,
    }
}

fn normalize_line_endings(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// Each line with every whitespace character removed — the ignore-whitespace
/// comparison keys. Line count is preserved, so the diff ops' indices stay in
/// the original text's line coordinates.
fn strip_line_whitespace(text: &str) -> String {
    text.lines()
        .map(|l| l.chars().filter(|c| !c.is_whitespace()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The one line diff a direction gets. Both the dirty flags and the counterpart
/// pairs read these ops, so they cannot disagree about which lines are equal —
/// under `ignore_whitespace` the caller passes the whitespace-stripped texts,
/// and a second diff of the originals would answer that question differently.
fn line_diff_ops(before_text: &str, after_text: &str) -> Vec<similar::DiffOp> {
    similar::TextDiff::from_lines(before_text, after_text)
        .ops()
        .to_vec()
}

/// The 1-based line numbers the plain-text line diff marks changed on each side:
/// Delete lines on before, Insert lines on after, Replace on both.
fn dirty_lines(ops: &[similar::DiffOp]) -> (HashSet<u32>, HashSet<u32>) {
    let mut before_lines = HashSet::new();
    let mut after_lines = HashSet::new();
    for op in ops {
        match *op {
            similar::DiffOp::Equal { .. } => {}
            similar::DiffOp::Delete {
                old_index, old_len, ..
            } => {
                before_lines.extend((old_index + 1..=old_index + old_len).map(|l| l as u32));
            }
            similar::DiffOp::Insert {
                new_index, new_len, ..
            } => {
                after_lines.extend((new_index + 1..=new_index + new_len).map(|l| l as u32));
            }
            similar::DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                before_lines.extend((old_index + 1..=old_index + old_len).map(|l| l as u32));
                after_lines.extend((new_index + 1..=new_index + new_len).map(|l| l as u32));
            }
        }
    }
    (before_lines, after_lines)
}

/// The block whose sourcepos span contains `line`, if any. Blocks are disjoint
/// and in document order, so the only candidate is the last one starting at or
/// before it — a binary search, never a scan (a root-commit view asks this of
/// every line in the file).
fn block_at(blocks: &[Block], line: u32) -> Option<usize> {
    let next = blocks.partition_point(|b| b.start_line <= line);
    (next > 0 && line <= blocks[next - 1].end_line).then(|| next - 1)
}

/// Which before block each after block is the same block as, read off the line
/// diff's own `Equal` ops: two blocks are counterparts when some line pair the
/// diff called equal falls inside both. Not a 1:1 map — a shifted boundary pairs
/// one block against two on the other side, which is the merge/split case the
/// walk already demotes. A block the diff never called equal to anything (a
/// wholly new or wholly deleted block) appears in no pair, which is what keeps
/// `emit_rows`' one-sided advance correct for it.
fn counterpart_pairs(
    ops: &[similar::DiffOp],
    before: &[Block],
    after: &[Block],
) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    for op in ops {
        let similar::DiffOp::Equal {
            old_index,
            new_index,
            len,
        } = *op
        else {
            continue;
        };

        for k in 0..len {
            let before_line = (old_index + 1 + k) as u32;
            let after_line = (new_index + 1 + k) as u32;
            if let (Some(bi), Some(ai)) =
                (block_at(before, before_line), block_at(after, after_line))
            {
                pairs.push((bi, ai));
            }
        }
    }

    pairs.sort_unstable();
    pairs.dedup();
    pairs
}

/// Dirty both ends of every counterpart pair. `emit_rows` walks the two sides
/// with one cursor each and advances a side alone when its block is dirty, so an
/// edit dirty on one side only leaves the cursors a block apart for the rest of
/// the document and no later pair can anchor. Iterating to a fixpoint matters
/// because a boundary shift chains pairs together; the cap turns a pair list
/// that somehow never settles into a bounded no-op rather than a hang. Flags are
/// only ever set, so `dirty_blocks`' orphan marking survives untouched.
fn propagate_dirty(before_dirty: &mut [bool], after_dirty: &mut [bool], pairs: &[(usize, usize)]) {
    for _ in 0..=pairs.len() {
        let mut spread = false;
        for &(bi, ai) in pairs {
            if before_dirty[bi] != after_dirty[ai] {
                before_dirty[bi] = true;
                after_dirty[ai] = true;
                spread = true;
            }
        }

        if !spread {
            return;
        }
    }
}

/// Which blocks a side's dirty lines touch: a block is dirty iff its sourcepos
/// span intersects the dirty set. Dirty lines outside every span (blank lines
/// between blocks, link-reference definitions, suppressed front matter) are
/// orphans: whitespace-only orphans are ignored — rendered output cannot
/// represent them — and any other orphan marks the nearest following block
/// (the preceding one at EOF) so the change stays visible somewhere. The
/// second return says a non-whitespace orphan had NO block to land on (a
/// zero-block doc): the edit is dropped from the rows, and the caller must
/// not label the diff whitespace-only.
fn dirty_blocks(blocks: &[Block], dirty: &HashSet<u32>, text: &str) -> (Vec<bool>, bool) {
    let mut flags: Vec<bool> = blocks
        .iter()
        .map(|b| (b.start_line..=b.end_line).any(|l| dirty.contains(&l)))
        .collect();
    let mut dropped_edit = false;
    let lines: Vec<&str> = text.lines().collect();
    for &line in dirty {
        if block_at(blocks, line).is_some() {
            continue;
        }
        if lines[line as usize - 1].trim().is_empty() {
            continue;
        }

        // The orphan rule's "nearest following block": the same partition point
        // `block_at` just rejected, now read as the block after the gap.
        let next = blocks.partition_point(|b| b.start_line <= line);
        match flags.get_mut(next) {
            Some(flag) => *flag = true,
            None => match flags.last_mut() {
                Some(last) => *last = true,
                None => dropped_edit = true,
            },
        }
    }
    (flags, dropped_edit)
}

/// Walk both block lists in document order. Clean blocks with identical kind +
/// markdown source are the anchors, emitted `Unchanged`; between anchors the
/// accumulated dirty runs pair positionally — Source's delete/add-run pairing.
/// An equal-`kind` pair merges into `Changed` via `changed_fragments`; a kind
/// mismatch or unpaired excess stays `Removed`/`Added`. A clean pair whose
/// identity differs (block boundaries shifted across an equal region) demotes
/// to the dirty runs rather than misaligning every anchor after it. Identity is
/// the raw source, never rendered html — html embeds each side's rev in image
/// URLs, so identical markdown renders differently per side. Under
/// `ignore_whitespace` identity is whitespace-stripped to match the line keys:
/// a pair the stripped diff called clean must anchor, not demote to `Changed`.
fn emit_rows(
    before: &[Block],
    before_dirty: &[bool],
    after: &[Block],
    after_dirty: &[bool],
    ignore_whitespace: bool,
) -> Vec<DiffRow> {
    let sources_match = |b: &Block, a: &Block| {
        if ignore_whitespace {
            b.source
                .chars()
                .filter(|c| !c.is_whitespace())
                .eq(a.source.chars().filter(|c| !c.is_whitespace()))
        } else {
            b.source == a.source
        }
    };
    // Only ever an AFTER-side block: `Unchanged` publishes after-axis spans, and
    // a before block's lines in those fields is exactly the axis violation the
    // tail arms below used to commit.
    let unchanged = |a: &Block| DiffRow::Unchanged {
        html: a.html.clone(),
        after_start: a.start_line,
        after_end: a.end_line,
    };

    let mut rows = Vec::new();
    let mut before_run: Vec<&Block> = Vec::new();
    let mut after_run: Vec<&Block> = Vec::new();
    // The last after-side line consumed by an anchor — where a deletion with no
    // after-side content at all anchors its context math.
    let mut after_cursor: u32 = 0;
    let (mut i, mut j) = (0, 0);
    while i < before.len() || j < after.len() {
        if i < before.len() && before_dirty[i] {
            before_run.push(&before[i]);
            i += 1;
            continue;
        }
        if j < after.len() && after_dirty[j] {
            after_run.push(&after[j]);
            j += 1;
            continue;
        }
        match (before.get(i), after.get(j)) {
            (Some(b), Some(a)) if b.kind == a.kind && sources_match(b, a) => {
                flush_runs(&mut rows, &mut before_run, &mut after_run, a.start_line);
                rows.push(unchanged(a));
                after_cursor = a.end_line;
                i += 1;
                j += 1;
            }
            (Some(b), Some(a)) => {
                before_run.push(b);
                after_run.push(a);
                i += 1;
                j += 1;
            }
            // A clean block whose counterpart side is exhausted is never a valid
            // anchor — its equal lines live inside an already-consumed block on
            // the other side (boundary shift across an equal region). Demote it,
            // like the mismatched-pair arm above.
            (Some(b), None) => {
                before_run.push(b);
                i += 1;
            }
            (None, Some(a)) => {
                after_run.push(a);
                j += 1;
            }
            (None, None) => unreachable!("loop condition guarantees one side has blocks left"),
        }
    }
    flush_runs(&mut rows, &mut before_run, &mut after_run, after_cursor + 1);
    rows
}

/// Pair a dirty before-run with a dirty after-run positionally and append the
/// resulting rows, clearing both runs. A `Removed` paired against a different
/// kind anchors at its partner's after-side start; unpaired excess anchors at
/// the run's last after-side line, or — when the run has none — at
/// `deletion_anchor`: the after-side line the deletion sits at (the upcoming
/// anchor's start, or one past the last consumed after line at EOF).
fn flush_runs(
    rows: &mut Vec<DiffRow>,
    before_run: &mut Vec<&Block>,
    after_run: &mut Vec<&Block>,
    deletion_anchor: u32,
) {
    let paired = before_run.len().min(after_run.len());
    for k in 0..paired {
        let b = before_run[k];
        let a = after_run[k];
        if b.kind == a.kind {
            let cf = changed_fragments(b, a);
            rows.push(DiffRow::Changed {
                before_html: cf.before_html,
                after_html: cf.after_html,
                word_html: cf.word_html,
                after_start: a.start_line,
                after_end: a.end_line,
            });
        } else {
            rows.push(DiffRow::Removed {
                html: b.html.clone(),
                before_start: b.start_line,
                before_end: b.end_line,
                after_anchor: a.start_line,
            });
            rows.push(DiffRow::Added {
                html: a.html.clone(),
                after_start: a.start_line,
                after_end: a.end_line,
            });
        }
    }
    let excess_anchor = after_run.last().map_or(deletion_anchor, |a| a.end_line);
    for b in &before_run[paired..] {
        rows.push(DiffRow::Removed {
            html: b.html.clone(),
            before_start: b.start_line,
            before_end: b.end_line,
            after_anchor: excess_anchor,
        });
    }
    for a in &after_run[paired..] {
        rows.push(DiffRow::Added {
            html: a.html.clone(),
            after_start: a.start_line,
            after_end: a.end_line,
        });
    }
    before_run.clear();
    after_run.clear();
}

/// One atom of an HTML fragment for the word-level merge. A `Tag` is a full
/// `<…>` span with its attributes intact (so `<img src=… alt="a b">` never
/// shatters); `Word` is a run of non-space visible text; `Space` is a run of
/// whitespace. Concatenating every token's inner string reproduces the original
/// fragment byte-for-byte. `Hash + Ord` are derived so a `&[Token]` can be diffed
/// by `similar::capture_diff_slices` (the density guard) and the enum ordering is
/// variant-then-string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
enum Token {
    Tag(String),
    Word(String),
    Space(String),
}

/// Split a raw HTML fragment into atomic tokens. A `<` opens a tag that runs to
/// the next `>` (attributes and entities inside ride along untouched); the rest is
/// split into alternating whitespace `Space` runs and non-space `Word` runs. A `<`
/// with no closing `>` is treated as a trailing word so tokenization always
/// terminates and stays rejoinable.
fn tokenize(fragment: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut rest = fragment;
    while let Some(first) = rest.chars().next() {
        if first == '<' {
            match rest.find('>') {
                Some(end) => {
                    let (tag, tail) = rest.split_at(end + 1);
                    tokens.push(Token::Tag(tag.to_string()));
                    rest = tail;
                }
                None => {
                    tokens.push(Token::Word(rest.to_string()));
                    rest = "";
                }
            }
        } else if first.is_whitespace() {
            let end = rest
                .find(|c: char| !c.is_whitespace())
                .unwrap_or(rest.len());
            let (space, tail) = rest.split_at(end);
            tokens.push(Token::Space(space.to_string()));
            rest = tail;
        } else {
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '<')
                .unwrap_or(rest.len());
            let (word, tail) = rest.split_at(end);
            tokens.push(Token::Word(word.to_string()));
            rest = tail;
        }
    }
    tokens
}

/// Inline elements whose open/close the word merge tracks as *context*: a del/ins
/// run must not straddle one, and a struck word keeps its wrapper (`<code>foo</code>`
/// rides inside the `<del>`). Any tag not listed here (block wrappers like `<p>`,
/// void tags) is passed through as opaque content and never enters the context stack.
const INLINE_TAGS: &[&str] = &[
    "a", "abbr", "b", "big", "cite", "code", "del", "em", "i", "ins", "kbd", "mark", "q", "s",
    "samp", "small", "span", "strong", "sub", "sup", "time", "tt", "u", "var",
];

/// Void / self-contained tags that never open a context (they have no matching
/// close). Treated as opaque passthrough content, diffable like a word.
const VOID_TAGS: &[&str] = &[
    "area", "br", "col", "embed", "hr", "img", "input", "source", "wbr",
];

enum TagClass {
    InlineOpen,
    InlineClose,
    Passthrough,
}

/// Size caps above which the word merge falls back to the block-level pair instead
/// of diffing. Mirrors the Source word-diff guards (`diff.rs`: 500-char lines, 40
/// pairs) in spirit — an unguarded `similar` word-diff on a large rewrite was a
/// measured cost, and the working-tree path re-runs on every save.
const MAX_MERGE_BYTES: usize = 20_000;
const MAX_MERGE_TOKENS: usize = 2_000;

/// The lowercase element name of a tag string (`<a href="x">` → `a`, `</strong>` → `strong`).
fn tag_name(tag: &str) -> String {
    tag.trim_start_matches('<')
        .trim_start_matches('/')
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Categorize a full `<…>` tag string for the context stack. Self-closing (`<x/>`),
/// declarations (`<!…>`), void tags, and any non-inline element are passthrough
/// content; only paired inline elements open/close context.
fn classify_tag(tag: &str) -> TagClass {
    let inner = tag.trim_start_matches('<').trim_end_matches('>');
    if inner.starts_with('!') || inner.ends_with('/') {
        return TagClass::Passthrough;
    }
    let is_close = inner.starts_with('/');
    let name = tag_name(tag);
    if !INLINE_TAGS.contains(&name.as_str()) || (!is_close && VOID_TAGS.contains(&name.as_str())) {
        return TagClass::Passthrough;
    }
    if is_close {
        TagClass::InlineClose
    } else {
        TagClass::InlineOpen
    }
}

/// A diffable unit of an HTML fragment: a run of content (`text`) tagged with the
/// stack of inline elements open around it (`context`). Folding inline tags into
/// context is what lets the diff notice a formatting-only change — the same word
/// under a different context is a different unit — and lets emission reconstruct a
/// balanced wrapper around any del/ins run. `Ord`/`Hash` are derived for
/// `capture_diff_slices`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct Unit {
    context: Vec<String>,
    text: String,
}

/// Fold a token stream into content units, resolving inline tags into each unit's
/// open-element context. `None` if the fragment's inline tags don't nest (a close
/// with no matching open, or an unclosed open) — a malformed fragment the merge
/// refuses rather than trying to balance.
fn build_units(tokens: &[Token]) -> Option<Vec<Unit>> {
    let mut stack: Vec<String> = Vec::new();
    let mut units = Vec::new();
    for token in tokens {
        match token {
            Token::Word(text) | Token::Space(text) => units.push(Unit {
                context: stack.clone(),
                text: text.clone(),
            }),
            Token::Tag(tag) => match classify_tag(tag) {
                TagClass::InlineOpen => stack.push(tag.clone()),
                TagClass::InlineClose => match stack.last() {
                    Some(top) if tag_name(top) == tag_name(tag) => {
                        stack.pop();
                    }
                    _ => return None,
                },
                TagClass::Passthrough => units.push(Unit {
                    context: stack.clone(),
                    text: tag.clone(),
                }),
            },
        }
    }
    stack.is_empty().then_some(units)
}

/// Open/close inline tags in `current` so it matches `target`, appending the tags
/// to `out`. Shared prefix stays; the divergent tail is closed (deepest first) then
/// the target's tail is opened.
fn transition(out: &mut String, current: &mut Vec<String>, target: &[String]) {
    let common = current
        .iter()
        .zip(target.iter())
        .take_while(|(a, b)| a == b)
        .count();
    while current.len() > common {
        let tag = current.pop().expect("len > common ≥ 0");
        let _ = write!(out, "</{}>", tag_name(&tag));
    }
    for tag in &target[common..] {
        out.push_str(tag);
        current.push(tag.clone());
    }
}

/// Emit one del/ins run: close every open inline element first (so the wrapper can
/// never straddle an element boundary), then wrap the run — reconstructing each
/// unit's own context inside the wrapper so a struck `<code>`/`<strong>` keeps its
/// tags and the fragment stays balanced.
fn emit_run(out: &mut String, open: &mut Vec<String>, units: &[Unit], tag: &str, class: &str) {
    transition(out, open, &[]);
    let _ = write!(out, "<{tag} class=\"{class}\">");
    let mut local: Vec<String> = Vec::new();
    for unit in units {
        transition(out, &mut local, &unit.context);
        out.push_str(&unit.text);
    }
    transition(out, &mut local, &[]);
    let _ = write!(out, "</{tag}>");
}

/// Walk the unit diff into one merged fragment: `Equal` runs pass through (adjusting
/// the open-context), `Delete`/`Insert`/`Replace` runs become balanced
/// `md-word-delete`/`md-word-add` wrappers.
fn merge_emit(ops: &[similar::DiffOp], before: &[Unit], after: &[Unit]) -> String {
    let mut out = String::new();
    let mut open: Vec<String> = Vec::new();
    for op in ops {
        match *op {
            similar::DiffOp::Equal { new_index, len, .. } => {
                for unit in &after[new_index..new_index + len] {
                    transition(&mut out, &mut open, &unit.context);
                    out.push_str(&unit.text);
                }
            }
            similar::DiffOp::Delete {
                old_index, old_len, ..
            } => emit_run(
                &mut out,
                &mut open,
                &before[old_index..old_index + old_len],
                "del",
                "md-word-delete",
            ),
            similar::DiffOp::Insert {
                new_index, new_len, ..
            } => emit_run(
                &mut out,
                &mut open,
                &after[new_index..new_index + new_len],
                "ins",
                "md-word-add",
            ),
            similar::DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                emit_run(
                    &mut out,
                    &mut open,
                    &before[old_index..old_index + old_len],
                    "del",
                    "md-word-delete",
                );
                emit_run(
                    &mut out,
                    &mut open,
                    &after[new_index..new_index + new_len],
                    "ins",
                    "md-word-add",
                );
            }
        }
    }
    transition(&mut out, &mut open, &[]);
    out
}

/// Self-check that the merged fragment's tags nest correctly. The merge returns
/// `None` rather than hand a caller broken markup — losing a real change to the
/// block-level fallback beats emitting an unbalanced fragment.
fn merged_is_balanced(html: &str) -> bool {
    let mut stack: Vec<String> = Vec::new();
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        rest = &rest[open..];
        let Some(close) = rest.find('>') else {
            return false;
        };
        let tag = &rest[..close + 1];
        rest = &rest[close + 1..];
        match classify_tag(tag) {
            TagClass::InlineOpen => stack.push(tag_name(tag)),
            TagClass::InlineClose => match stack.pop() {
                Some(name) if name == tag_name(tag) => {}
                _ => return false,
            },
            TagClass::Passthrough => {}
        }
    }
    stack.is_empty()
}

/// Fraction of *word* tokens that must change before the merge gives up and falls
/// back — the "confetti" fence. Measured on words only (not tags/whitespace) so a
/// formatting-only move (e.g. un-bolding a word) leaves every word Equal and stays
/// cheap, while a genuine rewrite pushes it over the threshold.
const MAX_CHANGED_SHARE: f64 = 0.5;

/// Count the `Word` tokens in a slice. Density is measured on words only: the
/// always-shared structural tokens (`<p>`/`</p>` tags, aligned whitespace) would
/// otherwise dilute the ratio so far that no all-word rewrite could ever cross the
/// threshold at the block level (a `<p>`-wrapped fragment is ~half tags+spaces).
fn word_count(tokens: &[Token]) -> usize {
    tokens
        .iter()
        .filter(|t| matches!(t, Token::Word(_)))
        .count()
}

/// Whether more than `MAX_CHANGED_SHARE` of the word tokens change — the signal
/// that this is a rewrite, not an edit, and a word-level diff would be noise
/// (grill §"Sharpened the guards"): the dedicated density fence.
fn too_dense(before: &[Token], after: &[Token]) -> bool {
    let total = word_count(before) + word_count(after);
    if total == 0 {
        return false;
    }
    let mut changed = 0usize;
    for op in similar::capture_diff_slices(similar::Algorithm::Myers, before, after) {
        match op {
            similar::DiffOp::Equal { .. } => {}
            similar::DiffOp::Delete {
                old_index, old_len, ..
            } => changed += word_count(&before[old_index..old_index + old_len]),
            similar::DiffOp::Insert {
                new_index, new_len, ..
            } => changed += word_count(&after[new_index..new_index + new_len]),
            similar::DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                changed += word_count(&before[old_index..old_index + old_len]);
                changed += word_count(&after[new_index..new_index + new_len]);
            }
        }
    }
    changed as f64 / total as f64 > MAX_CHANGED_SHARE
}

/// Merge the raw (unsanitized) before/after HTML of one changed leaf block into a
/// single word-level diff fragment: removed words wrapped in
/// `<del class="md-word-delete">`, added in `<ins class="md-word-add">`, tags kept
/// balanced. `None` when a guard trips (input imbalance, or an unbalanced result) —
/// the caller then falls back to the shipped block-level `Removed`+`Added` pair.
/// The output is UNsanitized; `changed_fragments` sanitizes it before it crosses IPC.
fn html_token_merge(before_raw: &str, after_raw: &str) -> Option<String> {
    if before_raw.len() > MAX_MERGE_BYTES || after_raw.len() > MAX_MERGE_BYTES {
        return None;
    }
    let before_tokens = tokenize(before_raw);
    let after_tokens = tokenize(after_raw);
    if before_tokens.len() > MAX_MERGE_TOKENS || after_tokens.len() > MAX_MERGE_TOKENS {
        return None;
    }
    if too_dense(&before_tokens, &after_tokens) {
        return None;
    }
    let before_units = build_units(&before_tokens)?;
    let after_units = build_units(&after_tokens)?;
    let ops = similar::capture_diff_slices(similar::Algorithm::Myers, &before_units, &after_units);
    let merged = merge_emit(&ops, &before_units, &after_units);
    merged_is_balanced(&merged).then_some(merged)
}

/// The before/after fragments for a `Changed` row, plus an optional inline
/// word-merged `word_html`. `before_html`/`after_html` feed the split columns and
/// the stacked inline fallback. `word_html` is the GitHub-style inline del/ins
/// merge — present only for a single-leaf block (paragraph, heading) that merges
/// cleanly; `None` for `code_block` (never token-merge highlighted `<pre>`,
/// invariant §4), for containers (table/list stay leaf-tinted), and for rewrites
/// the density/balance guards reject.
struct ChangedFragments {
    before_html: String,
    after_html: String,
    word_html: Option<String>,
}

fn changed_fragments(before: &Block, after: &Block) -> ChangedFragments {
    if before.leaves.is_empty() {
        let word_html = if before.kind == "code_block" || after.kind == "code_block" {
            None
        } else {
            html_token_merge(&before.raw_html, &after.raw_html).map(|m| sanitize_html(&m))
        };
        return ChangedFragments {
            before_html: before.html.clone(),
            after_html: after.html.clone(),
            word_html,
        };
    }
    let before_sigs: Vec<String> = before.leaves.iter().map(|l| l.signature.clone()).collect();
    let after_sigs: Vec<String> = after.leaves.iter().map(|l| l.signature.clone()).collect();

    let mut before_tints: Vec<(&str, &str)> = Vec::new();
    let mut after_tints: Vec<(&str, &str)> = Vec::new();
    for op in similar::capture_diff_slices(similar::Algorithm::Myers, &before_sigs, &after_sigs) {
        match op {
            similar::DiffOp::Equal { .. } => {}
            similar::DiffOp::Delete {
                old_index, old_len, ..
            } => {
                for l in &before.leaves[old_index..old_index + old_len] {
                    before_tints.push((&l.sourcepos, "md-removed"));
                }
            }
            similar::DiffOp::Insert {
                new_index, new_len, ..
            } => {
                for l in &after.leaves[new_index..new_index + new_len] {
                    after_tints.push((&l.sourcepos, "md-added"));
                }
            }
            similar::DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                for l in &before.leaves[old_index..old_index + old_len] {
                    before_tints.push((&l.sourcepos, "md-removed"));
                }
                for l in &after.leaves[new_index..new_index + new_len] {
                    after_tints.push((&l.sourcepos, "md-added"));
                }
            }
        }
    }
    ChangedFragments {
        before_html: sanitize_html(&tint_leaves(&before.sourcepos_html, &before_tints)),
        after_html: sanitize_html(&tint_leaves(&after.sourcepos_html, &after_tints)),
        word_html: None,
    }
}

/// Inject an `md-*` class onto each leaf element in a sourcepos-annotated fragment,
/// matched by its unique `data-sourcepos` value. The leftover `data-sourcepos`
/// attributes are not allowlisted, so ammonia strips them next; only the injected
/// class survives.
fn tint_leaves(sourcepos_html: &str, tints: &[(&str, &str)]) -> String {
    let mut out = sourcepos_html.to_string();
    for (sourcepos, class) in tints {
        let needle = format!("data-sourcepos=\"{sourcepos}\"");
        let replacement = format!("class=\"{class}\" {needle}");
        out = out.replacen(&needle, &replacement, 1);
    }
    out
}

/// The signature for a container's leaf (a table row or list item): its node
/// type plus its whitespace-collapsed text. The leaf-tint inner diff aligns
/// leaves by these, so a reflowed-but-equal leaf stays untinted.
fn block_signature<'a>(node: &'a comrak::nodes::AstNode<'a>) -> String {
    let mut text = String::new();
    for d in node.descendants() {
        match &d.data.borrow().value {
            NodeValue::Text(t) => {
                text.push_str(t);
                text.push(' ');
            }
            NodeValue::HtmlInline(t) => {
                text.push_str(t);
                text.push(' ');
            }
            NodeValue::Code(c) => {
                text.push_str(&c.literal);
                text.push(' ');
            }
            NodeValue::CodeBlock(c) => {
                text.push_str(&c.literal);
                text.push(' ');
            }
            NodeValue::HtmlBlock(h) => {
                text.push_str(&h.literal);
                text.push(' ');
            }
            _ => {}
        }
    }
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let kind = node.data.borrow().value.xml_node_name();
    format!("{kind}:{normalized}")
}

/// Read one side of the diff as a string, mapping a `not_found` (the file is
/// absent at this rev — added or deleted) to `None` so the diff renders the present
/// side alone (every block added or removed). Other errors propagate.
fn read_side(
    repo_path: &str,
    file_path: &str,
    rev: &RevSpec,
    state_map: &HashMap<String, PathBuf>,
) -> Result<Option<String>, TrunkError> {
    match read_file_at_from_state(repo_path, file_path, rev, state_map) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(e) if e.code == "not_found" => Ok(None),
        Err(e) => Err(e),
    }
}

/// Resolve `repo_path`, read `file_path` at both revs, and diff their markdown
/// blocks. A `not_found` on one side (added/deleted file) is handled by the caller
/// so the present side still renders.
pub fn render_markdown_diff_from_state(
    repo_path: &str,
    file_path: &str,
    before_rev: &RevSpec,
    after_rev: &RevSpec,
    ignore_whitespace: bool,
    state_map: &HashMap<String, PathBuf>,
) -> Result<MarkdownDiff, TrunkError> {
    let before = read_side(repo_path, file_path, before_rev, state_map)?;
    let after = read_side(repo_path, file_path, after_rev, state_map)?;
    Ok(diff_markdown_blocks(
        before.as_deref().unwrap_or(""),
        after.as_deref().unwrap_or(""),
        repo_path,
        file_path,
        before_rev,
        after_rev,
        ignore_whitespace,
    ))
}

/// Split leading `---`-fenced YAML front matter off `md`, returning
/// `(yaml_body, rest_of_document)`. Mirrors comrak's delimiter detection: the doc
/// must open with a `---` line, and the body ends at the next line that is exactly
/// `---` or `...`. `None` when there is no front matter.
fn split_front_matter(md: &str) -> Option<(&str, &str)> {
    let rest = md
        .strip_prefix("---\n")
        .or_else(|| md.strip_prefix("---\r\n"))?;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let content = line.trim_end_matches(['\r', '\n']);
        if content == "---" || content == "..." {
            return Some((&rest[..offset], &rest[offset + line.len()..]));
        }
        offset += line.len();
    }
    None
}

/// Rewrite a document's leading YAML front matter into a markdown key/value table
/// so front-matter edits participate in the block diff (a changed field tints only
/// its row). Invalid YAML or a non-mapping root leaves `md` unchanged — comrak then
/// suppresses the front matter as before (`extract_blocks` still filters it out).
fn front_matter_as_table(md: &str) -> Cow<'_, str> {
    let Some((yaml, rest)) = split_front_matter(md) else {
        return Cow::Borrowed(md);
    };
    match front_matter_table_markdown(yaml) {
        Some(table) => Cow::Owned(format!("{table}\n{rest}")),
        None => Cow::Borrowed(md),
    }
}

/// Build a `| Field | Value |` markdown table from a front-matter YAML mapping,
/// preserving key order. `None` if the YAML doesn't parse or its root isn't a map.
fn front_matter_table_markdown(yaml: &str) -> Option<String> {
    let docs = yaml_rust::YamlLoader::load_from_str(yaml).ok()?;
    let hash = docs.first()?.as_hash()?;
    let mut table = String::from("| Field | Value |\n| --- | --- |\n");
    for (key, value) in hash {
        let _ = writeln!(
            table,
            "| {} | {} |",
            md_cell(&yaml_inline(key)),
            md_cell(&yaml_inline(value))
        );
    }
    Some(table)
}

/// Render a YAML value as a compact one-line string for a table cell: scalars as
/// themselves, collections inline (`[a, b]`, `{k: v}`).
fn yaml_inline(y: &yaml_rust::Yaml) -> String {
    use yaml_rust::Yaml;
    match y {
        Yaml::String(s) => s.clone(),
        Yaml::Integer(i) => i.to_string(),
        Yaml::Real(s) => s.clone(),
        Yaml::Boolean(b) => b.to_string(),
        Yaml::Null => "null".to_string(),
        Yaml::Array(items) => {
            let inner: Vec<String> = items.iter().map(yaml_inline).collect();
            format!("[{}]", inner.join(", "))
        }
        Yaml::Hash(map) => {
            let inner: Vec<String> = map
                .iter()
                .map(|(k, v)| format!("{}: {}", yaml_inline(k), yaml_inline(v)))
                .collect();
            format!("{{{}}}", inner.join(", "))
        }
        Yaml::Alias(_) | Yaml::BadValue => String::new(),
    }
}

/// Escape a string to sit in one GFM table cell: newlines to spaces, `|` escaped.
fn md_cell(s: &str) -> String {
    s.replace(['\r', '\n'], " ").replace('|', "\\|")
}

/// Parse a document and reduce each top-level block (direct child of the comrak
/// root) to a `Block`. `markdown` must already be front-matter-rewritten
/// (`front_matter_as_table`) — the caller line-diffs that same text, keeping the
/// block spans and the diff in one coordinate system; a rewrite that failed
/// leaves raw front matter, which comrak parses and this filter suppresses.
/// Images are rewritten once over the whole tree first, so each fragment
/// resolves them like the whole-doc render would.
fn extract_blocks(markdown: &str, repo_path: &str, file_path: &str, rev: &RevSpec) -> Vec<Block> {
    let arena = comrak::Arena::new();
    let options = build_options();
    let mut options_sp = build_options();
    options_sp.render.sourcepos = true;
    let root = comrak::parse_document(&arena, markdown, &options);
    apply_image_rewrite(root, &build_image_rewrite(repo_path, file_path, rev));
    let lines: Vec<&str> = markdown.lines().collect();
    root.children()
        .filter(|n| !matches!(n.data.borrow().value, NodeValue::FrontMatter(_)))
        .map(|n| {
            let kind = n.data.borrow().value.xml_node_name();
            let is_container = kind == "table" || kind == "list";
            let raw = format_node(n, &options);
            let (leaves, sourcepos_html, raw_html) = if is_container {
                let leaves = n
                    .children()
                    .map(|c| Leaf {
                        signature: block_signature(c),
                        sourcepos: c.data.borrow().sourcepos.to_string(),
                    })
                    .collect();
                (leaves, format_node(n, &options_sp), String::new())
            } else {
                (Vec::new(), String::new(), raw.clone())
            };
            let sourcepos = n.data.borrow().sourcepos;
            let (start_line, end_line) = (sourcepos.start.line, sourcepos.end.line);
            Block {
                kind: kind.to_string(),
                html: sanitize_html(&raw),
                raw_html,
                source: lines[start_line - 1..end_line.min(lines.len())].join("\n"),
                leaves,
                sourcepos_html,
                start_line: start_line as u32,
                end_line: end_line as u32,
            }
        })
        .collect()
}

/// Resolve `repo_path` to its open repo, then read `file_path` at `rev`.
pub fn read_file_at_from_state(
    repo_path: &str,
    file_path: &str,
    rev: &RevSpec,
    state_map: &HashMap<String, PathBuf>,
) -> Result<Vec<u8>, TrunkError> {
    let repo = crate::commands::open_repo_from_state(repo_path, state_map)?;
    read_file_at_inner(&repo, file_path, rev)
}

#[tauri::command]
pub async fn read_file_at(
    repo_path: String,
    file_path: String,
    rev: RevSpec,
    state: State<'_, RepoState>,
) -> Result<Vec<u8>, String> {
    let state_map = state.0.lock().unwrap().clone();
    tauri::async_runtime::spawn_blocking(move || {
        read_file_at_from_state(&repo_path, &file_path, &rev, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())
}

/// Build the scheme-less-image → `trunk-asset://asset/?repo=&rev=&path=` rewrite
/// for a file at a rev: repo + rev + path ride as percent-encoded query params so
/// filesystem paths with spaces/slashes and the repo key survive intact. Shared by
/// the whole-doc renderer and the per-block diff path so per-block images resolve
/// identically. Remote (`http(s)`) and anchor URLs are left untouched.
fn build_image_rewrite(
    repo_path: &str,
    file_path: &str,
    rev: &RevSpec,
) -> impl Fn(&str) -> Option<String> {
    let base_dir = Path::new(file_path)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let repo_q = pct_encode(repo_path);
    let rev_q = pct_encode(&rev.to_url_token());
    move |url: &str| {
        if url.is_empty() || url.starts_with('#') || has_url_scheme(url) {
            None
        } else {
            let path_q = pct_encode(&resolve_relative(&base_dir, url));
            Some(format!(
                "trunk-asset://asset/?repo={repo_q}&rev={rev_q}&path={path_q}"
            ))
        }
    }
}

/// Cache key for a block diff — `Some` only when both revs are immutable commits,
/// so working-tree/index diffs always recompute (they move on every `repo-changed`).
fn diff_cache_key(
    repo_path: &str,
    file_path: &str,
    before_rev: &RevSpec,
    after_rev: &RevSpec,
    ignore_whitespace: bool,
) -> Option<String> {
    match (before_rev, after_rev) {
        (RevSpec::Commit { oid: before }, RevSpec::Commit { oid: after }) => Some(format!(
            "{repo_path}\u{1f}{file_path}\u{1f}{before}\u{1f}{after}\u{1f}{ignore_whitespace}"
        )),
        _ => None,
    }
}

#[tauri::command]
pub async fn render_markdown_diff(
    repo_path: String,
    file_path: String,
    before_rev: RevSpec,
    after_rev: RevSpec,
    ignore_whitespace: bool,
    state: State<'_, RepoState>,
    cache: State<'_, MarkdownDiffCache>,
) -> Result<MarkdownDiff, String> {
    let cache_key = diff_cache_key(
        &repo_path,
        &file_path,
        &before_rev,
        &after_rev,
        ignore_whitespace,
    );
    if let Some(ref key) = cache_key
        && let Some(hit) = cache.0.lock().unwrap().get(key).cloned()
    {
        return Ok(hit);
    }

    let state_map = state.0.lock().unwrap().clone();
    let diff = tauri::async_runtime::spawn_blocking(move || {
        render_markdown_diff_from_state(
            &repo_path,
            &file_path,
            &before_rev,
            &after_rev,
            ignore_whitespace,
            &state_map,
        )
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    if let Some(key) = cache_key {
        cache_put(&mut cache.0.lock().unwrap(), key, diff.clone());
    }
    Ok(diff)
}

/// Wraps the existing diff highlighter (`git/syntax.rs`) as a comrak codefence
/// adapter so fenced code emits byte-identical `--color-syn-*` classes — one
/// highlighting vocabulary shared by diffs and rendered markdown. Unknown
/// languages fall through to escaped, unhighlighted text.
struct TrunkSyntaxAdapter;

impl SyntaxHighlighterAdapter for TrunkSyntaxAdapter {
    fn write_highlighted(
        &self,
        output: &mut dyn FmtWrite,
        lang: Option<&str>,
        code: &str,
    ) -> std::fmt::Result {
        match lang.and_then(syntax::create_highlighter_by_token) {
            Some(mut hl) => write_highlighted_lines(output, &mut hl, code),
            None => comrak::html::escape(output, code),
        }
    }

    fn write_pre_tag(
        &self,
        output: &mut dyn FmtWrite,
        attributes: HashMap<&'static str, Cow<'_, str>>,
    ) -> std::fmt::Result {
        comrak::html::write_opening_tag(output, "pre", attributes)
    }

    fn write_code_tag(
        &self,
        output: &mut dyn FmtWrite,
        attributes: HashMap<&'static str, Cow<'_, str>>,
    ) -> std::fmt::Result {
        comrak::html::write_opening_tag(output, "code", attributes)
    }
}

fn write_highlighted_lines(
    output: &mut dyn FmtWrite,
    hl: &mut syntect::easy::HighlightLines<'_>,
    code: &str,
) -> std::fmt::Result {
    let mut lines = code.split('\n').peekable();
    while let Some(line) = lines.next() {
        let tokens = syntax::highlight_line_with(hl, line);
        let spans = syntax::merge_spans(&tokens, &[], line.len() as u32);
        if spans.is_empty() {
            comrak::html::escape(output, line)?;
        } else {
            for s in spans {
                let slice = &line[s.start as usize..s.end as usize];
                if s.syntax_class.is_empty() {
                    comrak::html::escape(output, slice)?;
                } else {
                    write!(output, "<span class=\"{}\">", s.syntax_class)?;
                    comrak::html::escape(output, slice)?;
                    output.write_str("</span>")?;
                }
            }
        }
        if lines.peek().is_some() {
            output.write_str("\n")?;
        }
    }
    Ok(())
}

/// Render GFM markdown → sanitized HTML. `rewrite_image` maps an image URL to a
/// replacement (or None to leave it) — the caller supplies the `trunk-asset://`
/// rewrite for local images; tests pass a no-op. Raw HTML is stripped and
/// dangerous hrefs emptied (comrak `unsafe_` off), then ammonia re-checks as
/// defense-in-depth so a `{@html}` on the frontend can't execute injected markup.
pub fn render_markdown_html(
    markdown: &str,
    rewrite_image: &dyn Fn(&str) -> Option<String>,
) -> String {
    let arena = comrak::Arena::new();
    let options = build_options();
    let root = comrak::parse_document(&arena, markdown, &options);
    apply_image_rewrite(root, rewrite_image);
    sanitize_html(&format_node(root, &options))
}

/// The comrak options shared by the whole-doc renderer and the per-block diff
/// path, so both parse identically. Front matter is delimited by `---` so comrak
/// excludes it from the prose body (without it, `---` reads as a thematic break
/// and the YAML leaks as a run-on paragraph). `render.unsafe` stays off: raw HTML
/// is stripped and dangerous hrefs emptied, with ammonia as the authoritative
/// second layer.
fn build_options() -> comrak::Options<'static> {
    let mut options = comrak::Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.tagfilter = true;
    options.extension.front_matter_delimiter = Some("---".to_string());
    options
}

/// Rewrite scheme-less image URLs across the whole tree before formatting, so a
/// per-block fragment resolves its images identically to the whole-doc render.
fn apply_image_rewrite<'a>(
    root: &'a comrak::nodes::AstNode<'a>,
    rewrite_image: &dyn Fn(&str) -> Option<String>,
) {
    for node in root.descendants() {
        let mut data = node.data.borrow_mut();
        if let NodeValue::Image(link) = &mut data.value
            && let Some(new_url) = rewrite_image(&link.url)
        {
            link.url = new_url;
        }
    }
}

/// Format one AST node to raw, UNsanitized HTML. Given a top-level block node
/// (not the document root) comrak emits only that block's fragment — the diff
/// path relies on this to render one fragment per block.
fn format_node<'a>(node: &'a comrak::nodes::AstNode<'a>, options: &comrak::Options<'_>) -> String {
    let adapter = TrunkSyntaxAdapter;
    let mut plugins = comrak::options::Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(&adapter);
    let mut html = String::new();
    comrak::format_html_with_plugins(node, options, &mut html, &plugins)
        .expect("formatting to a String cannot fail");
    html
}

/// True if `url` begins with a URI scheme (`scheme:`), per RFC 3986. Scheme-ful
/// URLs (http:, https:, mailto:, data:) are left alone; scheme-less ones are
/// local paths rewritten to `trunk-asset://`.
fn has_url_scheme(url: &str) -> bool {
    let mut chars = url.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
            return false;
        }
    }
    false
}

/// Resolve a scheme-less image URL against the markdown file's directory,
/// collapsing `.`/`..` into a normalized repo-relative POSIX path. A leading `/`
/// resolves from the repo root.
fn resolve_relative(base_dir: &str, url: &str) -> String {
    let combined = if let Some(rooted) = url.strip_prefix('/') {
        rooted.to_string()
    } else if base_dir.is_empty() {
        url.to_string()
    } else {
        format!("{base_dir}/{url}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in combined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// Percent-encode a string for use as a URL query value (RFC 3986 unreserved
/// set preserved, everything else `%XX`). Space becomes `%20`, never `+`, so
/// `Url::query_pairs` decodes it back exactly.
fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => write!(out, "%{b:02X}").expect("writing to a String cannot fail"),
        }
    }
    out
}

fn mime_for_ext(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Decode a `trunk-asset://asset/?repo=&rev=&path=` URL into its parts.
/// `Url::query_pairs` percent-decodes automatically.
// TODO: give this a named return struct if a second caller appears.
fn parse_asset_uri(uri: &str) -> Result<(String, RevSpec, String), TrunkError> {
    let url = tauri::Url::parse(uri).map_err(|e| TrunkError::new("bad_uri", e.to_string()))?;
    let (mut repo, mut rev_tok, mut path) = (None, None, None);
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "repo" => repo = Some(v.into_owned()),
            "rev" => rev_tok = Some(v.into_owned()),
            "path" => path = Some(v.into_owned()),
            _ => {}
        }
    }
    let repo = repo.ok_or_else(|| TrunkError::new("bad_uri", "missing repo"))?;
    let rev = RevSpec::from_url_token(
        &rev_tok.ok_or_else(|| TrunkError::new("bad_uri", "missing rev"))?,
    )?;
    let path = path.ok_or_else(|| TrunkError::new("bad_uri", "missing path"))?;
    Ok((repo, rev, path))
}

/// Resolve a `trunk-asset://` request to its file bytes + MIME. Backs the custom
/// protocol handler wired in lib.rs; reuses the same `read_file_at` resolver, so
/// the working-tree path-escape guard applies to images too.
pub fn resolve_trunk_asset<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    uri: &str,
) -> Result<(Vec<u8>, &'static str), TrunkError> {
    use tauri::Manager;
    let (repo, rev, path) = parse_asset_uri(uri)?;
    let state = app.state::<RepoState>();
    let state_map = state.0.lock().unwrap().clone();
    let bytes = read_file_at_from_state(&repo, &path, &rev, &state_map)?;
    Ok((bytes, mime_for_ext(&path)))
}

/// Render a review comment's markdown body to sanitized HTML. Comment text has
/// no file/rev, so scheme-less image URLs aren't rewritten (relative images have
/// nothing to resolve against and are dropped by the sanitizer; remote `http(s)`
/// images render).
pub fn render_comment_text(text: &str) -> String {
    render_markdown_html(text, &|_| None)
}

fn sanitize_html(html: &str) -> String {
    let mut builder = ammonia::Builder::default();
    builder
        .add_tags(["span", "input"])
        .add_tag_attributes("input", ["type", "checked", "disabled"])
        .add_url_schemes(["trunk-asset"])
        .add_allowed_classes("span", SYN_CLASSES.iter().copied())
        .add_allowed_classes("tr", MD_TINT_CLASSES.iter().copied())
        .add_allowed_classes("li", MD_TINT_CLASSES.iter().copied())
        .add_allowed_classes("del", MD_WORD_CLASSES.iter().copied())
        .add_allowed_classes("ins", MD_WORD_CLASSES.iter().copied());
    builder.clean(html).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::blob_reader::test_repo::{sig, with_three_revs};
    use std::fs;
    use tempfile::TempDir;

    fn no_rewrite(_: &str) -> Option<String> {
        None
    }

    /// The full markdown diff of two docs; repo/file/rev args (image resolution
    /// only) are irrelevant to row semantics and defaulted.
    fn diff_md(before: &str, after: &str) -> MarkdownDiff {
        diff_md_ws(before, after, false)
    }

    fn diff_md_ws(before: &str, after: &str, ignore_whitespace: bool) -> MarkdownDiff {
        diff_markdown_blocks(
            before,
            after,
            "/r",
            "d.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
            ignore_whitespace,
        )
    }

    fn diff_rows(before: &str, after: &str) -> Vec<DiffRow> {
        diff_md(before, after).rows
    }

    fn blocks_of(markdown: &str) -> Vec<Block> {
        extract_blocks(markdown, "/r", "d.md", &RevSpec::Head)
    }

    /// One letter per row in reading order — Unchanged, Added, Removed, Changed.
    /// The alignment rules are about which row kind lands where, so the sequence
    /// is the whole assertion and spelling out four fields per row buries it.
    fn row_kinds(before: &str, after: &str) -> String {
        diff_rows(before, after)
            .iter()
            .map(|r| match r {
                DiffRow::Unchanged { .. } => 'U',
                DiffRow::Added { .. } => 'A',
                DiffRow::Removed { .. } => 'R',
                DiffRow::Changed { .. } => 'C',
            })
            .collect()
    }

    /// Independent oracle for "the fragment's tags nest correctly" — deliberately
    /// not `html_token_merge`'s own self-check, so a merge test never certifies
    /// balance with the same code it is exercising.
    fn is_tag_balanced(html: &str) -> bool {
        let mut stack: Vec<String> = Vec::new();
        let mut rest = html;
        while let Some(open) = rest.find('<') {
            rest = &rest[open..];
            let Some(close) = rest.find('>') else {
                return false;
            };
            let tag = &rest[..close + 1];
            rest = &rest[close + 1..];
            let inner = tag.trim_start_matches('<').trim_end_matches('>');
            if inner.ends_with('/') || inner.starts_with('!') {
                continue;
            }
            let name: String = inner
                .trim_start_matches('/')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase();
            const VOID: &[&str] = &["br", "img", "hr", "input", "wbr"];
            if VOID.contains(&name.as_str()) {
                continue;
            }
            if inner.starts_with('/') {
                match stack.pop() {
                    Some(open_name) if open_name == name => {}
                    _ => return false,
                }
            } else {
                stack.push(name);
            }
        }
        stack.is_empty()
    }

    #[test]
    fn merge_plain_prose_wraps_only_changed_words() {
        let merged = html_token_merge("the quick brown fox", "the slow brown fox")
            .expect("a small word change merges, not None");
        assert!(
            merged.contains(r#"<del class="md-word-delete">quick</del>"#),
            "removed word wrapped in md-word-delete: {merged}"
        );
        assert!(
            merged.contains(r#"<ins class="md-word-add">slow</ins>"#),
            "added word wrapped in md-word-add: {merged}"
        );
        assert!(is_tag_balanced(&merged), "output is tag-balanced: {merged}");
        assert!(
            !merged.contains("md-word-delete\">brown") && !merged.contains("md-word-add\">brown"),
            "unchanged words are not wrapped in any diff marker: {merged}"
        );
    }

    #[test]
    fn identical_documents_yield_all_unchanged_rows() {
        let md = "# Title\n\nfirst para\n\nsecond para";
        let rows = diff_rows(md, md);
        assert_eq!(rows.len(), 3, "one row per top-level block: {rows:?}");
        assert!(
            rows.iter().all(|r| matches!(r, DiffRow::Unchanged { .. })),
            "all rows unchanged: {rows:?}"
        );
    }

    #[test]
    fn large_and_adversarial_input_terminates_without_panic() {
        let mut before = String::new();
        let mut after = String::new();
        for i in 0..2000 {
            before.push_str(&format!("paragraph number {i}\n\n"));
            after.push_str(&format!("paragraph number {}\n\n", i + 1));
        }
        // deeply nested quote + a ```markdown fence (the historically pathological
        // grammar): both must stay bounded via the grammar-refusal guard.
        after.push_str("> > > > > > > > deep\n\n```markdown\n**b** `c` mix\n```\n");
        let rows = diff_rows(&before, &after);
        assert!(!rows.is_empty(), "returns without hanging or panicking");
    }

    #[test]
    fn diff_cache_key_only_for_commit_pairs() {
        let commit = |oid: &str| RevSpec::Commit {
            oid: oid.to_string(),
        };
        assert!(
            diff_cache_key("/r", "d.md", &commit("aaa"), &commit("bbb"), false).is_some(),
            "commit-vs-commit is cacheable"
        );
        assert!(
            diff_cache_key("/r", "d.md", &RevSpec::Head, &commit("bbb"), false).is_none(),
            "a HEAD side is not cacheable"
        );
        assert!(
            diff_cache_key("/r", "d.md", &commit("aaa"), &RevSpec::WorkingTree, false).is_none(),
            "a working-tree side is not cacheable"
        );
    }

    #[test]
    fn diff_cache_key_separates_whitespace_modes() {
        // Same commit pair, different flag → different entries; a shared key
        // would serve rows computed under the other whitespace mode.
        let commit = |oid: &str| RevSpec::Commit {
            oid: oid.to_string(),
        };
        assert_ne!(
            diff_cache_key("/r", "d.md", &commit("aaa"), &commit("bbb"), false),
            diff_cache_key("/r", "d.md", &commit("aaa"), &commit("bbb"), true),
        );
    }

    #[test]
    fn absent_side_renders_all_added_or_all_removed() {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        fs::write(dir.path().join("other.md"), b"x").unwrap();
        {
            let mut idx = repo.index().unwrap();
            idx.add_path(Path::new("other.md")).unwrap();
            idx.write().unwrap();
            let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
            let s = sig();
            repo.commit(Some("HEAD"), &s, &s, "init", &tree, &[])
                .unwrap();
        }
        // new.md exists only in the working tree — absent at HEAD.
        fs::write(dir.path().join("new.md"), b"# added\n\nbody para").unwrap();

        let mut state_map = HashMap::new();
        state_map.insert(
            dir.path().to_string_lossy().to_string(),
            dir.path().to_path_buf(),
        );
        let repo_str = dir.path().to_string_lossy().to_string();

        let added = render_markdown_diff_from_state(
            &repo_str,
            "new.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
            false,
            &state_map,
        )
        .unwrap()
        .rows;
        assert!(
            !added.is_empty() && added.iter().all(|r| matches!(r, DiffRow::Added { .. })),
            "absent before → every block added: {added:?}"
        );

        let removed = render_markdown_diff_from_state(
            &repo_str,
            "new.md",
            &RevSpec::WorkingTree,
            &RevSpec::Head,
            false,
            &state_map,
        )
        .unwrap()
        .rows;
        assert!(
            !removed.is_empty() && removed.iter().all(|r| matches!(r, DiffRow::Removed { .. })),
            "absent after → every block removed: {removed:?}"
        );
    }

    #[test]
    fn staged_diff_before_the_first_commit_renders_every_block_added() {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        fs::write(dir.path().join("new.md"), b"# added\n\nbody para").unwrap();
        {
            let mut idx = repo.index().unwrap();
            idx.add_path(Path::new("new.md")).unwrap();
            idx.write().unwrap();
        }
        let mut state_map = HashMap::new();
        state_map.insert(
            dir.path().to_string_lossy().to_string(),
            dir.path().to_path_buf(),
        );

        let rows = render_markdown_diff_from_state(
            &dir.path().to_string_lossy(),
            "new.md",
            &RevSpec::Head,
            &RevSpec::Index,
            false,
            &state_map,
        )
        .expect("an unborn HEAD is an absent before side, not a failure")
        .rows;

        assert!(
            !rows.is_empty() && rows.iter().all(|r| matches!(r, DiffRow::Added { .. })),
            "unborn HEAD → every block added: {rows:?}"
        );
    }

    #[test]
    fn index_to_workdir_diff_shows_only_the_unstaged_edit() {
        // B1: the unstaged preview's base is the INDEX, so a partially staged
        // file diffs "staged"→"workdir". Any fallback to HEAD would re-show the
        // already-staged edit ("committed"→…) as if it were unstaged.
        let (dir, _repo, _oid) = with_three_revs();
        let mut state_map = HashMap::new();
        state_map.insert(
            dir.path().to_string_lossy().to_string(),
            dir.path().to_path_buf(),
        );
        let repo_str = dir.path().to_string_lossy().to_string();

        let rows = render_markdown_diff_from_state(
            &repo_str,
            "doc.md",
            &RevSpec::Index,
            &RevSpec::WorkingTree,
            false,
            &state_map,
        )
        .unwrap()
        .rows;

        let dump: String = rows.iter().map(|r| format!("{r:?}")).collect();
        assert!(
            dump.contains("staged") && dump.contains("workdir"),
            "diffs the index content against the working tree: {dump}"
        );
        assert!(
            !dump.contains("committed"),
            "the committed (HEAD) content must not appear: {dump}"
        );
    }

    #[test]
    fn empty_before_rev_renders_all_added_even_when_head_has_the_file() {
        // B2: a root commit has no parent — its before side must be absent, not
        // HEAD. `doc.md` exists at HEAD here, so any fallback to HEAD would
        // produce Unchanged/Changed rows instead of a pure all-added diff.
        let (dir, _repo, _oid) = with_three_revs();
        let mut state_map = HashMap::new();
        state_map.insert(
            dir.path().to_string_lossy().to_string(),
            dir.path().to_path_buf(),
        );
        let repo_str = dir.path().to_string_lossy().to_string();

        let rows = render_markdown_diff_from_state(
            &repo_str,
            "doc.md",
            &RevSpec::Empty,
            &RevSpec::WorkingTree,
            false,
            &state_map,
        )
        .unwrap()
        .rows;

        assert!(
            !rows.is_empty() && rows.iter().all(|r| matches!(r, DiffRow::Added { .. })),
            "an Empty before side is absent, never HEAD: {rows:?}"
        );
    }

    #[test]
    fn tinted_fragment_strips_sourcepos_and_keeps_only_the_tint_class() {
        let before = "| a | b |\n|---|---|\n| 1 | 2 |";
        let after = "| a | b |\n|---|---|\n| 9 | 2 |";
        let rows = diff_rows(before, after);
        let DiffRow::Changed { after_html, .. } = &rows[0] else {
            panic!("{rows:?}");
        };
        assert!(
            after_html.contains("md-added"),
            "the after leaf tints added (Source parity), tint survives: {after_html}"
        );
        assert!(
            !after_html.contains("data-sourcepos"),
            "sourcepos is stripped by sanitization: {after_html}"
        );
    }

    #[test]
    fn diff_strips_raw_script_and_does_not_smuggle_a_tint_class_from_text() {
        let before = "clean paragraph";
        let after = "<script>alert(1)</script>\n\ntext md-added here";
        let rows = diff_rows(before, after);
        let dump: String = rows.iter().map(|r| format!("{r:?}")).collect();
        assert!(!dump.contains("<script"), "raw <script> stripped: {dump}");
        assert!(
            !dump.contains("class=\"md-added\""),
            "literal 'md-added' text must not become a class attribute: {dump}"
        );
    }

    #[test]
    fn changed_table_tints_only_the_changed_row() {
        let before = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |";
        let after = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 99 |";
        let rows = diff_rows(before, after);
        assert_eq!(rows.len(), 1, "the whole table is one row: {rows:?}");
        let DiffRow::Changed {
            before_html,
            after_html,
            word_html,
            ..
        } = &rows[0]
        else {
            panic!("a one-cell table edit is a Changed row: {rows:?}");
        };
        assert!(
            after_html.contains("<table"),
            "table stays intact: {after_html}"
        );
        assert_eq!(
            after_html.matches("md-added").count(),
            1,
            "exactly the changed row tints added, not the whole table: {after_html}"
        );
        assert_eq!(
            before_html.matches("md-removed").count(),
            1,
            "the before fragment tints the same row removed: {before_html}"
        );
        assert!(
            word_html.is_none(),
            "a container never word-merges (leaf-tint only): {word_html:?}"
        );
    }

    #[test]
    fn changed_table_keeps_before_and_after_as_separate_leaf_tinted_fragments() {
        // A container's Changed carries the before table (removed rows, red) and
        // the after table (added rows, green) as separate fields — the split view
        // pairs them into columns, inline stacks them. word_html stays None (row
        // interleave inside one <table> is P3).
        let before = "| a | b |\n|---|---|\n| 1 | 2 |";
        let after = "| a | b |\n|---|---|\n| 9 | 2 |";
        let rows = diff_rows(before, after);
        assert_eq!(
            rows.len(),
            1,
            "the whole table is one Changed row: {rows:?}"
        );
        let DiffRow::Changed {
            before_html,
            after_html,
            word_html,
            ..
        } = &rows[0]
        else {
            panic!("a one-cell table edit is a Changed row: {rows:?}");
        };
        assert!(
            before_html.contains("md-removed") && before_html.contains(">1<"),
            "before fragment: removed-tinted row with the old value: {before_html}"
        );
        assert!(
            after_html.contains("md-added") && after_html.contains(">9<"),
            "after fragment: added-tinted row with the new value: {after_html}"
        );
        assert!(word_html.is_none(), "no word merge for a container");
    }

    #[test]
    fn changed_list_tints_only_the_changed_item() {
        let before = "- keep one\n- keep two\n- old third";
        let after = "- keep one\n- keep two\n- new third";
        let rows = diff_rows(before, after);
        assert_eq!(rows.len(), 1, "the whole list is one row: {rows:?}");
        let DiffRow::Changed { after_html, .. } = &rows[0] else {
            panic!("a one-item list edit is a Changed row: {rows:?}");
        };
        assert_eq!(
            after_html.matches("md-added").count(),
            1,
            "exactly the changed item tints added: {after_html}"
        );
    }

    #[test]
    fn changed_paragraph_word_merges_into_word_html() {
        let before = "the quick brown fox";
        let after = "the slow brown fox";
        let rows = diff_rows(before, after);
        assert_eq!(rows.len(), 1, "a same-kind edit is one row: {rows:?}");
        let DiffRow::Changed { word_html, .. } = &rows[0] else {
            panic!("a small word edit is a Changed row: {rows:?}");
        };
        let word_html = word_html
            .as_deref()
            .expect("a single-leaf paragraph edit produces inline word_html");
        assert!(
            word_html.contains(r#"<del class="md-word-delete">quick</del>"#),
            "the removed word is wrapped in md-word-delete and survives sanitize: {word_html}"
        );
        assert!(
            word_html.contains(r#"<ins class="md-word-add">slow</ins>"#),
            "the added word is wrapped in md-word-add and survives sanitize: {word_html}"
        );
    }

    #[test]
    fn code_block_change_has_before_after_but_no_word_html() {
        // A fenced code block is single-leaf but must never reach the word-token
        // merge (invariant §4): word_html stays None so highlighted <pre><code> is
        // never htmldiff'd — it renders as before/after (columns or stacked).
        let before = "```rust\nlet x = 1;\n```";
        let after = "```rust\nlet x = 2;\n```";
        let rows = diff_rows(before, after);
        let DiffRow::Changed {
            before_html,
            after_html,
            word_html,
            ..
        } = &rows[0]
        else {
            panic!("a code fence edit is a Changed row: {rows:?}");
        };
        assert!(
            word_html.is_none(),
            "a code fence never word-merges: {word_html:?}"
        );
        assert!(
            before_html.contains("<pre>") && after_html.contains("<pre>"),
            "before/after carry the highlighted code fragments: {before_html} / {after_html}"
        );
    }

    #[test]
    fn dense_rewrite_has_no_word_html() {
        // A paragraph rewritten to disjoint words trips the density guard, so
        // word_html is None (no confetti) — it renders as before/after instead.
        let before = "alpha beta gamma delta epsilon zeta";
        let after = "one two three four five six";
        let rows = diff_rows(before, after);
        let DiffRow::Changed { word_html, .. } = &rows[0] else {
            panic!("a same-kind rewrite is still a Changed row: {rows:?}");
        };
        assert!(
            word_html.is_none(),
            "a dense rewrite must not emit a confetti word diff: {word_html:?}"
        );
    }

    #[test]
    fn identical_docs_with_local_images_stay_unchanged_across_revs() {
        // The image rewrite embeds each side's REV in the URL (rev=head vs
        // rev=working-tree), so rendered html differs between sides even for
        // identical markdown. Anchor matching must compare rev-independent
        // identity, or every image-bearing block shows as a spurious change.
        let md = "# Title\n\n![logo](./img/logo.png) same caption\n\ntail para";
        let rows = diff_rows(md, md);
        assert!(
            rows.iter().all(|r| matches!(r, DiffRow::Unchanged { .. })),
            "identical docs are all-unchanged regardless of image rev URLs: {rows:?}"
        );
    }

    #[test]
    fn rewrapped_paragraph_reads_as_changed_matching_source() {
        // The pivot's defining semantics: rows derive from the plain-text line
        // diff, so a reflow IS a change — exactly what Source shows. (The old
        // signature model compared whitespace-collapsed text and hid it.)
        let before = "the quick brown fox\njumps over the lazy dog";
        let after = "the quick brown fox jumps over\nthe lazy dog";
        let rows = diff_rows(before, after);
        assert_eq!(rows.len(), 1, "one paragraph: {rows:?}");
        assert!(
            matches!(rows[0], DiffRow::Changed { .. }),
            "a reflow-only edit is a same-kind change, never Unchanged: {rows:?}"
        );
    }

    #[test]
    fn ignore_whitespace_compares_lines_with_all_whitespace_stripped() {
        // git -w semantics: "foo bar" and "foobar" compare EQUAL — not just
        // collapsed runs (-b), ALL whitespace is stripped from the line key.
        let before = "foo bar\n\nother para";
        let after = "foobar\n\nother para";

        let ignored = diff_md_ws(before, after, true);
        assert!(
            ignored
                .rows
                .iter()
                .all(|r| matches!(r, DiffRow::Unchanged { .. })),
            "a whitespace-only line edit is unchanged under the flag: {:?}",
            ignored.rows
        );
        assert!(
            ignored.whitespace_only,
            "the sources differ, so the whitespace note explains the empty diff"
        );

        let shown = diff_md_ws(before, after, false);
        assert!(
            shown
                .rows
                .iter()
                .any(|r| !matches!(r, DiffRow::Unchanged { .. })),
            "without the flag the same edit shows, matching Source: {:?}",
            shown.rows
        );
    }

    #[test]
    fn ignore_whitespace_still_shows_real_edits_with_the_actual_content() {
        // The stripped keys drive CLASSIFICATION only; the original lines still
        // render, so a real edit shows its true after-side content.
        let before = "the quick fox\n\nctx";
        let after = "the  slow fox\n\nctx";
        let diff = diff_md_ws(before, after, true);
        let changed = diff
            .rows
            .iter()
            .find_map(|r| match r {
                DiffRow::Changed { after_html, .. } => Some(after_html),
                _ => None,
            })
            .expect("a real word edit stays visible under the flag");
        assert!(
            changed.contains("the  slow fox"),
            "rendered content is the original line, not the stripped key: {changed}"
        );
        assert!(!diff.whitespace_only);
    }

    #[test]
    fn blank_line_only_insert_yields_no_tinted_rows_and_flags_whitespace_only() {
        // Rendered output cannot represent a blank line between blocks; the
        // orphan is ignored, but the flag tells the frontend to explain that
        // instead of claiming "No changes".
        let before = "first para\n\nsecond para";
        let after = "first para\n\n\nsecond para";
        let diff = diff_md(before, after);
        assert!(
            diff.rows
                .iter()
                .all(|r| matches!(r, DiffRow::Unchanged { .. })),
            "a blank-line-only edit tints nothing: {:?}",
            diff.rows
        );
        assert!(
            diff.whitespace_only,
            "the invisible change is flagged so the frontend can say so"
        );
    }

    #[test]
    fn identical_documents_are_not_flagged_whitespace_only() {
        let md = "# Title\n\npara";
        let diff = diff_md(md, md);
        assert!(
            !diff.whitespace_only,
            "no line changes at all → the plain No-changes state"
        );
    }

    #[test]
    fn orphan_link_reference_edit_marks_the_following_block_dirty() {
        // A link-reference definition produces no block of its own; editing its
        // URL dirties a line outside every block span. The non-whitespace orphan
        // must surface on the nearest following block instead of vanishing.
        let before = "[r]: http://old.example\n\nsee [the link][r] here";
        let after = "[r]: http://new.example\n\nsee [the link][r] here";
        let rows = diff_rows(before, after);
        assert!(
            rows.iter().any(|r| !matches!(r, DiffRow::Unchanged { .. })),
            "the orphan edit is visible on a block, not silently dropped: {rows:?}"
        );
    }

    #[test]
    fn zero_block_doc_with_a_real_edit_is_not_whitespace_only() {
        // A doc that is ONLY link-reference definitions produces no blocks at
        // all, so a URL edit has no block to land on. Dropping it is acceptable
        // (rendered output has nothing to show); labeling the diff
        // whitespace-only is a lie about a real edit.
        let before = "[ref]: https://old.example.com\n";
        let after = "[ref]: https://new.example.com\n";
        let diff = diff_md(before, after);
        assert!(
            !diff.whitespace_only,
            "a dropped non-whitespace edit must not report whitespace-only: {:?}",
            diff.rows
        );
    }

    #[test]
    fn zero_block_doc_with_a_whitespace_edit_stays_whitespace_only() {
        let before = "[ref]: https://example.com\n";
        let after = "[ref]: https://example.com\n\n";
        let diff = diff_md(before, after);
        assert!(diff.whitespace_only, "{:?}", diff.rows);
    }

    #[test]
    fn similar_edit_is_changed_type_change_is_remove_plus_add() {
        let edit = diff_rows(
            "kept intro\n\nold body text here",
            "kept intro\n\nold body text there",
        );
        assert!(
            edit.iter().any(|r| matches!(r, DiffRow::Changed { .. })),
            "a same-kind similar edit is one Changed row: {edit:?}"
        );
        assert!(
            !edit
                .iter()
                .any(|r| matches!(r, DiffRow::Added { .. } | DiffRow::Removed { .. })),
            "a similar edit is not split into add/remove: {edit:?}"
        );

        let type_change = diff_rows("hello world", "# hello world");
        assert!(
            !type_change
                .iter()
                .any(|r| matches!(r, DiffRow::Changed { .. })),
            "paragraph → heading must not be a Changed row: {type_change:?}"
        );
        assert!(
            type_change
                .iter()
                .any(|r| matches!(r, DiffRow::Removed { .. }))
                && type_change
                    .iter()
                    .any(|r| matches!(r, DiffRow::Added { .. })),
            "type change is remove + add: {type_change:?}"
        );
    }

    #[test]
    fn trailing_block_added_on_one_side_removed_on_the_other() {
        let before = "# Title\n\nkept para";
        let after = "# Title\n\nkept para\n\nnew para";

        let added = diff_rows(before, after);
        assert_eq!(added.len(), 3, "{added:?}");
        match &added[2] {
            DiffRow::Added { html, .. } => assert!(html.contains("new para"), "{html}"),
            other => panic!("expected Added carrying the after html, got {other:?}"),
        }

        let removed = diff_rows(after, before);
        assert_eq!(removed.len(), 3, "{removed:?}");
        match &removed[2] {
            DiffRow::Removed { html, .. } => assert!(html.contains("new para"), "{html}"),
            other => panic!("expected Removed carrying the before html, got {other:?}"),
        }
    }

    #[test]
    fn formats_a_single_block_node_not_the_whole_document() {
        let arena = comrak::Arena::new();
        let options = build_options();
        let root = comrak::parse_document(&arena, "# Title\n\nbody paragraph", &options);
        let heading = root.children().next().unwrap();
        let html = format_node(heading, &options);
        assert!(
            html.contains("<h1>Title</h1>"),
            "formats the heading block: {html}"
        );
        assert!(
            !html.contains("body paragraph"),
            "must format ONLY the first block, not the whole doc: {html}"
        );
    }

    #[test]
    fn renders_headings_and_emphasis() {
        let html = render_markdown_html("# Title\n\nsome **bold** text", &no_rewrite);
        assert!(html.contains("<h1>"), "heading should render: {html}");
        assert!(html.contains("<strong>bold</strong>"), "bold: {html}");
    }

    #[test]
    fn unchanged_block_reports_its_source_line_span() {
        // The frontend budgets hunk context by source-line distance, so spans are
        // 1-based inclusive and account for the blank-line gaps between blocks: a
        // hard-wrapped paragraph after "# Title\n\n" spans [3,5], not [1,3].
        let md = "# Title\n\nline one\nline two\nline three";
        let rows = diff_rows(md, md);
        let DiffRow::Unchanged {
            after_start,
            after_end,
            ..
        } = &rows[0]
        else {
            panic!("{rows:?}");
        };
        assert_eq!(
            (*after_start, *after_end),
            (1, 1),
            "the heading is source line 1: {rows:?}"
        );
        let DiffRow::Unchanged {
            after_start,
            after_end,
            ..
        } = &rows[1]
        else {
            panic!("{rows:?}");
        };
        assert_eq!(
            (*after_start, *after_end),
            (3, 5),
            "the wrapped paragraph spans lines 3-5 inclusive: {rows:?}"
        );
    }

    #[test]
    fn every_row_kind_carries_its_after_axis_span() {
        // before:  1 "# Title" · 3 "old body" · 5 "kept para" · 7 "- old item"
        // after:   1 "# Title" · 3 "new body" · 5 "kept para" · 7 "tail para"
        // line 3 edits in place (Changed); line 7 changes kind (Removed+Added).
        let before = "# Title\n\nold body\n\nkept para\n\n- old item";
        let after = "# Title\n\nnew body\n\nkept para\n\ntail para";
        let rows = diff_rows(before, after);

        let DiffRow::Unchanged {
            after_start,
            after_end,
            ..
        } = &rows[0]
        else {
            panic!("{rows:?}");
        };
        assert_eq!((*after_start, *after_end), (1, 1), "{rows:?}");

        let DiffRow::Changed {
            after_start,
            after_end,
            ..
        } = &rows[1]
        else {
            panic!("{rows:?}");
        };
        assert_eq!(
            (*after_start, *after_end),
            (3, 3),
            "the in-place edit carries the after block's span: {rows:?}"
        );

        let DiffRow::Removed {
            before_start,
            before_end,
            after_anchor,
            ..
        } = &rows[3]
        else {
            panic!("{rows:?}");
        };
        assert_eq!(
            (*before_start, *before_end),
            (7, 7),
            "the removed list keeps its before span: {rows:?}"
        );
        assert_eq!(
            *after_anchor, 7,
            "the deletion sits where its paired addition landed: {rows:?}"
        );

        let DiffRow::Added {
            after_start,
            after_end,
            ..
        } = &rows[4]
        else {
            panic!("{rows:?}");
        };
        assert_eq!((*after_start, *after_end), (7, 7), "{rows:?}");
    }

    #[test]
    fn unpaired_deletion_anchors_at_the_after_line_it_sits_at() {
        // "GONE" (before line 3) has no after-side partner: it sits at the diff
        // op's new-index — where the next anchor ("b") begins, line 3.
        let rows = diff_rows("a\n\nGONE\n\nb", "a\n\nb");
        let DiffRow::Removed { after_anchor, .. } = &rows[1] else {
            panic!("{rows:?}");
        };
        assert_eq!(*after_anchor, 3, "{rows:?}");
    }

    #[test]
    fn unpaired_deletion_at_eof_anchors_one_past_the_last_after_line() {
        // Trailing newlines on both docs keep "a" an equal line (from_lines
        // includes the newline in the line), so only GONE is dirty.
        let rows = diff_rows("a\n\nGONE\n", "a\n");
        let DiffRow::Removed { after_anchor, .. } = &rows[1] else {
            panic!("{rows:?}");
        };
        assert_eq!(*after_anchor, 2, "{rows:?}");
    }

    #[test]
    fn boundary_shift_merge_demotes_the_leftover_clean_block_to_removed() {
        // Deleting the blank line makes the after side parse ONE paragraph where
        // the before side has two. The only dirty line is a whitespace orphan, so
        // every block is clean — but the leftover before-block "para2" must join
        // the dirty run, never surface as `Unchanged` (that duplicated its content
        // and published before-axis lines in the after-axis span fields).
        let rows = diff_rows("para1\n\npara2", "para1\npara2");

        assert_eq!(rows.len(), 2, "{rows:?}");
        let DiffRow::Changed {
            after_start,
            after_end,
            ..
        } = &rows[0]
        else {
            panic!("{rows:?}");
        };
        assert_eq!((*after_start, *after_end), (1, 2), "{rows:?}");
        let DiffRow::Removed {
            before_start,
            before_end,
            after_anchor,
            ..
        } = &rows[1]
        else {
            panic!("{rows:?}");
        };
        assert_eq!((*before_start, *before_end), (3, 3), "{rows:?}");
        assert_eq!(*after_anchor, 2, "{rows:?}");
    }

    #[test]
    fn boundary_shift_split_demotes_the_leftover_clean_block_to_added() {
        let rows = diff_rows("para1\npara2", "para1\n\npara2");

        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(matches!(&rows[0], DiffRow::Changed { .. }), "{rows:?}");
        let DiffRow::Added {
            after_start,
            after_end,
            ..
        } = &rows[1]
        else {
            panic!("{rows:?}");
        };
        assert_eq!((*after_start, *after_end), (3, 3), "{rows:?}");
    }

    #[test]
    fn a_block_edited_on_one_side_only_is_still_its_counterpart_on_the_other() {
        // The insert lands inside the list, so the before side has no dirty line
        // at all and only the equal lines can say the two lists are the same
        // block. Every block pairs with its opposite number, edited one included.
        let before = "# Title\n\npara\n\n- one\n- two\n\ntail";
        let after = "# Title\n\npara\n\n- one\n- inserted\n- two\n\ntail";

        let pairs = counterpart_pairs(
            &line_diff_ops(before, after),
            &blocks_of(before),
            &blocks_of(after),
        );

        assert_eq!(pairs, vec![(0, 0), (1, 1), (2, 2), (3, 3)], "{pairs:?}");
    }

    #[test]
    fn a_wholly_new_block_has_no_counterpart() {
        // C4: the one-sided advance in emit_rows exists for this shape, so the
        // new block must stay unpaired or propagation would dirty a clean before
        // block and re-break the walk.
        let before = "# Title\n\npara\n\ntail";
        let after = "# Title\n\npara\n\nnew para\n\ntail";

        let pairs = counterpart_pairs(
            &line_diff_ops(before, after),
            &blocks_of(before),
            &blocks_of(after),
        );

        assert_eq!(pairs, vec![(0, 0), (1, 1), (2, 3)], "{pairs:?}");
    }

    #[test]
    fn a_line_inserted_inside_a_block_leaves_the_following_block_unchanged() {
        let before = "# Title\n\npara\n\n- one\n- two\n\ntail";
        let after = "# Title\n\npara\n\n- one\n- inserted\n- two\n\ntail";

        assert_eq!(row_kinds(before, after), "UUCU");
    }

    #[test]
    fn a_line_deleted_inside_a_block_leaves_the_following_block_unchanged() {
        let before = "# Title\n\npara\n\n- one\n- doomed\n- two\n\ntail";
        let after = "# Title\n\npara\n\n- one\n- two\n\ntail";

        assert_eq!(row_kinds(before, after), "UUCU");
    }

    #[test]
    fn cr_only_line_endings_render_without_panic() {
        // comrak counts a lone \r as a line ending; str::lines() does not — an
        // unnormalized CR-only doc panics the source slice in extract_blocks.
        let rows = diff_rows("", "para one\r\rpara two");

        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(
            rows.iter().all(|r| matches!(r, DiffRow::Added { .. })),
            "{rows:?}"
        );
    }

    #[test]
    fn line_ending_only_difference_reports_whitespace_only() {
        let diff = diff_md("alpha\r\n\r\nbeta", "alpha\n\nbeta");

        assert!(
            diff.rows
                .iter()
                .all(|r| matches!(r, DiffRow::Unchanged { .. })),
            "{:?}",
            diff.rows
        );
        assert!(diff.whitespace_only, "{:?}", diff.rows);
    }

    #[test]
    fn rows_serialize_with_camel_case_span_fields() {
        let rows = diff_rows(
            "# Title\n\nold body\n\n- old item",
            "# Title\n\nnew body\n\ntail",
        );
        let json = serde_json::to_string(&rows).unwrap();
        for key in [
            r#""afterStart""#,
            r#""afterEnd""#,
            r#""beforeStart""#,
            r#""beforeEnd""#,
            r#""afterAnchor""#,
        ] {
            assert!(json.contains(key), "expected {key} in {json}");
        }
        assert!(
            !json.contains(r#""lines""#),
            "the block-count field is gone from the wire: {json}"
        );
    }

    #[test]
    fn frontmatter_only_change_shows_as_a_changed_table_row_added_tint() {
        let before = "---\nname: doc\ndescription: old summary\n---\n\n# Body\n\nsame para";
        let after = "---\nname: doc\ndescription: new summary\n---\n\n# Body\n\nsame para";
        let rows = diff_rows(before, after);
        let DiffRow::Changed { after_html, .. } = &rows[0] else {
            panic!("front-matter table should be the first, changed block: {rows:?}");
        };
        assert!(
            after_html.contains("<table"),
            "front matter renders as a table: {after_html}"
        );
        assert!(
            after_html.contains("new summary"),
            "shows the changed value: {after_html}"
        );
        assert_eq!(
            after_html.matches("md-added").count(),
            1,
            "only the changed field's row tints added: {after_html}"
        );
        assert!(
            rows.iter()
                .skip(1)
                .all(|r| matches!(r, DiffRow::Unchanged { .. })),
            "the body is unchanged: {rows:?}"
        );
    }

    #[test]
    fn frontmatter_renders_as_a_key_value_table_with_nested_values_compacted() {
        let md =
            "---\nname: grill\nmetadata:\n  type: workflow\n  tags:\n    - a\n    - b\n---\n\nbody";
        let rows = diff_rows(md, md);
        let DiffRow::Unchanged { html, .. } = &rows[0] else {
            panic!("the front-matter table is the first block: {rows:?}");
        };
        assert!(html.contains("<table"), "renders as a table: {html}");
        assert!(html.contains("grill"), "scalar value shown: {html}");
        assert!(
            html.contains("type: workflow"),
            "nested map compacted inline: {html}"
        );
        assert!(
            html.contains("[a, b]"),
            "nested array compacted inline: {html}"
        );
    }

    #[test]
    fn invalid_frontmatter_yaml_is_suppressed_not_rendered_as_a_table() {
        let md = "---\nfoo: [1, 2\n---\n\n# Body\n\npara";
        let rows = diff_rows(md, md);
        let dump: String = rows.iter().map(|r| format!("{r:?}")).collect();
        assert!(
            !dump.contains("<table"),
            "invalid front matter falls back to suppression, not a broken table: {dump}"
        );
        assert!(
            rows.iter().all(|r| matches!(r, DiffRow::Unchanged { .. })),
            "only the unchanged body remains: {rows:?}"
        );
    }

    #[test]
    fn frontmatter_renders_as_nothing_not_prose() {
        let doc = "---\nname: grill\ndescription: >\n  Interview the user.\nmetadata:\n  trigger: an approach exists\n---\n\n# Grill\n\nBody text.";
        let html = render_markdown_html(doc, &no_rewrite);

        // With front_matter_delimiter set, comrak keeps the block out of the prose
        // body and renders nothing for it — no table, no `---` rule, no run-on
        // paragraph like "name: grill description:".
        assert!(!html.contains("<table>"), "no frontmatter table: {html}");
        assert!(!html.contains("<hr"), "no thematic break: {html}");
        assert!(
            !html.contains("name: grill"),
            "frontmatter must not leak as prose: {html}"
        );
        // The body still renders.
        assert!(html.contains("<h1>Grill</h1>"), "body heading kept: {html}");
    }

    #[test]
    fn document_without_frontmatter_is_unaffected() {
        let html = render_markdown_html("# Title\n\nbody", &no_rewrite);
        assert!(html.contains("<h1>Title</h1>"));
        assert!(!html.contains("<table>"), "no spurious table: {html}");
    }

    #[test]
    fn strips_raw_script() {
        let html = render_markdown_html("hi\n\n<script>alert(1)</script>", &no_rewrite);
        assert!(
            !html.contains("<script"),
            "raw <script> must be stripped: {html}"
        );
    }

    #[test]
    fn empties_dangerous_href() {
        let html = render_markdown_html("[click](javascript:alert(1))", &no_rewrite);
        assert!(
            !html.contains("javascript:"),
            "javascript: href must be neutralized: {html}"
        );
    }

    #[test]
    fn keeps_task_list_checkbox() {
        let html = render_markdown_html("- [x] done\n- [ ] todo", &no_rewrite);
        assert!(html.contains("<input"), "checkbox input kept: {html}");
        assert!(html.contains("type=\"checkbox\""), "checkbox type: {html}");
    }

    #[test]
    fn fence_emits_same_syn_classes_as_diff() {
        let html = render_markdown_html("```rust\nfn main() {}\n```", &no_rewrite);
        // The diff path highlights the identical code — both must tag `fn` as a keyword.
        let diff_tokens = syntax::highlight_line_tokens("fn main() {}", "rs");
        assert!(diff_tokens.iter().any(|t| t.scope == "syn-keyword"));
        assert!(
            html.contains("class=\"syn-keyword\""),
            "fence must emit syn-keyword like the diff path: {html}"
        );
    }

    #[test]
    fn unknown_fence_language_is_escaped_not_dropped() {
        let html = render_markdown_html("```notalang999\na < b && c\n```", &no_rewrite);
        assert!(html.contains("a &lt; b"), "content escaped + kept: {html}");
        assert!(
            !html.contains("syn-"),
            "no syntax spans for unknown lang: {html}"
        );
    }

    #[test]
    fn rewrites_scheme_less_image_url() {
        let rewrite = |url: &str| Some(format!("trunk-asset://head/{url}"));
        let html = render_markdown_html("![alt](img/logo.png)", &rewrite);
        assert!(
            html.contains("trunk-asset://head/img/logo.png"),
            "local image URL rewritten: {html}"
        );
    }

    #[test]
    fn build_image_rewrite_resolves_local_and_leaves_remote() {
        let rewrite = build_image_rewrite("/repo", "docs/README.md", &RevSpec::Head);
        let local = rewrite("img/logo.png").expect("local image rewritten");
        assert!(local.contains("rev=head"), "rev token: {local}");
        assert!(
            local.contains("path=docs%2Fimg%2Flogo.png"),
            "resolved against the file's dir: {local}"
        );
        assert!(
            rewrite("https://ex.com/a.png").is_none(),
            "remote image left untouched"
        );
        assert!(rewrite("#anchor").is_none(), "anchor left untouched");
    }

    #[test]
    fn resolve_relative_normalizes_paths() {
        assert_eq!(
            resolve_relative("docs", "img/logo.png"),
            "docs/img/logo.png"
        );
        assert_eq!(resolve_relative("docs", "../assets/x.png"), "assets/x.png");
        assert_eq!(resolve_relative("", "logo.png"), "logo.png");
        assert_eq!(resolve_relative("docs", "/root.png"), "root.png");
    }

    #[test]
    fn has_url_scheme_detects_remote_and_local() {
        assert!(has_url_scheme("https://example.com/x.png"));
        assert!(has_url_scheme("data:image/png;base64,AAA"));
        assert!(!has_url_scheme("img/logo.png"));
        assert!(!has_url_scheme("../logo.png"));
    }

    #[test]
    fn parse_asset_uri_round_trips_spaces_and_slashes() {
        let uri = format!(
            "trunk-asset://asset/?repo={}&rev={}&path={}",
            pct_encode("/Users/me/my repo"),
            pct_encode("head"),
            pct_encode("docs/a b/c.png")
        );
        let (repo, rev, path) = parse_asset_uri(&uri).unwrap();
        assert_eq!(repo, "/Users/me/my repo");
        assert_eq!(rev, RevSpec::Head);
        assert_eq!(path, "docs/a b/c.png");
    }

    #[test]
    fn cache_put_bounds_the_map() {
        let mut map = HashMap::new();
        for i in 0..MARKDOWN_CACHE_CAP {
            cache_put(&mut map, format!("k{i}"), "html".to_string());
        }
        assert_eq!(map.len(), MARKDOWN_CACHE_CAP);
        // The next insert overflows → the cache is dropped and only the new entry remains.
        cache_put(&mut map, "overflow".to_string(), "html".to_string());
        assert_eq!(map.len(), 1);
        assert!(map.contains_key("overflow"));
    }

    #[test]
    fn mime_for_ext_maps_common_images() {
        assert_eq!(mime_for_ext("a/b.png"), "image/png");
        assert_eq!(mime_for_ext("x.JPG"), "image/jpeg");
        assert_eq!(mime_for_ext("s.svg"), "image/svg+xml");
        assert_eq!(mime_for_ext("weird.xyz"), "application/octet-stream");
    }

    #[test]
    fn tokenize_keeps_multiattr_img_as_one_tag() {
        let tokens = tokenize(r#"<img src="x" alt="a b">"#);
        assert_eq!(
            tokens,
            vec![Token::Tag(r#"<img src="x" alt="a b">"#.to_string())],
            "a multi-attribute tag stays one atomic Tag token: {tokens:?}"
        );
    }

    #[test]
    fn tokenize_keeps_void_tag_atomic_and_splits_surrounding_text() {
        let tokens = tokenize("a<br>b c");
        assert_eq!(
            tokens,
            vec![
                Token::Word("a".to_string()),
                Token::Tag("<br>".to_string()),
                Token::Word("b".to_string()),
                Token::Space(" ".to_string()),
                Token::Word("c".to_string()),
            ],
            "void tag is one atom, text splits into word/space runs: {tokens:?}"
        );
    }

    #[test]
    fn tokenize_keeps_entity_inside_a_word_run() {
        let tokens = tokenize("a&amp;b &lt;");
        assert_eq!(
            tokens,
            vec![
                Token::Word("a&amp;b".to_string()),
                Token::Space(" ".to_string()),
                Token::Word("&lt;".to_string()),
            ],
            "an entity is opaque within its word run, never split on & or ;: {tokens:?}"
        );
    }

    #[test]
    fn tokenize_is_rejoinable_to_the_original() {
        let fragment =
            r#"<p>the <strong>quick</strong> <code>fox</code><br>&amp; <a href="x">jumps</a></p>"#;
        let rejoined: String = tokenize(fragment)
            .iter()
            .map(|t| match t {
                Token::Tag(s) | Token::Word(s) | Token::Space(s) => s.as_str(),
            })
            .collect();
        assert_eq!(
            rejoined, fragment,
            "tokens concatenate back to the original"
        );
    }

    #[test]
    fn merge_returns_none_over_size_cap() {
        let big = "lorem ipsum ".repeat(3000);
        let after = format!("{big} tail");
        assert!(
            html_token_merge(&big, &after).is_none(),
            "an oversized fragment falls back to block-level rather than word-diffing"
        );
    }

    #[test]
    fn merge_returns_none_on_full_rewrite() {
        assert!(
            html_token_merge("alpha beta gamma delta", "one two three four").is_none(),
            "a full rewrite (disjoint words) falls back rather than emitting confetti"
        );
    }

    #[test]
    fn merge_unbold_word_stays_balanced() {
        let merged = html_token_merge(
            "<strong>quick brown</strong>",
            "<strong>quick</strong> brown",
        )
        .expect("un-bolding a word merges, not None");
        assert!(is_tag_balanced(&merged), "output is tag-balanced: {merged}");
        assert!(
            merged.contains("<strong>quick</strong>"),
            "the still-bold word stays bold and unwrapped: {merged}"
        );
        assert!(
            merged.contains("md-word-delete") && merged.contains("md-word-add"),
            "the word whose formatting changed is shown as del+ins, not left plain: {merged}"
        );
    }

    #[test]
    fn merge_removed_inline_code_keeps_code_tag_inside_del() {
        let merged = html_token_merge("keep <code>foo</code> tail", "keep tail")
            .expect("removing an inline-code span merges, not None");
        assert!(is_tag_balanced(&merged), "output is tag-balanced: {merged}");
        assert!(
            merged.contains(r#"md-word-delete"><code>foo</code>"#),
            "the struck <code>foo</code> keeps its wrapper inside the del run: {merged}"
        );
    }

    #[test]
    fn merge_authored_strikethrough_not_tinted_as_deletion() {
        // comrak renders `~~gone~~` as a bare <del>; it is unchanged here, while
        // "here"→"there" is the real edit. The author's <del> must not gain a
        // diff class, and the diff's del must carry `md-word-delete`.
        let merged = html_token_merge("kept <del>gone</del> here", "kept <del>gone</del> there")
            .expect("merges, not None");
        assert!(is_tag_balanced(&merged), "output is tag-balanced: {merged}");
        assert!(
            merged.contains("<del>gone</del>"),
            "author strikethrough stays a bare <del>, never tinted as a deletion: {merged}"
        );
        assert!(
            merged.contains(r#"<del class="md-word-delete">here</del>"#)
                && merged.contains(r#"<ins class="md-word-add">there</ins>"#),
            "the real edit carries the md-word-* diff classes: {merged}"
        );
    }

    #[test]
    fn merge_returns_none_when_output_would_be_unbalanced() {
        assert!(
            html_token_merge("<em>dangling", "plain text").is_none(),
            "an unclosed inline tag falls back rather than emitting broken markup"
        );
        assert!(
            html_token_merge("ok", "a stray </strong> tag").is_none(),
            "a stray closing tag falls back too"
        );
    }

    #[test]
    fn balance_self_check_rejects_unbalanced_fragments() {
        assert!(
            !merged_is_balanced("<strong>x"),
            "unclosed open is unbalanced"
        );
        assert!(!merged_is_balanced("x</em>"), "stray close is unbalanced");
        assert!(
            merged_is_balanced(r#"<strong>x</strong> <del class="md-word-delete">y</del>"#),
            "well-nested tags (with a class) are balanced"
        );
    }

    #[test]
    fn leaves_remote_image_url_when_rewrite_declines() {
        let rewrite = |url: &str| {
            if url.starts_with("http") {
                None
            } else {
                Some(format!("trunk-asset://head/{url}"))
            }
        };
        let html = render_markdown_html("![alt](https://example.com/x.png)", &rewrite);
        assert!(
            html.contains("https://example.com/x.png"),
            "remote image untouched: {html}"
        );
    }
}

// Markdown rendering + blob reads. Two concerns share this module because both
// resolve a file at a `RevSpec`: `read_file_at` returns the raw bytes, and the
// `trunk-asset://` protocol handler (wired in lib.rs) streams those same bytes
// for local images. Keeping the resolver in one place means the security
// boundary — working-tree path-escape rejection — lives in exactly one function.
//
// TODO(rev_reads): extract `RevSpec` + the `read_file_at*` family into their own
// module once image-diff (grill §11) reuses the blob resolver, so the security
// boundary stops being a transitive dependency of every renderer call.

use crate::error::TrunkError;
use crate::git::syntax;
use crate::git::types::WordSpan;
use crate::state::RepoState;
use comrak::adapters::SyntaxHighlighterAdapter;
use comrak::nodes::NodeValue;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::Write as FmtWrite;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

/// Rendered-HTML cache keyed by `(repo, file, commit-oid)`. Only immutable
/// `Commit` revs are cached — working-tree/index/HEAD renders are recomputed so
/// the existing `repo-changed` refetch always shows fresh content (no separate
/// invalidation path). Registered as Tauri managed state in lib.rs.
#[derive(Default)]
pub struct MarkdownCache(pub Mutex<HashMap<String, String>>);

/// Block-diff cache keyed `(repo, file, before-oid, after-oid)`. Only commit-vs-
/// commit diffs are cached (both revs immutable); any working-tree/index side is
/// recomputed on every `repo-changed`. Same cap-128 drop-on-overflow policy as
/// `MarkdownCache`. Registered as Tauri managed state in lib.rs.
#[derive(Default)]
pub struct MarkdownDiffCache(pub Mutex<HashMap<String, Vec<DiffRow>>>);

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
/// on the frontend wrapper, outside the sanitized fragment (grill §D4).
const MD_TINT_CLASSES: &[&str] = &["md-added", "md-removed", "md-changed"];

/// Which version of a file to read. Shared by `read_file_at`, `render_markdown`,
/// and the `trunk-asset://` protocol handler so all three agree on what "the file
/// at this rev" means. The frontend derives it from `diffKind` + side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RevSpec {
    WorkingTree,
    Index,
    Head,
    Commit { oid: String },
}

impl RevSpec {
    /// Encode as the *host* of a `trunk-asset://<token>/<path>` URL. Kept
    /// colon-free (`commit-<oid>`, not `commit:<oid>`) so it is a valid URI
    /// authority — a colon there reads as `host:port` and the URL parser (and
    /// ammonia) reject it. The keywords can't collide with a hex oid, so
    /// decoding stays unambiguous.
    pub fn to_url_token(&self) -> String {
        match self {
            RevSpec::WorkingTree => "working-tree".to_string(),
            RevSpec::Index => "index".to_string(),
            RevSpec::Head => "head".to_string(),
            RevSpec::Commit { oid } => format!("commit-{oid}"),
        }
    }

    pub fn from_url_token(token: &str) -> Result<RevSpec, TrunkError> {
        match token {
            "working-tree" => Ok(RevSpec::WorkingTree),
            "index" => Ok(RevSpec::Index),
            "head" => Ok(RevSpec::Head),
            other => other
                .strip_prefix("commit-")
                .map(|oid| RevSpec::Commit {
                    oid: oid.to_string(),
                })
                .ok_or_else(|| {
                    TrunkError::new("invalid_rev", format!("unknown rev token: {other}"))
                }),
        }
    }
}

/// One row of a rendered-markdown block diff, in document reading order. Mirrors
/// the frontend `DiffRow` union (serde `kind` tag). `Changed` carries both sides'
/// fragments plus reserved Layer-2 word-span slots — always `None` in Layer 1.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DiffRow {
    Unchanged {
        html: String,
    },
    Added {
        html: String,
    },
    Removed {
        html: String,
    },
    Changed {
        before_html: String,
        after_html: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        before_word_spans: Option<Vec<WordSpan>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        after_word_spans: Option<Vec<WordSpan>>,
    },
}

/// A top-level block reduced to what the diff needs: a normalized signature for
/// alignment (node type + whitespace-collapsed text, so a reflow-only edit stays
/// equal) and its rendered, sanitized HTML fragment. Multi-leaf containers (table,
/// list) also carry their leaf rows/items and a sourcepos-annotated fragment, so a
/// container classified `Changed` can tint just the changed `<tr>`/`<li>` inside.
struct Block {
    signature: String,
    html: String,
    leaves: Vec<Leaf>,
    sourcepos_html: String,
}

/// A direct-child leaf of a container (a table row or list item): its signature
/// for the inner diff and its `data-sourcepos` value, which uniquely identifies its
/// element in the sourcepos-annotated fragment so the tint lands on the right row.
struct Leaf {
    signature: String,
    sourcepos: String,
}

/// Diff two markdown documents at the top-level-block granularity, returning an
/// aligned row per block in reading order. `repo`/`file`/`rev` are needed only to
/// resolve each side's images. The frontend projects every layout from this array.
pub fn diff_markdown_blocks(
    before_md: &str,
    after_md: &str,
    repo_path: &str,
    file_path: &str,
    before_rev: &RevSpec,
    after_rev: &RevSpec,
) -> Vec<DiffRow> {
    let before = extract_blocks(before_md, repo_path, file_path, before_rev);
    let after = extract_blocks(after_md, repo_path, file_path, after_rev);
    let before_sigs: Vec<String> = before.iter().map(|b| b.signature.clone()).collect();
    let after_sigs: Vec<String> = after.iter().map(|b| b.signature.clone()).collect();

    let mut rows = Vec::new();
    for op in similar::capture_diff_slices(similar::Algorithm::Myers, &before_sigs, &after_sigs) {
        match op {
            similar::DiffOp::Equal { new_index, len, .. } => {
                for b in &after[new_index..new_index + len] {
                    rows.push(DiffRow::Unchanged {
                        html: b.html.clone(),
                    });
                }
            }
            similar::DiffOp::Delete {
                old_index, old_len, ..
            } => {
                for b in &before[old_index..old_index + old_len] {
                    rows.push(DiffRow::Removed {
                        html: b.html.clone(),
                    });
                }
            }
            similar::DiffOp::Insert {
                new_index, new_len, ..
            } => {
                for b in &after[new_index..new_index + new_len] {
                    rows.push(DiffRow::Added {
                        html: b.html.clone(),
                    });
                }
            }
            similar::DiffOp::Replace {
                old_index,
                old_len,
                new_index,
                new_len,
            } => {
                let paired = old_len.min(new_len);
                for k in 0..paired {
                    let b = &before[old_index + k];
                    let a = &after[new_index + k];
                    if reclassify_as_changed(&b.signature, &a.signature) {
                        let (before_html, after_html) = changed_fragments(b, a);
                        rows.push(DiffRow::Changed {
                            before_html,
                            after_html,
                            before_word_spans: None,
                            after_word_spans: None,
                        });
                    } else {
                        rows.push(DiffRow::Removed {
                            html: b.html.clone(),
                        });
                        rows.push(DiffRow::Added {
                            html: a.html.clone(),
                        });
                    }
                }
                for b in &before[old_index + paired..old_index + old_len] {
                    rows.push(DiffRow::Removed {
                        html: b.html.clone(),
                    });
                }
                for a in &after[new_index + paired..new_index + new_len] {
                    rows.push(DiffRow::Added {
                        html: a.html.clone(),
                    });
                }
            }
        }
    }
    rows
}

/// The before/after HTML for a `Changed` pair. A single-leaf block (paragraph,
/// heading, …) carries its plain fragments — the frontend tints the wrapper. A
/// multi-leaf container (table, list) descends to its leaves: the specific changed
/// `<tr>`/`<li>` get an `md-*` class inside the fragment (criterion 6), everything
/// else stays untinted.
fn changed_fragments(before: &Block, after: &Block) -> (String, String) {
    if before.leaves.is_empty() {
        return (before.html.clone(), after.html.clone());
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
                let paired = old_len.min(new_len);
                for k in 0..paired {
                    before_tints.push((&before.leaves[old_index + k].sourcepos, "md-changed"));
                    after_tints.push((&after.leaves[new_index + k].sourcepos, "md-changed"));
                }
                for l in &before.leaves[old_index + paired..old_index + old_len] {
                    before_tints.push((&l.sourcepos, "md-removed"));
                }
                for l in &after.leaves[new_index + paired..new_index + new_len] {
                    after_tints.push((&l.sourcepos, "md-added"));
                }
            }
        }
    }
    (
        sanitize_html(&tint_leaves(&before.sourcepos_html, &before_tints)),
        sanitize_html(&tint_leaves(&after.sourcepos_html, &after_tints)),
    )
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

/// Whether an aligned before/after pair is an in-place edit (`Changed`) rather
/// than a full replacement (stacked remove + add). True only when the node type is
/// unchanged — a type change (paragraph → heading) stays split (criterion 5) — and
/// at least 40% of the longer text's ascii bytes are shared (the char-ratio idea
/// from `diff.rs`'s word-span dissimilarity guard).
fn reclassify_as_changed(before_sig: &str, after_sig: &str) -> bool {
    let (before_kind, before_text) = before_sig.split_once(':').unwrap_or((before_sig, ""));
    let (after_kind, after_text) = after_sig.split_once(':').unwrap_or((after_sig, ""));
    if before_kind != after_kind {
        return false;
    }
    let long = before_text.len().max(after_text.len());
    if long == 0 {
        return true;
    }
    let mut counts = [0i32; 128];
    for &byte in before_text.as_bytes() {
        if (byte as usize) < 128 {
            counts[byte as usize] += 1;
        }
    }
    let mut shared = 0usize;
    for &byte in after_text.as_bytes() {
        let i = byte as usize;
        if i < 128 && counts[i] > 0 {
            counts[i] -= 1;
            shared += 1;
        }
    }
    shared * 5 >= long * 2
}

/// The alignment signature for a top-level block: its node type plus its
/// whitespace-collapsed text. Type in the signature makes a type change (e.g.
/// paragraph → heading) a delete+insert, not a reflow; collapsing whitespace makes
/// a rewrapped paragraph compare equal.
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
    state_map: &HashMap<String, PathBuf>,
) -> Result<Vec<DiffRow>, TrunkError> {
    let before = read_side(repo_path, file_path, before_rev, state_map)?;
    let after = read_side(repo_path, file_path, after_rev, state_map)?;
    Ok(diff_markdown_blocks(
        before.as_deref().unwrap_or(""),
        after.as_deref().unwrap_or(""),
        repo_path,
        file_path,
        before_rev,
        after_rev,
    ))
}

/// Parse a document and reduce each top-level block (direct child of the comrak
/// root, front matter skipped) to a `Block`. Images are rewritten once over the
/// whole tree first, so each fragment resolves them like the whole-doc render would.
fn extract_blocks(markdown: &str, repo_path: &str, file_path: &str, rev: &RevSpec) -> Vec<Block> {
    let arena = comrak::Arena::new();
    let options = build_options();
    let mut options_sp = build_options();
    options_sp.render.sourcepos = true;
    let root = comrak::parse_document(&arena, markdown, &options);
    apply_image_rewrite(root, &build_image_rewrite(repo_path, file_path, rev));
    root.children()
        .filter(|n| !matches!(n.data.borrow().value, NodeValue::FrontMatter(_)))
        .map(|n| {
            let kind = n.data.borrow().value.xml_node_name();
            let is_container = kind == "table" || kind == "list";
            let (leaves, sourcepos_html) = if is_container {
                let leaves = n
                    .children()
                    .map(|c| Leaf {
                        signature: block_signature(c),
                        sourcepos: c.data.borrow().sourcepos.to_string(),
                    })
                    .collect();
                (leaves, format_node(n, &options_sp))
            } else {
                (Vec::new(), String::new())
            };
            Block {
                signature: block_signature(n),
                html: sanitize_html(&format_node(n, &options)),
                leaves,
                sourcepos_html,
            }
        })
        .collect()
}

/// Read a file's raw bytes at `rev`. Committed revs (Head/Index/Commit) read git
/// blobs from a tree/index and are inherently sandboxed; the working-tree case is
/// the only one that touches the filesystem, so it rejects any path escaping the
/// repo root (canonicalized to defeat `..` and symlink traversal).
pub fn read_file_at_inner(
    repo: &git2::Repository,
    file_path: &str,
    rev: &RevSpec,
) -> Result<Vec<u8>, TrunkError> {
    match rev {
        RevSpec::WorkingTree => read_working_tree_file(repo, file_path),
        RevSpec::Index => read_index_blob(repo, file_path),
        RevSpec::Head => {
            let tree = repo.head()?.peel_to_tree()?;
            read_tree_blob(repo, &tree, file_path)
        }
        RevSpec::Commit { oid } => {
            let oid = git2::Oid::from_str(oid)
                .map_err(|e| TrunkError::new("invalid_oid", e.to_string()))?;
            let tree = repo.find_commit(oid)?.tree()?;
            read_tree_blob(repo, &tree, file_path)
        }
    }
}

fn read_working_tree_file(repo: &git2::Repository, file_path: &str) -> Result<Vec<u8>, TrunkError> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| TrunkError::new("bare_repo", "cannot read working tree of a bare repo"))?;
    let root = workdir
        .canonicalize()
        .map_err(|e| TrunkError::new("io_error", e.to_string()))?;
    let target = root
        .join(file_path)
        .canonicalize()
        .map_err(|e| TrunkError::new("not_found", format!("{file_path}: {e}")))?;
    if !target.starts_with(&root) {
        return Err(TrunkError::new(
            "path_escape",
            format!("path escapes repository root: {file_path}"),
        ));
    }
    std::fs::read(&target).map_err(|e| TrunkError::new("io_error", e.to_string()))
}

fn read_index_blob(repo: &git2::Repository, file_path: &str) -> Result<Vec<u8>, TrunkError> {
    let index = repo.index()?;
    let entry = index
        .get_path(Path::new(file_path), 0)
        .ok_or_else(|| TrunkError::new("not_found", format!("not in index: {file_path}")))?;
    let blob = repo.find_blob(entry.id)?;
    Ok(blob.content().to_vec())
}

fn read_tree_blob(
    repo: &git2::Repository,
    tree: &git2::Tree,
    file_path: &str,
) -> Result<Vec<u8>, TrunkError> {
    let entry = tree
        .get_path(Path::new(file_path))
        .map_err(|_| TrunkError::new("not_found", format!("not in tree: {file_path}")))?;
    let obj = entry.to_object(repo)?;
    let blob = obj
        .as_blob()
        .ok_or_else(|| TrunkError::new("not_a_blob", format!("not a file: {file_path}")))?;
    Ok(blob.content().to_vec())
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

/// Read `file_path` at `rev`, render its markdown to sanitized HTML, and rewrite
/// scheme-less image URLs to `trunk-asset://<rev>/<repo-relative path>` resolved
/// against the file's directory. Remote (`http(s)`) images are left untouched.
pub fn render_markdown_from_state(
    repo_path: &str,
    file_path: &str,
    rev: &RevSpec,
    state_map: &HashMap<String, PathBuf>,
) -> Result<String, TrunkError> {
    let bytes = read_file_at_from_state(repo_path, file_path, rev, state_map)?;
    let markdown = String::from_utf8_lossy(&bytes);
    Ok(render_markdown_with_asset_base(
        &markdown, repo_path, file_path, rev,
    ))
}

/// Render a markdown string, rewriting scheme-less image URLs to `trunk-asset://`
/// resolved against `file_path`'s directory at `rev`. repo + rev + path ride as
/// percent-encoded query params (not path/host segments) so filesystem paths with
/// spaces/slashes and the repo key survive intact, and the protocol handler can
/// identify which open repo the image belongs to. Fixed host `asset`.
pub fn render_markdown_with_asset_base(
    markdown: &str,
    repo_path: &str,
    file_path: &str,
    rev: &RevSpec,
) -> String {
    render_markdown_html(markdown, &build_image_rewrite(repo_path, file_path, rev))
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

#[tauri::command]
pub async fn render_markdown(
    repo_path: String,
    file_path: String,
    rev: RevSpec,
    state: State<'_, RepoState>,
    cache: State<'_, MarkdownCache>,
) -> Result<String, String> {
    // Only content-addressed commit revs are cacheable; HEAD/index/working-tree
    // all move, so they render fresh every time.
    let cache_key = match &rev {
        RevSpec::Commit { oid } => Some(format!("{repo_path}\u{1f}{file_path}\u{1f}{oid}")),
        _ => None,
    };
    if let Some(ref key) = cache_key {
        if let Some(hit) = cache.0.lock().unwrap().get(key).cloned() {
            return Ok(hit);
        }
    }

    let state_map = state.0.lock().unwrap().clone();
    let html = tauri::async_runtime::spawn_blocking(move || {
        render_markdown_from_state(&repo_path, &file_path, &rev, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    if let Some(key) = cache_key {
        cache_put(&mut cache.0.lock().unwrap(), key, html.clone());
    }
    Ok(html)
}

/// Cache key for a block diff — `Some` only when both revs are immutable commits,
/// so working-tree/index diffs always recompute (they move on every `repo-changed`).
fn diff_cache_key(
    repo_path: &str,
    file_path: &str,
    before_rev: &RevSpec,
    after_rev: &RevSpec,
) -> Option<String> {
    match (before_rev, after_rev) {
        (RevSpec::Commit { oid: before }, RevSpec::Commit { oid: after }) => Some(format!(
            "{repo_path}\u{1f}{file_path}\u{1f}{before}\u{1f}{after}"
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
    state: State<'_, RepoState>,
    cache: State<'_, MarkdownDiffCache>,
) -> Result<Vec<DiffRow>, String> {
    let cache_key = diff_cache_key(&repo_path, &file_path, &before_rev, &after_rev);
    if let Some(ref key) = cache_key {
        if let Some(hit) = cache.0.lock().unwrap().get(key).cloned() {
            return Ok(hit);
        }
    }

    let state_map = state.0.lock().unwrap().clone();
    let rows = tauri::async_runtime::spawn_blocking(move || {
        render_markdown_diff_from_state(&repo_path, &file_path, &before_rev, &after_rev, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    if let Some(key) = cache_key {
        cache_put(&mut cache.0.lock().unwrap(), key, rows.clone());
    }
    Ok(rows)
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
        if let NodeValue::Image(link) = &mut data.value {
            if let Some(new_url) = rewrite_image(&link.url) {
                link.url = new_url;
            }
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
        .add_allowed_classes("li", MD_TINT_CLASSES.iter().copied());
    builder.clean(html).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn no_rewrite(_: &str) -> Option<String> {
        None
    }

    fn sig() -> git2::Signature<'static> {
        git2::Signature::new("Test", "test@example.com", &git2::Time::new(0, 0)).unwrap()
    }

    /// Repo with `doc.md` committed as "committed", staged as "staged", and left
    /// as "workdir" in the working tree — so each rev returns a distinct value.
    fn repo_with_three_revs() -> (TempDir, git2::Repository, git2::Oid) {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();

        fs::write(dir.path().join("doc.md"), b"committed").unwrap();
        let commit_oid = {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("doc.md")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let s = sig();
            repo.commit(Some("HEAD"), &s, &s, "initial", &tree, &[])
                .unwrap()
        };

        fs::write(dir.path().join("doc.md"), b"staged").unwrap();
        {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("doc.md")).unwrap();
            index.write().unwrap();
        }

        fs::write(dir.path().join("doc.md"), b"workdir").unwrap();

        (dir, repo, commit_oid)
    }

    #[test]
    fn reads_head_blob() {
        let (_dir, repo, _oid) = repo_with_three_revs();
        let bytes = read_file_at_inner(&repo, "doc.md", &RevSpec::Head).unwrap();
        assert_eq!(bytes, b"committed");
    }

    #[test]
    fn reads_index_blob() {
        let (_dir, repo, _oid) = repo_with_three_revs();
        let bytes = read_file_at_inner(&repo, "doc.md", &RevSpec::Index).unwrap();
        assert_eq!(bytes, b"staged");
    }

    #[test]
    fn reads_working_tree_file() {
        let (_dir, repo, _oid) = repo_with_three_revs();
        let bytes = read_file_at_inner(&repo, "doc.md", &RevSpec::WorkingTree).unwrap();
        assert_eq!(bytes, b"workdir");
    }

    #[test]
    fn reads_commit_blob() {
        let (_dir, repo, oid) = repo_with_three_revs();
        let rev = RevSpec::Commit {
            oid: oid.to_string(),
        };
        let bytes = read_file_at_inner(&repo, "doc.md", &rev).unwrap();
        assert_eq!(bytes, b"committed");
    }

    #[test]
    fn rejects_working_tree_path_escape() {
        let (_dir, repo, _oid) = repo_with_three_revs();
        let err = read_file_at_inner(&repo, "../../../../../../etc/hosts", &RevSpec::WorkingTree)
            .unwrap_err();
        // A path resolving outside the repo is either rejected as an escape or
        // never found — both keep the file's bytes from leaving the sandbox.
        assert!(
            err.code == "path_escape" || err.code == "not_found",
            "expected escape/not_found, got {}",
            err.code
        );
    }

    #[test]
    fn rev_url_token_round_trips() {
        for rev in [
            RevSpec::WorkingTree,
            RevSpec::Index,
            RevSpec::Head,
            RevSpec::Commit {
                oid: "deadbeef".to_string(),
            },
        ] {
            let token = rev.to_url_token();
            assert_eq!(RevSpec::from_url_token(&token).unwrap(), rev);
        }
    }

    #[test]
    fn rev_url_token_rejects_garbage() {
        assert!(RevSpec::from_url_token("not-a-rev").is_err());
    }

    #[test]
    fn identical_documents_yield_all_unchanged_rows() {
        let md = "# Title\n\nfirst para\n\nsecond para";
        let rows = diff_markdown_blocks(
            md,
            md,
            "/repo",
            "doc.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
        );
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
        let rows = diff_markdown_blocks(
            &before,
            &after,
            "/r",
            "d.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
        );
        assert!(!rows.is_empty(), "returns without hanging or panicking");
    }

    #[test]
    fn diff_cache_key_only_for_commit_pairs() {
        let commit = |oid: &str| RevSpec::Commit {
            oid: oid.to_string(),
        };
        assert!(
            diff_cache_key("/r", "d.md", &commit("aaa"), &commit("bbb")).is_some(),
            "commit-vs-commit is cacheable"
        );
        assert!(
            diff_cache_key("/r", "d.md", &RevSpec::Head, &commit("bbb")).is_none(),
            "a HEAD side is not cacheable"
        );
        assert!(
            diff_cache_key("/r", "d.md", &commit("aaa"), &RevSpec::WorkingTree).is_none(),
            "a working-tree side is not cacheable"
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
            &state_map,
        )
        .unwrap();
        assert!(
            !added.is_empty() && added.iter().all(|r| matches!(r, DiffRow::Added { .. })),
            "absent before → every block added: {added:?}"
        );

        let removed = render_markdown_diff_from_state(
            &repo_str,
            "new.md",
            &RevSpec::WorkingTree,
            &RevSpec::Head,
            &state_map,
        )
        .unwrap();
        assert!(
            !removed.is_empty() && removed.iter().all(|r| matches!(r, DiffRow::Removed { .. })),
            "absent after → every block removed: {removed:?}"
        );
    }

    #[test]
    fn tinted_fragment_strips_sourcepos_and_keeps_only_the_tint_class() {
        let before = "| a | b |\n|---|---|\n| 1 | 2 |";
        let after = "| a | b |\n|---|---|\n| 9 | 2 |";
        let rows = diff_markdown_blocks(
            before,
            after,
            "/r",
            "d.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
        );
        let DiffRow::Changed { after_html, .. } = &rows[0] else {
            panic!("{rows:?}");
        };
        assert!(
            after_html.contains("md-changed"),
            "tint survives: {after_html}"
        );
        assert!(
            !after_html.contains("data-sourcepos"),
            "sourcepos is stripped by sanitization: {after_html}"
        );
    }

    #[test]
    fn diff_strips_raw_script_and_does_not_smuggle_a_tint_class_from_text() {
        let before = "clean paragraph";
        let after = "<script>alert(1)</script>\n\ntext md-changed here";
        let rows = diff_markdown_blocks(
            before,
            after,
            "/r",
            "d.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
        );
        let dump: String = rows.iter().map(|r| format!("{r:?}")).collect();
        assert!(!dump.contains("<script"), "raw <script> stripped: {dump}");
        assert!(
            !dump.contains("class=\"md-changed\""),
            "literal 'md-changed' text must not become a class attribute: {dump}"
        );
    }

    #[test]
    fn changed_table_tints_only_the_changed_row() {
        let before = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |";
        let after = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 99 |";
        let rows = diff_markdown_blocks(
            before,
            after,
            "/r",
            "d.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
        );
        assert_eq!(rows.len(), 1, "the whole table is one row: {rows:?}");
        let DiffRow::Changed { after_html, .. } = &rows[0] else {
            panic!("a one-cell table edit is a Changed row: {rows:?}");
        };
        assert!(
            after_html.contains("<table"),
            "table stays intact: {after_html}"
        );
        assert_eq!(
            after_html.matches("md-changed").count(),
            1,
            "exactly the changed row is tinted, not the whole table: {after_html}"
        );
    }

    #[test]
    fn changed_list_tints_only_the_changed_item() {
        let before = "- keep one\n- keep two\n- old third";
        let after = "- keep one\n- keep two\n- new third";
        let rows = diff_markdown_blocks(
            before,
            after,
            "/r",
            "d.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
        );
        assert_eq!(rows.len(), 1, "the whole list is one row: {rows:?}");
        let DiffRow::Changed { after_html, .. } = &rows[0] else {
            panic!("a one-item list edit is a Changed row: {rows:?}");
        };
        assert_eq!(
            after_html.matches("md-changed").count(),
            1,
            "exactly the changed item is tinted: {after_html}"
        );
    }

    #[test]
    fn rewrapped_paragraph_reads_as_unchanged() {
        let before = "the quick brown fox\njumps over the lazy dog";
        let after = "the quick brown fox jumps over\nthe lazy dog";
        let rows = diff_markdown_blocks(
            before,
            after,
            "/r",
            "d.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
        );
        assert_eq!(rows.len(), 1, "one paragraph: {rows:?}");
        assert!(
            matches!(rows[0], DiffRow::Unchanged { .. }),
            "a reflow-only edit is not tinted: {rows:?}"
        );
    }

    #[test]
    fn similar_edit_is_changed_type_change_is_remove_plus_add() {
        let edit = diff_markdown_blocks(
            "kept intro\n\nold body text here",
            "kept intro\n\nold body text there",
            "/r",
            "d.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
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

        let type_change = diff_markdown_blocks(
            "hello world",
            "# hello world",
            "/r",
            "d.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
        );
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

        let added = diff_markdown_blocks(
            before,
            after,
            "/repo",
            "doc.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
        );
        assert_eq!(added.len(), 3, "{added:?}");
        match &added[2] {
            DiffRow::Added { html } => assert!(html.contains("new para"), "{html}"),
            other => panic!("expected Added carrying the after html, got {other:?}"),
        }

        let removed = diff_markdown_blocks(
            after,
            before,
            "/repo",
            "doc.md",
            &RevSpec::Head,
            &RevSpec::WorkingTree,
        );
        assert_eq!(removed.len(), 3, "{removed:?}");
        match &removed[2] {
            DiffRow::Removed { html } => assert!(html.contains("new para"), "{html}"),
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
    fn render_from_state_rewrites_local_image_against_file_dir() {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("docs")).unwrap();
        fs::write(
            dir.path().join("docs/README.md"),
            b"![logo](img/logo.png) and ![remote](https://ex.com/a.png)",
        )
        .unwrap();

        let oid = {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("docs/README.md")).unwrap();
            index.write().unwrap();
            let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
            let s = sig();
            repo.commit(Some("HEAD"), &s, &s, "initial", &tree, &[])
                .unwrap()
        };

        let mut state_map = HashMap::new();
        state_map.insert(
            dir.path().to_string_lossy().to_string(),
            dir.path().to_path_buf(),
        );

        let rev = RevSpec::Commit {
            oid: oid.to_string(),
        };
        let html = render_markdown_from_state(
            &dir.path().to_string_lossy(),
            "docs/README.md",
            &rev,
            &state_map,
        )
        .unwrap();

        assert!(
            html.contains(&format!("rev=commit-{oid}"))
                && html.contains("path=docs%2Fimg%2Flogo.png"),
            "local image resolved against the file's dir at the doc's rev: {html}"
        );
        assert!(
            html.contains("https://ex.com/a.png"),
            "remote image left untouched: {html}"
        );

        // The emitted URL round-trips back through the handler's parser.
        let repo_str = dir.path().to_string_lossy();
        let uri = format!(
            "trunk-asset://asset/?repo={}&rev={}&path={}",
            pct_encode(&repo_str),
            pct_encode(&rev.to_url_token()),
            pct_encode("docs/img/logo.png")
        );
        let (repo, parsed_rev, path) = parse_asset_uri(&uri).unwrap();
        assert_eq!(repo, repo_str);
        assert_eq!(parsed_rev, rev);
        assert_eq!(path, "docs/img/logo.png");
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

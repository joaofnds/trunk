// Markdown rendering + blob reads. Two concerns share this module because both
// resolve a file at a `RevSpec`: `read_file_at` returns the raw bytes, and the
// `trunk-asset://` protocol handler (wired in lib.rs) streams those same bytes
// for local images. Keeping the resolver in one place means the security
// boundary — working-tree path-escape rejection — lives in exactly one function.

use crate::error::TrunkError;
use crate::git::syntax;
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

const MARKDOWN_CACHE_CAP: usize = 128;

/// Insert into the render cache, bounding its size. Rendered HTML is cheap to
/// recompute, so on overflow we drop the whole cache rather than track LRU order
/// (no dependency, fewest elements) — a rare full miss beats unbounded growth.
fn cache_put(map: &mut HashMap<String, String>, key: String, value: String) {
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
    let base_dir = Path::new(file_path)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let repo_q = pct_encode(repo_path);
    let rev_q = pct_encode(&rev.to_url_token());
    let rewrite = |url: &str| {
        if url.is_empty() || url.starts_with('#') || has_url_scheme(url) {
            None
        } else {
            let path_q = pct_encode(&resolve_relative(&base_dir, url));
            Some(format!(
                "trunk-asset://asset/?repo={repo_q}&rev={rev_q}&path={path_q}"
            ))
        }
    };
    render_markdown_html(markdown, &rewrite)
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
    let (rp, fp, rev) = (repo_path.clone(), file_path.clone(), rev.clone());
    let html = tauri::async_runtime::spawn_blocking(move || {
        render_markdown_from_state(&rp, &fp, &rev, &state_map)
    })
    .await
    .map_err(|e| TrunkError::new("spawn_error", e.to_string()).to_json())?
    .map_err(|e| e.to_json())?;

    if let Some(key) = cache_key {
        cache_put(&mut cache.0.lock().unwrap(), key, html.clone());
    }
    Ok(html)
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
    let mut options = comrak::Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.tagfilter = true;
    // Recognize YAML front matter so comrak excludes it from the prose body:
    // with the delimiter set, comrak renders front matter as nothing (without it,
    // `---` reads as a thematic break and the YAML leaks as a run-on paragraph).
    options.extension.front_matter_delimiter = Some("---".to_string());
    // `render.unsafe` stays at its default (off): raw HTML is stripped and
    // dangerous hrefs emptied. Ammonia below is the second, authoritative layer.

    let root = comrak::parse_document(&arena, markdown, &options);

    for node in root.descendants() {
        let mut data = node.data.borrow_mut();
        if let NodeValue::Image(link) = &mut data.value {
            if let Some(new_url) = rewrite_image(&link.url) {
                link.url = new_url;
            }
        }
    }

    let adapter = TrunkSyntaxAdapter;
    let mut plugins = comrak::options::Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(&adapter);

    let mut html = String::new();
    comrak::format_html_with_plugins(root, &options, &mut html, &plugins)
        .expect("formatting to a String cannot fail");

    sanitize_html(&html)
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
        .add_allowed_classes("span", SYN_CLASSES.iter().copied());
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

use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use syntect::easy::HighlightLines;
use syntect::highlighting::ThemeSet;
use syntect::parsing::SyntaxSet;

struct BenchRepo {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}

/// Create a repo with an initial commit on main, then `branch_count` additional branches
/// each with 2 extra commits. Produces a repo with many refs for `list_refs_inner` to enumerate.
fn make_repo_with_branches(branch_count: usize) -> BenchRepo {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let sig = git2::Signature::now("Bench", "bench@test.com").unwrap();

    // Initial commit on main
    let blob_oid = repo.blob(b"initial").unwrap();
    let mut tb = repo.treebuilder(None).unwrap();
    tb.insert("README.md", blob_oid, 0o100644).unwrap();
    let tree_oid = tb.write().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    let initial_oid = repo
        .commit(
            Some("refs/heads/main"),
            &sig,
            &sig,
            "Initial commit",
            &tree,
            &[],
        )
        .unwrap();
    let initial_commit = repo.find_commit(initial_oid).unwrap();

    // Create branches, each with 2 additional commits
    for b in 0..branch_count {
        let branch = repo
            .branch(&format!("branch-{b}"), &initial_commit, false)
            .unwrap();
        let branch_ref = branch.into_reference();
        let ref_name = branch_ref.name().unwrap().to_owned();

        let mut parent_oid = initial_oid;
        for c in 0..2 {
            let blob = repo
                .blob(format!("branch-{b}-commit-{c}").as_bytes())
                .unwrap();
            let mut tb = repo.treebuilder(None).unwrap();
            tb.insert(format!("file-{b}-{c}.txt"), blob, 0o100644)
                .unwrap();
            let tree_oid = tb.write().unwrap();
            let tree = repo.find_tree(tree_oid).unwrap();
            let parent = repo.find_commit(parent_oid).unwrap();
            let oid = repo
                .commit(
                    Some(&ref_name),
                    &sig,
                    &sig,
                    &format!("Branch {b} commit {c}"),
                    &tree,
                    &[&parent],
                )
                .unwrap();
            parent_oid = oid;
        }
    }

    BenchRepo {
        path: dir.path().to_path_buf(),
        _dir: dir,
    }
}

/// Create a repo with an initial commit containing README.md, then modify
/// README.md on the filesystem to produce unstaged changes for diff and status benchmarks.
fn make_repo_with_unstaged_changes() -> BenchRepo {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let sig = git2::Signature::now("Bench", "bench@test.com").unwrap();

    // Write README.md to filesystem and commit it
    std::fs::write(dir.path().join("README.md"), "initial content").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("README.md")).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    repo.commit(
        Some("refs/heads/main"),
        &sig,
        &sig,
        "Initial commit",
        &tree,
        &[],
    )
    .unwrap();

    // Modify README.md to produce unstaged changes
    std::fs::write(dir.path().join("README.md"), "modified content").unwrap();

    BenchRepo {
        path: dir.path().to_path_buf(),
        _dir: dir,
    }
}

/// Create a fresh repo with an unstaged hunk for `stage_hunk_inner` (mutating operation).
/// Returns (dir, `path_string`, `state_map`) -- dir must live until the iteration ends.
fn make_repo_for_stage_hunk() -> (tempfile::TempDir, String, HashMap<String, PathBuf>) {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let sig = git2::Signature::now("Bench", "bench@test.com").unwrap();

    // Write README.md and commit
    std::fs::write(dir.path().join("README.md"), "initial content\n").unwrap();
    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("README.md")).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    repo.commit(
        Some("refs/heads/main"),
        &sig,
        &sig,
        "Initial commit",
        &tree,
        &[],
    )
    .unwrap();

    // Modify README.md to produce an unstaged hunk
    std::fs::write(dir.path().join("README.md"), "modified content\n").unwrap();

    let path = dir.path().display().to_string();
    let mut state_map: HashMap<String, PathBuf> = HashMap::new();
    state_map.insert(path.clone(), dir.path().to_path_buf());

    (dir, path, state_map)
}

// OnceLock fixtures for read-only benchmarks
static REPO_BRANCHES: OnceLock<BenchRepo> = OnceLock::new();
static REPO_UNSTAGED: OnceLock<BenchRepo> = OnceLock::new();

fn bench_list_refs(c: &mut Criterion) {
    let bench_repo = REPO_BRANCHES.get_or_init(|| make_repo_with_branches(50));
    let path = bench_repo.path.display().to_string();
    let mut state_map: HashMap<String, PathBuf> = HashMap::new();
    state_map.insert(path.clone(), bench_repo.path.clone());

    c.bench_function("list_refs_inner", |b| {
        b.iter(|| {
            trunk_lib::commands::branches::list_refs_inner(&path, &state_map).unwrap();
        });
    });
}

fn bench_diff_unstaged(c: &mut Criterion) {
    let bench_repo = REPO_UNSTAGED.get_or_init(make_repo_with_unstaged_changes);
    let path = bench_repo.path.display().to_string();
    let mut state_map: HashMap<String, PathBuf> = HashMap::new();
    state_map.insert(path.clone(), bench_repo.path.clone());

    c.bench_function("diff_unstaged_inner", |b| {
        b.iter(|| {
            trunk_lib::commands::diff::diff_unstaged_inner(
                &path,
                "README.md",
                &state_map,
                &trunk_lib::git::types::DiffRequestOptions::default(),
            )
            .unwrap();
        });
    });
}

fn bench_get_status(c: &mut Criterion) {
    // Reuse REPO_UNSTAGED -- get_status reads but doesn't mutate
    let bench_repo = REPO_UNSTAGED.get_or_init(make_repo_with_unstaged_changes);
    let path = bench_repo.path.display().to_string();
    let mut state_map: HashMap<String, PathBuf> = HashMap::new();
    state_map.insert(path.clone(), bench_repo.path.clone());

    c.bench_function("get_status_inner", |b| {
        b.iter(|| {
            trunk_lib::commands::staging::get_status_inner(&path, &state_map).unwrap();
        });
    });
}

fn bench_stage_hunk(c: &mut Criterion) {
    c.bench_function("stage_hunk_inner", |b| {
        b.iter_batched(
            make_repo_for_stage_hunk,
            |(_dir, path, state_map)| {
                trunk_lib::commands::staging::stage_hunk_inner(
                    &path,
                    "README.md",
                    0,
                    &state_map,
                    &trunk_lib::git::types::DiffRequestOptions::default(),
                )
                .unwrap();
                // _dir dropped here, cleaning up temp directory
            },
            BatchSize::SmallInput,
        );
    });
}

/// Create a repo with a realistic code file (TypeScript) that has multiple changed hunks.
/// Tests the full enrichment pipeline: syntax highlighting + word-level diff.
fn make_repo_with_code_changes() -> BenchRepo {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let sig = git2::Signature::now("Bench", "bench@test.com").unwrap();

    let original = r#"import { invoke } from "@tauri-apps/api/core";
import type { FileDiff, DiffRequestOptions } from "../lib/types";

export async function loadDiff(path: string, options: DiffRequestOptions): Promise<FileDiff[]> {
    const result = await invoke<FileDiff[]>("diff_unstaged", { path, options });
    return result.filter((fd) => !fd.is_binary);
}

export function formatLineNumber(num: number | null): string {
    if (num === null) return "   ";
    return num.toString().padStart(4, " ");
}

export function isContextLine(origin: string): boolean {
    return origin === "Context";
}

export function getLineClass(origin: string): string {
    switch (origin) {
        case "Add": return "line-add";
        case "Delete": return "line-delete";
        default: return "line-context";
    }
}

export async function stageFile(path: string, filePath: string): Promise<void> {
    await invoke("stage_file", { path, filePath });
}

export async function unstageFile(path: string, filePath: string): Promise<void> {
    await invoke("unstage_file", { path, filePath });
}

export function computeStats(diffs: FileDiff[]): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const fd of diffs) {
        for (const hunk of fd.hunks) {
            for (const line of hunk.lines) {
                if (line.origin === "Add") added++;
                if (line.origin === "Delete") removed++;
            }
        }
    }
    return { added, removed };
}
"#;

    let modified = r#"import { invoke } from "@tauri-apps/api/core";
import type { FileDiff, DiffRequestOptions, ViewMode } from "../lib/types";

export async function loadDiff(
    path: string,
    filePath: string,
    options: DiffRequestOptions,
): Promise<FileDiff[]> {
    const result = await invoke<FileDiff[]>("diff_unstaged", { path, filePath, options });
    return result.filter((fd) => !fd.is_binary && fd.hunks.length > 0);
}

export function formatLineNumber(num: number | null, width: number = 4): string {
    if (num === null) return " ".repeat(width);
    return num.toString().padStart(width, " ");
}

export function isContextLine(origin: string): boolean {
    return origin === "Context";
}

export function getLineClass(origin: string, viewMode: ViewMode): string {
    const base = (() => {
        switch (origin) {
            case "Add": return "line-add";
            case "Delete": return "line-delete";
            default: return "line-context";
        }
    })();
    return viewMode === "full" ? `${base} full-file` : base;
}

export async function stageFile(repoPath: string, filePath: string): Promise<void> {
    await invoke("stage_file", { path: repoPath, filePath });
}

export async function unstageFile(repoPath: string, filePath: string): Promise<void> {
    await invoke("unstage_file", { path: repoPath, filePath });
}

export function computeStats(diffs: FileDiff[]): { added: number; removed: number; files: number } {
    let added = 0;
    let removed = 0;
    for (const fd of diffs) {
        for (const hunk of fd.hunks) {
            for (const line of hunk.lines) {
                if (line.origin === "Add") added++;
                if (line.origin === "Delete") removed++;
            }
        }
    }
    return { added, removed, files: diffs.length };
}
"#;

    std::fs::write(dir.path().join("diff-utils.ts"), original).unwrap();
    let mut index = repo.index().unwrap();
    index
        .add_path(std::path::Path::new("diff-utils.ts"))
        .unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    repo.commit(
        Some("refs/heads/main"),
        &sig,
        &sig,
        "Initial commit",
        &tree,
        &[],
    )
    .unwrap();

    std::fs::write(dir.path().join("diff-utils.ts"), modified).unwrap();

    BenchRepo {
        path: dir.path().to_path_buf(),
        _dir: dir,
    }
}

static REPO_CODE: OnceLock<BenchRepo> = OnceLock::new();

/// Benchmark the full pipeline (git2 walk + enrichment) — the optimized version.
fn bench_diff_code_file(c: &mut Criterion) {
    let bench_repo = REPO_CODE.get_or_init(make_repo_with_code_changes);
    let path = bench_repo.path.display().to_string();
    let mut state_map: HashMap<String, PathBuf> = HashMap::new();
    state_map.insert(path.clone(), bench_repo.path.clone());

    c.bench_function("diff_ts_full_pipeline", |b| {
        b.iter(|| {
            trunk_lib::commands::diff::diff_unstaged_inner(
                &path,
                "diff-utils.ts",
                &state_map,
                &trunk_lib::git::types::DiffRequestOptions::default(),
            )
            .unwrap()
        });
    });
}

/// Benchmark JUST the enrichment step (new: per-file highlighter).
fn bench_enrich_new(c: &mut Criterion) {
    let bench_repo = REPO_CODE.get_or_init(make_repo_with_code_changes);
    let path = bench_repo.path.display().to_string();
    let mut state_map: HashMap<String, PathBuf> = HashMap::new();
    state_map.insert(path.clone(), bench_repo.path.clone());

    // Get raw diffs and their real side content once, outside b.iter, so the
    // benchmark measures enrich_file_diffs's own cost, not side resolution.
    let (raw, sides) = trunk_lib::commands::diff::diff_unstaged_raw_for_bench(
        &path,
        "diff-utils.ts",
        &state_map,
        &trunk_lib::git::types::DiffRequestOptions::default(),
    )
    .unwrap();

    c.bench_function("enrich_ts_new_perfile", |b| {
        b.iter(|| {
            let mut diffs = raw.clone();
            trunk_lib::commands::diff::enrich_file_diffs(&mut diffs, &sides);
            diffs
        });
    });
}

/// The debounced draft autosave, which is the write the `synchronous = NORMAL`
/// pragma choice trades against. A number here is readable over time; the same
/// measurement as a threshold in the correctness suite only reports how loaded
/// the CI runner was.
fn bench_draft_write(c: &mut Criterion) {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    let store = trunk_lib::reviewdb::open(dir.path()).unwrap();
    let mut n = 0u64;

    c.bench_function("reviewdb_draft_write", |b| {
        b.iter(|| {
            n += 1;
            trunk_lib::commands::review::save_draft_inner(
                &store,
                &repo,
                &format!("keystroke burst {n}"),
                None,
                1_000,
            )
            .unwrap();
        });
    });
}

/// Blocks of uniform TypeScript, sized so the file lands near 3,000 lines --
/// comfortably under `MAX_SYNTAX_PARSE_LINES` even when a fixture's needed
/// lines span the whole file, so every case measures highlighting rather than
/// the cap that skips it.
const LARGE_FILE_BLOCKS: usize = 375;
const EARLY_CHANGED_BLOCK: usize = 1;
const LATE_CHANGED_BLOCK: usize = LARGE_FILE_BLOCKS - 2;

/// The uniform blocks, with `total_line` deciding each block's `total` statement --
/// which is the only line any version of this file varies.
fn large_typescript_file_with(total_line: impl Fn(usize) -> String) -> String {
    let mut lines = vec![
        "import type { FileDiff } from \"../lib/types\";".to_string(),
        String::new(),
    ];

    for block in 0..LARGE_FILE_BLOCKS {
        lines.push(format!(
            "export function computeStat{block}(diffs: FileDiff[]): number {{"
        ));
        lines.push(total_line(block));
        lines.push("    for (const fd of diffs) {".to_string());
        lines.push("        total += fd.hunks.length;".to_string());
        lines.push("    }".to_string());
        lines.push("    return total;".to_string());
        lines.push("}".to_string());
        lines.push(String::new());
    }

    lines.join("\n")
}

/// The large file's two versions, differing only in one line of `changed_block`.
/// `None` yields the committed version.
fn large_typescript_file(changed_block: Option<usize>) -> String {
    large_typescript_file_with(|block| {
        if changed_block == Some(block) {
            format!("    let total = {block} * 2;")
        } else {
            format!("    let total = {block};")
        }
    })
}

/// The same file with any number of changed blocks, and `nonce` in every changed
/// line so two rewrites never produce the same bytes -- which is what gives the
/// working-tree side a fresh content OID on each save.
fn large_typescript_file_variant(changed_blocks: &[usize], nonce: usize) -> String {
    large_typescript_file_with(|block| {
        if changed_blocks.contains(&block) {
            format!("    let total = {block} * 2 + {nonce};")
        } else {
            format!("    let total = {block};")
        }
    })
}

/// A repo with the ~3,000-line file committed and the working tree matching it.
fn make_repo_with_committed_large_file() -> BenchRepo {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let sig = git2::Signature::now("Bench", "bench@test.com").unwrap();

    std::fs::write(dir.path().join("large.ts"), large_typescript_file(None)).unwrap();

    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("large.ts")).unwrap();
    index.write().unwrap();
    let tree_oid = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();
    repo.commit(
        Some("refs/heads/main"),
        &sig,
        &sig,
        "Initial commit",
        &tree,
        &[],
    )
    .unwrap();

    BenchRepo {
        path: dir.path().to_path_buf(),
        _dir: dir,
    }
}

/// A repo whose only unstaged change is one line of a ~3,000-line file. Each
/// side's highlighter walks every line from 1 up to that one, so how deep the
/// change sits is what the fixture varies -- the diff itself stays the same size.
fn make_repo_with_large_file_change(changed_block: usize) -> BenchRepo {
    let bench_repo = make_repo_with_committed_large_file();

    std::fs::write(
        bench_repo.path.join("large.ts"),
        large_typescript_file(Some(changed_block)),
    )
    .unwrap();

    bench_repo
}

static REPO_LARGE_EARLY: OnceLock<BenchRepo> = OnceLock::new();
static REPO_LARGE_LATE: OnceLock<BenchRepo> = OnceLock::new();
static REPO_EDIT_SAVE: OnceLock<BenchRepo> = OnceLock::new();
static REPO_EDIT_SAVE_WIDE: OnceLock<BenchRepo> = OnceLock::new();

/// The full pipeline over a one-line change in a large file. Pairs an early
/// change against a late one: the gap between them is what the per-side design
/// charges for the distance from the top of the file.
fn bench_diff_large_file(c: &mut Criterion) {
    let early =
        REPO_LARGE_EARLY.get_or_init(|| make_repo_with_large_file_change(EARLY_CHANGED_BLOCK));
    let late = REPO_LARGE_LATE.get_or_init(|| make_repo_with_large_file_change(LATE_CHANGED_BLOCK));

    let mut group = c.benchmark_group("diff_ts_large_file");
    group.sample_size(20);

    for (id, bench_repo) in [("early_change", early), ("late_change", late)] {
        let path = bench_repo.path.display().to_string();
        let mut state_map: HashMap<String, PathBuf> = HashMap::new();
        state_map.insert(path.clone(), bench_repo.path.clone());

        group.bench_function(id, |b| {
            b.iter(|| {
                trunk_lib::commands::diff::diff_unstaged_inner(
                    &path,
                    "large.ts",
                    &state_map,
                    &trunk_lib::git::types::DiffRequestOptions::default(),
                )
                .unwrap()
            });
        });
    }

    // The user's edit-save loop: the working-tree side rewritten every
    // iteration, which is what a save produces. `edit_save_wide_span` changes
    // both ends of the file, so the needed lines span it top to bottom.
    let edit_save = REPO_EDIT_SAVE.get_or_init(make_repo_with_committed_large_file);
    let edit_save_wide = REPO_EDIT_SAVE_WIDE.get_or_init(make_repo_with_committed_large_file);

    for (id, changed_blocks, bench_repo) in [
        ("edit_save_loop", &[LATE_CHANGED_BLOCK][..], edit_save),
        (
            "edit_save_wide_span",
            &[EARLY_CHANGED_BLOCK, LATE_CHANGED_BLOCK][..],
            edit_save_wide,
        ),
    ] {
        let path = bench_repo.path.display().to_string();
        let file = bench_repo.path.join("large.ts");
        let mut state_map: HashMap<String, PathBuf> = HashMap::new();
        state_map.insert(path.clone(), bench_repo.path.clone());
        let options = trunk_lib::git::types::DiffRequestOptions::default();
        let mut nonce = 0usize;

        group.bench_function(id, |b| {
            b.iter(|| {
                nonce += 1;
                std::fs::write(&file, large_typescript_file_variant(changed_blocks, nonce))
                    .unwrap();
                trunk_lib::commands::diff::diff_unstaged_inner(
                    &path, "large.ts", &state_map, &options,
                )
                .unwrap()
            });
        });
    }

    group.finish();
}

/// One block of TypeScript, frozen. Nothing in `trunk_lib` may reach this
/// constant: the calibration benchmarks measure the runner, so the moment their
/// workload tracks Trunk's code they stop dividing runner speed out of the gate.
const CALIBRATION_TS_BLOCK: &str = r#"
export interface CalibrationRecord {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
  readonly tags: readonly string[];
}

export function summarize(records: readonly CalibrationRecord[]): number {
  let total = 0;
  for (const record of records) {
    if (record.weight > 0 && record.tags.length > 0) {
      total += record.weight * record.tags.length;
    } else {
      total -= 1;
    }
  }
  return total;
}

export const DEFAULTS: CalibrationRecord = {
  id: "0",
  label: "default",
  weight: 1,
  tags: ["a", "b"],
};
"#;

const CALIBRATION_TS_BLOCKS: usize = 40;

const CALIBRATION_COMMITS: usize = 200;

static CALIBRATION_TS: OnceLock<String> = OnceLock::new();
static CALIBRATION_SYNTAX: OnceLock<SyntaxSet> = OnceLock::new();
static CALIBRATION_THEMES: OnceLock<ThemeSet> = OnceLock::new();
static CALIBRATION_REPO: OnceLock<BenchRepo> = OnceLock::new();

/// A fixed syntect highlight, the divisor for every syntect-class benchmark.
fn bench_calibration_syntect(c: &mut Criterion) {
    let source = CALIBRATION_TS.get_or_init(|| CALIBRATION_TS_BLOCK.repeat(CALIBRATION_TS_BLOCKS));
    let syntaxes = CALIBRATION_SYNTAX.get_or_init(two_face::syntax::extra_newlines);
    let themes = CALIBRATION_THEMES.get_or_init(ThemeSet::load_defaults);
    let syntax = syntaxes.find_syntax_by_extension("ts").unwrap();
    let theme = &themes.themes["base16-ocean.dark"];

    c.bench_function("calibration/syntect", |b| {
        b.iter(|| {
            let mut highlighter = HighlightLines::new(syntax, theme);
            let mut spans = 0usize;
            for line in source.split_inclusive('\n') {
                spans += highlighter.highlight_line(line, syntaxes).unwrap().len();
            }
            spans
        });
    });
}

/// A fixed git2 walk, the divisor for every git2-class benchmark.
fn bench_calibration_git2(c: &mut Criterion) {
    let bench_repo = CALIBRATION_REPO.get_or_init(make_calibration_repo);

    c.bench_function("calibration/git2", |b| {
        b.iter(|| {
            let repo = git2::Repository::open(&bench_repo.path).unwrap();
            let mut walk = repo.revwalk().unwrap();
            walk.push_head().unwrap();

            let mut bytes = 0usize;
            for oid in walk {
                let commit = repo.find_commit(oid.unwrap()).unwrap();
                let tree = commit.tree().unwrap();
                for entry in &tree {
                    let object = entry.to_object(&repo).unwrap();
                    bytes += object.as_blob().map_or(0, |blob| blob.content().len());
                }
            }
            bytes
        });
    });
}

fn make_calibration_repo() -> BenchRepo {
    let dir = tempfile::tempdir().unwrap();
    let repo = git2::Repository::init(dir.path()).unwrap();
    let when = git2::Time::new(1_700_000_000, 0);
    let sig = git2::Signature::new("Calibration", "calibration@test.com", &when).unwrap();

    let mut parent: Option<git2::Oid> = None;
    for n in 0..CALIBRATION_COMMITS {
        let blob = repo
            .blob(format!("{CALIBRATION_TS_BLOCK}{n}").as_bytes())
            .unwrap();
        let mut tb = repo.treebuilder(None).unwrap();
        tb.insert("calibration.ts", blob, 0o100644).unwrap();
        let tree_oid = tb.write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let parents: Vec<git2::Commit> = parent
            .map(|oid| repo.find_commit(oid).unwrap())
            .into_iter()
            .collect();
        let borrowed: Vec<&git2::Commit> = parents.iter().collect();
        parent = Some(
            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                &format!("Calibration commit {n}"),
                &tree,
                &borrowed,
            )
            .unwrap(),
        );
    }

    let path = dir.path().to_path_buf();
    BenchRepo { _dir: dir, path }
}

criterion_group!(
    benches,
    bench_calibration_syntect,
    bench_calibration_git2,
    bench_draft_write,
    bench_list_refs,
    bench_diff_unstaged,
    bench_diff_code_file,
    bench_diff_large_file,
    bench_enrich_new,
    bench_get_status,
    bench_stage_hunk
);
criterion_main!(benches);

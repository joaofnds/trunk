use serde::{Deserialize, Serialize};

// CRITICAL: All fields use owned types (String, Vec, i64, u32, usize, bool, Option<T>).
// NO git2 types (Commit<'repo>, Diff<'repo>, etc.) — those carry lifetimes and cannot be stored.
// Every git2 access converts immediately: commit_to_dto(c: &Commit) -> GraphCommit

#[derive(Debug, Serialize, Clone)]
pub enum EdgeType {
    Straight,
    MergeLeft,
    MergeRight,
    ForkLeft,
    ForkRight,
}

#[derive(Debug, Serialize, Clone)]
pub struct GraphEdge {
    pub from_column: usize,
    pub to_column: usize,
    pub edge_type: EdgeType,
    pub color_index: usize,
    pub dashed: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum RefType {
    LocalBranch,
    RemoteBranch,
    Tag,
    Stash,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RefLabel {
    pub name: String,
    pub short_name: String,
    pub ref_type: RefType,
    pub is_head: bool,
    pub color_index: usize,
}

#[derive(Debug, Serialize, Clone)]
pub struct StashEntry {
    pub index: usize,
    pub name: String,
    pub short_name: String,
    pub oid: String,
    pub parent_oid: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct GraphCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub body: Option<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_timestamp: i64,
    pub parent_oids: Vec<String>,
    pub column: usize,
    pub color_index: usize,
    pub edges: Vec<GraphEdge>,
    pub refs: Vec<RefLabel>,
    pub is_head: bool,
    pub is_merge: bool,
    pub is_branch_tip: bool,
    pub is_stash: bool,
    pub in_head_chain: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct GraphResult {
    pub commits: Vec<GraphCommit>,
    pub max_columns: usize,
}

/// A single commit in the review session, rendered by the panel (D-05) and
/// consumed as a membership set by the graph (D-04/D-06). Serialize-default
/// snake_case matches `GraphCommit`, whose fields it copies 1:1.
#[derive(Debug, Serialize, Clone)]
pub struct SessionCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    /// True when this commit is an auto-created review snapshot (working-tree or
    /// index), not a commit the user hand-picked. The panel hides EMPTY snapshot
    /// sections (260531-l02d) while keeping empty hand-picked sections (their
    /// per-commit "Add note" affordance). Set by `list_session_commits`.
    #[serde(default)]
    pub is_snapshot: bool,
}

// Per-commit (or WIP) diff size: insertions/deletions/files for the green-red bar
// in the graph's Diff column. Write-only DTO (Serialize, no Deserialize) like
// GraphCommit. Snake_case field names serialize as-is (no rename_all) to match the
// frontend DiffStat interface.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct DiffStat {
    pub insertions: usize,
    pub deletions: usize,
    pub files_changed: usize,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub enum MatchType {
    Sha,
    Message,
    Ref,
    Author,
}

#[derive(Debug, Serialize, Clone)]
pub struct SearchResult {
    pub oid: String,
    pub match_types: Vec<MatchType>,
}

#[derive(Debug, Serialize, Clone)]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    pub last_commit_timestamp: i64,
}

#[derive(Debug, Serialize, Clone)]
pub struct RefsResponse {
    pub local: Vec<BranchInfo>,
    pub remote: Vec<BranchInfo>,
    pub tags: Vec<RefLabel>,
    pub stashes: Vec<StashEntry>,
}

#[derive(Debug, Serialize, Clone)]
pub enum FileStatusType {
    New,
    Modified,
    Deleted,
    Renamed,
    Typechange,
    Conflicted,
}

#[derive(Debug, Serialize, Clone)]
pub struct FileStatus {
    pub path: String,
    pub status: FileStatusType,
    pub is_binary: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct WorkingTreeStatus {
    pub unstaged: Vec<FileStatus>,
    pub staged: Vec<FileStatus>,
    pub conflicted: Vec<FileStatus>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum DiffOrigin {
    Context,
    Add,
    Delete,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct WordSpan {
    pub start: u32,
    pub end: u32,
    pub emphasized: bool,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct SyntaxToken {
    pub start: u32,
    pub end: u32,
    pub scope: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct MergedSpan {
    pub start: u32,
    pub end: u32,
    pub syntax_class: String,
    pub emphasized: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequestOptions {
    #[serde(default = "default_context_lines")]
    pub context_lines: u32,
    #[serde(default)]
    pub ignore_whitespace: bool,
    #[serde(default)]
    pub show_full_file: bool,
}

fn default_context_lines() -> u32 {
    3
}

impl Default for DiffRequestOptions {
    fn default() -> Self {
        Self {
            context_lines: 3,
            ignore_whitespace: false,
            show_full_file: false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiffLine {
    pub origin: DiffOrigin,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    pub spans: Vec<MergedSpan>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum DiffStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
    Untracked,
    Unknown,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileDiff {
    pub path: String,
    pub status: DiffStatus,
    pub is_binary: bool,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeadCommitMessage {
    pub subject: String,
    pub body: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct UndoResult {
    pub subject: String,
    pub body: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct CommitDetail {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub body: Option<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_timestamp: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_timestamp: i64,
    pub parent_oids: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub enum OperationType {
    None,
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Serialize, Clone)]
pub struct OperationInfo {
    pub op_type: OperationType,
    pub source_branch: Option<String>,
    pub target_branch: Option<String>,
    pub progress: Option<String>,
    pub source_color_index: Option<usize>,
    pub target_color_index: Option<usize>,
    pub rebase_message: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct MergeSides {
    pub base: String,
    pub ours: String,
    pub theirs: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct RebaseTodoItem {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author_name: String,
    pub author_timestamp: i64,
}

// ── Review session schema (Phase 65 keystone) ────────────────────────────────
// Persisted to disk and read back, so every type derives Deserialize (unlike the
// write-only DTOs above — mirrors DiffStatus). Enums serialize as PascalCase
// strings with NO rename_all (mirrors RefType). Struct fields stay snake_case.
// The Anchor NEVER carries hunk_index/line_index/context_lines/ignore_whitespace
// (D-01): it stores source coordinates only, never diff-array positions.

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum Source {
    Diff,
    FullFile,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum Side {
    Old,
    New,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Anchor {
    pub commit_oid: String,
    pub file_path: String,
    pub source: Source,
    pub side: Side,
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Comment {
    // Stable id generated on write (D-03); edit/delete target by id, never by
    // list position. `#[serde(default)]` makes a v1 file lacking `id` deserialize
    // to "" (the migration-shape-A sentinel backfilled at load time) instead of
    // failing from_value.
    #[serde(default)]
    pub id: String,
    pub text: String,
    pub anchor: Option<Anchor>,
    pub cached_excerpt: Option<String>,
    // Commit-level comment target (D-01, written in Plan 02). A missing field
    // maps to None automatically for Option, so no #[serde(default)] is needed.
    pub commit_oid: Option<String>,
}

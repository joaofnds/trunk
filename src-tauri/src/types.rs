use serde::{Deserialize, Serialize};
use trunk_git::types::RefLabel;

// CRITICAL: All fields use owned types (String, Vec, i64, u32, usize, bool, Option<T>).
// NO git2 types (Commit<'repo>, Diff<'repo>, etc.), because those carry lifetimes and cannot
// be stored.
// Every git2 access converts immediately into one of these before it leaves a command.

#[derive(Debug, Serialize, Clone)]
pub struct StashEntry {
    pub index: usize,
    pub name: String,
    pub short_name: String,
    pub oid: String,
    pub parent_oid: Option<String>,
}

// Per-commit (or WIP) diff size: insertions/deletions/files for the green-red bar
// in the graph's Diff column. Write-only DTO (Serialize, no Deserialize) like
// GraphCommit. Snake_case field names serialize as-is (no rename_all) to match the
// frontend DiffStat interface.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct DiffStat {
    pub insertions: usize,
    pub deletions: usize,
    pub files_changed: usize,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
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

/// One file in the working-tree status. `old_path` names where a renamed file
/// came from and is `None` for every other status, mirroring `FileDiff` — the
/// file lists render both from the same shape.
#[derive(Debug, Serialize, Clone)]
pub struct FileStatus {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatusType,
    pub is_binary: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct WorkingTreeStatus {
    pub unstaged: Vec<FileStatus>,
    pub staged: Vec<FileStatus>,
    pub conflicted: Vec<FileStatus>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub enum DiffOrigin {
    Context,
    Add,
    Delete,
    /// git's "\ No newline at end of file" marker. It annotates the line above
    /// it rather than being a line of either side, so it carries no line numbers
    /// and no side of the split view seats it.
    NoNewline,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct WordSpan {
    pub start: u32,
    pub end: u32,
    pub emphasized: bool,
}

#[derive(Debug, Serialize, Clone, Default, PartialEq, Eq)]
pub struct SyntaxToken {
    pub start: u32,
    pub end: u32,
    pub scope: &'static str,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq, Eq)]
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

const fn default_context_lines() -> u32 {
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

/// How the split view should seat a changed line relative to the other side, decided by
/// the run-level word diff.
///
/// `Partner` names the hunk-line index of the homologous opposite-side line; `Alone` is
/// a line the word diff decided has no counterpart; `Unknown` means no word diff ran
/// over the line's run. The verdict is per run: a run the word diff skipped is all
/// `Unknown` and the view pairs it positionally, as before the word diff existed.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LinePairing {
    Partner {
        line: u32,
    },
    Alone,
    #[default]
    Unknown,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub origin: DiffOrigin,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
    /// Offsets in UTF-16 code units, not bytes: the frontend renders with
    /// `content.slice(start, end)`, so `merged_spans_to_utf16` converts at the
    /// enrich boundary. Rust-side span math elsewhere stays byte-based.
    pub spans: Vec<MergedSpan>,
    #[serde(default)]
    pub pairing: LinePairing,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub enum DiffStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
    Untracked,
    Unknown,
}

/// One file's place in a diff.
///
/// `path` is the new-side path, and for a delta libgit2's rename detection paired,
/// `old_path` names where the content came from; every other status leaves it `None`,
/// so a `Some` is the file list's signal to render one entry naming both paths.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
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
    /// Where the undo left HEAD. A redo restores the undone commit onto this
    /// position and nowhere else: replayed after a checkout or a reset it would
    /// commit the old message against unrelated history, so the caller carries
    /// this to tell the two apart.
    pub head_oid: String,
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

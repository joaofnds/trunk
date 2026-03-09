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
}

#[derive(Debug, Serialize, Clone)]
pub enum RefType {
    LocalBranch,
    RemoteBranch,
    Tag,
    Stash,
}

#[derive(Debug, Serialize, Clone)]
pub struct RefLabel {
    pub name: String,
    pub short_name: String,
    pub ref_type: RefType,
    pub is_head: bool,
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
}

#[derive(Debug, Serialize, Clone)]
pub struct GraphResult {
    pub commits: Vec<GraphCommit>,
    pub max_columns: usize,
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
    pub stashes: Vec<RefLabel>,
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

#[derive(Debug, Serialize, Clone)]
pub enum DiffOrigin {
    Context,
    Add,
    Delete,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiffLine {
    pub origin: DiffOrigin,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Serialize, Clone)]
pub enum DiffStatus {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
    Untracked,
    Unknown,
}

#[derive(Debug, Serialize, Clone)]
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

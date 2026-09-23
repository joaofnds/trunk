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
    /// The ref on the commit that opened this row's lane, which names the line of history
    /// the row belongs to. `None` when nothing points at that commit.
    ///
    /// Not the nearest ref above the row: a column reused by a later branch, and a tag
    /// pointing inside someone else's lane, are both nearer without naming anything. A lane
    /// only a tag holds is named by that tag.
    pub lane_ref: Option<RefLabel>,
}

#[derive(Debug, Serialize, Clone)]
pub struct GraphResult {
    pub commits: Vec<GraphCommit>,
    pub max_columns: usize,
}

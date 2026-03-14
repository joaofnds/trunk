// All TypeScript DTO interfaces mirroring Rust DTOs in src-tauri/src/git/types.rs
// Use string literal unions (not enum) — matches serde default serialization

export type EdgeType = 'Straight' | 'MergeLeft' | 'MergeRight' | 'ForkLeft' | 'ForkRight';
export type RefType = 'LocalBranch' | 'RemoteBranch' | 'Tag' | 'Stash';
export type FileStatusType = 'New' | 'Modified' | 'Deleted' | 'Renamed' | 'Typechange' | 'Conflicted';
export type DiffOrigin = 'Context' | 'Add' | 'Delete';

export interface GraphEdge {
  from_column: number;
  to_column: number;
  edge_type: EdgeType;
  color_index: number;
  dashed: boolean;
}

export interface RefLabel {
  name: string;
  short_name: string;
  ref_type: RefType;
  is_head: boolean;
  color_index: number;
}

export interface GraphCommit {
  oid: string;
  short_oid: string;
  summary: string;
  body: string | null;
  author_name: string;
  author_email: string;
  author_timestamp: number;
  parent_oids: string[];
  column: number;
  color_index: number;
  edges: GraphEdge[];
  refs: RefLabel[];
  is_head: boolean;
  is_merge: boolean;
  is_branch_tip: boolean;
  is_stash: boolean;
}

export interface GraphResponse {
  commits: GraphCommit[];
  max_columns: number;
}

export interface BranchInfo {
  name: string;
  is_head: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  last_commit_timestamp: number;
}

export interface StashEntry {
  index: number;
  name: string;
  short_name: string;
  oid: string;
  parent_oid: string | null;
}

export interface RefsResponse {
  local: BranchInfo[];
  remote: BranchInfo[];
  tags: RefLabel[];
  stashes: StashEntry[];
}

export interface FileStatus {
  path: string;
  status: FileStatusType;
  is_binary: boolean;
}

export interface WorkingTreeStatus {
  unstaged: FileStatus[];
  staged: FileStatus[];
  conflicted: FileStatus[];
}

export interface DiffLine {
  origin: DiffOrigin;
  content: string;
  old_lineno: number | null;
  new_lineno: number | null;
}

export interface DiffHunk {
  header: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffLine[];
}

export type DiffStatus = 'Added' | 'Deleted' | 'Modified' | 'Renamed' | 'Copied' | 'Untracked' | 'Unknown';

export interface FileDiff {
  path: string;
  status: DiffStatus;
  is_binary: boolean;
  hunks: DiffHunk[];
}

export interface SvgPathData {
  d: string;
  colorIndex: number;
  dashed?: boolean;
}

export interface HeadCommitMessage {
  subject: string;
  body: string | null;
}

export interface CommitDetail {
  oid: string;
  short_oid: string;
  summary: string;
  body: string | null;
  author_name: string;
  author_email: string;
  author_timestamp: number;
  committer_name: string;
  committer_email: string;
  committer_timestamp: number;
  parent_oids: string[];
}

// Overlay types — global grid coordinate system for SVG overlay (Phase 20+)
export interface OverlayNode {
  oid: string;
  x: number;           // swimlane index (column)
  y: number;           // row index
  colorIndex: number;
  isMerge: boolean;
  isBranchTip: boolean;
  isStash: boolean;
  isWip: boolean;
}

export interface OverlayEdge {
  fromX: number;        // source swimlane
  fromY: number;        // source row
  toX: number;          // target swimlane
  toY: number;          // target row
  colorIndex: number;
  dashed: boolean;
}

export interface OverlayGraphData {
  nodes: OverlayNode[];
  edges: OverlayEdge[];
  maxColumns: number;
}

export interface OverlayPath {
  d: string;
  colorIndex: number;
  dashed: boolean;
  kind: 'rail' | 'connection';
}

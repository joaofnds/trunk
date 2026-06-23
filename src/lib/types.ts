// All TypeScript DTO interfaces mirroring Rust DTOs in src-tauri/src/git/types.rs
// Use string literal unions (not enum) — matches serde default serialization

export type EdgeType =
	| "Straight"
	| "MergeLeft"
	| "MergeRight"
	| "ForkLeft"
	| "ForkRight";
export type RefType = "LocalBranch" | "RemoteBranch" | "Tag" | "Stash";
export type FileStatusType =
	| "New"
	| "Modified"
	| "Deleted"
	| "Renamed"
	| "Typechange"
	| "Conflicted";
export type DiffOrigin = "Context" | "Add" | "Delete";

export interface WordSpan {
	start: number;
	end: number;
	emphasized: boolean;
}

export interface SyntaxToken {
	start: number;
	end: number;
	scope: string;
}

export interface MergedSpan {
	start: number;
	end: number;
	syntax_class: string;
	emphasized: boolean;
}

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

// Navigation context for the currently-selected commit, derived from the
// loaded graph list. Emitted by CommitGraph, consumed by CommitDetail.
export interface CommitNav {
	index: number; // 1-based position among real commits (WIP row excluded)
	total: number; // count of loaded real commits
	hasMore: boolean; // true if older commits exist but aren't loaded yet
	newerOid: string | null; // adjacent commit toward HEAD (up); null at top
	olderOid: string | null; // adjacent commit toward root (down); null at loaded tail
	childOids: string[]; // loaded commits whose parent_oids include this commit
}

export type MatchType = "Sha" | "Message" | "Ref" | "Author";

export interface SearchResult {
	oid: string;
	match_types: MatchType[];
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

export type OperationType =
	| "None"
	| "Merge"
	| "Rebase"
	| "CherryPick"
	| "Revert";

export interface OperationInfo {
	op_type: OperationType;
	source_branch: string | null;
	target_branch: string | null;
	progress: string | null;
	source_color_index: number | null;
	target_color_index: number | null;
	rebase_message: string | null;
}

export interface MergeSides {
	base: string;
	ours: string;
	theirs: string;
}

export interface DiffLine {
	origin: DiffOrigin;
	content: string;
	old_lineno: number | null;
	new_lineno: number | null;
	spans: MergedSpan[];
}

export interface DiffHunk {
	header: string;
	old_start: number;
	old_lines: number;
	new_start: number;
	new_lines: number;
	lines: DiffLine[];
}

export type DiffStatus =
	| "Added"
	| "Deleted"
	| "Modified"
	| "Renamed"
	| "Copied"
	| "Untracked"
	| "Unknown";

export interface FileDiff {
	path: string;
	status: DiffStatus;
	is_binary: boolean;
	hunks: DiffHunk[];
}

export interface DiffRequestOptions {
	contextLines: number;
	ignoreWhitespace: boolean;
	showFullFile: boolean;
}

export type ContentMode = "hunk" | "full";
export type LayoutMode = "inline" | "split";

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

// Graph display settings — user-configurable layout constants for the commit graph.
// Defaults live in graph-constants.ts. A future settings page will persist and
// expose these values; the pure functions that produce SVG paths accept them as
// a parameter so they re-derive correctly when settings change.
export interface GraphDisplaySettings {
	rowHeight: number; // px per commit row
	laneWidth: number; // px per swimlane column
	dotRadius: number; // px radius of commit dots
	edgeStroke: number; // px stroke width for rails / connections
	mergeStroke: number; // px stroke width for merge-commit circles
	pillStroke: number; // px stroke width for ref-pill connector lines
}

// Per-status breakdown shown on the synthetic WIP row in the graph.
export interface WipStats {
	modified: number;
	new: number;
	deleted: number;
	renamed: number;
	typechange: number;
	conflicted: number;
}

// Overlay types — global grid coordinate system for SVG overlay (Phase 20+)
export interface OverlayNode {
	oid: string;
	x: number; // swimlane index (column)
	y: number; // row index
	colorIndex: number;
	isMerge: boolean;
	isBranchTip: boolean;
	isStash: boolean;
	isWip: boolean;
}

export interface OverlayConnection {
	childX: number; // child column
	childY: number; // child row
	parentX: number; // parent column
	parentY: number; // parent row
	colorIndex: number;
	dashed: boolean;
}

export interface OverlayGraphData {
	nodes: OverlayNode[];
	connections: OverlayConnection[];
	maxColumns: number;
}

export interface OverlayPath {
	d: string;
	colorIndex: number;
	dashed: boolean;
	minRow: number;
	maxRow: number;
}

export interface OverlayRefPill {
	x: number; // left edge of pill in SVG space
	y: number; // vertical center (cy(rowIndex))
	width: number; // computed from text measurement + padding
	textWidth: number; // raw canvas-measured text width (for precise foreignObject sizing)
	height: number; // PILL_HEIGHT constant
	label: string; // original ref short_name
	truncatedLabel: string; // possibly truncated with "…"
	refType: RefType; // for icon rendering
	colorIndex: number; // for laneColor() fill
	isHead: boolean; // full brightness, bold text
	isRemoteOnly: boolean; // 65-70% opacity dimming
	isNonHead: boolean; // brightness(0.75)
	overflowCount: number; // 0 = no badge, >0 = "+N" badge
	allRefs: RefLabel[]; // all refs on this commit (for hover expansion)
	dotCx: number; // target commit dot X coordinate
	dotCy: number; // target commit dot Y coordinate
	commitColorIndex: number; // commit's lane color for connector line
	rowIndex: number; // for virtualization filtering
	isHollow: boolean; // true for merge/stash/WIP dots (stroke-only, no fill)
}

// Interactive rebase types (mirrors src-tauri/src/git/types.rs RebaseTodoItem)
export interface RebaseTodoItem {
	oid: string;
	short_oid: string;
	summary: string;
	author_name: string;
	author_timestamp: number;
}

// Review session schema (mirrors src-tauri/src/git/types.rs Phase 65 keystone)
// String-for-string with the Rust on-wire shape: PascalCase enum strings,
// snake_case fields, nullable optionals for Rust Option<T>.
export type Source = "Diff" | "FullFile";
export type Side = "Old" | "New";

export interface Anchor {
	commit_oid: string;
	file_path: string;
	source: Source;
	side: Side;
	start_line: number;
	end_line: number;
}

export interface Comment {
	id: string;
	text: string;
	anchor: Anchor | null;
	cached_excerpt: string | null;
	commit_oid?: string | null;
}

// Why a comment cannot be jumped to / no longer resolves against the repo.
// Mirrors the Rust OrphanReason enum (PascalCase variant strings, no rename_all,
// following the Source/Side convention above).
export type OrphanReason = "CommitGone" | "FileGone" | "LineOutOfRange";

// Per-comment resolvability classification (mirrors the Rust CommentResolution
// struct, snake_case-irrelevant single-word fields; reason is null when resolvable).
export interface CommentResolution {
	id: string;
	resolvable: boolean;
	reason: OrphanReason | null;
}

export interface DraftComment {
	text: string;
	anchor: Anchor | null;
}

export interface ReviewSession {
	schema_version: number;
	commits: string[];
	comments: Comment[];
	draft_comment: DraftComment | null;
}

// Session lifecycle status (mirrors src-tauri/src/commands/review.rs Plan 65-03).
// SessionState serializes kebab-case (unlike the PascalCase on-disk enums above):
// it's a transient IPC enum, not part of the persisted schema.
export type SessionState = "active" | "resume-available" | "none";

export interface SessionStatus {
	state: SessionState;
	file_exists: boolean;
	canonical_path: string;
}

// Current snapshot OIDs for the active session (mirrors the Rust ReviewSnapshots
// struct from Plan 65; Serialize snake_case, nullable for Rust Option<String>).
export interface ReviewSnapshots {
	working_tree_snapshot: string | null;
	index_snapshot: string | null;
}

// A commit hand-picked into the active review session (mirrors the Rust
// SessionCommit struct from Plan 66-01, Serialize-default snake_case fields).
export interface SessionCommit {
	oid: string;
	short_oid: string;
	summary: string;
	// True for an auto-created review snapshot (working-tree/index), not a
	// hand-picked commit. The panel hides EMPTY snapshot sections (260531-l02d).
	is_snapshot: boolean;
}

// Request DTOs for the comment-capture commands (Plan 67-02 Rust structs use
// #[serde(rename_all = "camelCase")], so the wire keys are camelCase here while
// the nested Anchor keeps its frozen snake_case schema). These reuse the existing
// Anchor type above — do NOT redeclare it.
export interface AddCommentRequest {
	path: string;
	text: string;
	anchor: Anchor;
	cachedExcerpt: string;
}

export interface SaveDraftCommentRequest {
	path: string;
	text: string;
	anchor: Anchor | null;
}

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

// start/end are UTF-16 code-unit indices — `content.slice(start, end)` is the
// intended read; Rust converts from its byte offsets before serializing.
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
	in_head_chain: boolean;
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
	/** Where a renamed file came from. Null for every other status. */
	old_path: string | null;
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

// Where a bare `git push` would send the current branch, resolved in Rust through
// pushRemote/pushDefault (mirrors the Rust PushTarget). Either field is null when
// git cannot name one — a detached HEAD, or no resolvable remote.
export interface PushTarget {
	remote: string | null;
	branch: string | null;
}

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

/**
 * How the split view should seat a changed line, decided by the backend's
 * run-level word diff. `partner` names the hunk-line index of the homologous
 * opposite-side line; `alone` has no counterpart; `unknown` (or an absent
 * field, in fixtures) means no word diff ran. The verdict is per run: a
 * block whose lines are all unknown pairs positionally, as before the word
 * diff existed.
 */
export type LinePairing =
	| { kind: "partner"; line: number }
	| { kind: "alone" }
	| { kind: "unknown" };

export interface DiffLine {
	origin: DiffOrigin;
	content: string;
	old_lineno: number | null;
	new_lineno: number | null;
	spans: MergedSpan[];
	pairing?: LinePairing;
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
	/** Where a renamed file came from. Null for every other status. */
	old_path: string | null;
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
export type RenderMode = "source" | "rendered";

// How the rendered markdown diff presents a changed block: two copies
// (before red, after green) or one merged suggestion-mode copy with del/ins
// marks, the way docs tools show tracked changes.
export type RenderedDiffStyle = "copies" | "merged";

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

// Diff size for one commit (or the WIP row) — feeds the graph's Diff column
// bar + number. Mirrors the Rust DiffStat DTO (snake_case).
export interface DiffStat {
	insertions: number;
	deletions: number;
	files_changed: number;
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
	name: string; // fully-qualified ref (refs/heads/x, refs/remotes/origin/x)
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

// Mirrors src-tauri/src/commands/interactive_rebase.rs RebaseTodo. A null
// base_oid means the listing starts at the repository root, which rebases
// from --root.
export interface RebaseTodo {
	base_oid: string | null;
	items: RebaseTodoItem[];
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

// One anchored root comment plus its flat replies. Mirrors the Rust
// RenderedThread: the stored row plus its markdown body rendered to sanitized
// HTML at list time.
export interface Thread {
	id: string;
	review_id: string;
	text: string;
	anchor: Anchor | null;
	cached_excerpt: string | null;
	commit_oid?: string | null;
	state: ThreadState;
	stale: boolean;
	channel: Channel;
	// The owning review's published bit (criterion 12): once true, the store
	// refuses to delete this thread or its replies, so ThreadCard hides the
	// Delete / Delete reply controls rather than offer an action that only
	// fails on the round trip.
	published: boolean;
	// The states a UI gesture may legally move this thread to, in presentation
	// order — precomputed by the backend from the one transition matrix
	// (ThreadState::allowed_transitions, human channel). ThreadCard renders
	// these verbatim instead of re-deriving the matrix locally.
	allowed_transitions: readonly ThreadState[];
	// Present only on threads returned by `list_threads` (the render batch);
	// optional so optimistic/raw shapes elsewhere still type-check. ThreadCard
	// `{@html}`s it, falling back to escaped raw `text` when absent.
	text_html?: string;
	replies: readonly Reply[];
}

// A flat reply under a thread. Mirrors the Rust RenderedReply — no anchor, no
// state: state lives on the thread, never on a reply.
export interface Reply {
	readonly id: string;
	readonly text: string;
	readonly text_html: string;
	readonly channel: Channel;
	readonly created_at: number;
}

// The per-repo draft row: the composer's autosave target, with no review
// foreign key so a cancelled composer strands nothing.
export interface Draft {
	text: string;
	anchor: Anchor | null;
}

// The closed sets the store's CHECK constraints enforce. Milestone 2 owns the
// transitions between them; milestone 1 writes only `open` / `human`.
export type ThreadState = "open" | "addressed" | "done" | "dismissed";
export type Channel = "human" | "agent";

// A durable, per-repo collection of threads plus a derived lifecycle state.
export type ReviewState = "composing" | "ready" | "settled";

export interface Review {
	id: string;
	title: string;
	state: ReviewState;
	published: boolean;
	thread_count: number;
	created_at: number;
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

// Current snapshot OIDs for the repo (mirrors the Rust RepoSnapshots struct;
// Serialize snake_case, nullable for Rust Option<String>). Per repo, not per
// review — D8 makes the pins repo-level.
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

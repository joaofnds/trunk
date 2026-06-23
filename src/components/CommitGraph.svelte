<script lang="ts">
import { Archive, Globe, Laptop, Tag } from "@lucide/svelte";
import { listen } from "@tauri-apps/api/event";
import {
	CheckMenuItem,
	Menu,
	MenuItem,
	PredefinedMenuItem,
	Submenu,
} from "@tauri-apps/api/menu";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { tick, untrack } from "svelte";
import { buildGraphData } from "../lib/active-lanes.js";
import { copySha } from "../lib/clipboard.js";
import { computeCommitNav } from "../lib/commitNav.js";
import {
	BADGE_FONT_SIZE,
	BADGE_HEIGHT,
	COLUMN_PADDING_X,
	DEFAULT_GRAPH_SETTINGS,
	ICON_GAP,
	ICON_WIDTH,
	PILL_FONT_SIZE,
	PILL_GAP,
	PILL_HEIGHT,
	PILL_PADDING_X,
} from "../lib/graph-constants.js";
import { isTrunkError, safeInvoke, type TrunkError } from "../lib/invoke.js";
import { buildOverlayPaths } from "../lib/overlay-paths.js";
import { getVisibleOverlayElements } from "../lib/overlay-visible.js";
import { buildRefPillData } from "../lib/ref-pill-data.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import {
	type ColumnVisibility,
	type ColumnWidths,
	getColumnVisibility,
	getColumnWidths,
	setColumnVisibility,
	setColumnWidths,
} from "../lib/store.js";
import { measureTextWidth } from "../lib/text-measure.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	CommitNav,
	EdgeType,
	GraphCommit,
	GraphResponse,
	OverlayRefPill,
	RefLabel,
	RefType,
	SearchResult,
	SessionCommit,
	SessionStatus,
	StashEntry,
	WipStats,
} from "../lib/types.js";
import CommitRow from "./CommitRow.svelte";
import InputDialog from "./InputDialog.svelte";
import SearchBar from "./SearchBar.svelte";
import VirtualList from "./VirtualList.svelte";

interface Props {
	repoPath: string;
	oncommitselect?: (oid: string) => void;
	oncommitnavchange?: (nav: CommitNav | null) => void;
	wipCount?: number;
	wipMessage?: string;
	wipStats?: WipStats;
	onWipClick?: () => void;
	refreshSignal?: number;
	selectedCommitOid?: string | null;
	onopenrebaseeditor?: (baseOid: string, inclusive?: boolean) => void;
	onopenmessageeditor?: (
		defaultValue: string,
		title: string,
	) => Promise<string | null>;
	clearRedoStack: () => void;
	/** Center-pane inline-comments toggle; gates the per-row comment badge. */
	showInlineComments?: boolean;
	/** Shared comments store; supplies the per-commit count map. */
	reviewComments?: ReviewCommentsManager;
}

let {
	repoPath,
	oncommitselect,
	oncommitnavchange,
	wipCount = 0,
	wipMessage = "WIP",
	wipStats,
	onWipClick,
	refreshSignal,
	selectedCommitOid,
	onopenrebaseeditor,
	onopenmessageeditor,
	clearRedoStack,
	showInlineComments = false,
	reviewComments,
}: Props = $props();

// Per-row comment badge count. Gated on the toggle + an active session so the
// badge's self-hide at 0 also enforces the gate (children stay dumb). The WIP
// row's oid is the literal "__wip__" key the store folds snapshot counts into.
function commentCountFor(oid: string): number {
	if (!showInlineComments || !reviewComments?.active) return 0;
	return reviewComments.countByCommit.get(oid) ?? 0;
}

const BATCH = 200;
const SKELETON_COUNT = 10;

/** Icon map for commit graph pills — matches sidebar BranchRow icon vocabulary */
const PILL_ICONS: Record<string, typeof Laptop> = {
	LocalBranch: Laptop,
	RemoteBranch: Globe,
	Tag: Tag,
	Stash: Archive,
};

// Graph display settings — will be wired to user preferences in a future settings page.
// Change values here (or load from store) to adjust layout without touching any other file.
let displaySettings = $state({ ...DEFAULT_GRAPH_SETTINGS });

// Measured row height from VirtualList. At non-100% browser zoom, sub-pixel
// snapping makes the actual rendered row height differ slightly from the CSS
// value (ROW_HEIGHT = 26). Over thousands of rows, using the CSS constant for
// SVG coordinates causes progressive drift. svgRowHeight tracks the real
// measured height so the SVG overlay stays aligned with the DOM rows.
let svgRowHeight = $state(displaySettings.rowHeight);

let commits = $state<GraphCommit[]>([]);
let maxColumns = $state(1);
let hasMore = $state(true);
let loading = $state(false);
let error = $state<string | null>(null);
let offset = $state(0);
let listRef = $state<{
	scroll: (opts: {
		index: number;
		smoothScroll?: boolean;
		align?: string;
	}) => Promise<void>;
} | null>(null);
let scrolledToHead = false;
let containerRef = $state<HTMLDivElement | null>(null);

let columnWidths = $state<ColumnWidths>({
	ref: 120,
	graph: 24,
	author: 60,
	date: 40,
	sha: 50,
});
let columnVisibility = $state<ColumnVisibility>({
	ref: true,
	graph: true,
	message: true,
	author: true,
	date: true,
	sha: true,
});

const ORDERED_COLUMNS = [
	"ref",
	"graph",
	"message",
	"author",
	"date",
	"sha",
] as const;
type ColumnKey = (typeof ORDERED_COLUMNS)[number];

const visibleColumns = $derived(
	ORDERED_COLUMNS.filter((k) => columnVisibility[k]),
);
const lastVisibleColumn = $derived(
	visibleColumns[visibleColumns.length - 1] as ColumnKey | undefined,
);

$effect(() => {
	getColumnWidths().then((w) => {
		columnWidths = w;
	});
});

$effect(() => {
	getColumnVisibility().then((v) => {
		columnVisibility = v;
	});
});

// GRAPH-02: horizontal panning offset for the graph column.
// When graphColWidth < naturalGraphWidth, graphScrollX tracks which portion of the
// graph lanes are visible. Controlled by trackpad/wheel horizontal gestures.
let graphScrollX = $state(0);

// Derived: natural graph width based on actual lane count
const naturalGraphWidth = $derived(
	Math.max(maxColumns, 1) * displaySettings.laneWidth,
);
// Derived: maximum horizontal scroll within the graph column
const maxGraphScrollX = $derived(
	columnVisibility.graph
		? Math.max(0, naturalGraphWidth - columnWidths.graph + 2 * COLUMN_PADDING_X)
		: 0,
);

// Clamp graphScrollX when maxGraphScrollX shrinks (e.g. column widened or fewer lanes)
$effect(() => {
	if (graphScrollX > maxGraphScrollX) graphScrollX = maxGraphScrollX;
});

// Font strings for measuring header labels and column content
const HEADER_FONT = "11px ui-sans-serif, system-ui, sans-serif";
const AUTHOR_CONTENT_FONT = "12px ui-sans-serif, system-ui, sans-serif";
const DATE_CONTENT_FONT = "11px ui-sans-serif, system-ui, sans-serif";
const SHA_CONTENT_FONT = "11px ui-monospace, SFMono-Regular, Menlo, monospace";

// Author cell reserves space for the initials avatar (diameter + gap) before the name.
const AUTHOR_AVATAR_WIDTH = 18 + 8;

// Minimum column widths = header label text width + column padding (border-box) + breathing room
const HEADER_PAD = 4 * COLUMN_PADDING_X; // 2× for CSS padding + 2× for breathing room
const headerMinRef = measureTextWidth("Branch/Tag", HEADER_FONT) + HEADER_PAD;
const headerMinGraph = measureTextWidth("Graph", HEADER_FONT) + HEADER_PAD;
const headerMinAuthor = measureTextWidth("Author", HEADER_FONT) + HEADER_PAD;
const headerMinDate = measureTextWidth("Date", HEADER_FONT) + HEADER_PAD;
const headerMinSha = measureTextWidth("SHA", HEADER_FONT) + HEADER_PAD;

// Track which columns the user has explicitly resized this session.
const userResizedColumns = new Set<keyof ColumnWidths>();

// Max content widths for auto-fit (updated when commits load)
let maxAuthorContentWidth = $state(0);
let maxDateContentWidth = $state(0);
let shaContentWidth = $state(0);

function relativeDateStr(ts: number): string {
	if (ts === 0) return "";
	const now = Date.now() / 1000;
	const diff = Math.max(0, now - ts);
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
	if (diff < 31536000) return `${Math.floor(diff / 2592000)}mo ago`;
	return `${Math.floor(diff / 31536000)}y ago`;
}

function updateContentWidths(newCommits: GraphCommit[], reset = false) {
	if (reset) {
		maxAuthorContentWidth = 0;
		maxDateContentWidth = 0;
		shaContentWidth = 0;
	}
	for (const c of newCommits) {
		if (c.oid === "__wip__" || c.is_stash) continue;
		const aw =
			measureTextWidth(c.author_name, AUTHOR_CONTENT_FONT) +
			2 * COLUMN_PADDING_X +
			AUTHOR_AVATAR_WIDTH;
		if (aw > maxAuthorContentWidth) maxAuthorContentWidth = aw;
		const dw =
			measureTextWidth(relativeDateStr(c.author_timestamp), DATE_CONTENT_FONT) +
			2 * COLUMN_PADDING_X;
		if (dw > maxDateContentWidth) maxDateContentWidth = dw;
	}
	if (newCommits.length > 0 && shaContentWidth === 0) {
		shaContentWidth =
			measureTextWidth("0000000", SHA_CONTENT_FONT) + 2 * COLUMN_PADDING_X;
	}
}

// Auto-fit column widths to content. Uses untrack on columnWidths reads to avoid
// infinite reactive loops (each effect writes columnWidths, which would re-trigger others).
$effect(() => {
	const cols = maxColumns;
	const fitWidth =
		Math.max(cols, 1) * displaySettings.laneWidth + 2 * COLUMN_PADDING_X;
	const targetWidth = Math.max(fitWidth, headerMinGraph);
	const cur = untrack(() => columnWidths);
	if (!userResizedColumns.has("graph")) {
		columnWidths = { ...cur, graph: targetWidth };
	} else if (cur.graph > targetWidth) {
		columnWidths = { ...cur, graph: targetWidth };
	}
});

$effect(() => {
	const w = maxAuthorContentWidth;
	if (w <= 0) return;
	const targetWidth = Math.max(w, headerMinAuthor);
	if (!userResizedColumns.has("author")) {
		columnWidths = { ...untrack(() => columnWidths), author: targetWidth };
	}
});

$effect(() => {
	const w = maxDateContentWidth;
	if (w <= 0) return;
	const targetWidth = Math.max(w, headerMinDate);
	if (!userResizedColumns.has("date")) {
		columnWidths = { ...untrack(() => columnWidths), date: targetWidth };
	}
});

$effect(() => {
	const w = shaContentWidth;
	if (w <= 0) return;
	const targetWidth = Math.max(w, headerMinSha);
	if (!userResizedColumns.has("sha")) {
		columnWidths = { ...untrack(() => columnWidths), sha: targetWidth };
	}
});

let stashOidToIndex = $state<Map<string, number>>(new Map());

// Search state
let searchOpen = $state(false);
let searchQuery = $state("");
let searchResults = $state<SearchResult[]>([]);
let searchCurrentIndex = $state(0);
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// Derived: Set of matching OIDs for O(1) lookup in CommitRow
const searchMatchOids = $derived(new Set(searchResults.map((r) => r.oid)));
// Derived: OID of current match for strong highlight
const searchCurrentOid = $derived(
	searchResults.length > 0
		? (searchResults[searchCurrentIndex]?.oid ?? null)
		: null,
);
// Derived: whether SVG dimming should be active (search open + query + results)
const searchDimmingActive = $derived(
	searchOpen && searchQuery.length > 0 && searchResults.length > 0,
);

// Review selection state (Phase 66). sessionStatus carries the canonical_path so
// the session-changed listener can filter to this repo (mirrors ReviewPanel).
// sessionActive gates the context-menu review items — sourced from
// get_review_session_status state === "active", NOT the panel-open flag (A1).
let sessionStatus = $state<SessionStatus | null>(null);
let sessionActive = $derived(sessionStatus?.state === "active");
// Tracked separately from sessionStatus so the session-changed listener can
// fail-closed when canonical is unknown (mirrors ReviewPanel:241 — Phase 73-01
// pattern). When null, cross-repo events MUST NOT trigger reload (WR-01).
let canonicalPath = $state<string | null>(null);
// Event-driven membership Set (Pitfall 5: reassign new Set(...) so reactivity fires).
let sessionOids = $state<Set<string>>(new Set());
// Transient D-01 range base — set by "Set as review base", cleared after the
// range is added or cancelled (and whenever the session goes inactive).
let pendingBase = $state<string | null>(null);

async function reloadSession() {
	try {
		const status = await safeInvoke<SessionStatus>(
			"get_review_session_status",
			{ path: repoPath },
		);
		// Capture canonical BEFORE the active-branch so the session-changed
		// listener filter works even on cold (resume-available / none) sessions
		// — mirrors ReviewPanel:241 (Phase 73-01).
		canonicalPath = status.canonical_path;
		sessionStatus = status;
		if (status.state === "active") {
			const list = await safeInvoke<SessionCommit[]>("list_session_commits", {
				path: repoPath,
			});
			sessionOids = new Set(list.map((c) => c.oid));
		} else {
			sessionOids = new Set();
		}
	} catch (e) {
		// no_session / not_open are normal states (cold repo, or first-run
		// window before refresh_commit_graph populates CommitCache). Reset to
		// empty, never toast. Anything else is a real backend / IPC failure —
		// reset state so the UI doesn't show stale session data, AND surface
		// a toast so the operator sees the failure (WR-02).
		sessionStatus = null;
		canonicalPath = null;
		sessionOids = new Set();
		if (isTrunkError(e) && (e.code === "no_session" || e.code === "not_open")) {
			return;
		}
		showToast(
			"Failed to load review session. Try again or reopen the repo.",
			"error",
		);
	}
}

async function loadStashMap() {
	try {
		const stashes = await safeInvoke<StashEntry[]>("list_stashes", {
			path: repoPath,
		});
		const map = new Map<string, number>();
		for (const stash of stashes) {
			map.set(stash.oid, stash.index);
		}
		stashOidToIndex = map;
	} catch {
		stashOidToIndex = new Map();
	}
}

function startColumnResize(
	column: keyof ColumnWidths,
	e: MouseEvent,
	invert = false,
) {
	e.preventDefault();
	userResizedColumns.add(column);
	const startX = e.clientX;
	const startWidth = columnWidths[column];
	const minWidths: Record<keyof ColumnWidths, number> = {
		ref: headerMinRef,
		graph: headerMinGraph,
		author: headerMinAuthor,
		date: headerMinDate,
		sha: headerMinSha,
	};
	const maxWidths: Record<keyof ColumnWidths, number> = {
		ref: 400,
		graph: Math.max(
			naturalGraphWidth + displaySettings.laneWidth + 2 * COLUMN_PADDING_X,
			headerMinGraph,
		),
		author: 400,
		date: 400,
		sha: 400,
	};

	function onMouseMove(ev: MouseEvent) {
		const delta = (ev.clientX - startX) * (invert ? -1 : 1);
		const newWidth = Math.max(
			minWidths[column],
			Math.min(maxWidths[column], startWidth + delta),
		);
		columnWidths = { ...columnWidths, [column]: newWidth };
	}

	function onMouseUp() {
		setColumnWidths(columnWidths);
		window.removeEventListener("mousemove", onMouseMove);
		window.removeEventListener("mouseup", onMouseUp);
	}

	window.addEventListener("mousemove", onMouseMove);
	window.addEventListener("mouseup", onMouseUp);
}

const columnLabels: { key: keyof ColumnVisibility; label: string }[] = [
	{ key: "ref", label: "Branch/Tag" },
	{ key: "graph", label: "Graph" },
	{ key: "message", label: "Message" },
	{ key: "author", label: "Author" },
	{ key: "date", label: "Date" },
	{ key: "sha", label: "SHA" },
];

// InputDialog state
interface DialogConfig {
	title: string;
	fields: {
		key: string;
		label: string;
		placeholder?: string;
		multiline?: boolean;
		required?: boolean;
		defaultValue?: string;
	}[];
	onsubmit: (values: Record<string, string>) => void;
}
let dialogConfig = $state<DialogConfig | null>(null);

function closeDialog() {
	dialogConfig = null;
}

// Commit context menu actions

async function handleCheckoutCommit(commit: GraphCommit) {
	const confirmed = await ask(
		"Checkout this commit in detached HEAD mode? You won't be on any branch. Create a branch afterward to save your work.",
		{ title: "Checkout Commit", kind: "warning" },
	);
	if (!confirmed) return;
	try {
		await safeInvoke("checkout_commit", { path: repoPath, oid: commit.oid });
	} catch (e) {
		const err = e as TrunkError;
		await message(err.message ?? "Failed to checkout commit", {
			title: "Checkout Error",
			kind: "error",
		});
	}
}

function handleCreateBranch(commit: GraphCommit) {
	dialogConfig = {
		title: "Create Branch",
		fields: [{ key: "name", label: "Branch name", required: true }],
		onsubmit: async (values) => {
			closeDialog();
			try {
				await safeInvoke("create_branch", {
					path: repoPath,
					name: values.name,
					fromOid: commit.oid,
				});
				showToast(`Checked out ${values.name}`, "success");
			} catch (e) {
				const err = e as TrunkError;
				if (err.code === "dirty_workdir") {
					showToast(
						"Branch created (checkout skipped — uncommitted changes)",
						"success",
					);
				} else {
					await message(err.message ?? "Failed to create branch", {
						title: "Create Branch Error",
						kind: "error",
					});
				}
			}
		},
	};
}

function handleCreateTag(commit: GraphCommit) {
	dialogConfig = {
		title: "Create Tag",
		fields: [
			{ key: "name", label: "Tag name", required: true },
			{ key: "message", label: "Message (optional)", multiline: true },
		],
		onsubmit: async (values) => {
			closeDialog();
			try {
				await safeInvoke("create_tag", {
					path: repoPath,
					oid: commit.oid,
					tagName: values.name,
					message: values.message || "",
				});
			} catch (e) {
				const err = e as TrunkError;
				await message(err.message ?? "Failed to create tag", {
					title: "Create Tag Error",
					kind: "error",
				});
			}
		},
	};
}

async function handleCherryPick(commit: GraphCommit) {
	clearRedoStack();
	try {
		await safeInvoke("cherry_pick", { path: repoPath, oid: commit.oid });
	} catch (e) {
		const err = e as TrunkError;
		await message(
			err.message ??
				"Cherry-pick failed. You may need to resolve conflicts manually.",
			{ title: "Cherry-pick Error", kind: "error" },
		);
	}
}

async function handleRevert(commit: GraphCommit) {
	clearRedoStack();
	try {
		// Two-step: begin stages the revert and emits repo-changed, then the user
		// edits the message in the host MessageEditor. A null return (cancel/empty)
		// leaves the repo in its recoverable in-progress state — no continue (D-02).
		const result = await safeInvoke<{ message: string | null }>(
			"revert_commit_begin",
			{ path: repoPath, oid: commit.oid },
		);
		const msg = await onopenmessageeditor?.(
			result.message ?? "",
			"Revert commit message",
		);
		if (msg == null) return;
		await safeInvoke("revert_continue", { path: repoPath, message: msg });
	} catch (e) {
		const err = e as TrunkError;
		await message(
			err.message ??
				"Revert failed. You may need to resolve conflicts manually.",
			{
				title: "Revert Error",
				kind: "error",
			},
		);
	}
}

async function handleReset(
	commit: GraphCommit,
	mode: "soft" | "mixed" | "hard",
) {
	const labels: Record<string, string> = {
		soft: "Soft reset keeps all changes staged.",
		mixed: "Mixed reset keeps changes but unstages them.",
		hard: "Hard reset discards ALL changes. This cannot be undone!",
	};
	const confirmed = await ask(
		`Reset current branch to this commit?\n\n${labels[mode]}`,
		{
			title: `Reset (${mode})`,
			kind: mode === "hard" ? "warning" : "info",
		},
	);
	if (!confirmed) return;
	try {
		await safeInvoke("reset_to_commit", {
			path: repoPath,
			oid: commit.oid,
			mode,
		});
	} catch (e) {
		const err = e as TrunkError;
		await message(err.message ?? "Reset failed.", {
			title: "Reset Error",
			kind: "error",
		});
	}
}

async function handleMergeBranch(branch: string) {
	try {
		const result = await safeInvoke<{ kind: string; message?: string }>(
			"merge_branch_begin",
			{ path: repoPath, branch },
		);
		// fast_forwarded / conflicts open no editor — the begin's repo-changed emit
		// drives the UI. Only a clean non-ff merge ("ready") needs a commit message.
		if (result.kind === "ready") {
			const msg = await onopenmessageeditor?.(
				result.message ?? "",
				"Merge commit message",
			);
			if (msg == null) return; // cancel/empty leaves the merge in progress (D-02)
			await safeInvoke("merge_continue", { path: repoPath, message: msg });
		}
		// No toast on success -- graph refresh via repo-changed event is sufficient
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Merge failed", "error");
	}
}

async function handleRebaseBranch(ontoBranch: string) {
	try {
		await safeInvoke("rebase_branch", { path: repoPath, ontoBranch });
		// No toast on success -- graph refresh via repo-changed event is sufficient
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Rebase failed", "error");
	}
}

async function handleInteractiveRebaseBranch(branchName: string) {
	try {
		const forkPoint = await safeInvoke<string>("get_fork_point", {
			path: repoPath,
			branch: branchName,
		});
		onopenrebaseeditor?.(forkPoint);
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Failed to detect fork point", "error");
	}
}

async function showCommitContextMenu(e: MouseEvent, commit: GraphCommit) {
	e.preventDefault();

	// Determine if merge/rebase options should be shown
	const clickedBranch = commit.refs.find(
		(r) => r.ref_type === "LocalBranch" && !r.is_head,
	);
	const headCommit = commits.find((c) => c.is_head);
	const headRef = headCommit?.refs.find(
		(r) => r.ref_type === "LocalBranch" && r.is_head,
	);
	const headBranchName = headRef?.short_name;

	const mergeRebaseItems: (
		| Awaited<ReturnType<typeof MenuItem.new>>
		| Awaited<ReturnType<typeof PredefinedMenuItem.new>>
	)[] = [];
	if (clickedBranch && headBranchName) {
		mergeRebaseItems.push(
			await MenuItem.new({
				text: `Merge ${clickedBranch.short_name} into ${headBranchName}`,
				action: () => {
					handleMergeBranch(clickedBranch.short_name).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: `Rebase ${headBranchName} onto ${clickedBranch.short_name}`,
				action: () => {
					handleRebaseBranch(clickedBranch.short_name).catch(() => {});
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
		);
	}

	// Fast-forward (only when HEAD is on a branch and commit is not HEAD and not a stash)
	const fastForwardItems: (
		| Awaited<ReturnType<typeof MenuItem.new>>
		| Awaited<ReturnType<typeof PredefinedMenuItem.new>>
	)[] = [];
	if (headBranchName && !commit.is_stash && !commit.is_head) {
		fastForwardItems.push(
			await MenuItem.new({
				text: `Fast-forward ${headBranchName} to here`,
				action: async () => {
					try {
						await safeInvoke("fast_forward_to", {
							path: repoPath,
							targetOid: commit.oid,
						});
					} catch (e) {
						const err = e as TrunkError;
						showToast(err.message ?? "Fast-forward failed", "error");
					}
				},
			}),
		);
	}

	// Interactive Rebase (only when HEAD is on a branch and commit is not HEAD and not a stash)
	const interactiveRebaseItems: (
		| Awaited<ReturnType<typeof MenuItem.new>>
		| Awaited<ReturnType<typeof PredefinedMenuItem.new>>
	)[] = [];
	if (headBranchName && !commit.is_stash && !commit.is_head) {
		interactiveRebaseItems.push(
			await MenuItem.new({
				text: "Interactive Rebase...",
				action: () => {
					onopenrebaseeditor?.(commit.oid, true);
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
		);
	}

	// Review selection items (D-01 range gesture + D-06 Add/Remove toggle).
	// Injected ONLY when a review session is active (sessionActive, sourced from
	// get_review_session_status — NOT the panel-open flag, A1). NO `enabled:
	// !commit.is_merge` gate — merges ARE selectable (D-08), unlike the
	// Cherry-pick/Revert items below.
	const reviewItems: (
		| Awaited<ReturnType<typeof MenuItem.new>>
		| Awaited<ReturnType<typeof PredefinedMenuItem.new>>
	)[] = [];
	if (sessionActive) {
		const inSession = sessionOids.has(commit.oid);
		reviewItems.push(
			await MenuItem.new({
				text: inSession ? "Remove from review" : "Add to review",
				action: async () => {
					try {
						await safeInvoke(
							inSession ? "remove_review_commit" : "add_review_commit",
							{ path: repoPath, oid: commit.oid },
						);
					} catch (e) {
						const err = e as TrunkError;
						showToast(err.message ?? "Failed to update review", "error");
					}
				},
			}),
		);
		if (pendingBase === null) {
			reviewItems.push(
				await MenuItem.new({
					text: "Set as review base",
					action: () => {
						pendingBase = commit.oid;
					},
				}),
			);
		} else {
			reviewItems.push(
				await MenuItem.new({
					text: "Add range to review",
					action: async () => {
						try {
							await safeInvoke("seed_review_range", {
								path: repoPath,
								baseOid: pendingBase,
								tipOid: commit.oid,
							});
						} catch (e) {
							const err = e as TrunkError;
							showToast(err.message ?? "Failed to seed range", "error");
						} finally {
							// The gesture is done either way — success or an invalid
							// range (bad_range / unrelated_history) both clear the base.
							pendingBase = null;
						}
					},
				}),
				await MenuItem.new({
					text: "Clear review base",
					action: () => {
						pendingBase = null;
					},
				}),
			);
		}
		reviewItems.push(await PredefinedMenuItem.new({ item: "Separator" }));
	}

	const menu = await Menu.new({
		items: [
			...mergeRebaseItems,
			...fastForwardItems,
			...interactiveRebaseItems,
			...reviewItems,
			await MenuItem.new({
				text: "Copy SHA",
				action: () => {
					copySha(commit.oid);
				},
			}),
			await MenuItem.new({
				text: "Copy Message",
				action: () => {
					writeText(commit.summary).catch(() => {});
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: "Checkout Commit...",
				action: () => {
					handleCheckoutCommit(commit).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Create Branch...",
				action: () => {
					handleCreateBranch(commit);
				},
			}),
			await MenuItem.new({
				text: "Create Tag...",
				action: () => {
					handleCreateTag(commit);
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: "Cherry-pick",
				enabled: !commit.is_merge,
				action: () => {
					handleCherryPick(commit).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Revert",
				enabled: !commit.is_merge,
				action: () => {
					handleRevert(commit).catch(() => {});
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await Submenu.new({
				text: "Reset...",
				items: [
					await MenuItem.new({
						text: "Soft",
						action: () => {
							handleReset(commit, "soft").catch(() => {});
						},
					}),
					await MenuItem.new({
						text: "Mixed",
						action: () => {
							handleReset(commit, "mixed").catch(() => {});
						},
					}),
					await MenuItem.new({
						text: "Hard",
						action: () => {
							handleReset(commit, "hard").catch(() => {});
						},
					}),
				],
			}),
		],
	});
	await menu.popup();
}

// Stash context menu actions

async function handleStashPop(index: number) {
	try {
		await safeInvoke("stash_pop", { path: repoPath, index });
	} catch (e) {
		const err = e as TrunkError;
		await message(err.message ?? "Failed to pop stash", {
			title: "Stash Error",
			kind: "error",
		});
	}
}

async function handleStashApply(index: number) {
	try {
		await safeInvoke("stash_apply", { path: repoPath, index });
	} catch (e) {
		const err = e as TrunkError;
		await message(err.message ?? "Failed to apply stash", {
			title: "Stash Error",
			kind: "error",
		});
	}
}

async function handleStashDrop(index: number) {
	const confirmed = await ask(`Drop stash@{${index}}? This cannot be undone.`, {
		title: "Confirm Drop",
		kind: "warning",
	});
	if (!confirmed) return;
	try {
		await safeInvoke("stash_drop", { path: repoPath, index });
	} catch (e) {
		const err = e as TrunkError;
		await message(err.message ?? "Failed to drop stash", {
			title: "Stash Error",
			kind: "error",
		});
	}
}

async function showStashContextMenu(e: MouseEvent, commit: GraphCommit) {
	e.preventDefault();
	const stashIndex = stashOidToIndex.get(commit.oid);
	if (stashIndex === undefined) return;
	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Pop",
				action: () => {
					handleStashPop(stashIndex).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Apply",
				action: () => {
					handleStashApply(stashIndex).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Drop",
				action: () => {
					handleStashDrop(stashIndex).catch(() => {});
				},
			}),
		],
	});
	await menu.popup();
}

function handleRowContextMenu(e: MouseEvent, commit: GraphCommit) {
	if (commit.is_stash) {
		showStashContextMenu(e, commit);
	} else {
		showCommitContextMenu(e, commit);
	}
}

// Pill context menu actions (branch delete/rename, tag delete, remote branch delete)

async function handleDeleteRemoteBranch(branchName: string) {
	const confirmed = await ask(
		`Delete remote branch '${branchName}'? This will remove it from the remote.`,
		{ title: "Delete Remote Branch", kind: "warning" },
	);
	if (!confirmed) return;
	try {
		await safeInvoke("delete_remote_branch", { path: repoPath, branchName });
		showToast(`Deleted remote branch ${branchName}`, "success");
	} catch (e) {
		const err = e as TrunkError;
		await message(err.message ?? "Failed to delete remote branch", {
			title: "Delete Remote Branch Error",
			kind: "error",
		});
	}
}

async function handleDeleteBranch(branchName: string) {
	const confirmed = await ask(
		`Delete branch '${branchName}'? This cannot be undone.`,
		{
			title: "Delete Branch",
			kind: "warning",
		},
	);
	if (!confirmed) return;
	try {
		await safeInvoke("delete_branch", { path: repoPath, branchName });
		showToast(`Deleted branch ${branchName}`, "success");
	} catch (e) {
		const err = e as TrunkError;
		await message(err.message ?? "Failed to delete branch", {
			title: "Delete Branch Error",
			kind: "error",
		});
	}
}

function handleRenameBranch(branchName: string) {
	dialogConfig = {
		title: "Rename Branch",
		fields: [
			{
				key: "name",
				label: "New name",
				required: true,
				defaultValue: branchName,
			},
		],
		onsubmit: async (values) => {
			closeDialog();
			const newName = values.name.trim();
			if (!newName || newName === branchName) return;
			try {
				await safeInvoke("rename_branch", {
					path: repoPath,
					oldName: branchName,
					newName,
				});
				showToast(`Renamed branch to ${newName}`, "success");
			} catch (e) {
				const err = e as TrunkError;
				await message(err.message ?? "Failed to rename branch", {
					title: "Rename Error",
					kind: "error",
				});
			}
		},
	};
}

async function handleDeleteTag(tagName: string) {
	const confirmed = await ask(
		`Delete tag '${tagName}'? This cannot be undone.`,
		{
			title: "Delete Tag",
			kind: "warning",
		},
	);
	if (!confirmed) return;
	try {
		await safeInvoke("delete_tag", { path: repoPath, tagName });
		showToast(`Deleted tag ${tagName}`, "success");
	} catch (e) {
		const err = e as TrunkError;
		await message(err.message ?? "Failed to delete tag", {
			title: "Delete Tag Error",
			kind: "error",
		});
	}
}

// --- Unified ref handlers (used by both pill and overflow ref) ---

interface RefInfo {
	name: string;
	refType: RefType;
	isHead: boolean;
}

function refFromPill(pill: OverlayRefPill): RefInfo {
	return { name: pill.label, refType: pill.refType, isHead: pill.isHead };
}

function refFromLabel(ref: RefLabel): RefInfo {
	return { name: ref.short_name, refType: ref.ref_type, isHead: ref.is_head };
}

function checkoutLocalBranch(name: string) {
	return safeInvoke<void>("checkout_branch", {
		path: repoPath,
		branchName: name,
	});
}

function checkoutRemoteBranch(fullName: string) {
	const shortName = fullName.slice(fullName.indexOf("/") + 1);
	return safeInvoke<void>("create_branch", {
		path: repoPath,
		name: shortName,
		fromOid: fullName,
	});
}

async function handleRefCheckout(e: MouseEvent, ref: RefInfo) {
	e.preventDefault();
	e.stopPropagation();
	if (ref.isHead) return;
	try {
		if (ref.refType === "RemoteBranch") await checkoutRemoteBranch(ref.name);
		else await checkoutLocalBranch(ref.name);
	} catch (e) {
		showToast((e as TrunkError).message ?? "Checkout failed", "error");
	}
}

async function showRefContextMenu(e: MouseEvent, ref: RefInfo) {
	e.preventDefault();
	e.stopPropagation();

	const headCommit = commits.find((c) => c.is_head);
	const headRef = headCommit?.refs.find(
		(r) => r.ref_type === "LocalBranch" && r.is_head,
	);
	const headBranchName = headRef?.short_name;

	if (ref.refType === "LocalBranch") {
		const menu = await Menu.new({
			items: [
				...(!ref.isHead
					? [
							await MenuItem.new({
								text: `Checkout ${ref.name}`,
								action: () => {
									handleRefCheckout(e, ref);
								},
							}),
							await PredefinedMenuItem.new({ item: "Separator" }),
						]
					: []),
				...(!ref.isHead && headBranchName
					? [
							await MenuItem.new({
								text: `Merge ${ref.name} into ${headBranchName}`,
								action: () => {
									handleMergeBranch(ref.name).catch(() => {});
								},
							}),
							await MenuItem.new({
								text: `Rebase ${headBranchName} onto ${ref.name}`,
								action: () => {
									handleRebaseBranch(ref.name).catch(() => {});
								},
							}),
							await MenuItem.new({
								text: `Interactive Rebase ${ref.name}...`,
								action: () => {
									handleInteractiveRebaseBranch(ref.name).catch(() => {});
								},
							}),
							await PredefinedMenuItem.new({ item: "Separator" }),
						]
					: []),
				await MenuItem.new({
					text: "Rename…",
					action: () => {
						handleRenameBranch(ref.name);
					},
				}),
				await PredefinedMenuItem.new({ item: "Separator" }),
				await MenuItem.new({
					text: "Delete",
					enabled: !ref.isHead,
					action: () => {
						handleDeleteBranch(ref.name).catch(() => {});
					},
				}),
			],
		});
		await menu.popup();
	} else if (ref.refType === "RemoteBranch") {
		const menu = await Menu.new({
			items: [
				await MenuItem.new({
					text: `Checkout ${ref.name}`,
					action: () => {
						handleRefCheckout(e, ref);
					},
				}),
				...(headBranchName
					? [
							await PredefinedMenuItem.new({ item: "Separator" }),
							await MenuItem.new({
								text: `Merge ${ref.name} into ${headBranchName}`,
								action: () => {
									handleMergeBranch(ref.name).catch(() => {});
								},
							}),
							await MenuItem.new({
								text: `Rebase ${headBranchName} onto ${ref.name}`,
								action: () => {
									handleRebaseBranch(ref.name).catch(() => {});
								},
							}),
							await MenuItem.new({
								text: `Interactive Rebase ${ref.name}...`,
								action: () => {
									handleInteractiveRebaseBranch(ref.name).catch(() => {});
								},
							}),
						]
					: []),
				await PredefinedMenuItem.new({ item: "Separator" }),
				await MenuItem.new({
					text: "Delete",
					action: () => {
						handleDeleteRemoteBranch(ref.name).catch(() => {});
					},
				}),
			],
		});
		await menu.popup();
	} else if (ref.refType === "Tag") {
		const menu = await Menu.new({
			items: [
				await MenuItem.new({
					text: "Delete",
					action: () => {
						handleDeleteTag(ref.name).catch(() => {});
					},
				}),
			],
		});
		await menu.popup();
	}
}

async function showHeaderContextMenu(e: MouseEvent) {
	e.preventDefault();
	const items = await Promise.all(
		columnLabels.map((col) =>
			CheckMenuItem.new({
				text: col.label,
				checked: columnVisibility[col.key],
				enabled: col.key !== "message",
				action: () => {
					if (col.key === "message") return;
					columnVisibility = {
						...columnVisibility,
						[col.key]: !columnVisibility[col.key],
					};
					setColumnVisibility(columnVisibility);
				},
			}),
		),
	);
	const menu = await Menu.new({ items });
	await menu.popup();
}

function makeWipItem(msg: string, col: number, colorIdx: number): GraphCommit {
	return {
		oid: "__wip__",
		short_oid: "",
		summary: msg,
		body: null,
		author_name: "",
		author_email: "",
		author_timestamp: 0,
		parent_oids: [],
		column: col,
		color_index: colorIdx,
		edges: [
			{
				from_column: col,
				to_column: col,
				edge_type: "Straight" as EdgeType,
				color_index: colorIdx,
				dashed: false,
			},
		],
		refs: [],
		is_head: false,
		is_merge: false,
		is_branch_tip: false,
		is_stash: false,
	};
}

const displayItems = $derived.by(() => {
	// Stash commits are now included in the backend graph result with proper lane data.
	// We only need to prepend the WIP row if there are uncommitted changes.
	if (wipCount > 0) {
		// Find the actual HEAD commit (the one with is_head flag) to match WIP's column and color.
		const headCommit = commits.find((c) => c.is_head);
		const col = headCommit?.column ?? 0;
		const colorIdx = headCommit?.color_index ?? 0;
		return [makeWipItem(wipMessage, col, colorIdx), ...commits];
	}
	return [...commits];
});

// Emit the selected commit's nav context (pager position + topology neighbors)
// whenever the loaded list, selection, or load-more state changes. Reading
// `commits` (deeply reactive) covers loadMore extending the tail.
$effect(() => {
	oncommitnavchange?.(
		computeCommitNav(displayItems, selectedCommitOid ?? null, hasMore),
	);
});

const laneColor = (idx: number) => `var(--lane-${idx % 8})`;
const cx = (col: number) =>
	col * displaySettings.laneWidth + displaySettings.laneWidth / 2;
// Use svgRowHeight for Y-coordinates so the SVG overlay stays aligned with
// the actual DOM row positions at non-100% browser zoom levels.
const cy = (row: number) => row * svgRowHeight + svgRowHeight / 2;

// SVG-specific display settings — identical to displaySettings except rowHeight
// uses the measured value so that overlay paths, dots, and pills don't drift.
const svgSettings = $derived({ ...displaySettings, rowHeight: svgRowHeight });

const graphData = $derived.by(() => buildGraphData(displayItems, maxColumns));
const paths = $derived.by(() => buildOverlayPaths(graphData, svgSettings));
const pillData = $derived.by(() =>
	buildRefPillData(
		graphData.nodes,
		displayItems,
		columnWidths.ref,
		measureTextWidth,
		svgSettings,
	),
);

let hoveredPill = $state<OverlayRefPill | null>(null);
let hoverTimeout: ReturnType<typeof setTimeout> | null = null;

function pillMouseEnter(pill: OverlayRefPill) {
	if (hoverTimeout) {
		clearTimeout(hoverTimeout);
		hoverTimeout = null;
	}
	if (pill.overflowCount > 0 || pill.truncatedLabel !== pill.label) {
		hoveredPill = pill;
	}
}

function pillMouseLeave() {
	hoverTimeout = setTimeout(() => {
		hoveredPill = null;
	}, 50);
}

function overlayMouseEnter() {
	if (hoverTimeout) {
		clearTimeout(hoverTimeout);
		hoverTimeout = null;
	}
}

function overlayMouseLeave() {
	hoveredPill = null;
}

async function loadMore() {
	if (loading || !hasMore) return;
	loading = true;
	error = null;
	try {
		const response = await safeInvoke<GraphResponse>("get_commit_graph", {
			path: repoPath,
			offset,
		});
		commits.push(...response.commits);
		maxColumns = response.max_columns;
		updateContentWidths(response.commits);
		offset += response.commits.length;
		if (response.commits.length < BATCH) hasMore = false;
	} catch (e) {
		const err = e as TrunkError;
		error = err.message ?? "Failed to load commits";
	} finally {
		loading = false;
	}
}

/** Scroll the graph to center the row for the given OID.
 * Loads additional history batches if the commit is not yet loaded.
 * Called from App.svelte via bind:this (GRAPH-03). */
export async function scrollToOid(oid: string): Promise<void> {
	let idx = displayItems.findIndex((c) => c.oid === oid);

	// Load more batches until found or all commits exhausted
	while (idx < 0 && hasMore && !loading) {
		await loadMore();
		await tick();
		idx = displayItems.findIndex((c) => c.oid === oid);
	}

	if (idx < 0 || !listRef) return;

	// Center the row in the viewport by computing the scroll offset manually.
	// VirtualList doesn't support 'center' alignment, so we calculate:
	//   scrollTop = rowTop - (viewportHeight / 2) + (rowHeight / 2)
	const rowTop = idx * svgRowHeight;
	const viewport = document.querySelector(
		".virtual-list-viewport",
	) as HTMLElement | null;
	if (viewport) {
		const viewportHeight = viewport.clientHeight;
		const centerOffset = Math.max(
			0,
			rowTop - viewportHeight / 2 + svgRowHeight / 2,
		);
		viewport.scrollTo({ top: centerOffset, behavior: "smooth" });
	} else {
		// Fallback: use VirtualList's scroll with 'auto' alignment
		await listRef.scroll({ index: idx, smoothScroll: true, align: "auto" });
	}
}

async function refresh() {
	try {
		const response = await safeInvoke<GraphResponse>("refresh_commit_graph", {
			path: repoPath,
		});
		// Swap data atomically -- old data stays visible until this assignment
		commits = response.commits;
		maxColumns = response.max_columns;
		updateContentWidths(response.commits, true);
		offset = response.commits.length;
		hasMore = response.commits.length >= BATCH;
		error = null;
		await loadStashMap();
	} catch (e) {
		const err = e as TrunkError;
		error = err.message ?? "Failed to load commits";
		// Keep old commits visible on error -- do NOT clear
	}
}

$effect(() => {
	untrack(async () => {
		await loadMore();
		await loadStashMap();
	});
});

// Review session: initial load on mount / repo change.
$effect(() => {
	untrack(() => reloadSession());
});

// Live coordination: reload sessionOids when a session-changed event arrives for
// this repo's canonical path. Fail-closed when canonicalPath is null (cross-repo
// events during the cold-start window must not trigger a reload — WR-01). The
// `cancelled` flag prevents the listen() promise from leaking a listener if the
// effect tears down before the promise resolves (mirrors ReviewPanel:447-461).
$effect(() => {
	let unlisten: (() => void) | undefined;
	let cancelled = false;
	listen<string>("session-changed", (event) => {
		// Fail-closed: when canonicalPath is unknown OR the payload is for a
		// different repo, drop the event. ReviewPanel relies on synchronous
		// `await reload()` in $effect to set canonicalPath before the listener
		// fires; CommitGraph's reload effect runs in parallel with the listener
		// effect, so the null check is mandatory (WR-01).
		if (!canonicalPath || event.payload !== canonicalPath) return;
		reloadSession();
	}).then((fn) => {
		if (cancelled) fn();
		else unlisten = fn;
	});
	return () => {
		cancelled = true;
		unlisten?.();
	};
});

// Clear the transient range base whenever the session goes inactive.
$effect(() => {
	if (!sessionActive) pendingBase = null;
});

$effect(() => {
	// Access refreshSignal to create reactive dependency
	if (refreshSignal !== undefined && refreshSignal > 0) {
		untrack(() => refresh());
	}
});

$effect(() => {
	// Only scroll once per mount (scrolledToHead guards against re-firing)
	if (scrolledToHead) return;
	if (!listRef) return;
	if (displayItems.length === 0) return;

	const headIdx = displayItems.findIndex((c) => c.is_head);
	if (headIdx >= 0) {
		scrolledToHead = true;
		tick().then(() =>
			listRef?.scroll({ index: headIdx, smoothScroll: false, align: "top" }),
		);
	} else if (untrack(() => hasMore)) {
		// HEAD not in current batch -- load the next batch so the effect re-fires with more commits.
		// untrack prevents hasMore from creating a reactive dependency here.
		untrack(() => loadMore());
	}
});

// Cmd+F search toggle — handled via native menu accelerator (registered in Rust)
// so it works regardless of WebView focus state (e.g. after fullscreen/maximize).
$effect(() => {
	let unlisten: (() => void) | undefined;
	listen<void>("search-toggle", () => {
		if (searchOpen) {
			const input = document.querySelector(
				".search-bar-input",
			) as HTMLInputElement | null;
			if (input) {
				input.focus();
				input.select();
			}
		} else {
			searchOpen = true;
		}
	}).then((fn) => {
		unlisten = fn;
	});

	return () => {
		unlisten?.();
		if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
	};
});

function handleSearchQueryChange(query: string) {
	searchQuery = query;
	if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

	if (!query.trim()) {
		searchResults = [];
		searchCurrentIndex = 0;
		return;
	}

	searchDebounceTimer = setTimeout(async () => {
		try {
			const results = await safeInvoke<SearchResult[]>("search_commits", {
				path: repoPath,
				query: query.trim(),
			});
			searchResults = results;
			searchCurrentIndex = 0;
			if (results.length > 0) {
				scrollToOid(results[0].oid);
				oncommitselect?.(results[0].oid);
			}
		} catch {
			searchResults = [];
			searchCurrentIndex = 0;
		}
	}, 200);
}

function handleSearchNext() {
	if (searchResults.length === 0) return;
	searchCurrentIndex = (searchCurrentIndex + 1) % searchResults.length;
	const oid = searchResults[searchCurrentIndex].oid;
	scrollToOid(oid);
	oncommitselect?.(oid);
}

function handleSearchPrev() {
	if (searchResults.length === 0) return;
	searchCurrentIndex =
		(searchCurrentIndex - 1 + searchResults.length) % searchResults.length;
	const oid = searchResults[searchCurrentIndex].oid;
	scrollToOid(oid);
	oncommitselect?.(oid);
}

function handleSearchClose() {
	searchOpen = false;
	searchQuery = "";
	searchResults = [];
	searchCurrentIndex = 0;
	if (searchDebounceTimer) {
		clearTimeout(searchDebounceTimer);
		searchDebounceTimer = null;
	}
}

// Keyboard arrow navigation for commit selection
function handleKeydown(e: KeyboardEvent) {
	if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;

	// Don't intercept keys when search bar input is focused
	const active = document.activeElement;
	if (active?.classList.contains("search-bar-input")) return;

	e.preventDefault();

	const items = displayItems;
	if (items.length === 0) return;

	const currentIdx = items.findIndex((c) => c.oid === selectedCommitOid);

	let nextIdx: number;
	if (e.key === "ArrowDown") {
		if (currentIdx === -1) nextIdx = 0;
		else if (currentIdx >= items.length - 1) return;
		else nextIdx = currentIdx + 1;
	} else {
		if (currentIdx <= 0) return;
		nextIdx = currentIdx - 1;
	}

	const commit = items[nextIdx];
	if (commit.oid === "__wip__") {
		onWipClick?.();
	} else {
		oncommitselect?.(commit.oid);
	}

	tick().then(() => {
		const row = containerRef?.querySelector(
			`[data-original-index="${nextIdx}"]`,
		);
		row?.scrollIntoView({ block: "nearest" });
	});
}

// Auto-focus the container on mount so keyboard nav works immediately
$effect(() => {
	if (containerRef) {
		tick().then(() => {
			if (
				document.activeElement === document.body ||
				document.activeElement === null
			) {
				containerRef?.focus();
			}
		});
	}
});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="h-full overflow-hidden flex flex-col"
  style="background: var(--bg-1); outline: none;"
  tabindex="0"
  role="listbox"
  bind:this={containerRef}
  onkeydown={handleKeydown}
>
  <!-- Header row (always visible) -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="flex items-center flex-shrink-0"
    style="height: {displaySettings.rowHeight}px; background: var(--bg-1); border-bottom: 1px solid var(--line); font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-3); padding: 0 {COLUMN_PADDING_X}px;"
    oncontextmenu={showHeaderContextMenu}
  >
    {#if columnVisibility.ref}
      <div class="flex-shrink-0 relative" style="width: {columnWidths.ref}px; padding: 0 {COLUMN_PADDING_X}px;">
        Branch/Tag
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        {#if 'ref' !== lastVisibleColumn}
          <div class="col-resize-handle" onmousedown={(e) => startColumnResize('ref', e)}></div>
        {/if}
      </div>
    {/if}
    {#if columnVisibility.graph}
      <div class="flex-shrink-0 relative" style="width: {columnWidths.graph}px; padding: 0 {COLUMN_PADDING_X}px;">
        Graph
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        {#if 'graph' !== lastVisibleColumn}
          <div class="col-resize-handle" onmousedown={(e) => startColumnResize('graph', e)}></div>
        {/if}
      </div>
    {/if}
    {#if columnVisibility.message}
      <div class="flex-1 relative" style="padding: 0 {COLUMN_PADDING_X}px;">
        Message
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        {#if 'message' !== lastVisibleColumn}
          <div class="col-resize-handle" onmousedown={(e) => startColumnResize('author', e, true)}></div>
        {/if}
      </div>
    {/if}
    {#if columnVisibility.author}
      <div class="flex-shrink-0 relative" style="width: {columnWidths.author}px; padding: 0 {COLUMN_PADDING_X}px;">
        Author
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        {#if 'author' !== lastVisibleColumn}
          <div class="col-resize-handle" onmousedown={(e) => startColumnResize('date', e, true)}></div>
        {/if}
      </div>
    {/if}
    {#if columnVisibility.date}
      <div class="flex-shrink-0 relative" style="width: {columnWidths.date}px; padding: 0 {COLUMN_PADDING_X}px;">
        Date
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        {#if 'date' !== lastVisibleColumn}
          <div class="col-resize-handle" onmousedown={(e) => startColumnResize('sha', e, true)}></div>
        {/if}
      </div>
    {/if}
    {#if columnVisibility.sha}
      <div class="flex-shrink-0" style="width: {columnWidths.sha}px; padding: 0 {COLUMN_PADDING_X}px;">
        SHA
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        {#if 'sha' !== lastVisibleColumn}
          <div class="col-resize-handle" onmousedown={(e) => startColumnResize('sha', e, true)}></div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Content area (grows to fill remaining space) -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="flex-1 overflow-hidden" style="position: relative; padding: 0 {COLUMN_PADDING_X}px;" onwheel={(e) => {
    // GRAPH-02: horizontal pan on trackpad swipe or shift+wheel — only when pointer is over the graph column
    if (maxGraphScrollX > 0 && e.deltaX !== 0) {
      const rect = e.currentTarget.getBoundingClientRect();
      const pointerX = e.clientX - rect.left - COLUMN_PADDING_X;
      const graphStart = columnVisibility.ref ? columnWidths.ref : 0;
      const graphEnd = graphStart + (columnVisibility.graph ? columnWidths.graph : 0);
      if (pointerX >= graphStart && pointerX <= graphEnd) {
        graphScrollX = Math.max(0, Math.min(maxGraphScrollX, graphScrollX + e.deltaX));
      }
    }
  }}>
    {#if searchOpen}
      <SearchBar
        query={searchQuery}
        currentIndex={searchCurrentIndex}
        totalMatches={searchResults.length}
        onquerychange={handleSearchQueryChange}
        onnext={handleSearchNext}
        onprev={handleSearchPrev}
        onclose={handleSearchClose}
      />
    {/if}

    {#if commits.length === 0 && loading}
      <!-- Initial skeleton loading -->
      {#each { length: SKELETON_COUNT } as _}
        <div class="flex items-center gap-2 px-2 animate-pulse" style="height: {displaySettings.rowHeight}px">
          <div
            class="rounded-full flex-shrink-0"
            style="background: var(--color-border); width: 64px; height: 12px;"
          ></div>
          <div
            class="rounded flex-shrink-0"
            style="background: var(--color-border); width: 32px; height: 100%;"
          ></div>
          <div class="rounded flex-1" style="background: var(--color-border); height: 12px;"></div>
        </div>
      {/each}
    {:else if commits.length === 0 && error}
      <!-- Initial load error -->
      <div class="error-banner m-4 rounded-md px-4 py-3 text-sm">
        {error}
      </div>
    {:else}
      <!-- SVG overlay snippet - renders inside virtual list scroll container -->
      {#snippet graphOverlay(contentHeight: number, visibleStart: number, visibleEnd: number)}
        {@const refOffset = columnVisibility.ref ? columnWidths.ref : 0}
        {@const visible = getVisibleOverlayElements(paths, graphData.nodes, visibleStart, visibleEnd, pillData)}
        {@const graphColWidth = columnVisibility.graph ? columnWidths.graph : naturalGraphWidth}
        {@const scrollX = Math.min(graphScrollX, Math.max(0, naturalGraphWidth - graphColWidth + 2 * COLUMN_PADDING_X))}
        <svg
          class="absolute top-0"
          width={refOffset + Math.max(graphColWidth, naturalGraphWidth)}
          height={contentHeight}
          style="left: 0; pointer-events: none; z-index: 1; {searchDimmingActive ? 'opacity: var(--opacity-search-dim);' : ''}"
        >
          <!-- GRAPH-02: clip graph content to column width -->
          <defs>
            <clipPath id="graph-clip">
              <rect x={refOffset + COLUMN_PADDING_X} y="0" width={graphColWidth - 2 * COLUMN_PADDING_X} height={contentHeight} />
            </clipPath>
          </defs>
          <!-- GRAPH-02: Layer A — rails + connections, scrolled and clipped.
               Translated left by scrollX to pan through lanes. -->
          <g clip-path="url(#graph-clip)">
            <g class="overlay-paths" transform="translate({refOffset + COLUMN_PADDING_X - scrollX}, 0)">
              {#each visible.paths as path}
                <path d={path.d} fill="none"
                  stroke={laneColor(path.colorIndex)}
                  stroke-width={displaySettings.edgeStroke}
                  stroke-linecap="round"
                  stroke-dasharray={path.dashed ? '3 3' : 'none'} />
              {/each}
            </g>
          </g>
          <!-- GRAPH-02: Layer B — dots with "sticky" X clamping.
               Dots slide along their horizontal line to stay visible in the viewport.
               Viewport spans graph coordinates [scrollX, scrollX + graphColWidth].
               Dots clamp to viewport edges (bead-on-a-string effect). -->
          <g class="overlay-dots" transform="translate({refOffset + COLUMN_PADDING_X}, 0)">
            {#each visible.dots as node}
              {@const clampedCx = Math.max(displaySettings.laneWidth / 2, Math.min(graphColWidth - 2 * COLUMN_PADDING_X - displaySettings.dotRadius, cx(node.x) - scrollX))}
              {#if node.isWip}
                <circle cx={clampedCx} cy={cy(node.y)} r={displaySettings.dotRadius}
                  fill="none" stroke={laneColor(node.colorIndex)}
                  stroke-width={displaySettings.edgeStroke} stroke-dasharray="3 3" />
              {:else if node.isStash}
                <rect
                  x={clampedCx - displaySettings.dotRadius}
                  y={cy(node.y) - displaySettings.dotRadius}
                  width={displaySettings.dotRadius * 2}
                  height={displaySettings.dotRadius * 2}
                  fill="none"
                  stroke={laneColor(node.colorIndex)}
                  stroke-width={displaySettings.edgeStroke}
                  stroke-dasharray="3 3" />
              {:else if node.isMerge}
                <circle cx={clampedCx} cy={cy(node.y)} r={displaySettings.dotRadius}
                  fill="var(--bg-1)" stroke={laneColor(node.colorIndex)}
                  stroke-width={displaySettings.mergeStroke} />
              {:else}
                <circle cx={clampedCx} cy={cy(node.y)} r={displaySettings.dotRadius}
                  fill={laneColor(node.colorIndex)} />
              {/if}
            {/each}
          </g>
          {#if columnVisibility.ref}
            <g class="overlay-pills">
              {#each visible.pills as pill}
                {@const overflowBadgeWidth = pill.overflowCount > 0 ? `+${pill.overflowCount}`.length * BADGE_FONT_SIZE * 0.7 + PILL_PADDING_X * 2 : 0}
                {@const pillGroupRightX = pill.x + pill.width + (pill.overflowCount > 0 ? PILL_GAP + overflowBadgeWidth : 0)}
                <!-- Connector from the pill group's right edge (past the +N badge) to the commit dot, plus a short stub linking the named pill to the badge. The badge sits between the two segments with no line behind it, so it reads as solid yet stays connected to the pill (uses sticky X position, scroll-adjusted) -->
                {#if columnVisibility.graph}
                  {@const stickyDotCx = Math.max(displaySettings.laneWidth / 2, Math.min(graphColWidth - 2 * COLUMN_PADDING_X - displaySettings.dotRadius, pill.dotCx - scrollX))}
                  {@const connectorEndX = refOffset + COLUMN_PADDING_X + stickyDotCx - (pill.isHollow ? displaySettings.dotRadius : 0)}
                  <line
                    x1={pillGroupRightX}
                    y1={pill.y}
                    x2={connectorEndX}
                    y2={pill.dotCy}
                    stroke={laneColor(pill.commitColorIndex)}
                    stroke-width={pill.isHead ? displaySettings.pillStroke * 2 : displaySettings.pillStroke}
                    opacity={pill.isRemoteOnly ? 0.67 : 1}
                    style={pill.isNonHead && !pill.isRemoteOnly ? 'filter: brightness(0.75)' : ''}
                  />
                  {#if pill.overflowCount > 0}
                    <!-- Stub linking the named pill to the +N badge, filling the gap so they read as one connected group. -->
                    <line
                      x1={pill.x + pill.width}
                      y1={pill.y}
                      x2={pill.x + pill.width + PILL_GAP}
                      y2={pill.y}
                      stroke={laneColor(pill.commitColorIndex)}
                      stroke-width={pill.isHead ? displaySettings.pillStroke * 2 : displaySettings.pillStroke}
                      opacity={pill.isRemoteOnly ? 0.67 : 1}
                      style={pill.isNonHead && !pill.isRemoteOnly ? 'filter: brightness(0.75)' : ''}
                    />
                  {/if}
                {/if}

                <!-- Capsule rect -->
                <rect
                  x={pill.x}
                  y={pill.y - PILL_HEIGHT / 2}
                  width={pill.width}
                  height={PILL_HEIGHT}
                  rx={PILL_HEIGHT / 2}
                  ry={PILL_HEIGHT / 2}
                  fill={laneColor(pill.colorIndex)}
                  fill-opacity={pill.isRemoteOnly ? 0.1 : 0.14}
                  stroke={laneColor(pill.colorIndex)}
                  stroke-opacity="0.5"
                  pointer-events="auto"
                  style:cursor={pill.refType === 'LocalBranch' || pill.refType === 'RemoteBranch' ? 'pointer' : 'context-menu'}
                  onmouseenter={() => pillMouseEnter(pill)}
                  onmouseleave={pillMouseLeave}
                  oncontextmenu={(e) => showRefContextMenu(e, refFromPill(pill))}
                  ondblclick={pill.refType === 'LocalBranch' || pill.refType === 'RemoteBranch' ? (e: MouseEvent) => handleRefCheckout(e, refFromPill(pill)) : undefined}
                />

                <!-- Icon rendered directly in SVG at a fixed position (no CSS layout) -->
                {#if PILL_ICONS[pill.refType]}
                  {@const PillIcon = PILL_ICONS[pill.refType]}
                  <g transform="translate({pill.x + PILL_PADDING_X}, {pill.y - ICON_WIDTH / 2})" opacity="0.9" style="pointer-events: auto; cursor: {pill.refType === 'LocalBranch' || pill.refType === 'RemoteBranch' ? 'pointer' : 'context-menu'};" oncontextmenu={(e) => showRefContextMenu(e, refFromPill(pill))} ondblclick={pill.refType === 'LocalBranch' || pill.refType === 'RemoteBranch' ? (e: MouseEvent) => handleRefCheckout(e, refFromPill(pill)) : undefined}>
                    <PillIcon size={ICON_WIDTH} />
                  </g>
                {/if}

                <!-- Text in its own foreignObject sized to exactly the canvas-measured text width.
                     No flex layout — icon is positioned separately so the text width is unambiguous. -->
                <foreignObject
                  x={pill.x + PILL_PADDING_X + ICON_WIDTH + ICON_GAP}
                  y={pill.y - PILL_HEIGHT / 2}
                  width={Math.ceil(pill.textWidth)}
                  height={PILL_HEIGHT}
                >
                  <span
                    style="
                      display: block;
                      line-height: {PILL_HEIGHT}px;
                      color: {laneColor(pill.colorIndex)};
                      font-size: {PILL_FONT_SIZE}px;
                      font-family: var(--font-sans);
                      font-weight: {pill.isHead ? 700 : 500};
                      white-space: nowrap;
                      overflow: hidden;
                      cursor: {pill.refType === 'LocalBranch' || pill.refType === 'RemoteBranch' ? 'pointer' : 'context-menu'};
                    "
                    oncontextmenu={(e) => showRefContextMenu(e, refFromPill(pill))}
                    ondblclick={pill.refType === 'LocalBranch' || pill.refType === 'RemoteBranch' ? (e: MouseEvent) => handleRefCheckout(e, refFromPill(pill)) : undefined}
                  >{pill.truncatedLabel}</span>
                </foreignObject>

                <!-- Overflow +N badge -->
                {#if pill.overflowCount > 0}
                  {@const badgeText = `+${pill.overflowCount}`}
                  <rect
                    x={pill.x + pill.width + PILL_GAP}
                    y={pill.y - BADGE_HEIGHT / 2}
                    width={overflowBadgeWidth}
                    height={BADGE_HEIGHT}
                    rx={BADGE_HEIGHT / 2}
                    ry={BADGE_HEIGHT / 2}
                    fill={laneColor(pill.colorIndex)}
                    fill-opacity="0.14"
                    stroke={laneColor(pill.colorIndex)}
                    stroke-opacity="0.5"
                    pointer-events="auto"
                    onmouseenter={() => pillMouseEnter(pill)}
                    onmouseleave={pillMouseLeave}
                  />
                  <foreignObject
                    x={pill.x + pill.width + PILL_GAP}
                    y={pill.y - BADGE_HEIGHT / 2}
                    width={overflowBadgeWidth}
                    height={BADGE_HEIGHT}
                  >
                    <span
                      style="
                        color: {laneColor(pill.colorIndex)};
                        font-size: {BADGE_FONT_SIZE}px;
                        font-family: var(--font-sans);
                        font-weight: 500;
                        line-height: {BADGE_HEIGHT}px;
                        display: block;
                        text-align: center;
                        white-space: nowrap;
                      "
                    >{badgeText}</span>
                  </foreignObject>
                {/if}
              {/each}
            </g>
          {/if}
        </svg>
        {#if hoveredPill && columnVisibility.ref}
          {#if hoveredPill.overflowCount > 0}
            <!-- Multi-ref expansion: shows all refs vertically -->
            <div
              class="absolute rounded-lg shadow-lg"
              style="
                left: {hoveredPill.x}px;
                top: {hoveredPill.y - PILL_HEIGHT / 2}px;
                background: var(--bg-2);
                border: 1px solid var(--line);
                padding: 4px 8px;
                z-index: 50;
                pointer-events: auto;
                opacity: 1;
                transition: opacity 180ms ease;
              "
              onmouseenter={overlayMouseEnter}
              onmouseleave={overlayMouseLeave}
            >
              {#each hoveredPill.allRefs as ref}
                {@const ri = refFromLabel(ref)}
                <div
                  style="display: flex; align-items: center; gap: 3px; cursor: {ri.refType === 'LocalBranch' || ri.refType === 'RemoteBranch' ? 'pointer' : 'context-menu'}; border-radius: 4px; color: var(--lane-{ref.color_index % 8});"
                  class="text-[11px] leading-5 font-medium whitespace-nowrap hover:bg-white/8 px-1 -mx-1"
                  oncontextmenu={(e) => showRefContextMenu(e, ri)}
                  ondblclick={ri.refType === 'LocalBranch' || ri.refType === 'RemoteBranch' ? (e: MouseEvent) => handleRefCheckout(e, ri) : undefined}
                >
                  {#if PILL_ICONS[ref.ref_type]}
                    {@const RefIcon = PILL_ICONS[ref.ref_type]}
                    <RefIcon size={10} style="flex-shrink: 0; opacity: 0.85;" />
                  {/if}
                  {ref.short_name}
                </div>
              {/each}
            </div>
          {:else}
            <!-- Truncated single-ref: width-only expansion showing full label -->
            <div
              class="absolute rounded-full shadow-lg"
              style="
                left: {hoveredPill.x}px;
                top: {hoveredPill.y - PILL_HEIGHT / 2}px;
                height: {PILL_HEIGHT}px;
                background: color-mix(in oklch, var(--lane-{hoveredPill.colorIndex % 8}) 14%, var(--bg-2));
                box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--lane-{hoveredPill.colorIndex % 8}) 50%, transparent);
                padding: 0 {PILL_PADDING_X}px;
                z-index: 50;
                pointer-events: auto;
                display: flex;
                align-items: center;
                opacity: 1;
                transition: opacity 180ms ease;
                cursor: {hoveredPill.refType === 'LocalBranch' || hoveredPill.refType === 'RemoteBranch' ? 'pointer' : 'context-menu'};
              "
              onmouseenter={overlayMouseEnter}
              onmouseleave={overlayMouseLeave}
              oncontextmenu={(e) => showRefContextMenu(e, refFromPill(hoveredPill!))}
              ondblclick={hoveredPill.refType === 'LocalBranch' || hoveredPill.refType === 'RemoteBranch' ? (e: MouseEvent) => handleRefCheckout(e, refFromPill(hoveredPill!)) : undefined}
            >
              <span style="display: flex; align-items: center; gap: 2px; font-weight: {hoveredPill.isHead ? 700 : 500}; color: var(--lane-{hoveredPill.colorIndex % 8});" class="text-[11px] font-medium whitespace-nowrap">
                {#if PILL_ICONS[hoveredPill.refType]}
                  {@const HoverIcon = PILL_ICONS[hoveredPill.refType]}
                  <HoverIcon size={10} style="flex-shrink: 0; opacity: 0.9;" />
                {/if}
                {hoveredPill.label}
              </span>
            </div>
          {/if}
        {/if}
      {/snippet}

      {#key displaySettings.rowHeight}
      <VirtualList
        bind:this={listRef}
        items={displayItems}
        defaultEstimatedItemHeight={displaySettings.rowHeight}
        bind:measuredItemHeight={svgRowHeight}
        onLoadMore={loadMore}
        loadMoreThreshold={50}
        {hasMore}
        overlaySnippet={graphOverlay}
      >
        {#snippet renderItem(commit, index)}
          <CommitRow {commit} rowIndex={index} onselect={commit.oid === '__wip__' ? () => onWipClick?.() : oncommitselect} oncontextmenu={handleRowContextMenu} {maxColumns} {columnWidths} {columnVisibility} selected={commit.oid === selectedCommitOid && commit.oid !== '__wip__'} rowHeight={displaySettings.rowHeight} isSearchMatch={searchMatchOids.has(commit.oid)} isCurrentMatch={commit.oid === searchCurrentOid} isSearchActive={searchOpen && searchQuery.length > 0 && searchResults.length > 0} inSession={sessionOids.has(commit.oid)} isPendingBase={pendingBase === commit.oid} commentCount={commentCountFor(commit.oid)} wipStats={commit.oid === '__wip__' ? wipStats : undefined} />
        {/snippet}
      </VirtualList>
      {/key}

      <!-- Mid-scroll skeleton (more commits loading) -->
      {#if loading && commits.length > 0}
        {#each { length: 3 } as _}
        <div class="flex items-center gap-2 animate-pulse" style="height: {displaySettings.rowHeight}px">
            <div
              class="rounded-full flex-shrink-0"
              style="background: var(--color-border); width: 64px; height: 12px;"
            ></div>
            <div
              class="rounded flex-shrink-0"
              style="background: var(--color-border); width: 32px; height: 100%;"
            ></div>
            <div
              class="rounded flex-1"
              style="background: var(--color-border); height: 12px;"
            ></div>
          </div>
        {/each}
      {/if}

      <!-- Mid-scroll error + retry -->
      {#if error && commits.length > 0}
        <div class="flex items-center gap-3 px-4 py-2">
          <span class="error-text text-sm">{error}</span>
          <button
            onclick={loadMore}
            class="rounded px-3 py-1 text-xs font-medium"
            style="background: var(--color-surface); border: 1px solid var(--color-border); color: var(--color-text);"
          >
            Retry
          </button>
        </div>
      {/if}
    {/if}
  </div>
</div>

{#if dialogConfig}
  <InputDialog
    title={dialogConfig.title}
    fields={dialogConfig.fields}
    onsubmit={dialogConfig.onsubmit}
    oncancel={closeDialog}
  />
{/if}

<style>
  .col-resize-handle {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    cursor: col-resize;
    background: linear-gradient(to right, transparent 1.5px, var(--color-border) 1.5px, var(--color-border) 2.5px, transparent 2.5px);
    transition: background 0.15s;
  }
  .col-resize-handle:hover {
    background: linear-gradient(to right, transparent 1px, var(--color-accent) 1px, var(--color-accent) 3px, transparent 3px);
  }
  /* GRAPH-01: visible padding above first and below last commit row */
  :global(.virtual-list-viewport) {
    padding-top: 8px;
    padding-bottom: 8px;
    box-sizing: border-box;
    overflow-x: hidden;
  }
  .error-banner {
    background: var(--color-danger-bg);
    border: 1px solid var(--color-danger-border);
    color: var(--color-danger);
  }
  .error-text {
    color: var(--color-danger);
  }
</style>

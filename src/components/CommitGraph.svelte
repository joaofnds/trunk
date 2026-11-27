<script lang="ts">
import Archive from "@lucide/svelte/icons/archive";
import Clock from "@lucide/svelte/icons/clock";
import FileDiff from "@lucide/svelte/icons/file-diff";
import GitBranch from "@lucide/svelte/icons/git-branch";
import Globe from "@lucide/svelte/icons/globe";
import Hash from "@lucide/svelte/icons/hash";
import Laptop from "@lucide/svelte/icons/laptop";
import MessageSquare from "@lucide/svelte/icons/message-square";
import Network from "@lucide/svelte/icons/network";
import Tag from "@lucide/svelte/icons/tag";
import User from "@lucide/svelte/icons/user";
import { type Component, onDestroy, tick, untrack } from "svelte";
import { buildGraphData } from "../lib/active-lanes.js";
import { deleteBranch } from "../lib/branch-delete.js";
import { mergeBranch, rebaseBranch } from "../lib/branch-op.js";
import {
	CHECKOUT_CONFLICT_MESSAGE,
	checkedOutMessage,
	isCheckoutConflict,
	reportCheckoutFailure,
} from "../lib/checkout.js";
import { copySha, copyText } from "../lib/clipboard.js";
import {
	type CoalescedTask,
	createCoalescedTask,
} from "../lib/coalesced-task.js";
import {
	authorContentWidth,
	authorShowsName,
	columnFloors,
	DEFAULT_WIDTHS,
	dateContentWidth,
	graphTargetWidth,
	HEADER_ICON_WIDTH,
	headerMinWidths,
	MESSAGE_FLOOR,
	messageFit,
	messageReserve,
	refContentWidth,
	SIZED_COLUMNS,
	shaContentWidth,
	shareBudget,
	showsHeaderLabel,
	tableMinWidth,
} from "../lib/column-widths.js";
import type { SelectModifiers } from "../lib/compare-select.js";
import { ask } from "../lib/dialog.js";
import { forDisplay } from "../lib/display-text.js";
import { errorMessage, reportErrorToast } from "../lib/error-report.js";
import { canFastForward } from "../lib/fast-forward.js";
import {
	BADGE_FONT_SIZE,
	BADGE_HEIGHT,
	COLUMN_PADDING_X,
	DASH,
	DEFAULT_GRAPH_SETTINGS,
	ICON_GAP,
	ICON_WIDTH,
	nextGraphInstanceId,
	PILL_FONT_SIZE,
	PILL_GAP,
	PILL_HEIGHT,
	PILL_PADDING_X,
	TABLE_INSET_X,
} from "../lib/graph-constants.js";
import { graphKeyTarget, isGraphKey } from "../lib/graph-keys.js";
import { centredRowTop, openingScrollTop } from "../lib/graph-scroll.js";
import { isTrunkError, safeInvoke } from "../lib/invoke.js";
import { focusInEditable, keyChord } from "../lib/keyboard.js";
import { laneRefForRow } from "../lib/lane-ref.js";
import { nativeMenu } from "../lib/native-menu.js";
import {
	buildOverlayPaths,
	makePathContext,
	wipMarkerPath,
} from "../lib/overlay-paths.js";
import { getVisibleOverlayElements } from "../lib/overlay-visible.js";
import { createOwnedTimer } from "../lib/owned-timer.js";
import {
	branchRemoteMenuGroup,
	deleteRemoteBranch,
	listRemotes,
	renameBranch,
	runTagAction,
} from "../lib/ref-actions.js";
import { buildRefPillData, overflowBadgeWidth } from "../lib/ref-pill-data.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import { getScheduler } from "../lib/scheduler.js";
import { createHorizontalScrollSync } from "../lib/scroll-sync.js";
import { announcePan, type Pan } from "../lib/scrollbar-activity.js";
import { applyStash, dropStash, popStash } from "../lib/stash-actions.js";
import {
	type ColumnWidths,
	changeColumnVisibility,
	columnVisibilityPreference,
	loadUserWidths,
	saveUserWidths,
} from "../lib/store.js";
import { popupTagMenu, tagMenuEntriesOf } from "../lib/tag-menu.js";
import { measureTextWidth } from "../lib/text-measure.js";
import { textOverrun } from "../lib/text-overrun.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	CommitDetail,
	Conclusion,
	DiffStat,
	GraphCommit,
	GraphResponse,
	OverlayRefPill,
	RebasePreviewTarget,
	RefLabel,
	RefType,
	ReviewTally,
	SearchResult,
	StashEntry,
	WipStats,
} from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import HitArea from "../lib/ui/HitArea.svelte";
import Splitter from "../lib/ui/Splitter.svelte";
import { isSideways } from "../lib/wheel.js";
import { withWipRow } from "../lib/wip-row.js";
import CommitRow from "./CommitRow.svelte";
import InputDialog from "./InputDialog.svelte";
import SearchBar from "./SearchBar.svelte";
import VirtualList from "./VirtualList.svelte";

interface Props {
	/** The initial page has settled and its rows or error have rendered. */
	onready?: () => void;
	repoPath: string;
	/** The tab's remote operation, which a remote delete from a menu runs as. */
	remoteState: RemoteState;
	/** The checked-out branch, read from every ref, so it is known while HEAD's row
	 *  is not yet loaded. Undefined while HEAD is detached and until the refs load. */
	headBranch?: string;
	oncommitselect?: (oid: string, mods?: SelectModifiers) => void;
	oncomparecommits?: (baseOid: string, targetOid: string) => void;
	oncommitnavigate?: (oid: string) => void;
	/** Captures parent navigation, including a ref lookup whose OID is still unknown. */
	snapshotNavigationIntent?: () => () => boolean;
	// Reports the WIP-inclusive display list + pagination state whenever they
	// change, so the parent can compute commit nav (pager + child chips) itself
	// via computeCommitNav from the rows this graph last reported.
	oncommitschange?: (displayItems: GraphCommit[], hasMore: boolean) => void;
	wipCount?: number;
	wipMessage?: string;
	wipStats?: WipStats;
	onWipClick?: () => void;
	/** The WIP row's message labels the commit draft's Summary field: a click
	 *  on it asks for that field. */
	onFocusDraftSummary?: () => void;
	/** True while the commit draft's Summary field has the focus. */
	draftSummaryFocused?: boolean;
	refreshSignal?: number;
	/** Last notification captured successfully, retained by RepoView across pane changes. */
	consumedRefreshSignal?: number;
	onrefreshconsumed?: (generation: number) => void;
	wipRefreshSignal?: number;
	cachedGraphRevision?: number;
	refreshImmediately?: boolean;
	selectedCommitOid?: string | null;
	navigationCommitOid?: string | null;
	/** OIDs of the active compare's picked rows, highlighted like the selection. */
	compareOids?: ReadonlySet<string>;
	onopenrebaseeditor?: (target: RebasePreviewTarget) => void;
	onopenmessageeditor?: (
		defaultValue: string,
		title: string,
	) => Promise<string | null>;
	/** Whether this graph owns the active tab's center pane. */
	tabActive: boolean;
	/** Filtered per-commit badge projection from RepoView. */
	commentCounts: Map<string, number>;
	commentTallies: Map<string, ReviewTally>;
	/** Shared comments store; supplies the commented oids and the active review. */
	reviewComments?: ReviewCommentsManager;
	/** Whether BranchSidebar's stored-visibility read for this repo has resolved
	 *  (and, if it hid anything, pushed to the backend). The first page load
	 *  waits on this so it never paints against the backend's unfiltered
	 *  default -- open_repo always builds its first graph with nothing hidden,
	 *  since the backend has nothing stored for a path it has not seen yet.
	 *  Defaults true: only RepoView has a BranchSidebar sibling to gate on. */
	visibilityResolved?: boolean;
	/** Whether the parent's `repo-changed` listener has finished registering.
	 *  The first page waits on it, so a change reported before that page's read
	 *  arrives as an unchecked page and one reported after it as an event, and
	 *  none falls between the two. Defaults true for the same reason. */
	repoListenerSettled?: boolean;
}

let {
	repoPath,
	remoteState,
	headBranch,
	onready,
	oncommitselect,
	oncomparecommits,
	oncommitnavigate,
	snapshotNavigationIntent,
	oncommitschange,
	wipCount = 0,
	wipMessage = "",
	wipStats,
	onWipClick,
	onFocusDraftSummary,
	draftSummaryFocused = false,
	refreshSignal,
	consumedRefreshSignal = 0,
	onrefreshconsumed,
	wipRefreshSignal,
	cachedGraphRevision,
	refreshImmediately = false,
	selectedCommitOid,
	navigationCommitOid = selectedCommitOid,
	compareOids = new Set<string>(),
	onopenrebaseeditor,
	onopenmessageeditor,
	tabActive,
	commentCounts,
	commentTallies,
	reviewComments,
	// Defaults true (load immediately) rather than false: RepoView is the one
	// caller that has a BranchSidebar sibling to gate on and opts in explicitly.
	// Every other caller -- tests included -- has nothing else resolving a
	// visibility set for this repo, so there is nothing to wait for.
	visibilityResolved: refVisibilityResolved = true,
	repoListenerSettled = true,
}: Props = $props();
const pagesReadable = $derived(refVisibilityResolved && repoListenerSettled);
const scheduler = getScheduler();
// The staging panel shows the uncommitted changes while no commit is selected
// and nothing is compared, and their row reads as selected then.
const uncommittedChangesShown = $derived(
	!selectedCommitOid && compareOids.size === 0,
);

/**
 * Every open repository keeps its CommitGraph mounted, hidden by visibility
 * rather than removed, so a clip path named the same in two of them is one id
 * twice in one document. The browser resolves such a reference to whichever
 * came first, which clipped a wide graph to a collapsed one in another tab.
 *
 * Counted rather than random so a render is reproducible: the goldens compare
 * the markup, and a random id would differ on every run.
 */
const clipScope = `g${nextGraphInstanceId()}`;

// Per-row comment badge count, from counts already built under the thread
// filter, so hidden threads count nothing. The WIP row's oid is the literal
// "__wip__" key the store folds snapshot counts into.
function commentCountFor(oid: string): number {
	return commentCounts.get(oid) ?? 0;
}

function commentTallyFor(oid: string): ReviewTally | null {
	return commentTallies.get(oid) ?? null;
}

const BATCH = 200;
const SKELETON_COUNT = 10;
/** How many times scrollToOid asks again for a page that did not land before it
 *  gives up. Above 1 so a page dropped by the stale-page guard is retried
 *  against the rebuilt graph, low enough that a persistent failure stops
 *  quickly. */
const PAGE_ATTEMPT_BUDGET = 3;

type PageResult = "appended" | "target_absent" | "failed" | "stale";

interface PageRequest {
	through: string | undefined;
	result: Promise<PageResult>;
}

/** Stands in for the session membership Set when no comments rune is supplied. */
const EMPTY_OIDS: ReadonlySet<string> = new Set();

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
// value (ROW_HEIGHT). Over thousands of rows, using the CSS constant for
// SVG coordinates causes progressive drift. svgRowHeight tracks the real
// measured height so the SVG overlay stays aligned with the DOM rows.
let svgRowHeight = $state(displaySettings.rowHeight);

// Rows arrive laid out and are never edited in place, so each change replaces
// the list. Deep state would wrap every row in a proxy, and each append re-reads
// every loaded row through those proxies in the lane, path and pill passes.
let commits = $state.raw<GraphCommit[]>([]);
let maxColumns = $state(1);
let hasMore = $state(true);
let pendingPage = $state.raw<PageRequest>();
const loading = $derived(pendingPage !== undefined);
let error = $state<string | null>(null);
let offset = $state(0);
let scrollSequence = 0;
let listRef = $state<{
	scroll: (opts: {
		index: number;
		smoothScroll?: boolean;
		align?: string;
	}) => Promise<void>;
} | null>(null);
let scrolledToHead = false;
let containerRef = $state<HTMLDivElement | null>(null);
let headerRef = $state<HTMLDivElement | null>(null);

/** The virtual list's scroller, or null while the list is not mounted. */
function listViewport(): HTMLElement | null {
	return (
		containerRef?.querySelector<HTMLElement>(".virtual-list-viewport") ?? null
	);
}

// The column header and the rows scroll sideways as one. The viewport belongs to
// the virtual list, so it is registered each time the list mounts.
const syncTableScroll = createHorizontalScrollSync();

$effect(() => {
	if (!listRef) return;

	const viewport = listViewport();
	if (!viewport) return;

	return syncTableScroll(viewport).destroy;
});

// Diff column: per-oid stats for loaded history commits + the WIP row's stat.
// Reassigned (never mutated) so the deeply-reactive Map drives re-render. All
// fetches are gated on columnVisibility.diff so a hidden column does zero work.
let commitStats = $state<Map<string, DiffStat>>(new Map());
let wipDiffStat = $state<DiffStat | undefined>(undefined);
// Gate: columnVisibility starts at the optimistic default (diff: true) and is
// overwritten asynchronously from the persisted store. Until that resolves we
// don't know the real visibility, so no stat fetch fires — otherwise a user who
// persisted diff:false pays a full page + WIP diff computation on every load for
// a column they turned off.
const columnVisibilityResolved = $derived($columnVisibilityPreference.resolved);
let statsWereActive = false;
let renderedStart = $state(0);
let renderedEnd = $state(0);
let attemptedStats = new Set<string>();
let graphActive = true;

// Whole-graph generation. showGraph can replace the page independently while a
// refresh is active, so an older response must not overwrite that replacement.
let refreshSeq = 0;
let graphRevision = $state(0);
let graphReady = $state(false);
let depthRecovery:
	| { revision: number; sequence: number; result: Promise<void> }
	| undefined;

/** Marks a graph as shown. The view's first graph can predate a change the
 *  watcher reported before this view's listener could hear it, so an unchecked
 *  one gets the refresh that change's event would have requested (TRUNK-494).
 *  The listener hears every change after that, so later graphs need none. */
function markGraphReady(response: GraphResponse): void {
	if (!graphReady && !response.checked) graphRefresh.request();
	graphReady = true;
}

/** Until the first graph or its failure arrives there is nothing to show but
 *  the wait: a page can be held back by the stored ref visibility read, and the
 *  uncommitted changes row alone would read as a repository with no history. */
const awaitingFirstGraph = $derived(!graphReady && error === null);

let columnWidths = $state<ColumnWidths>({ ...DEFAULT_WIDTHS });
const columnVisibility = $derived($columnVisibilityPreference.value);

$effect(() => {
	userWidthsRestored = loadUserWidths(repoPath, floors).then((stored) => {
		const restored = SIZED_COLUMNS.filter(
			(column) => column in stored && !columnsSizedSinceMount.has(column),
		);
		const widths = { ...columnWidths };
		for (const column of restored)
			widths[column] = stored[column] ?? widths[column];
		columnWidths = widths;
		userSizedColumns = new Set([...userSizedColumns, ...restored]);
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

/** Where the Graph column starts in the table, before any sideways scroll. */
const graphStart = $derived(columnVisibility.ref ? columnWidths.ref : 0);

/** How wide the Graph column is laid out: nothing while it is hidden. */
const graphWidth = $derived(columnVisibility.graph ? columnWidths.graph : 0);

/** A column whose content pans sideways inside it, by an offset kept here. */
interface ColumnPan extends Pan {
	/** Whether a pointer this far into the table is over the column. */
	holds(x: number): boolean;
	offset(): number;
	/** How far the content runs past the column. */
	range(): number;
}

function columnPan(column: {
	/** Where the column lies in the table, before any sideways scroll. */
	band(): { start: number; width: number };
	offset(): number;
	range(): number;
	scrollTo(offset: number): void;
}): ColumnPan {
	return {
		offset: column.offset,
		range: column.range,
		scrollTo: column.scrollTo,
		holds(x) {
			const { start, width } = column.band();
			return x >= start && x < start + width;
		},
		extent(viewport) {
			const { start, width } = column.band();
			const tableLeft =
				viewport.getBoundingClientRect().left - viewport.scrollLeft;

			return {
				trackStart: tableLeft + start,
				trackLength: width,
				offset: column.offset(),
				scrollLength: width + column.range(),
				clientLength: width,
			};
		},
	};
}

const graphPan = columnPan({
	band: () => ({ start: graphStart, width: graphWidth }),
	offset: () => graphScrollX,
	range: () => maxGraphScrollX,
	scrollTo(offset) {
		graphScrollX = offset;
	},
});

let messageScrollX = $state(0);

/** The summaries the list shows now, of all the rows it has mounted. */
function summariesOnScreen(): HTMLElement[] {
	const viewport = listViewport();
	if (!viewport) return [];

	const { top, bottom } = viewport.getBoundingClientRect();
	const mounted = viewport.querySelectorAll<HTMLElement>(
		"[data-message-summary]",
	);
	return [...mounted].filter((summary) => {
		const row = summary.getBoundingClientRect();
		return row.bottom > top && row.top < bottom;
	});
}

/** How far the longest cut summary on screen runs past what its row shows. */
function messageOverrun(): number {
	let widest = 0;
	for (const summary of summariesOnScreen()) {
		widest = Math.max(widest, textOverrun(summary));
	}

	return Math.ceil(widest);
}

/** Message's header cell: the engine lays out the column's width there. */
function messageHeader(): HTMLElement | null {
	return (
		containerRef?.querySelector<HTMLElement>(
			"[data-testid=column-header] > [data-column=message]",
		) ?? null
	);
}

const messagePan = columnPan({
	band: () => ({
		start: graphStart + graphWidth,
		width: messageHeader()?.getBoundingClientRect().width ?? 0,
	}),
	offset: () => messageScrollX,
	range: messageOverrun,
	scrollTo(offset) {
		messageScrollX = offset;
	},
});

// The pan's end is read from the summaries on screen, and a pan left past it
// moves them out of their cells, so whatever changes those summaries pulls the
// pan back to their end: a scroll, new rows, or a new width.
function clampMessagePan() {
	if (messageScrollX > 0) {
		messageScrollX = Math.min(messageScrollX, messageOverrun());
	}
}

$effect(() => {
	if (!listRef) return;

	const viewport = listViewport();
	if (!viewport) return;

	viewport.addEventListener("scroll", clampMessagePan);
	return () => viewport.removeEventListener("scroll", clampMessagePan);
});

$effect(() => {
	void displayItems;
	void columnWidths;
	void rowWidth;
	void tick().then(clampMessagePan);
});

const columnPans: readonly ColumnPan[] = [graphPan, messagePan];

// A sideways gesture over a column that pans, Graph or Message, moves its
// content until that reaches its end in the gesture's direction, and from
// there, or anywhere else, it scrolls the table. While the table can scroll
// sideways the pan cancels the gesture, or the table would move under it too;
// a table that fits leaves the gesture to the engine. A wheel event that is
// not sideways is the engine's whole, since WebKit holds its own scrollers to
// the swipe's main axis.
function panColumn(event: WheelEvent & { currentTarget: HTMLElement }) {
	if (!isSideways(event)) return;

	const viewport = listViewport();
	if (!viewport) return;

	const rect = event.currentTarget.getBoundingClientRect();
	const pointerX =
		event.clientX - rect.left - TABLE_INSET_X + viewport.scrollLeft;
	const column = columnPans.find((pan) => pan.holds(pointerX));
	if (!column) return;

	const panned = Math.max(
		0,
		Math.min(column.range(), column.offset() + event.deltaX),
	);
	if (panned === column.offset()) return;

	if (viewport.scrollWidth > viewport.clientWidth) event.preventDefault();
	column.scrollTo(panned);
	announcePan(viewport, column);
}

const headerMins = headerMinWidths(measureTextWidth);
const floors = columnFloors(measureTextWidth);

// The columns whose width the user set, which no fit may change. Reassigned
// rather than mutated, so the fits re-run when a column joins or leaves it.
let userSizedColumns = $state<ReadonlySet<keyof ColumnWidths>>(new Set());
// The graph mounts with its repository tab, so a drag or a double-click can come
// before the stored widths are read. Saves wait for the restore so they carry
// what it brings back, and the restore leaves the columns sized since alone.
let userWidthsRestored: Promise<void> = Promise.resolve();
const columnsSizedSinceMount = new Set<keyof ColumnWidths>();

/** The width the rows lay their cells out in, 0 until the list is measured. */
let rowWidth = $state(0);

$effect(() => {
	const list = containerRef;
	if (!list) return;

	const observer = new ResizeObserver(([entry]) => {
		rowWidth = entry.contentRect.width - 2 * TABLE_INSET_X;
	});
	observer.observe(list);

	return () => observer.disconnect();
});

// Max content widths for auto-fit (updated when commits load)
let maxRefContentWidth = $state(0);
let maxAuthorContentWidth = $state(0);
let maxDateContentWidth = $state(0);
let maxShaContentWidth = $state(0);

function updateContentWidths(newCommits: GraphCommit[], reset = false) {
	if (reset) {
		maxRefContentWidth = 0;
		maxAuthorContentWidth = 0;
		maxDateContentWidth = 0;
		maxShaContentWidth = 0;
	}
	const pageRefWidth = refContentWidth(
		newCommits,
		measureTextWidth,
		displaySettings,
	);
	if (pageRefWidth > maxRefContentWidth) {
		maxRefContentWidth = pageRefWidth;
	}

	const pageAuthorWidth = authorContentWidth(newCommits, measureTextWidth);
	if (pageAuthorWidth > maxAuthorContentWidth) {
		maxAuthorContentWidth = pageAuthorWidth;
	}

	if (newCommits.length > 0 && maxDateContentWidth === 0) {
		maxDateContentWidth = dateContentWidth(measureTextWidth);
	}
	if (newCommits.length > 0 && maxShaContentWidth === 0) {
		maxShaContentWidth = shaContentWidth(measureTextWidth);
	}
}

const userSizedWidth = $derived(
	[...userSizedColumns]
		.filter((column) => columnVisibility[column])
		.reduce((total, column) => total + columnWidths[column], 0),
);

// Every fit is laid out by one effect because they share one budget, which
// separate writers of the same object cannot do. It writes columnWidths, so it
// reads it untracked; the user widths it leaves room for arrive through
// userSizedWidth, which changes only when those widths do.
$effect(() => {
	const fitted = SIZED_COLUMNS.filter(
		(column) => columnVisibility[column] && !userSizedColumns.has(column),
	);
	const fits = shareBudget({
		wanted: {
			ref: maxRefContentWidth || DEFAULT_WIDTHS.ref,
			graph: graphTargetWidth(maxColumns, displaySettings.laneWidth),
			diff: DEFAULT_WIDTHS.diff,
			author: maxAuthorContentWidth || DEFAULT_WIDTHS.author,
			date: maxDateContentWidth || DEFAULT_WIDTHS.date,
			sha: maxShaContentWidth || DEFAULT_WIDTHS.sha,
		},
		fitted,
		rowWidth,
		reserved: userSizedWidth + messageReserve(columnVisibility),
		messageFit: messageFit(columnVisibility),
		floors,
	});

	columnWidths = { ...untrack(() => columnWidths), ...fits };
});

let stashOids = $state<Set<string>>(new Set());

interface SearchQuery {
	readonly path: string;
	readonly text: string;
	readonly wantsFirstMatch: () => boolean;
}

interface SearchRead {
	readonly query: SearchQuery;
	readonly revision: number;
}

let searchOpen = $state(false);
let searchText = $state("");
let searchQuery = $state.raw<SearchQuery>();
let searchActivation = $state.raw<{ readonly query: SearchQuery }>();
let pendingSearch = $state.raw<SearchRead>();
let searchAnswer = $state.raw<{
	readonly read: SearchRead;
	readonly results: readonly SearchResult[];
}>();
let searchCurrentIndex = $state(0);
let pendingMatchStep: { index: number; isCurrent: () => boolean } | undefined;

const lastSearchAnswer = $derived(
	searchQuery?.path === repoPath && searchAnswer?.read.query === searchQuery
		? searchAnswer
		: undefined,
);
const graphCurrentForSearch = $derived(
	cachedGraphRevision === undefined || cachedGraphRevision <= graphRevision,
);
const searchResults = $derived(
	tabActive &&
		graphCurrentForSearch &&
		lastSearchAnswer?.read.revision === graphRevision
		? lastSearchAnswer.results
		: undefined,
);
// While revalidating, the old order only interprets Next and Previous. Their
// target must appear in the new answer before it can select or scroll.
const stepResults = $derived(
	searchResults ??
		(pendingSearch && tabActive && graphCurrentForSearch
			? lastSearchAnswer?.results
			: undefined),
);
const searchMatchOids = $derived(new Set(searchResults?.map((r) => r.oid)));
const searchCurrentOid = $derived(
	searchResults?.[searchCurrentIndex]?.oid ?? null,
);
const searchDimmingActive = $derived(searchMatchOids.size > 0);

// Review selection state. The shared rune owns the reviews: one reviews-changed
// subscription, one membership Set for every surface. There is no session state
// any more — the rail follows the ACTIVE REVIEW's commit set, and the review
// gestures are always available because a gesture with no active review creates
// one (this is NOT the panel-open flag, A1).
const reviewOids = $derived(reviewComments?.oids ?? EMPTY_OIDS);
// Transient D-01 range base — set by "Set as review base", cleared after the
// range is added or cancelled, and whenever the active review changes.
let pendingBase = $state<string | null>(null);

async function loadStashMap() {
	const path = repoPath;
	try {
		const stashes = await safeInvoke<StashEntry[]>("list_stashes", {
			path,
		});
		if (!graphActive || path !== repoPath) return;
		stashOids = new Set(stashes.map((stash) => stash.oid));
	} catch {
		if (graphActive && path === repoPath) stashOids = new Set();
	}
}

const stashMapRefresh = createCoalescedTask(scheduler, loadStashMap);

function resizeColumn(
	column: keyof ColumnWidths,
	requested: number,
	ceiling = Number.POSITIVE_INFINITY,
) {
	const width = Math.max(floors[column], Math.min(ceiling, requested));
	if (width === columnWidths[column]) return false;

	if (!userSizedColumns.has(column))
		userSizedColumns = new Set([...userSizedColumns, column]);
	columnsSizedSinceMount.add(column);
	columnWidths = { ...columnWidths, [column]: width };

	return true;
}

function startColumnResize(
	column: keyof ColumnWidths,
	edge: ColumnEdge,
	e: MouseEvent,
) {
	e.preventDefault();
	const startX = e.clientX;
	const startWidth = columnWidths[column];
	const ceiling = columnCeiling(column, edge);
	let moved = false;

	function onMouseMove(ev: MouseEvent) {
		const growth = EDGES[edge].growth * (ev.clientX - startX);
		if (resizeColumn(column, startWidth + growth, ceiling)) moved = true;
	}

	function onMouseUp() {
		window.removeEventListener("mousemove", onMouseMove);
		window.removeEventListener("mouseup", onMouseUp);
		if (!moved) return;

		storeUserWidths();
	}

	window.addEventListener("mousemove", onMouseMove);
	window.addEventListener("mouseup", onMouseUp);
}

function stepColumn(
	column: keyof ColumnWidths,
	edge: ColumnEdge,
	delta: number,
) {
	const width = columnWidths[column] + EDGES[edge].growth * delta;
	if (resizeColumn(column, width, columnCeiling(column, edge)))
		storeUserWidths();
}

/**
 * The widest a drag or a key may make a column. One held to the row's end
 * widens at its leading edge into Message, and that edge stops where Message
 * reaches its floor: past it the fits would yield instead, and the column would
 * grow away from the pointer rather than under it. A column left of Message has
 * no ceiling, and neither has any column while the list is unmeasured.
 */
function columnCeiling(
	column: keyof ColumnWidths,
	edge: ColumnEdge,
): number | undefined {
	if (edge === "trailing" || rowWidth <= 0) return undefined;

	const messageRoom = rowWidth - tableMinWidth(columnWidths, columnVisibility);
	return columnWidths[column] + Math.max(0, messageRoom);
}

function storeUserWidths() {
	userWidthsRestored.then(() => {
		const widths: Partial<ColumnWidths> = {};
		for (const column of userSizedColumns)
			widths[column] = columnWidths[column];

		saveUserWidths(repoPath, widths);
	});
}

/** Hands a column back to its fit, the one way out of a user width, and the
 *  Graph column's lanes back to their start. */
function refitColumn(column: keyof ColumnWidths) {
	const remaining = new Set(userSizedColumns);
	remaining.delete(column);
	userSizedColumns = remaining;
	columnsSizedSinceMount.add(column);
	storeUserWidths();

	if (column === "graph") graphScrollX = 0;
}

/**
 * Message takes the space the sized columns leave, so the columns left of it
 * change width at their trailing edge and the ones right of it, held to the
 * row's end, at their leading edge. Each column's handle sits on the edge that
 * moves, and a drag or a key step along it widens the column by its distance
 * times `growth`.
 */
const EDGES = {
	trailing: { handle: "column", growth: 1 },
	leading: { handle: "column-leading", growth: -1 },
} as const;
type ColumnEdge = keyof typeof EDGES;

/**
 * Message has no entry in ColumnWidths and no resize handle of its own. The
 * union keeps that difference in the type rather than in a comparison against
 * the key.
 */
type ColumnHeader =
	| {
			key: keyof ColumnWidths;
			label: string;
			icon: Component;
			sized: true;
			edge: ColumnEdge;
	  }
	| { key: "message"; label: string; icon: Component; sized: false };

const columnLabels: ColumnHeader[] = [
	{
		key: "ref",
		label: "Branch/Tag",
		icon: GitBranch,
		sized: true,
		edge: "trailing",
	},
	{
		key: "graph",
		label: "Graph",
		icon: Network,
		sized: true,
		edge: "trailing",
	},
	{ key: "message", label: "Message", icon: MessageSquare, sized: false },
	{ key: "diff", label: "Diff", icon: FileDiff, sized: true, edge: "leading" },
	{ key: "author", label: "Author", icon: User, sized: true, edge: "leading" },
	{ key: "date", label: "Date", icon: Clock, sized: true, edge: "leading" },
	{ key: "sha", label: "SHA", icon: Hash, sized: true, edge: "leading" },
];

// InputDialog state
interface DialogConfig {
	title: string;
	confirmLabel: string;
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
		{ title: "Checkout Commit", kind: "warning", okLabel: "Checkout" },
	);
	if (!confirmed) return;
	try {
		await safeInvoke("checkout_commit", { path: repoPath, oid: commit.oid });
		showToast(checkedOutMessage(commit.short_oid), "success");
	} catch (e) {
		reportCheckoutFailure(e);
	}
}

function handleCreateBranch(commit: GraphCommit) {
	dialogConfig = {
		title: "Create Branch",
		confirmLabel: "Create branch",
		fields: [{ key: "name", label: "Branch name", required: true }],
		onsubmit: async (values) => {
			closeDialog();
			try {
				await safeInvoke("create_branch", {
					path: repoPath,
					name: values.name,
					fromOid: commit.oid,
				});
				showToast(checkedOutMessage(values.name), "success");
			} catch (e) {
				if (isCheckoutConflict(e)) {
					showToast(CHECKOUT_CONFLICT_MESSAGE, "error");
				} else {
					reportErrorToast(e, "Failed to create branch");
				}
			}
		},
	};
}

function handleCreateTag(commit: GraphCommit) {
	dialogConfig = {
		title: "Create Tag",
		confirmLabel: "Create tag",
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
				reportErrorToast(e, "Failed to create tag");
			}
		},
	};
}

async function handleCherryPick(commit: GraphCommit) {
	try {
		await safeInvoke("cherry_pick", { path: repoPath, oid: commit.oid });
	} catch (e) {
		// A conflict stops the pick in progress, as a conflicted merge stops: the
		// banner and the conflicted files carry it from there, so it is no error.
		if (isTrunkError(e) && e.code === "conflict_state") return;
		if (isTrunkError(e) && e.code === "cherry_pick_empty") {
			showToast(
				`HEAD already has the changes in ${commit.short_oid} "${commit.summary}", so there was nothing to cherry-pick.`,
				"success",
			);
			return;
		}
		reportErrorToast(e, "Cherry-pick failed.");
	}
}

async function handleRevert(commit: GraphCommit) {
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
		const conclusion = await safeInvoke<Conclusion>("revert_continue", {
			path: repoPath,
			message: msg,
		});
		if (conclusion === "skipped")
			showToast(
				"Nothing was left to commit, so the revert ended without a commit.",
				"success",
			);
	} catch (e) {
		// A conflicted revert stops in progress, as a conflicted pick does.
		if (isTrunkError(e) && e.code === "conflict_state") return;
		if (isTrunkError(e) && e.code === "revert_empty") {
			showToast(
				`HEAD already undoes the changes in ${commit.short_oid} "${commit.summary}", so there was nothing to revert.`,
				"success",
			);
			return;
		}
		reportErrorToast(e, "Revert failed.");
	}
}

async function copyMessage(commit: GraphCommit) {
	const detail = await safeInvoke<CommitDetail>("get_commit_detail", {
		path: repoPath,
		oid: commit.oid,
	});
	await copyText(detail.message.trimEnd(), commit.summary);
}

const loadedHead = $derived(commits.find((c) => c.is_head));
const checkedOutBranch = $derived(
	loadedHead === undefined
		? headBranch
		: loadedHead.refs.find((r) => r.ref_type === "LocalBranch" && r.is_head)
				?.short_name,
);

async function handleReset(
	commit: GraphCommit,
	mode: "soft" | "mixed" | "hard",
) {
	const moving =
		checkedOutBranch === undefined ? "HEAD" : forDisplay(checkedOutBranch);
	const labels: Record<typeof mode, string> = {
		soft: `Soft reset keeps your files as they are. The difference from ${commit.short_oid} shows as staged, and unstaged changes stay unstaged.`,
		mixed: "Mixed reset keeps every change, unstaged.",
		hard: `Hard reset discards your uncommitted changes to tracked files and deletes new files you staged but never committed. Neither can be recovered. Untracked files stay. It leaves ${moving} with only the history of ${commit.short_oid}.`,
	};
	const confirmed = await ask(
		`Reset ${moving} to ${commit.short_oid} "${forDisplay(commit.summary)}"?\n\n${labels[mode]}`,
		{
			title: `Reset (${mode})`,
			kind: mode === "hard" ? "warning" : "info",
			okLabel: "Reset",
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
		reportErrorToast(e, "Reset failed.");
	}
}

function handleMergeBranch(branch: string) {
	return mergeBranch({
		repoPath,
		branch,
		openMessageEditor: onopenmessageeditor,
	});
}

function handleRebaseBranch(ontoBranch: string) {
	return rebaseBranch({ repoPath, ontoBranch });
}

async function showCommitContextMenu(e: MouseEvent, commit: GraphCommit) {
	e.preventDefault();
	const { Menu, MenuItem, PredefinedMenuItem, Submenu } = await nativeMenu();

	// Determine if merge/rebase options should be shown
	const clickedBranch = commit.refs.find(
		(r) => r.ref_type === "LocalBranch" && !r.is_head,
	);
	const headCommit = commits.find((c) => c.is_head);
	const mergeRebaseItems: (
		| Awaited<ReturnType<typeof MenuItem.new>>
		| Awaited<ReturnType<typeof PredefinedMenuItem.new>>
	)[] = [];
	if (clickedBranch && checkedOutBranch) {
		mergeRebaseItems.push(
			await MenuItem.new({
				text: `Merge ${clickedBranch.short_name} into ${checkedOutBranch}`,
				action: () => {
					handleMergeBranch(clickedBranch.name).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: `Rebase ${checkedOutBranch} onto ${clickedBranch.short_name}`,
				action: () => {
					handleRebaseBranch(clickedBranch.name).catch(() => {});
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
		);
	}

	// Fast-forward (only when HEAD is on a branch and commit is not HEAD and not a
	// stash), enabled only where git can move the branch forward to the commit.
	const fastForwardItems: (
		| Awaited<ReturnType<typeof MenuItem.new>>
		| Awaited<ReturnType<typeof PredefinedMenuItem.new>>
	)[] = [];
	if (headCommit && checkedOutBranch && !commit.is_stash && !commit.is_head) {
		fastForwardItems.push(
			await MenuItem.new({
				text: `Fast-forward ${checkedOutBranch} to here`,
				enabled: canFastForward(commits, {
					head: headCommit.oid,
					target: commit.oid,
				}),
				action: async () => {
					try {
						await safeInvoke("fast_forward_to", {
							path: repoPath,
							targetOid: commit.oid,
						});
					} catch (e) {
						reportErrorToast(e, "Fast-forward failed");
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
	if (checkedOutBranch && !commit.is_stash && !commit.is_head) {
		interactiveRebaseItems.push(
			await MenuItem.new({
				text: "Interactive Rebase...",
				// Off HEAD's first-parent line, the listing spans a divergent
				// branch, and git would silently move the checked-out branch onto
				// it. From a merge, the range holds that merge, which the backend
				// refuses.
				enabled: commit.in_head_chain && !commit.is_merge,
				action: () => {
					onopenrebaseeditor?.({ kind: "commit", oid: commit.oid });
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
		);
	}

	// Compare (TRUNK-1): the context-menu fallback for the cmd-click gesture.
	const compareItems: (
		| Awaited<ReturnType<typeof MenuItem.new>>
		| Awaited<ReturnType<typeof PredefinedMenuItem.new>>
	)[] = [];
	if (selectedCommitOid && selectedCommitOid !== commit.oid) {
		const baseOid = selectedCommitOid;
		compareItems.push(
			await MenuItem.new({
				text: "Compare with selected commit",
				action: () => {
					scrollSequence += 1;
					oncomparecommits?.(baseOid, commit.oid);
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
		);
	}

	// Review selection items (D-01 range gesture + D-06 Add/Remove toggle).
	// Always injected: "Add to review" creates the active review when the repo
	// has none, the same way a comment submit does, so there is nothing to gate
	// on. NO `enabled: !commit.is_merge` gate — merges ARE selectable (D-08),
	// unlike the Cherry-pick/Revert items below.
	const reviewItems: (
		| Awaited<ReturnType<typeof MenuItem.new>>
		| Awaited<ReturnType<typeof PredefinedMenuItem.new>>
	)[] = [];
	{
		const inSession = reviewOids.has(commit.oid);
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
						reportErrorToast(e, "Failed to update review");
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
							reportErrorToast(e, "Failed to seed range");
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
			...compareItems,
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
					copyMessage(commit).catch((e: unknown) =>
						reportErrorToast(e, "Could not copy the message."),
					);
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

async function showStashContextMenu(e: MouseEvent, commit: GraphCommit) {
	e.preventDefault();
	const { Menu, MenuItem } = await nativeMenu();
	if (!stashOids.has(commit.oid)) return;
	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Pop",
				action: () => {
					void popStash(repoPath, commit.oid);
				},
			}),
			await MenuItem.new({
				text: "Apply",
				action: () => {
					void applyStash(repoPath, commit.oid);
				},
			}),
			await MenuItem.new({
				text: "Drop",
				action: () => {
					void dropStash(repoPath, {
						oid: commit.oid,
						message: commit.summary,
					});
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

async function handleDeleteBranch(branchName: string) {
	try {
		const outcome = await deleteBranch(repoPath, branchName);
		if (outcome.kind === "declined") return;
		showToast(outcome.report, "success");
	} catch (e) {
		reportErrorToast(e, "Failed to delete branch");
	}
}

function handleRenameBranch(branchName: string) {
	dialogConfig = {
		title: "Rename Branch",
		confirmLabel: "Rename branch",
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
			await renameBranch(repoPath, { from: branchName, to: values.name });
		},
	};
}

// --- Unified ref handlers (used by both pill and overflow ref) ---

// `name` is the fully-qualified ref and is what every DWIM-resolving sink gets:
// a bare shorthand is resolved against refs/tags first, so a tag named
// `origin/feature` captures every action aimed at that branch pill. `shortName`
// is for display and for the commands that re-qualify it themselves.
interface RefInfo {
	name: string;
	shortName: string;
	refType: RefType;
	isHead: boolean;
}

function refFromPill(pill: OverlayRefPill): RefInfo {
	return {
		name: pill.name,
		shortName: pill.label,
		refType: pill.refType,
		isHead: pill.isHead,
	};
}

function refFromLabel(ref: RefLabel): RefInfo {
	return {
		name: ref.name,
		shortName: ref.short_name,
		refType: ref.ref_type,
		isHead: ref.is_head,
	};
}

async function checkoutLocalBranch(name: string): Promise<string> {
	await safeInvoke<void>("checkout_branch", {
		path: repoPath,
		branchName: name,
	});
	return name;
}

function checkoutRemoteBranch(ref: RefInfo): Promise<string> {
	return safeInvoke<string>("checkout_remote_branch", {
		path: repoPath,
		remoteRef: ref.name,
	});
}

function checksOutOnDoubleClick(refType: RefType): boolean {
	return refType === "LocalBranch" || refType === "RemoteBranch";
}

async function handleRefCheckout(e: MouseEvent, ref: RefInfo) {
	e.preventDefault();
	e.stopPropagation();
	if (ref.isHead) return;
	try {
		const branch =
			ref.refType === "RemoteBranch"
				? await checkoutRemoteBranch(ref)
				: await checkoutLocalBranch(ref.shortName);
		showToast(checkedOutMessage(branch), "success");
	} catch (e) {
		reportCheckoutFailure(e);
	}
}

async function showRefContextMenu(e: MouseEvent, ref: RefInfo) {
	e.preventDefault();
	e.stopPropagation();
	const { Menu, MenuItem, PredefinedMenuItem } = await nativeMenu();

	if (ref.refType === "LocalBranch") {
		const menu = await Menu.new({
			items: [
				...(!ref.isHead
					? [
							await MenuItem.new({
								text: `Checkout ${ref.shortName}`,
								action: () => {
									handleRefCheckout(e, ref);
								},
							}),
							await PredefinedMenuItem.new({ item: "Separator" }),
						]
					: []),
				...(!ref.isHead && checkedOutBranch
					? [
							await MenuItem.new({
								text: `Merge ${ref.shortName} into ${checkedOutBranch}`,
								action: () => {
									handleMergeBranch(ref.name).catch(() => {});
								},
							}),
							await MenuItem.new({
								text: `Rebase ${checkedOutBranch} onto ${ref.shortName}`,
								action: () => {
									handleRebaseBranch(ref.name).catch(() => {});
								},
							}),
							await MenuItem.new({
								text: `Interactive Rebase ${ref.shortName}...`,
								action: () => {
									onopenrebaseeditor?.({
										kind: "branch",
										refName: ref.name,
									});
								},
							}),
							await PredefinedMenuItem.new({ item: "Separator" }),
						]
					: []),
				...(await branchRemoteMenuGroup(
					repoPath,
					ref.shortName,
					ref.isHead,
					remoteState,
				)),
				await MenuItem.new({
					text: "Rename…",
					action: () => {
						handleRenameBranch(ref.shortName);
					},
				}),
				await PredefinedMenuItem.new({ item: "Separator" }),
				await MenuItem.new({
					text: "Delete",
					enabled: !ref.isHead,
					action: () => {
						handleDeleteBranch(ref.shortName).catch(() => {});
					},
				}),
			],
		});
		await menu.popup();
	} else if (ref.refType === "RemoteBranch") {
		const menu = await Menu.new({
			items: [
				await MenuItem.new({
					text: `Checkout ${ref.shortName}`,
					action: () => {
						handleRefCheckout(e, ref);
					},
				}),
				...(checkedOutBranch
					? [
							await PredefinedMenuItem.new({ item: "Separator" }),
							await MenuItem.new({
								text: `Merge ${ref.shortName} into ${checkedOutBranch}`,
								action: () => {
									handleMergeBranch(ref.name).catch(() => {});
								},
							}),
							await MenuItem.new({
								text: `Rebase ${checkedOutBranch} onto ${ref.shortName}`,
								action: () => {
									handleRebaseBranch(ref.name).catch(() => {});
								},
							}),
							await MenuItem.new({
								text: `Interactive Rebase ${ref.shortName}...`,
								action: () => {
									onopenrebaseeditor?.({
										kind: "branch",
										refName: ref.name,
									});
								},
							}),
						]
					: []),
				await PredefinedMenuItem.new({ item: "Separator" }),
				await MenuItem.new({
					text: "Delete",
					enabled: !remoteState.isRunning,
					action: () => {
						void deleteRemoteBranch(repoPath, ref.shortName, remoteState);
					},
				}),
			],
		});
		await menu.popup();
	} else if (ref.refType === "Tag") {
		const remotes = await listRemotes(repoPath);
		await popupTagMenu(
			tagMenuEntriesOf(ref.shortName, remotes, remoteState.isRunning),
			(action) => {
				void runTagAction(repoPath, ref.shortName, action, remoteState);
			},
		);
	}
}

function openMenuIfOnHeader(e: MouseEvent) {
	if (!(e.target instanceof Node) || !headerRef?.contains(e.target)) return;

	void showHeaderContextMenu(e);
}

async function showHeaderContextMenu(e: MouseEvent) {
	e.preventDefault();
	const { Menu, CheckMenuItem } = await nativeMenu();
	const items = await Promise.all(
		columnLabels.map((col) => {
			const checked = columnVisibility[col.key];
			return CheckMenuItem.new({
				text: col.label,
				checked,
				enabled: col.key !== "message",
				action: () => {
					if (!graphActive || col.key === "message") return;
					void changeColumnVisibility(col.key, !checked).catch(() => {
						showToast("Could not save column visibility", "error");
					});
				},
			});
		}),
	);
	const menu = await Menu.new({ items });
	await menu.popup();
}

const displayItems = $derived(withWipRow(commits, wipCount, wipMessage));

// Report the display list + pagination state whenever they change (loadMore
// extending the tail included, since it replaces `commits`), so the parent can
// derive commit nav itself.
$effect(() => {
	oncommitschange?.(displayItems, hasMore);
});

const laneColor = (idx: number) => `var(--lane-${idx % 8})`;
/** A ghost pill's text fades through its colour, not an opacity: WebKit paints
 *  HTML that has a layer of its own inside a foreignObject without the page
 *  zoom, off its pill (src/markup-classes.test.ts guards it). */
const pillTextColor = (pill: OverlayRefPill) =>
	pill.isGhost
		? `color-mix(in oklch, ${laneColor(pill.colorIndex)} 50%, transparent)`
		: laneColor(pill.colorIndex);

// SVG-specific display settings — identical to displaySettings except rowHeight
// uses the measured value so that overlay paths, dots, and pills don't drift
// from the DOM rows at non-100% browser zoom levels.
const svgSettings = $derived({ ...displaySettings, rowHeight: svgRowHeight });
const geometry = $derived(makePathContext(svgSettings));

// A dot slides along its horizontal line to stay inside the panned viewport
// (bead-on-a-string). `graphX` is the dot's unscrolled centre — from the node
// for the dots layer, from the pill for its connector.
function stickyDotX(graphX: number, colWidth: number, scroll: number): number {
	const halfLane = displaySettings.laneWidth / 2;

	return Math.max(
		halfLane,
		Math.min(colWidth - 2 * COLUMN_PADDING_X - halfLane, graphX - scroll),
	);
}

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

/** Row the pointer is over, for the lane's branch name. Naming a branch is a
 *  property of the hovered commit, so it needs no viewport state. */
let hoveredRow = $state<number | null>(null);
const hoveredLaneRef = $derived(
	hoveredRow === null ? undefined : laneRefForRow(displayItems, hoveredRow),
);

/** The hovered row's lane name, as a real ref pill so it renders through the
 *  pill path rather than a second lookalike. Built from a copy of the hovered
 *  commit carrying that ref, which is what a pill is: a ref on a row. */
const ghostPill = $derived.by(() => {
	if (hoveredRow === null || !hoveredLaneRef) return undefined;

	const commit = displayItems[hoveredRow];
	if (!commit || commit.refs.length > 0) return undefined;

	const node = graphData.nodes[hoveredRow];
	if (!node) return undefined;

	// buildRefPillData indexes commits by node.y, so both arrays have to stay in
	// the row coordinates the rest of the pipeline uses. Passing one node and a
	// one-element list looks equivalent and is not: the lookup misses and nothing
	// is built. Give it the real list with only the hovered row carrying the ref.
	const withLaneRef = displayItems.with(hoveredRow, {
		...commit,
		refs: [hoveredLaneRef],
	});
	const [pill] = buildRefPillData(
		[node],
		withLaneRef,
		columnWidths.ref,
		measureTextWidth,
		svgSettings,
	);
	return pill ? { ...pill, rowIndex: hoveredRow, isGhost: true } : undefined;
});
const pillClose = createOwnedTimer();

function pillMouseEnter(pill: OverlayRefPill) {
	pillClose.cancel();
	if (pill.overflowCount > 0 || pill.truncatedLabel !== pill.label) {
		hoveredPill = pill;
	}
}

function pillMouseLeave() {
	pillClose.arm(() => {
		hoveredPill = null;
	}, 50);
}

function overlayMouseEnter() {
	pillClose.cancel();
}

function overlayMouseLeave() {
	hoveredPill = null;
}

// A press on a row, a pill or a ref of the hover list would leave focus there.
// A row unmounts once it scrolls out of the rendered window, taking focus and the
// arrow keys with it, and a pill takes no key, so the list takes it.
function keepFocusOnList() {
	containerRef?.focus();
}

// One reader follows the latest rendered window. Missing OIDs are attempted
// once per revision/activation so an unreadable row cannot starve later rows.
async function readVisibleStats() {
	while (
		graphActive &&
		tabActive &&
		columnVisibilityResolved &&
		columnVisibility.diff
	) {
		const wipRows = wipCount > 0 ? 1 : 0;
		const start = Math.max(0, renderedStart - wipRows);
		const end = Math.min(commits.length, Math.max(0, renderedEnd - wipRows));
		let first = start;
		while (
			first < end &&
			(commitStats.has(commits[first].oid) ||
				attemptedStats.has(commits[first].oid))
		)
			first++;
		if (first >= end) return;

		let stop = first + 1;
		while (
			stop < Math.min(end, first + 32) &&
			!commitStats.has(commits[stop].oid) &&
			!attemptedStats.has(commits[stop].oid)
		)
			stop++;

		const count = stop - first;
		const revision = graphRevision;

		for (const commit of commits.slice(first, first + count))
			attemptedStats.add(commit.oid);
		try {
			const stats = await safeInvoke<Record<string, DiffStat>>(
				"get_commit_stats",
				{
					path: repoPath,
					offset: first,
					count,
					revision,
				},
			);
			if (!graphActive || revision !== graphRevision) return;

			const next = new Map(commitStats);
			for (const [oid, stat] of Object.entries(stats)) next.set(oid, stat);

			commitStats = next;
		} catch (error) {
			if (!graphActive) return;

			if (isTrunkError(error) && error.code === "graph_changed") {
				requestRead(cachedGraphRefresh);
				return;
			}

			throw error;
		}
	}
}

const visibleStatsRefresh = createCoalescedTask(scheduler, readVisibleStats);

// WIP row stat (uncached, recomputed each refresh). Gated only on column
// visibility and active tab — NOT on wipCount: repo-changed bumps refreshSignal synchronously
// but refreshes wipCount via an async get_dirty_counts, so wipCount still reads
// 0 during a clean→dirty refresh. The working tree is already in its new state,
// so get_wip_diff_stats returns the correct value; when wipCount catches up and
// the WIP row appears, its stat is already loaded.
async function readWipStats() {
	if (!graphActive || !tabActive) return;
	if (!columnVisibilityResolved || !columnVisibility.diff) {
		wipDiffStat = undefined;
		return;
	}
	try {
		const stat = await safeInvoke<DiffStat>("get_wip_diff_stats", {
			path: repoPath,
		});
		// Drop the response if a newer fetch won (rapid working-tree edits) or the
		// column was toggled off in flight — honor "hidden column does zero work",
		// matching the visible history reader.
		if (!graphActive || !columnVisibility.diff) return;
		wipDiffStat = stat;
	} catch {
		if (graphActive) wipDiffStat = undefined;
	}
}

const wipStatsRefresh = createCoalescedTask(scheduler, readWipStats);

function requestWipStats(): void {
	requestRead(wipStatsRefresh);
}

onDestroy(() => {
	graphActive = false;
	wipStatsRefresh.dispose();
	stashMapRefresh.dispose();
	visibleStatsRefresh.dispose();
});

/** Joins the page in flight or starts one at the current offset. A visible
 *  target below that page extends it, with up to a page of context. */
function loadMore(through?: string): PageRequest | undefined {
	// Blocks every caller -- the mount effect below, VirtualList's own
	// infinite-scroll trigger (which fires immediately on an empty first render,
	// independent of that effect), and scrollToOid -- until BranchSidebar's
	// stored-visibility read has resolved and the view's repo-changed listener is
	// registered. Otherwise this pages against open_repo's unfiltered default,
	// which is the paint TRUNK-128 fixed, or reads a graph whose next change no
	// listener hears (TRUNK-494).
	if (!graphActive || !pagesReadable || !hasMore) return;
	if (pendingPage) return pendingPage;

	error = null;
	pendingPage = { through, result: fetchPage(through) };
	return pendingPage;
}

/** A shared jump that finds no row leaves the ordinary page still to load. */
async function loadNextPage(): Promise<void> {
	let page = loadMore();
	while ((await page?.result) === "target_absent") page = loadMore();
}

async function fetchPage(through: string | undefined): Promise<PageResult> {
	let seq = refreshSeq;
	try {
		// The replacement is already available in the cache. Wait for its prefix
		// before choosing an offset and revision for another page.
		while (depthRecovery) await depthRecovery.result;
		if (!graphActive) return "stale";
		if (!hasMore) return "target_absent";

		seq = refreshSeq;
		const response = await safeInvoke<GraphResponse | null>(
			"get_commit_graph",
			{
				path: repoPath,
				offset,
				...(offset > 0 ? { revision: graphRevision } : {}),
				...(through === undefined ? {} : { through }),
			},
		);
		// Drop it rather than append: these rows were laid out under the old
		// graph, and offset now indexes the new one. The viewport re-triggers a
		// load for whatever it still needs.
		if (!graphActive || seq !== refreshSeq) return "stale";
		if (response === null) return "target_absent";

		graphRevision = response.revision;
		markGraphReady(response);
		commits = commits.concat(response.commits);
		maxColumns = response.max_columns;
		updateContentWidths(response.commits);
		offset += response.commits.length;
		if (response.commits.length < BATCH) hasMore = false;
		return "appended";
	} catch (e) {
		// A page that failed for the graph we no longer show is not this graph's
		// error, and reporting it would bury the rebuilt view under a stale bar.
		if (!graphActive || seq !== refreshSeq) return "stale";
		if (isTrunkError(e) && e.code === "graph_changed") {
			await cachedGraphRefresh.run();
			return "stale";
		}
		error = errorMessage(e, "Failed to load commits");
		return "failed";
	} finally {
		// Release the slot in the same turn as the append so effects observing
		// the new rows can start another page.
		if (graphActive) pendingPage = undefined;
	}
}

/** Scroll the graph to center the row for the given OID.
 * Loads additional history batches if the commit is not yet loaded.
 * Called from App.svelte via bind:this (GRAPH-03). */
export async function scrollToOid(
	oid: string,
	isStillRequested: () => boolean = () => true,
): Promise<void> {
	const sequence = ++scrollSequence;
	const isCurrent = () =>
		graphActive && sequence === scrollSequence && isStillRequested();
	if (!isCurrent()) return;

	let idx = displayItems.findIndex((c) => c.oid === oid);

	let attempts = 0;
	while (idx < 0 && attempts < PAGE_ATTEMPT_BUDGET) {
		const page = loadMore(oid);
		if (!page) return;

		const result = await page.result;
		if (!isCurrent()) return;

		await tick();
		if (!isCurrent()) return;

		idx = displayItems.findIndex((c) => c.oid === oid);
		if (result === "failed" || result === "stale") attempts += 1;
		else if (page.through === oid) break;
	}

	if (!isCurrent() || idx < 0 || !listRef) return;

	// VirtualList has no 'center' alignment, so the offset is computed here.
	const viewport = listViewport();
	if (viewport) {
		viewport.scrollTo({
			top: centredRowTop(idx, {
				rowHeight: svgRowHeight,
				viewportHeight: viewport.clientHeight,
			}),
			behavior: "smooth",
		});
	} else {
		// Fallback: use VirtualList's scroll with 'auto' alignment
		await listRef.scroll({ index: idx, smoothScroll: true, align: "auto" });
	}
}

/** How many rows are loaded, so a rebuild can answer with the same depth rather
 *  than replacing the list with page one. Called from RepoView via bind:this. */
export function loadedRows(): number {
	return offset;
}

/** Adopts the prefix returned by a visibility change. */
export function showGraph(response: GraphResponse): void {
	void applyGraph(response);
	requestWipStats();
}

function applyGraph(
	response: GraphResponse,
	requestedDepth = BATCH,
	readSequence = refreshSeq,
) {
	// A visibility command and a refresh can return in either order. The
	// backend revision orders their snapshots, including a prefix still being
	// expanded. The request sequence breaks ties within the same revision.
	const newest = Math.max(graphRevision, depthRecovery?.revision ?? 0);
	if (
		!graphActive ||
		response.revision < newest ||
		(response.revision === newest && readSequence !== refreshSeq)
	)
		return;

	const depth = offset;
	const received = response.commits.length;
	const reachedEnd = received < Math.max(BATCH, requestedDepth);
	if (received >= depth || reachedEnd) {
		replaceGraph(response, requestedDepth);
		return;
	}

	// A page landed after the replacement's depth was chosen. Stop appending
	// old pages and get one complete prefix from the cache before painting it.
	const seq = ++refreshSeq;
	const recovery = recoverGraphDepth(response, depth, seq).finally(() => {
		if (depthRecovery?.result === recovery) depthRecovery = undefined;
	});
	depthRecovery = {
		revision: response.revision,
		sequence: seq,
		result: recovery,
	};
	return recovery;
}

async function recoverGraphDepth(
	response: GraphResponse,
	depth: number,
	seq: number,
): Promise<void> {
	let expanded: GraphResponse;
	try {
		expanded = await readCachedPrefix(depth);
	} catch (e) {
		if (!graphActive || depthRecovery?.sequence !== seq) return;
		replaceGraph(response, BATCH);
		error = errorMessage(e, "Failed to load commits");
		return;
	}
	if (!graphActive || depthRecovery?.sequence !== seq) return;

	// Sample at installation, so a scroll or jump while either read was in
	// flight owns the viewport. The row may have moved in the new graph.
	const viewport = listViewport();
	const top = viewport?.scrollTop ?? 0;
	const index = Math.floor(top / svgRowHeight);
	const anchor = displayItems[index]?.oid;
	const navigation = scrollSequence;

	replaceGraph(expanded, depth);
	if (!viewport || !anchor || top === 0) return;

	const newIndex = displayItems.findIndex((row) => row.oid === anchor);
	if (newIndex < 0 || newIndex === index) return;

	const installed = refreshSeq;
	await tick();
	if (
		graphActive &&
		installed === refreshSeq &&
		navigation === scrollSequence &&
		viewport.scrollTop === top
	) {
		viewport.scrollTo({ top: top + (newIndex - index) * svgRowHeight });
	}
}

function replaceGraph(response: GraphResponse, requestedDepth: number): void {
	depthRecovery = undefined;
	refreshSeq += 1;
	graphRevision = response.revision;
	markGraphReady(response);
	// Swap data atomically -- old data stays visible until this assignment
	commits = response.commits;
	maxColumns = response.max_columns;
	updateContentWidths(response.commits, true);
	offset = response.commits.length;
	hasMore = response.commits.length >= Math.max(BATCH, requestedDepth);
	error = null;
	// Keep immutable stats for rows still loaded, and read stats only for missing OIDs.
	const loadedOids = new Set(response.commits.map((commit) => commit.oid));
	commitStats = new Map(
		[...commitStats].filter(([oid]) => loadedOids.has(oid)),
	);
	attemptedStats = new Set();
}

function requestRead(task: CoalescedTask) {
	if (refreshImmediately) {
		void task
			.run()
			.catch((error: unknown) => console.error("Graph refresh failed", error));
	} else task.request();
}

async function readCachedGraph() {
	const seq = ++refreshSeq;
	const depth = offset;
	try {
		const response = await readCachedPrefix(depth);
		await applyGraph(response, depth, seq);
	} catch (e) {
		if (graphActive && seq === refreshSeq)
			error = errorMessage(e, "Failed to load commits");
	}
}

function readCachedPrefix(depth: number) {
	return safeInvoke<GraphResponse>("get_commit_graph", {
		path: repoPath,
		offset: 0,
		loaded: depth,
	});
}

const cachedGraphRefresh = createCoalescedTask(scheduler, readCachedGraph);
onDestroy(() => cachedGraphRefresh.dispose());

$effect(() => {
	if (
		!graphReady ||
		!tabActive ||
		!refVisibilityResolved ||
		cachedGraphRevision === undefined
	)
		return;
	const revision = cachedGraphRevision;
	untrack(() => {
		if (revision > graphRevision) requestRead(cachedGraphRefresh);
	});
});

$effect(() => {
	if (wipRefreshSignal !== undefined && wipRefreshSignal > 0) {
		untrack(() => {
			requestWipStats();
			requestRead(stashMapRefresh);
		});
	}
});

async function refreshGraph() {
	const seq = ++refreshSeq;
	const generation = refreshSignal ?? 0;
	const depth = offset;
	const worktree = Promise.all([wipStatsRefresh.run(), stashMapRefresh.run()]);
	try {
		const response = await safeInvoke<GraphResponse>("refresh_commit_graph", {
			path: repoPath,
			loaded: depth,
		});
		// The backend rejects retained captures. This success consumes only the
		// generation it started with, even if the graph pane has since unmounted.
		onrefreshconsumed?.(generation);
		await applyGraph(response, depth, seq);
	} catch (e) {
		if (!graphActive || seq !== refreshSeq) return;
		error = errorMessage(e, "Failed to load commits");
		// Keep old commits visible on error -- do NOT clear
	} finally {
		await worktree;
	}
}

const graphRefresh = createCoalescedTask(scheduler, refreshGraph);
onDestroy(() => graphRefresh.dispose());

// Waits on the parent's ref-visibility resolution before the first page load, so
// this never paints against open_repo's unfiltered default -- the backend has
// nothing stored for a path it has not seen yet, and BranchSidebar's read of the
// persisted set is an independent sibling effect with no ordering against this
// one otherwise (TRUNK-128). It waits on the view's repo-changed listener too, so
// a change reported after this read always reaches the graph (TRUNK-494).
$effect(() => {
	if (!pagesReadable) return;
	untrack(async () => {
		await loadNextPage();
		await stashMapRefresh.run();
		// Diff stats (visible rows + WIP) are driven by the visibility-resolution effect
		// below, so the column does zero stat work until the persisted visibility
		// is known.
	});
});

let readyReported = false;
$effect(() => {
	if (readyReported || loading || awaitingFirstGraph) return;
	readyReported = true;
	untrack(() => {
		void tick().then(() => {
			if (graphActive) onready?.();
		});
	});
});

// Persisted visibility, activation, data and the virtual list's measured range
// drive stats. Background tabs and hidden columns do not start requests.
$effect(() => {
	if (!columnVisibilityResolved) return;
	const active = tabActive && columnVisibility.diff;
	void renderedStart;
	void renderedEnd;
	void commits.length;
	void wipCount;
	untrack(() => {
		if (active && !statsWereActive) {
			attemptedStats = new Set();
			requestWipStats();
		}
		statsWereActive = active;
		if (active) requestRead(visibleStatsRefresh);
	});
});

// Clear the transient range base whenever the active review changes — the base
// names a commit in one review's set and means nothing in another's.
$effect(() => {
	void reviewComments?.activeReviewId;
	pendingBase = null;
});

// A repo-changed refresh (the file watcher, or a BranchSidebar action) reads the
// same backend snapshot open_repo does, so it is exposed to the identical
// unfiltered-default race this file's other gates close: a refresh that lands in
// the window before BranchSidebar's stored-visibility read resolves would repaint
// the hidden refs right back in. Waiting on refVisibilityResolved here means a
// refresh signalled during that window fires the moment the gate opens, rather
// than running unfiltered now or being dropped.
$effect(() => {
	if (!refVisibilityResolved) return;
	const generation = refreshSignal;
	untrack(() => {
		if (generation !== undefined && generation > consumedRefreshSignal)
			requestRead(graphRefresh);
	});
});

$effect(() => {
	// Only scroll once per mount (scrolledToHead guards against re-firing)
	if (scrolledToHead) return;
	if (!listRef) return;
	if (displayItems.length === 0) return;

	// in_head_chain, not is_head: a detached HEAD (mid-rebase, or after checking
	// out a sha) carries no is_head row, and the fallback below would then page
	// the entire history looking for one.
	const headIdx = displayItems.findIndex((c) => c.in_head_chain);
	if (headIdx >= 0) {
		scrolledToHead = true;
		tick().then(() => {
			const viewport = listViewport();
			if (viewport) {
				viewport.scrollTo({
					top: openingScrollTop(headIdx, {
						rowHeight: svgRowHeight,
						viewportHeight: viewport.clientHeight,
					}),
				});
			} else {
				void listRef?.scroll({
					index: headIdx,
					smoothScroll: false,
					align: "top",
				});
			}
		});
	} else if (untrack(() => hasMore)) {
		// HEAD not in current batch -- load the next batch so the effect re-fires with more commits.
		// untrack prevents hasMore from creating a reactive dependency here.
		untrack(() => void loadNextPage());
	} else {
		scrolledToHead = true;
	}
});

let searchBar = $state<SearchBar | null>(null);
export function openFind() {
	if (!tabActive) return;

	if (searchOpen) searchBar?.focusQuery();
	else searchOpen = true;
}

$effect(() => {
	const query = searchQuery;
	if (!tabActive || !query || query.path !== repoPath) return;

	// A graph replacement only changes the revision to read. Each tab return
	// starts a new activation so a scroll from the previous one stays canceled.
	const activate = () => {
		searchActivation = { query };
	};
	const timer = untrack(() => lastSearchAnswer)
		? undefined
		: setTimeout(activate, 200);
	if (timer === undefined) activate();
	return () => {
		clearTimeout(timer);
		searchActivation = undefined;
		pendingMatchStep = undefined;
	};
});

$effect(() => {
	const query = searchActivation?.query;
	const revision = graphRevision;
	if (
		!tabActive ||
		!graphReady ||
		!graphCurrentForSearch ||
		!query ||
		query !== searchQuery ||
		query.path !== repoPath ||
		untrack(() => searchResults !== undefined)
	)
		return;

	const read = { query, revision };
	pendingSearch = read;
	void readSearch(read);
	return () => {
		if (pendingSearch === read) pendingSearch = undefined;
	};
});

function isCurrentSearch(read: SearchRead): boolean {
	return (
		graphActive &&
		tabActive &&
		graphCurrentForSearch &&
		pendingSearch === read &&
		searchQuery === read.query &&
		repoPath === read.query.path &&
		graphRevision === read.revision
	);
}

async function readSearch(read: SearchRead): Promise<void> {
	const response = await safeInvoke<readonly SearchResult[]>("search_commits", {
		path: read.query.path,
		query: read.query.text,
		revision: read.revision,
	}).then(
		(results) => ({ results }),
		(error: unknown) => ({ error }),
	);
	if (!isCurrentSearch(read)) return;

	if ("error" in response) {
		if (
			isTrunkError(response.error) &&
			response.error.code === "graph_changed"
		) {
			await cachedGraphRefresh.run();
			if (!isCurrentSearch(read)) return;
		} else {
			reportErrorToast(response.error, "Could not search commits");
		}
		pendingSearch = undefined;
		pendingMatchStep = undefined;
		return;
	}

	pendingSearch = undefined;
	const step = pendingMatchStep;
	pendingMatchStep = undefined;
	const previous = lastSearchAnswer;
	const { results } = response;
	const steppedOid = step?.isCurrent()
		? previous?.results[step.index]?.oid
		: undefined;
	const steppedIndex = results.findIndex(({ oid }) => oid === steppedOid);
	const currentOid = previous?.results[searchCurrentIndex]?.oid;
	const currentIndex = results.findIndex(({ oid }) => oid === currentOid);
	searchAnswer = { read, results };
	searchCurrentIndex =
		steppedIndex >= 0
			? steppedIndex
			: currentIndex >= 0
				? currentIndex
				: Math.max(0, Math.min(searchCurrentIndex, results.length - 1));
	const match = results[searchCurrentIndex];
	if (
		match &&
		(steppedIndex >= 0 || (!previous && read.query.wantsFirstMatch()))
	)
		selectSearchResult(match.oid);
}

function snapshotSearchNavigation(): () => boolean {
	const sequence = scrollSequence;
	const isParentCurrent = snapshotNavigationIntent?.();

	return () => sequence === scrollSequence && (isParentCurrent?.() ?? true);
}

function selectSearchResult(oid: string) {
	const activation = searchActivation;
	const answer = searchAnswer;
	(oncommitnavigate ?? oncommitselect)?.(oid);
	const isParentCurrent = snapshotNavigationIntent?.();
	void scrollToOid(
		oid,
		() =>
			searchActivation === activation &&
			searchAnswer === answer &&
			searchCurrentOid === oid &&
			(isParentCurrent?.() ?? true),
	);
}

function handleSearchQueryChange(query: string) {
	searchText = query;
	searchAnswer = undefined;
	searchCurrentIndex = 0;
	const trimmed = query.trim();
	searchQuery = trimmed
		? {
				path: repoPath,
				text: trimmed,
				wantsFirstMatch: snapshotSearchNavigation(),
			}
		: undefined;
}

function stepSearch(direction: -1 | 1) {
	if (!stepResults?.length) return;

	const step = pendingMatchStep;
	const from = step?.isCurrent() ? step.index : searchCurrentIndex;
	const index = (from + direction + stepResults.length) % stepResults.length;
	if (searchResults) {
		searchCurrentIndex = index;
		selectSearchResult(searchResults[index].oid);
	} else {
		pendingMatchStep = { index, isCurrent: snapshotSearchNavigation() };
	}
}

function handleSearchClose() {
	searchOpen = false;
	handleSearchQueryChange("");
	containerRef?.focus();
}

function handleRowSelect(oid: string, mods?: SelectModifiers) {
	scrollSequence += 1;
	if (oid === "__wip__") onWipClick?.();
	else oncommitselect?.(oid, mods);
}

function rowsPerPage(): number {
	const height = listViewport()?.clientHeight ?? 0;
	return Math.max(1, Math.floor(height / svgRowHeight) - 1);
}

function handleKeydown(e: KeyboardEvent) {
	const chord = keyChord(e);
	if (!isGraphKey(chord)) return;
	if (focusInEditable(document.activeElement)) return;

	e.preventDefault();

	const items = displayItems;
	if (items.length === 0) return;

	// With no commit selected the staging panel shows the uncommitted changes, so
	// their row, which leads the list, is where the keys start from.
	const wipLeads = items[0]?.oid === "__wip__";
	const currentIdx =
		!navigationCommitOid && wipLeads
			? 0
			: items.findIndex((c) => c.oid === navigationCommitOid);

	const nextIdx = graphKeyTarget(
		chord,
		currentIdx,
		items.length,
		rowsPerPage(),
	);
	if (nextIdx === null) return;

	const commit = items[nextIdx];
	const sequence = ++scrollSequence;
	if (commit.oid === "__wip__") {
		onWipClick?.();
	} else {
		(oncommitnavigate ?? oncommitselect)?.(commit.oid);
	}

	tick().then(() => {
		if (sequence !== scrollSequence) return;

		const row = containerRef?.querySelector(
			`[data-original-index="${nextIdx}"]`,
		);
		if (row) {
			row.scrollIntoView({ block: "nearest" });
		} else {
			void listRef?.scroll({
				index: nextIdx,
				smoothScroll: false,
				align: "nearest",
			});
		}
	});
}

// Auto-focus the container on mount so keyboard nav works immediately, and again
// when the list comes back from under a diff or another tab. A list another pane
// covers takes no focus, which that pane's keys would otherwise lose.
$effect(() => {
	if (containerRef && tabActive) {
		tick().then(() => {
			if (
				tabActive &&
				(document.activeElement === document.body ||
					document.activeElement === null)
			) {
				containerRef?.focus();
			}
		});
	}
});
</script>

<div
	class="h-full overflow-hidden flex flex-col bg-surface outline-none"
	class:author-avatar-only={!authorShowsName(
		columnWidths.author,
		measureTextWidth,
	)}
	style:--column-ref-width="{columnWidths.ref}px"
	style:--column-graph-width="{columnWidths.graph}px"
	style:--column-diff-width="{columnWidths.diff}px"
	style:--column-author-width="{columnWidths.author}px"
	style:--column-date-width="{columnWidths.date}px"
	style:--column-sha-width="{columnWidths.sha}px"
	tabindex="0"
	role="listbox"
	aria-multiselectable="true"
	bind:this={containerRef}
	onkeydown={handleKeydown}
	oncontextmenu={openMenuIfOnHeader}
>
	<!-- Header row (always visible). Its cells sit in a scroller of their own inside
       the padding, as the list's rows do, so the two scroll the same distance. -->
	<div
		class="flex-shrink-0 h-bar bg-surface shadow-hairline text-callout font-semibold text-text"
		style:padding="0 {TABLE_INSET_X}px"
		bind:this={headerRef}
	>
		<div
			data-testid="column-header"
			class="flex items-center h-full overflow-hidden"
			use:syncTableScroll
		>
			{#each columnLabels as col (col.key)}
				{#if columnVisibility[col.key]}
					{#if col.sized}
						{@const width = columnWidths[col.key]}
						<div
							class="relative flex h-full flex-shrink-0 items-center whitespace-nowrap"
							data-column={col.key}
							style:padding="0 {COLUMN_PADDING_X}px"
							title={col.label}
						>
							<span class="flex min-w-0 overflow-hidden">
								{#if showsHeaderLabel(width, headerMins[col.key])}
									{col.label}
								{:else}
									<col.icon size={HEADER_ICON_WIDTH} aria-hidden="true" />
								{/if}
							</span>
							<Splitter
								variant={EDGES[col.edge].handle}
								aria-label="Resize {col.label} column"
								value={width}
								min={floors[col.key]}
								max={columnCeiling(col.key, col.edge)}
								onstep={(delta) => stepColumn(col.key, col.edge, delta)}
								onmousedown={(e) => startColumnResize(col.key, col.edge, e)}
								ondblclick={() => refitColumn(col.key)}
							/>
						</div>
					{:else}
						<div
							class="relative flex-1 overflow-hidden whitespace-nowrap"
							data-column={col.key}
							style:padding="0 {COLUMN_PADDING_X}px"
							style:min-width="{MESSAGE_FLOOR}px"
							title={col.label}
						>
							{col.label}
						</div>
					{/if}
				{/if}
			{/each}
		</div>
	</div>

	<!-- Content area (grows to fill remaining space) -->
	<div
		class="flex-1 overflow-hidden relative"
		style:padding="0 {TABLE_INSET_X}px"
		onwheel={panColumn}
	>
		{#if searchOpen}
			<SearchBar
				bind:this={searchBar}
				query={searchText}
				currentIndex={searchCurrentIndex}
				totalMatches={stepResults?.length ?? 0}
				searching={searchResults === undefined}
				onquerychange={handleSearchQueryChange}
				onnext={() => stepSearch(1)}
				onprev={() => stepSearch(-1)}
				onclose={handleSearchClose}
			/>
		{/if}

		{#if commits.length === 0 && (loading || awaitingFirstGraph)}
			<!-- Initial skeleton loading -->
			{#each { length: SKELETON_COUNT } as _}
				<div
					class="flex items-center gap-2 px-2 animate-pulse"
					style:height="{displaySettings.rowHeight}px"
				>
					<div
						class="skeleton-ref rounded-full flex-shrink-0 bg-border h-3"
					></div>
					<div
						class="skeleton-graph rounded flex-shrink-0 bg-border h-full"
					></div>
					<div class="rounded flex-1 bg-border h-3"></div>
				</div>
			{/each}
		{:else if commits.length === 0 && error}
			<!-- Initial load error -->
			<div class="error-banner m-4 rounded px-4 py-3 text-body">
				{error}
			</div>
		{:else}
			<!-- SVG overlay snippet - renders inside virtual list scroll container -->
			{#snippet graphOverlay(
				contentHeight: number,
				visibleStart: number,
				visibleEnd: number,
			)}
				{@const visible = getVisibleOverlayElements(
					paths,
					graphData.nodes,
					visibleStart,
					visibleEnd,
					pillData,
				)}
				{@const graphColWidth = columnVisibility.graph
					? columnWidths.graph
					: naturalGraphWidth}
				{@const scrollX = Math.min(graphScrollX, maxGraphScrollX)}
				<svg
					role="presentation"
					class="absolute top-0 left-0 pointer-events-none z-1"
					class:search-dim={searchDimmingActive}
					width={graphStart + Math.max(graphColWidth, naturalGraphWidth)}
					height={contentHeight}
				>
					<!-- Layers A and B live in the Graph column's band; with the column
               hidden CommitRow drops that cell and the Message text slides into
               the band, so anything painted here lands on top of it. -->
					{#if columnVisibility.graph}
						{@const railBandWidth = graphColWidth - 2 * COLUMN_PADDING_X}
						<!-- A dot whose lane sits past an edge is clamped inward, away from
               the lane its rail still runs down, so the rail shows past the dot
               on the far side. The hug band hides the rails behind those dots.

               It grows with the hug rather than appearing at full width: its
               width is how far the lanes overrun the edge, so it arrives as the
               first dot starts being pulled in and stops at a dot's width plus
               padding, which is all a pile of hugged dots ever covers. Below
               that the rails would be cut before the dots that hide them.

               Measured from the column and the lane count, never from the dots
               on screen: reading it from the rendered rows made it appear and
               vanish as the list scrolled, and the rails were clipped to
               whatever it happened to be at the time. -->
						{@const hugMax = 2 * displaySettings.dotRadius + COLUMN_PADDING_X}
						<!-- Where the fade reaches zero, measured in from the band's edge. A
               hugged dot sits half a lane in, and the rail carries on half a
               radius past its centre before it is gone: enough to read as the
               line ending under the dot, not so much that it stops short of it
               and leaves a gap. -->
						{@const fadeEndInset =
							displaySettings.laneWidth / 2 - displaySettings.dotRadius / 2}
						{@const hugRight = Math.min(
							hugMax,
							Math.max(0, naturalGraphWidth - scrollX - railBandWidth),
						)}
						{@const hugLeft = Math.min(hugMax, Math.max(0, scrollX))}
						<!-- Once the hug takes the whole band there is no stretch of rail left
               to fade from, and a gradient across it leaves the rail opaque at
               one edge: the faint line that still showed through a fully
               collapsed column. Nothing is drawable there, so nothing is drawn. -->
						{@const railsHidden = railBandWidth - hugLeft - hugRight <= 0}
						<!-- GRAPH-02: clip graph content to column width -->
						<defs>
							<clipPath id="graph-clip-{clipScope}">
								<rect
									x={graphStart + COLUMN_PADDING_X}
									y="0"
									width={railBandWidth}
									height={contentHeight}
								/>
							</clipPath>
							<!-- A dot clamped to an edge is where its line ends, but the rail
                 behind it keeps drawing and shows past the dot on the far side.
                 Each lane colour gets a gradient that fades it out across the
                 hug band, so the rail dies under the dots rather than stopping
                 at a hard line short of them.

                 Painted on each rail's own stroke. A mask over the layer would
                 be rasterized at the full scroll height, which is the whole
                 history rather than the rows on screen. -->
							{#if hugRight > 0 || hugLeft > 0}
								{#each { length: 8 } as _, lane}
									<!-- Authored in the rails group's own space: userSpaceOnUse
                     resolves against the element that references the gradient,
                     and that group carries the column offset and the pan. Using
                     absolute coordinates here put the fade a whole column to
                     the right of the band, where it never touched a rail. -->
									<linearGradient
										id="rail-fade-{lane}-{clipScope}"
										gradientUnits="userSpaceOnUse"
										x1={scrollX}
										x2={scrollX + railBandWidth}
									>
										{#if hugLeft > 0}
											<stop
												offset="0"
												stop-color="var(--lane-{lane})"
												stop-opacity="0"
											/>
											<stop
												offset={fadeEndInset / railBandWidth}
												stop-color="var(--lane-{lane})"
												stop-opacity="0"
											/>
											<stop
												offset={hugLeft / railBandWidth}
												stop-color="var(--lane-{lane})"
												stop-opacity="1"
											/>
										{/if}
										{#if hugRight > 0}
											<stop
												offset={(railBandWidth - hugRight) / railBandWidth}
												stop-color="var(--lane-{lane})"
												stop-opacity="1"
											/>
											<stop
												offset={(railBandWidth - fadeEndInset) / railBandWidth}
												stop-color="var(--lane-{lane})"
												stop-opacity="0"
											/>
											<stop
												offset="1"
												stop-color="var(--lane-{lane})"
												stop-opacity="0"
											/>
										{/if}
									</linearGradient>
								{/each}
							{/if}
							<!-- The dots' own band. A dot is clamped to a lane centre, so half of
                 it sits outside the rail band at either edge; cutting it there
                 would slice every hugged dot in half. It is the rail band grown
                 by a radius, which still ends inside the column's padding. -->
							<clipPath id="graph-dot-clip-{clipScope}">
								<rect
									x={graphStart + COLUMN_PADDING_X - displaySettings.dotRadius}
									y="0"
									width={railBandWidth + 2 * displaySettings.dotRadius}
									height={contentHeight}
								/>
							</clipPath>
						</defs>
						<!-- GRAPH-02: Layer A — rails + connections, scrolled and clipped.
               Translated left by scrollX to pan through lanes. -->
						<g clip-path="url(#graph-clip-{clipScope})">
							<g
								class="overlay-paths"
								transform="translate({graphStart +
									COLUMN_PADDING_X -
									scrollX}, 0)"
							>
								{#each railsHidden ? [] : visible.paths as path}
									<path
										d={path.d}
										fill="none"
										stroke={hugRight > 0 || hugLeft > 0
											? `url(#rail-fade-${path.colorIndex % 8}-${clipScope})`
											: laneColor(path.colorIndex)}
										stroke-width={displaySettings.edgeStroke}
										stroke-linecap="round"
										stroke-dasharray={path.dashed ? `${DASH} ${DASH}` : "none"}
									/>
								{/each}
							</g>
						</g>
						<!-- GRAPH-02: Layer B — dots with "sticky" X clamping.
               Dots slide along their horizontal line to stay visible in the viewport.
               Viewport spans graph coordinates [scrollX, scrollX + graphColWidth].
               Dots clamp to viewport edges (bead-on-a-string effect). -->
						<g clip-path="url(#graph-dot-clip-{clipScope})">
							<g
								class="overlay-dots"
								transform="translate({graphStart + COLUMN_PADDING_X}, 0)"
							>
								{#each visible.dots as node}
									{@const clampedCx = stickyDotX(
										geometry.cx(node.x),
										graphColWidth,
										scrollX,
									)}
									<!-- A stroke straddles the path it is drawn on, so half of it falls
                   outside. Every stroked marker is inset by half its stroke, which
                   makes all four kinds occupy the same width as the filled dot:
                   without it a merge read 14px against a solid 12 and sat visibly
                   off the line its lane shares. -->
									{@const strokeInset = displaySettings.edgeStroke / 2}
									{#if node.isWip}
										<path
											d={wipMarkerPath(
												clampedCx,
												geometry.cy(node.y),
												displaySettings.dotRadius - strokeInset,
											)}
											fill="none"
											stroke={laneColor(node.colorIndex)}
											stroke-width={displaySettings.edgeStroke}
										/>
									{:else if node.isStash}
										<rect
											x={clampedCx - displaySettings.dotRadius + strokeInset}
											y={geometry.cy(node.y) -
												displaySettings.dotRadius +
												strokeInset}
											width={displaySettings.dotRadius * 2 -
												displaySettings.edgeStroke}
											height={displaySettings.dotRadius * 2 -
												displaySettings.edgeStroke}
											fill="none"
											stroke={laneColor(node.colorIndex)}
											stroke-width={displaySettings.edgeStroke}
											stroke-dasharray="{DASH} {DASH}"
										/>
									{:else if node.isMerge}
										<circle
											cx={clampedCx}
											cy={geometry.cy(node.y)}
											r={displaySettings.dotRadius -
												displaySettings.mergeStroke / 2}
											fill="var(--color-surface)"
											stroke={laneColor(node.colorIndex)}
											stroke-width={displaySettings.mergeStroke}
										/>
									{:else}
										<circle
											cx={clampedCx}
											cy={geometry.cy(node.y)}
											r={displaySettings.dotRadius}
											fill={laneColor(node.colorIndex)}
										/>
									{/if}
								{/each}
							</g>
						</g>
					{/if}
					{#if columnVisibility.ref}
						<g class="overlay-pills">
							<clipPath id="ref-clip-{clipScope}">
								<rect
									x="0"
									y="0"
									width={Math.max(0, graphStart - COLUMN_PADDING_X)}
									height={contentHeight}
								/>
							</clipPath>
							{#each ghostPill
								? [...visible.pills, ghostPill]
								: visible.pills as pill}
								{@const badgeWidth = overflowBadgeWidth(pill.overflowCount)}
								{@const pillTop = pill.y - PILL_HEIGHT / 2}
								{@const badgeX = pill.x + pill.width + PILL_GAP}
								{@const badgeTop = pill.y - BADGE_HEIGHT / 2}
								{@const pillGroupRightX =
									pill.x +
									pill.width +
									(pill.overflowCount > 0 ? PILL_GAP + badgeWidth : 0)}
								{@const pillIsBranch = checksOutOnDoubleClick(pill.refType)}
								<!-- Connector from the pill group's right edge (past the +N badge) to the commit dot, plus a short stub linking the named pill to the badge. The badge sits between the two segments with no line behind it, so it reads as solid yet stays connected to the pill (uses sticky X position, scroll-adjusted) -->
								{#if columnVisibility.graph}
									{@const stickyDotCx = stickyDotX(
										pill.dotCx,
										graphColWidth,
										scrollX,
									)}
									{@const connectorEndX =
										graphStart +
										COLUMN_PADDING_X +
										stickyDotCx -
										(pill.isHollow ? displaySettings.dotRadius : 0)}
									<line
										x1={pillGroupRightX}
										y1={pill.y}
										x2={connectorEndX}
										y2={pill.dotCy}
										stroke={laneColor(pill.commitColorIndex)}
										stroke-width={pill.isHead
											? displaySettings.pillStroke * 2
											: displaySettings.pillStroke}
										opacity={pill.isGhost ? 0.45 : pill.isRemoteOnly ? 0.67 : 1}
										class:non-head={pill.isNonHead && !pill.isRemoteOnly}
									/>
									{#if pill.overflowCount > 0}
										<!-- Stub linking the named pill to the +N badge, filling the gap so they read as one connected group. -->
										<line
											x1={pill.x + pill.width}
											y1={pill.y}
											x2={badgeX}
											y2={pill.y}
											stroke={laneColor(pill.commitColorIndex)}
											stroke-width={pill.isHead
												? displaySettings.pillStroke * 2
												: displaySettings.pillStroke}
											opacity={pill.isGhost
												? 0.45
												: pill.isRemoteOnly
													? 0.67
													: 1}
											class:non-head={pill.isNonHead && !pill.isRemoteOnly}
										/>
									{/if}
								{/if}

								<!-- What the pill draws stays inside the Branch/Tag column; only its
                     connector reaches the lanes. -->
								<g clip-path="url(#ref-clip-{clipScope})">
									<!-- Capsule rect -->
									<rect
										x={pill.x}
										y={pillTop}
										width={pill.width}
										height={PILL_HEIGHT}
										rx={PILL_HEIGHT / 2}
										ry={PILL_HEIGHT / 2}
										fill={laneColor(pill.colorIndex)}
										fill-opacity={pill.isGhost
											? 0.06
											: pill.isRemoteOnly
												? 0.1
												: 0.14}
										stroke={laneColor(pill.colorIndex)}
										stroke-opacity={pill.isGhost ? 0.25 : 0.5}
									/>

									<!-- Icon rendered directly in SVG at a fixed position (no CSS layout) -->
									{#if PILL_ICONS[pill.refType]}
										{@const PillIcon = PILL_ICONS[pill.refType]}
										<g
											transform="translate({pill.x + PILL_PADDING_X}, {pill.y -
												ICON_WIDTH / 2})"
											opacity={pill.isGhost ? 0.45 : 0.9}
										>
											<PillIcon size={ICON_WIDTH} />
										</g>
									{/if}

									<!-- Text in its own foreignObject sized to exactly the canvas-measured text width.
                     No flex layout — icon is positioned separately so the text width is unambiguous. -->
									<foreignObject
										x={pill.x + PILL_PADDING_X + ICON_WIDTH + ICON_GAP}
										y={pillTop}
										width={Math.ceil(pill.textWidth)}
										height={PILL_HEIGHT}
									>
										<span
											class="block font-sans whitespace-nowrap overflow-hidden"
											style:line-height="{PILL_HEIGHT}px"
											style:color={pillTextColor(pill)}
											style:font-size="{PILL_FONT_SIZE}px"
											style:font-weight={pill.isHead ? 700 : 500}
											>{pill.truncatedLabel}</span
										>
									</foreignObject>

									<!-- Overflow +N badge -->
									{#if pill.overflowCount > 0}
										{@const badgeText = `+${pill.overflowCount}`}
										<rect
											x={badgeX}
											y={badgeTop}
											width={badgeWidth}
											height={BADGE_HEIGHT}
											rx={BADGE_HEIGHT / 2}
											ry={BADGE_HEIGHT / 2}
											fill={laneColor(pill.colorIndex)}
											fill-opacity="0.14"
											stroke={laneColor(pill.colorIndex)}
											stroke-opacity={pill.isGhost ? 0.25 : 0.5}
										/>
										<foreignObject
											x={badgeX}
											y={badgeTop}
											width={badgeWidth}
											height={BADGE_HEIGHT}
										>
											<span
												class="block text-center whitespace-nowrap font-sans font-medium"
												style:color={pillTextColor(pill)}
												style:font-size="{BADGE_FONT_SIZE}px"
												style:line-height="{BADGE_HEIGHT}px"
												>{badgeText}</span
											>
										</foreignObject>
									{/if}

									<!-- The pointer's targets, over everything the pill draws. A ghost
                     pill has none, since it names a lane and not a ref on its row. -->
									{#if !pill.isGhost}
										<foreignObject
											x={pill.x}
											y={pillTop}
											width={pill.width}
											height={PILL_HEIGHT}
										>
											<HitArea
												aria-label={pill.label}
												shape="pill"
												cursor={pillIsBranch ? "pointer" : "context-menu"}
												onfocus={keepFocusOnList}
												onmouseenter={() => pillMouseEnter(pill)}
												onmouseleave={pillMouseLeave}
												oncontextmenu={(e) =>
													showRefContextMenu(e, refFromPill(pill))}
												ondblclick={pillIsBranch
													? (e: MouseEvent) =>
															handleRefCheckout(e, refFromPill(pill))
													: undefined}
											/>
										</foreignObject>
										{#if pill.overflowCount > 0}
											<foreignObject
												x={badgeX}
												y={badgeTop}
												width={badgeWidth}
												height={BADGE_HEIGHT}
											>
												<HitArea
													aria-label="{pill.label} and {pill.overflowCount} more"
													shape="pill"
													onfocus={keepFocusOnList}
													onmouseenter={() => pillMouseEnter(pill)}
													onmouseleave={pillMouseLeave}
												/>
											</foreignObject>
										{/if}
									{/if}
								</g>
							{/each}
						</g>
					{/if}
				</svg>
				{#if hoveredPill && columnVisibility.ref}
					{#if hoveredPill.overflowCount > 0}
						<!-- Multi-ref expansion: shows all refs vertically -->
						<div
							role="menu"
							tabindex="-1"
							aria-label="Refs on this commit"
							class="absolute rounded shadow-lg bg-surface-raised border border-border py-1 px-2 z-50 pointer-events-auto"
							style:left="{hoveredPill.x}px"
							style:top="{hoveredPill.y - PILL_HEIGHT / 2}px"
							onfocusin={keepFocusOnList}
							onmouseenter={overlayMouseEnter}
							onmouseleave={overlayMouseLeave}
						>
							{#each hoveredPill.allRefs as ref}
								{@const ri = refFromLabel(ref)}
								{@const refIsBranch = checksOutOnDoubleClick(ri.refType)}
								<div
									class="rounded text-small font-medium whitespace-nowrap hover:bg-hover -mx-1 h-target"
									style:color="var(--lane-{ref.color_index % 8})"
								>
									<HitArea
										role="menuitem"
										aria-label={ref.short_name}
										shape="row"
										cursor={refIsBranch ? "pointer" : "context-menu"}
										oncontextmenu={(e) => showRefContextMenu(e, ri)}
										ondblclick={refIsBranch
											? (e: MouseEvent) => handleRefCheckout(e, ri)
											: undefined}
									>
										<span class="flex items-center gap-1 px-1">
											{#if PILL_ICONS[ref.ref_type]}
												{@const RefIcon = PILL_ICONS[ref.ref_type]}
												<RefIcon size={10} class="flex-shrink-0 opacity-85" />
											{/if}
											{ref.short_name}
										</span>
									</HitArea>
								</div>
							{/each}
						</div>
					{:else}
						{@const pill = hoveredPill}
						{@const pillIsBranch = checksOutOnDoubleClick(pill.refType)}
						<!-- Truncated single-ref: width-only expansion showing full label -->
						<div
							role="menu"
							tabindex="-1"
							aria-label="Full name of this ref"
							class="absolute rounded-full flex items-center z-50 pointer-events-auto"
							style:left="{pill.x}px"
							style:top="{pill.y - PILL_HEIGHT / 2}px"
							style:height="{PILL_HEIGHT}px"
							style:background="color-mix(in oklch, var(--lane-{pill.colorIndex %
								8}) 14%, var(--color-surface-raised))"
							style:box-shadow="inset 0 0 0 1px color-mix(in oklch, var(--lane-{pill.colorIndex %
								8}) 50%, transparent)"
							onfocusin={keepFocusOnList}
							onmouseenter={overlayMouseEnter}
							onmouseleave={overlayMouseLeave}
						>
							<HitArea
								role="menuitem"
								aria-label={pill.label}
								shape="pill"
								cursor={pillIsBranch ? "pointer" : "context-menu"}
								oncontextmenu={(e) => showRefContextMenu(e, refFromPill(pill))}
								ondblclick={pillIsBranch
									? (e: MouseEvent) => handleRefCheckout(e, refFromPill(pill))
									: undefined}
							>
								<span
									class="flex items-center gap-1 text-small font-medium whitespace-nowrap"
									style:font-weight={pill.isHead ? 700 : 500}
									style:color="var(--lane-{pill.colorIndex % 8})"
									style:padding="0 {PILL_PADDING_X}px"
								>
									{#if PILL_ICONS[pill.refType]}
										{@const HoverIcon = PILL_ICONS[pill.refType]}
										<HoverIcon size={10} class="flex-shrink-0 opacity-90" />
									{/if}
									{pill.label}
								</span>
							</HitArea>
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
					onLoadMore={() => void loadNextPage()}
					onrangechange={(start, end) => {
						renderedStart = start;
						renderedEnd = end;
					}}
					loadMoreThreshold={50}
					{hasMore}
					overlaySnippet={graphOverlay}
					minContentWidth={tableMinWidth(columnWidths, columnVisibility)}
				>
					{#snippet renderItem(commit, index)}
						<CommitRow
							{commit}
							onselect={handleRowSelect}
							oncontextmenu={handleRowContextMenu}
							onenter={() => (hoveredRow = index)}
							onleave={() => (hoveredRow = null)}
							onfocus={keepFocusOnList}
							{columnVisibility}
							selected={commit.oid === "__wip__"
								? uncommittedChangesShown
								: commit.oid === selectedCommitOid ||
									compareOids.has(commit.oid)}
							rowHeight={displaySettings.rowHeight}
							isSearchMatch={searchMatchOids.has(commit.oid)}
							isCurrentMatch={commit.oid === searchCurrentOid}
							isSearchActive={searchDimmingActive}
							inSession={reviewOids.has(commit.oid)}
							isPendingBase={pendingBase === commit.oid}
							commentCount={commentCountFor(commit.oid)}
							commentTally={commentTallyFor(commit.oid)}
							wipStats={commit.oid === "__wip__" ? wipStats : undefined}
							onfocusdraftsummary={commit.oid === "__wip__"
								? onFocusDraftSummary
								: undefined}
							draftSummaryFocused={commit.oid === "__wip__" &&
								draftSummaryFocused}
							diffStat={commit.oid === "__wip__"
								? wipDiffStat
								: commitStats.get(commit.oid)}
							{messageScrollX}
						/>
					{/snippet}
				</VirtualList>
			{/key}

			<!-- Mid-scroll skeleton (more commits loading) -->
			{#if loading && commits.length > 0}
				{#each { length: 3 } as _}
					<div
						class="flex items-center gap-2 animate-pulse"
						style:height="{displaySettings.rowHeight}px"
					>
						<div
							class="skeleton-ref rounded-full flex-shrink-0 bg-border h-3"
						></div>
						<div
							class="skeleton-graph rounded flex-shrink-0 bg-border h-full"
						></div>
						<div class="rounded flex-1 bg-border h-3"></div>
					</div>
				{/each}
			{/if}

			<!-- Mid-scroll error + retry -->
			{#if error && commits.length > 0}
				<div class="flex items-center gap-3 px-4 py-2">
					<span class="error-text text-body">{error}</span>
					<Button onclick={() => void loadNextPage()}>Retry</Button>
				</div>
			{/if}
		{/if}
	</div>
</div>

{#if dialogConfig}
	<InputDialog
		title={dialogConfig.title}
		confirmLabel={dialogConfig.confirmLabel}
		fields={dialogConfig.fields}
		onsubmit={dialogConfig.onsubmit}
		oncancel={closeDialog}
	/>
{/if}

<style>
/* Each sized column is one width, set on the list root and read here by the
   header cell and the row cell alike, so neither can keep a width of its own. */
[role="listbox"] :global([data-column="ref"]) {
	width: var(--column-ref-width);
}
[role="listbox"] :global([data-column="graph"]) {
	width: var(--column-graph-width);
}
[role="listbox"] :global([data-column="diff"]) {
	width: var(--column-diff-width);
}
[role="listbox"] :global([data-column="author"]) {
	width: var(--column-author-width);
}
[role="listbox"] :global([data-column="date"]) {
	width: var(--column-date-width);
}
[role="listbox"] :global([data-column="sha"]) {
	width: var(--column-sha-width);
}
/* Hidden rather than removed, so the name still overruns its cell and the
   avatar's hover still names the author. */
.author-avatar-only :global([data-author-name]) {
	visibility: hidden;
}
/* GRAPH-01: visible padding above first and below last commit row */
:global(.virtual-list-viewport) {
	padding-top: var(--space-2);
	padding-bottom: var(--space-2);
	box-sizing: border-box;
}
.error-banner {
	background: var(--color-danger-bg);
	border: 1px solid var(--color-danger-border);
	color: var(--color-danger);
}
.error-text {
	color: var(--color-danger);
}

/* The overlay steps back while a search is open so the matched rows read first. */
.search-dim {
	opacity: var(--opacity-search-dim);
}

/* A connector to a branch that is not HEAD is drawn a shade darker than its
   lane, so the checked-out branch's connector is the one that stands out. */
.non-head {
	filter: brightness(0.75);
}

/* The loading skeleton's stand-ins for a ref pill and a graph lane. */
.skeleton-ref {
	width: calc(16 * var(--u));
}
.skeleton-graph {
	width: calc(8 * var(--u));
}
</style>

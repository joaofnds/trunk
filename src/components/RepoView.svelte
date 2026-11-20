<script lang="ts">
import { listen } from "@tauri-apps/api/event";
import { onDestroy, tick, untrack } from "svelte";
import { buildTree, collectFilePaths } from "../lib/build-tree.js";
import {
	type CoalescedTask,
	createCoalescedTask,
} from "../lib/coalesced-task.js";
import { buildCommentCounts } from "../lib/comment-counts.js";
import {
	commentsForView,
	type PanelDiffKind,
	type ViewDescriptor,
} from "../lib/comment-matching.js";
import { CommitFormSession } from "../lib/commit-form-session.svelte.js";
import { computeCommitNav } from "../lib/commitNav.js";
import {
	type ComparePair,
	cmdClick,
	plainClick,
	type SelectionState,
	type SelectModifiers,
	shiftClick,
	swapCompare,
} from "../lib/compare-select.js";
import { resolveDiffTarget } from "../lib/diff-in-view.js";
import type { DiffPreferences } from "../lib/diff-preferences.svelte.js";
import { errorMessage, reportErrorToast } from "../lib/error-report.js";
import { listsSameFiles } from "../lib/file-status.js";
import { inertWhile } from "../lib/inert-while.js";
import { safeInvoke } from "../lib/invoke.js";
import { focusInEditable } from "../lib/keyboard.js";
import {
	type LoadedDiff,
	loadedDiffFor,
	loadedModeFor,
	modeFor,
	noLoadedDiffs,
	shownDiff,
	withLoadedDiff,
} from "../lib/loaded-diffs.js";
import { createOwnedTimer } from "../lib/owned-timer.js";
import { span } from "../lib/perf.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import {
	requestRepoChange,
	subscribeToRepoChanges,
} from "../lib/repo-change-subscription.js";
import { getDraft } from "../lib/review-comment-actions.js";
import { createReviewComments } from "../lib/review-comments.svelte.js";
import {
	createReviewEditorStore,
	type ReviewComposerTarget,
	type ReviewEditorHost,
	type ReviewEditorStore,
} from "../lib/review-editors.svelte.js";
import {
	ALL_THREADS,
	badgeToneForThread,
	combineReviewTone,
	countBadgeThreads,
} from "../lib/review-filter.js";
import { createReviewSession } from "../lib/review-session.svelte.js";
import { initials, provideReviewer } from "../lib/reviewer.svelte.js";
import { sameData } from "../lib/same-data.js";
import { getScheduler } from "../lib/scheduler.js";
import { createSidePanes } from "../lib/side-panes.svelte.js";
import {
	type CommitDraft,
	clearCommitDraft,
	clearReviewUpdateSnapshot,
	flushCommitDraftForUpdate,
	flushReviewComposerForUpdate,
	getCommitDraft,
	getReviewUpdateSnapshot,
	getTreeViewEnabled,
	setCommitDraft,
	setLeftPaneWidth,
	setRightPaneWidth,
	setTreeViewEnabled,
} from "../lib/store.js";
import { diffTakesComments } from "../lib/takes-comments.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	CommitDetail as CommitDetailType,
	ContentMode,
	DiffRequestOptions,
	DiffStat,
	FileDiff,
	GraphCommit,
	GraphResponse,
	RebaseBase,
	RebaseTodo,
	RebaseTodoItem,
	RefsResponse,
	ReviewFilter,
	ReviewTone,
	Side,
	Thread,
	ThreadFilter,
	TrackedFile,
	WipStats,
	WorkingTreeStatus,
} from "../lib/types.js";
import Splitter from "../lib/ui/Splitter.svelte";
import { registerUpdateParticipant } from "../lib/updates-context.js";
import { isUpdateFrozen } from "../lib/updates-lifecycle.js";
import { restoreReviewUpdateComposer } from "../lib/updates-review.js";
import BranchSidebar from "./BranchSidebar.svelte";
import CommitGraph from "./CommitGraph.svelte";
import FileFinder from "./FileFinder.svelte";
import LazyView from "./LazyView.svelte";
import MessageEditor from "./MessageEditor.svelte";
import PushRecoveryPrompt from "./PushRecoveryPrompt.svelte";
import StagingPanel from "./StagingPanel.svelte";

interface DirtyCounts {
	staged: number;
	unstaged: number;
	conflicted: number;
	modified: number;
	new: number;
	deleted: number;
	renamed: number;
	typechange: number;
}

interface Props {
	onready?: () => void;
	onrecoveryready?: (error: string | null) => void;
	ondirtychange?: (counts: { staged: number; unstaged: number }) => void;
	repoPath: string;
	remoteState: RemoteState;
	leftPaneWidth: number;
	leftPaneCollapsed: boolean;
	rightPaneWidth: number;
	rightPaneCollapsed: boolean;
	// Whether this is the active tab. Visited tabs stay mounted, so window-global
	// menu events (search-toggle) need it to tell themselves apart.
	tabActive: boolean;
	// Whether the window has focus, so the review panel can tell the user is
	// looking at the replies it shows. Required, so a mount that forgets it
	// fails the type check instead of never marking a reply seen.
	windowFocused: boolean;
	// Review mode is toggled by the OS menu (review-toggle) at the App level so the
	// global event only affects the active tab; App passes the flag down per tab.
	reviewActive: boolean;
	// Hides review threads from the graph and the diff. Owned by App.
	reviewThreadsHidden?: boolean;
	// The global thread filter, owned by App. The review panel always shows
	// what it picks, and the graph and the diff do unless threads are hidden.
	threadFilter?: ThreadFilter;
	// Asks App to change the panel's filter, from its presets and state counts.
	onthreadfilterchange?: (filter: ThreadFilter) => void;
	contentMode: ContentMode;
	oncontentmodechange: (mode: ContentMode) => void;
	diffPreferences: DiffPreferences;
	// Reports whether the active review tab's center pane is showing the review PANEL
	// (vs. a diff) up to App, so the Toolbar Review button shares one source of truth
	// with what's rendered: it's lit only when the panel shows, and a click while a
	// diff is up returns to the panel rather than ending the session (260531-l02e).
	onreviewpanelshowingchange: (showing: boolean) => void;
	// Reports both Toolbar badge counts up to App: `view` is the current view's
	// comment count (show-comments toggle badge), `total` is the whole session's
	// (Review button badge). The predicate (which view's count to report) lives
	// here because RepoView owns the view state. Optional so the gate stays green
	// until App provides it.
	oncommentcountschange?: (counts: {
		view: number;
		total: number;
		viewTone: ReviewTone | null;
		totalTone: ReviewTone | null;
	}) => void;
	// The commit the graph shows as HEAD, or null before it shows one. The
	// toolbar aims Undo at it, so Undo takes back the commit the user sees.
	onshownheadchange?: (oid: string | null) => void;
	onleftpanecollapsedchange: (collapsed: boolean) => void;
	onrightpanecollapsedchange: (collapsed: boolean) => void;
	onleftpanewidthchange: (width: number) => void;
	onrightpanewidthchange: (width: number) => void;
	// Review mode hides the graph, so showing a commit there means leaving it.
	onleavereview: () => void;
}

let {
	repoPath,
	remoteState,
	leftPaneWidth,
	leftPaneCollapsed,
	rightPaneWidth,
	rightPaneCollapsed,
	tabActive,
	windowFocused,
	reviewActive,
	reviewThreadsHidden = false,
	threadFilter = ALL_THREADS,
	onthreadfilterchange,
	contentMode,
	oncontentmodechange,
	diffPreferences,
	onreviewpanelshowingchange,
	oncommentcountschange,
	onshownheadchange,
	onleftpanecollapsedchange,
	onrightpanecollapsedchange,
	onleftpanewidthchange,
	onrightpanewidthchange,
	onleavereview,
	onready,
	onrecoveryready,
	ondirtychange,
}: Props = $props();

// What the graph and the diff show: nothing while review threads are hidden.
const reviewFilter = $derived<ReviewFilter>(
	reviewThreadsHidden ? "none" : threadFilter,
);

const scheduler = getScheduler();
let repoViewActive = true;

const repoNotification = createCoalescedTask(scheduler, async () => {
	handleRefresh();
});

// The rendered-markdown view refetches off this token rather than through the
// selected-diff task, so it needs its own coalesced task to stay behind the
// same path gate as the rest of the open file's work (TRUNK-232).
const displayedDiffNotification = createCoalescedTask(scheduler, async () => {
	diffRefreshToken += 1;
});

// Center-pane Review-mode state (UI-SPEC:133, LOCKED to the center pane). The
// rune owns rightPaneMode (panel|diff); jumpTo composes the existing
// selection/scroll machinery via injected deps. App's review-toggle flag syncs
// into the rune so only the active tab enters review mode.
const reviewSession = createReviewSession();

// The single reactive comments source for this tab (plan §3). Lifted here so
// ReviewPanel, DiffPanel/diff views, and CommitDetail all read one store with
// one reviews-changed subscription. repoPath is stable for this tab's RepoView
// instance (App keys it by tab.id), so the one-time capture is intentional;
// the rune owns its own listener teardown via destroy().
const reviewComments = createReviewComments(
	untrack(() => repoPath),
	scheduler,
);
$effect(() => reviewComments.setActive(tabActive));
const reviewEditors: ReviewEditorStore = createReviewEditorStore();

// The review draws the reviewer by their initials, read once from the name the
// repository signs commits with. A repo with no name set, or a read that fails,
// leaves the person glyph, which is all the initials would replace.
let reviewerName = $state<string | null>(null);
void safeInvoke<string | null>("get_user_name", {
	path: untrack(() => repoPath),
})
	.then((name) => {
		reviewerName = name ?? null;
	})
	.catch(() => {});
provideReviewer({
	get initials() {
		return reviewerName === null ? null : initials(reviewerName);
	},
});
onDestroy(() => reviewComments.destroy());

const editorSessionFor = (host: ReviewEditorHost) => (thread: Thread) =>
	reviewEditors.thread(thread.review_id, host, thread.id);
const editorSessionForPanelThread = editorSessionFor("review-panel");
const editorSessionForCommitNoteThread = editorSessionFor("commit-notes");
const editorSessionForDiffThread = editorSessionFor("diff");
const editorDraftFor = (
	reviewId: string | null,
	surface: string,
	target: string,
) => reviewEditors.draft(reviewId, surface, target);
const editorNoteSessionFor = (reviewId: string | null, surface: string) =>
	reviewEditors.note(reviewId, surface);

$effect(() => {
	reviewSession.setReviewActive(reviewActive);
});

// Reconcile repository-tab editor state against the authoritative active-review
// snapshot. Filtered or hidden projections must never decide whether a thread or
// reply is still alive, because doing so would erase an editor merely by changing
// views. Inactive-review sessions remain available for the next review switch.
$effect(() => {
	void reviewComments.revision;
	reviewEditors.reconcile({
		reviewId: reviewComments.activeReviewId,
		threads: reviewComments.threads,
		authoritative: reviewComments.threadsAuthoritative,
	});
});

// Report whether this tab's center pane shows the review panel, but only while it's
// the active review tab (reviewActive folds in tab.id === activeTabId at the App
// level). Inactive tabs never clobber App's value; on tab switch the newly-active
// review tab re-reports. The reported value mirrors the render condition below
// EXACTLY (it reads showDiff), so the Toolbar button and the rendered pane share one
// source of truth — deselecting a file re-shows the panel and re-lights the button.
$effect(() => {
	if (reviewSession.state.reviewActive) {
		onreviewpanelshowingchange(
			!(reviewSession.state.rightPaneMode === "diff" && showDiff),
		);
	}
});

// The Toolbar Review button, clicked while the center pane shows a diff, asks to
// return to the review panel (rather than ending the session). The event is
// window-global like review-toggle; only the active review tab responds.
$effect(() => {
	let unlisten: (() => void) | undefined;
	listen<void>("review-show-panel", () => {
		if (isUpdateFrozen()) return;
		if (reviewSession.state.reviewActive) reviewSession.showPanel();
	}).then((fn) => {
		unlisten = fn;
	});
	return () => unlisten?.();
});

// DiffPanel ref for jump-to-range scroll+highlight (Phase 69 / D-07).
let diffPanelRef = $state<{
	jumpToThread: (
		thread: Thread,
		startLine: number,
		endLine: number,
		side: Side,
	) => void;
} | null>(null);

let pendingReviewJump = $state<{
	thread: Thread;
	path: string | null;
	startLine: number;
	endLine: number;
	side: Side;
} | null>(null);

$effect(() => {
	const jump = pendingReviewJump;
	const panel = diffPanelRef;
	const targetPath = selectedCompareFile ?? selectedDiffPath;
	if (!jump) return;

	if (!showDiff || jump.path !== targetPath) {
		pendingReviewJump = null;
		return;
	}
	if (!panel) return;

	pendingReviewJump = null;
	requestAnimationFrame(() => {
		if (panel !== diffPanelRef) return;

		panel.jumpToThread(jump.thread, jump.startLine, jump.endLine, jump.side);
	});
});

// Bind the panel's jump affordance to the rune, wiring the existing RepoView
// machinery as the rune's navigation seams. The rune uses the IDEMPOTENT
// variants, which skip handleCommitSelect's compare handling. The jump gesture
// must never clear the very target it's about to scroll to, otherwise the
// panel→diff swap lands on a blank diff with no selection.
function handleReviewJump(comment: Thread) {
	reviewSession.jumpTo(comment, {
		selectCommit: selectCommitIdempotent,
		selectFile: selectCommitFileIdempotent,
		openCurrentFile,
		scrollToRange: (startLine, endLine, side) => {
			pendingReviewJump = {
				thread: comment,
				path: selectedCompareFile ?? selectedDiffPath,
				startLine,
				endLine,
				side,
			};
		},
	});
}

// The graph is not on screen in review mode, so a commit-header click leaves
// review mode before selecting the commit.
async function handleReviewJumpToCommit(oid: string) {
	navigationIntent += 1;
	commitSelectGeneration += 1;
	const isCurrent = snapshotNavigationIntent();
	requestedCommitOid = oid;
	onleavereview();
	await tick();
	if (!isCurrent()) return;

	await navigateToCommit(oid);
}

// Per-repo state
let refreshSignal = $state(0);
let graphRefreshSignal = $state(0);
let consumedGraphRefreshSignal = $state(0);
let worktreeRefreshSignal = $state(0);
let sidebarRefreshSignal = $state(0);
let refreshImmediately = $state(false);
let cachedGraphRevision = $state<number | undefined>();
let pendingRefsRevision = $state<number | undefined>();
let dirtyCounts = $state<DirtyCounts>({
	staged: 0,
	unstaged: 0,
	conflicted: 0,
	modified: 0,
	new: 0,
	deleted: 0,
	renamed: 0,
	typechange: 0,
});
// Monotonic token so an out-of-order dirty-count response can't clobber a newer one.
// Graph layout now depends on this value, so a stale one freezes a layout that
// disagrees with the worktree until the next fs event.
let dirtyCountsSeq = 0;
let headBranch = $state<string | undefined>(undefined);
let wipSubject = $state("");
let wipBody = $state("");
const commitFormSession = new CommitFormSession();
let draftSummaryFocused = $state(false);
let draftLoaded = $state(false);
let treeViewEnabled = $state(false);

// Staging file selection (from StagingPanel)
let selectedFile = $state<{
	path: string;
	kind: "unstaged" | "staged" | "conflicted";
} | null>(null);
// Replace this array wholesale: $state.raw ignores an in-place mutation, so a
// push here updates nothing on screen.
let stagingDiffFiles = $state.raw<FileDiff[]>([]);
let stagingDiffLoading = $state(false);
let stagingDiffError = $state<string | null>(null);
let stagingDiffMode = $state<ContentMode | null>(null);
let selectGeneration = 0;

interface SelectedDiffLoad {
	path: string;
	kind: "unstaged" | "staged";
	options: DiffRequestOptions;
	generation: number;
	reportError: boolean;
	mode: ContentMode;
}

let pendingSelectedDiff: SelectedDiffLoad | null = null;
const selectedDiffRefresh = createCoalescedTask(
	scheduler,
	readSelectedFileDiff,
);
// Bumped on every coalesced repo-changed notification so the rendered-markdown preview
// refetches alongside Source's fileDiffs (the fs watcher only reaches Source's
// data path; the preview holds its own fetch).
let diffRefreshToken = $state(0);
let cachedStatus = $state<WorkingTreeStatus | null>(null);
let stagingPanelRef = $state<StagingPanel | null>(null);

// File finder (TRUNK-154.2): reaching a tracked file no pending change touches.
// The picked file opens in the full-file view under its own diff kind, which
// carries no view oid, so no comment renders against it and the Comment
// affordance stays gated until the content pin lands (TRUNK-154.3).
let finderOpen = $state(false);
let finderFiles = $state.raw<TrackedFile[]>([]);
let selectedCurrentFile = $state<string | null>(null);
let currentFileDiffs = $state.raw<FileDiff[]>([]);
let currentFileLoading = $state(false);
let currentFileError = $state<string | null>(null);
let finderLoadSeq = 0;

// The open current file is read by two callers — the finder's pick and every
// repository change under it — through one coalesced owner, so a burst of
// events cannot put two reads of the same file in flight. `generation` is the
// selection's lifetime: closing the view, picking another file and teardown all
// advance it, so a read in flight when the user leaves is dropped rather than
// painted over whatever they left for. Leaving a file and returning to it lands
// on a new generation, so the earlier response stays rejected even though the
// path matches again.
interface CurrentFileLoad {
	path: string;
	generation: number;
	reportError: boolean;
}

let currentFileGeneration = 0;
let pendingCurrentFile: CurrentFileLoad | null = null;
const currentFileRefresh = createCoalescedTask(scheduler, readCurrentFile);

async function openFileFinder() {
	const seq = ++finderLoadSeq;
	try {
		const files = await safeInvoke<TrackedFile[]>("list_tracked_files", {
			path: repoPath,
		});
		if (seq !== finderLoadSeq) return;
		finderFiles = files;
		finderOpen = true;
	} catch (e) {
		reportErrorToast(e, "Could not list this repository's files");
	}
}

/** Reads the file the current-file selection names, for whichever caller asked
 *  last. Navigation belongs to the explicit open below, never to this: a
 *  refresh that cleared selections or re-showed the diff would move the user
 *  off whatever they had picked since. */
async function readCurrentFile(): Promise<void> {
	const load = pendingCurrentFile;
	if (!load) return;
	const repo = repoPath;
	const loadIsCurrent = () =>
		repoViewActive &&
		repo === repoPath &&
		load.generation === currentFileGeneration &&
		selectedCurrentFile === load.path;

	try {
		const result = await safeInvoke<FileDiff[]>("open_current_file", {
			path: repo,
			filePath: load.path,
		});
		if (!loadIsCurrent()) return;
		// A fresh array, even of identical data, resets the pane's selection and
		// folds. Every index write re-reads the open file, so only a real change
		// may replace it.
		if (!sameData(currentFileDiffs, result)) currentFileDiffs = result;
		currentFileError = null;
	} catch (error) {
		if (!loadIsCurrent()) return;
		if (load.reportError)
			reportErrorToast(error, `Could not open ${load.path}`);
		// A file that has gone, or has stopped being readable, keeps its selected
		// path and shows the pane's error with a retry. Dropping the payload is
		// what stops the user selecting lines that are no longer in the file.
		currentFileDiffs = [];
		currentFileError = loadErrorMessage(error);
	} finally {
		if (loadIsCurrent()) currentFileLoading = false;
	}
}

function prepareCurrentFileRead(path: string, reportError: boolean): void {
	pendingCurrentFile = {
		path,
		generation: currentFileGeneration,
		reportError,
	};
	currentFileLoading = true;
	currentFileError = null;
}

async function openCurrentFile(filePath: string) {
	cancelPendingCommitSelection();
	finderOpen = false;
	currentFileGeneration += 1;
	currentFileDiffs = [];
	prepareCurrentFileRead(filePath, true);
	selectedCurrentFile = filePath;
	selectedFile = null;
	selectedCommitFile = null;
	selectedCompareFile = null;
	if (reviewSession.state.reviewActive) reviewSession.showDiff();
	await currentFileRefresh.run();
}

function closeCurrentFile() {
	currentFileGeneration += 1;
	pendingCurrentFile = null;
	selectedCurrentFile = null;
	currentFileDiffs = [];
	currentFileLoading = false;
	currentFileError = null;
}

// Commit selection (from CommitGraph)
let selectedCommitOid = $state<string | null>(null);
let requestedCommitOid = $state<string | null>(null);
let commitDetail = $state<CommitDetailType | null>(null);
let commitDetailStat = $state<DiffStat | null>(null);
// Replace this array wholesale: $state.raw ignores an in-place mutation, so a
// push here updates nothing on screen.
let commitFileDiffs = $state.raw<FileDiff[]>([]);
let commitLoadedDiffs = $state.raw(noLoadedDiffs<string>());
let selectedCommitFile = $state<string | null>(null);
let commitDiffLoadSeq = 0;
let commitDiffLoading = $state(false);
let commitDiffError = $state<string | null>(null);
// A view's mode is the mode of the payload it shows for the selected path, so
// a payload of the other mode is stale while its file reloads.
let commitDiffMode = $derived(
	selectedCommitFile
		? loadedModeFor(commitLoadedDiffs, {
				source: selectedCommitOid,
				path: selectedCommitFile,
			})
		: null,
);
// Bumped on every selectCommitIdempotent call so an out-of-order commit-switch
// response can't clobber a newer one, and a failed switch's catch arm can tell
// it's still the latest before clearing state.
let commitSelectGeneration = 0;
// The commit whose detail is being read, the generation that read belongs to,
// and the read itself, which a repeated request for that commit waits on.
let commitRead: {
	oid: string;
	generation: number;
	landed: Promise<void>;
} | null = null;
let navigationIntent = 0;

// Compare selection (TRUNK-1): the Base → Target pair picked in the graph.
// Detail/file state loads per pair; a stale response is dropped by generation.
let compare = $state<ComparePair | null>(null);
let compareBaseDetail = $state<CommitDetailType | null>(null);
let compareTargetDetail = $state<CommitDetailType | null>(null);
// Replace this array wholesale: $state.raw ignores an in-place mutation, so a
// push here updates nothing on screen.
let compareFileDiffs = $state.raw<FileDiff[]>([]);
let compareLoadedDiffs = $state.raw(noLoadedDiffs<ComparePair>());
let compareStat = $state<DiffStat | null>(null);
let selectedCompareFile = $state<string | null>(null);
let compareGeneration = 0;
let compareDiffLoadSeq = 0;
let compareDiffLoading = $state(false);
let compareDiffError = $state<string | null>(null);
let compareDiffMode = $derived(
	selectedCompareFile
		? loadedModeFor(compareLoadedDiffs, {
				source: compare,
				path: selectedCompareFile,
			})
		: null,
);
let compareOids = $derived<ReadonlySet<string>>(
	new Set(compare ? compare.picked : []),
);

// The WIP-inclusive display list + pagination state CommitGraph reports via
// oncommitschange, cached here so commitNav below is computed from the rows the
// graph last reported, the same while a diff, the review panel or the rebase
// editor covers it. Raw, like CommitGraph's own list: the rows are replaced,
// never edited, and a proxy on each would tax every walk commitNav makes.
let graphDisplayItems = $state.raw<GraphCommit[]>([]);
let graphHasMore = $state(false);
let commitNav = $derived(
	computeCommitNav(graphDisplayItems, selectedCommitOid ?? null, graphHasMore),
);
let requestedCommitNav = $derived(
	requestedCommitOid === selectedCommitOid
		? commitNav
		: computeCommitNav(graphDisplayItems, requestedCommitOid, graphHasMore),
);

// Diff-in-view navigation (spec 2026-08-18): non-null = mode active. Remembers
// the path last opened (click or auto-open) so a commit switch can reopen it.
let diffInViewPath = $state<string | null>(null);
// True only right after a reconciliation lands on a commit with zero files.
// Not derived: it must stay false during the load gap even though
// commitFileDiffs is momentarily stale/empty.
let commitEmpty = $state(false);

// CommitGraph component ref -- used to call scrollToOid for ref navigation (GRAPH-03)
let commitGraphRef = $state<{
	scrollToOid: (oid: string, isStillRequested?: () => boolean) => Promise<void>;
	showGraph: (graph: GraphResponse) => void;
	loadedRows: () => number;
} | null>(null);

// Gates CommitGraph's first page load on BranchSidebar's stored-visibility read, so
// the graph never paints open_repo's unfiltered default first (TRUNK-128). Starts
// false on every mount -- RepoView is remounted per repoPath via {#key} in App.svelte,
// so this does not need its own reset effect.
let refVisibilityResolved = $state(false);
// Gates the view's first graph, CommitGraph's first page and BranchSidebar's push
// of the stored set, on this view's repo-changed listener (TRUNK-494).
let repoListenerSettled = $state(false);

// Rebase editor state
let rebaseEditorCommits = $state<RebaseTodoItem[]>([]);
let rebaseBaseOid = $state<string | null>(null);
let rebaseBranchName = $state("");
let rebaseBase = $state<RebaseBase | null>(null);
const showRebaseEditor = $derived(rebaseBase !== null);
let rebaseFocusedCommitDetail = $state<CommitDetailType | null>(null);
let rebaseFocusedCommitStat = $state<DiffStat | null>(null);
// Replace this array wholesale: $state.raw ignores an in-place mutation, so a
// push here updates nothing on screen.
let rebaseFocusedFileDiffs = $state.raw<FileDiff[]>([]);
let rebaseLoadedDiffs = $state.raw(noLoadedDiffs<string>());
let rebaseFocusedFileSelected = $state<string | null>(null);
let rebaseDiffFile = $state<string | null>(null);
let rebaseFocusLoadSeq = 0;
let rebaseDiffLoadSeq = 0;
let rebaseDiffLoading = $state(false);
let rebaseDiffError = $state<string | null>(null);
let rebaseFocusedOid = $derived(rebaseFocusedCommitDetail?.oid ?? null);
let rebaseDiffMode = $derived(
	rebaseDiffFile
		? loadedModeFor(rebaseLoadedDiffs, {
				source: rebaseFocusedOid,
				path: rebaseDiffFile,
			})
		: null,
);
let rebaseShownDiff = $derived(
	rebaseDiffFile
		? shownDiff(rebaseFocusedFileDiffs, rebaseLoadedDiffs, {
				source: rebaseFocusedOid,
				path: rebaseDiffFile,
			})
		: [],
);

const wipCount = $derived(
	dirtyCounts.staged + dirtyCounts.unstaged + dirtyCounts.conflicted,
);

const wipStats = $derived<WipStats>({
	modified: dirtyCounts.modified,
	new: dirtyCounts.new,
	deleted: dirtyCounts.deleted,
	renamed: dirtyCounts.renamed,
	typechange: dirtyCounts.typechange,
	conflicted: dirtyCounts.conflicted,
});

// Center pane: show DiffPanel when a file is selected (from either source),
// or diff-in-view navigation is active (keeps the pane up during the load gap
// and for the empty-commit placeholder).
let showDiff = $derived(
	selectedFile !== null ||
		selectedCommitFile !== null ||
		diffInViewPath !== null ||
		selectedCompareFile !== null ||
		selectedCurrentFile !== null,
);

// Review mode holds the window: the reviews in the left pane, the shown review
// or one of its diffs in the center, and no right pane.
const reviewMode = $derived(reviewSession.state.reviewActive);

const sidePanes = createSidePanes({
	view: () => {
		if (rebaseBase) return "rebase";
		return reviewMode ? "review" : "main";
	},
	sidebar: {
		width: () => leftPaneWidth,
		collapsed: () => leftPaneCollapsed,
		onwidthchange: (width) => onleftpanewidthchange(width),
		oncollapsedchange: (collapsed) => onleftpanecollapsedchange(collapsed),
		store: setLeftPaneWidth,
	},
	detailPane: {
		width: () => rightPaneWidth,
		collapsed: () => rightPaneCollapsed,
		onwidthchange: (width) => onrightpanewidthchange(width),
		oncollapsedchange: (collapsed) => onrightpanecollapsedchange(collapsed),
		store: setRightPaneWidth,
	},
});
let reviewListPane = $state<HTMLDivElement | null>(null);

// The review panel claims the center pane until a selection swaps it for the diff.
const reviewPanelShown = $derived(
	reviewMode && !(reviewSession.state.rightPaneMode === "diff" && showDiff),
);
let showMergeEditor = $derived(selectedFile?.kind === "conflicted");
// The graph stays mounted under whatever covers the center pane, as a background
// tab stays mounted under the active one, so closing a diff returns to the rows
// and scroll position the user left rather than to the top of a fresh first page.
const graphCovered = $derived(reviewPanelShown || showDiff || showRebaseEditor);

// The diffs to display: filtered commit file diff, staging diff, or the whole
// of a tracked file opened through the finder. A current-file view is last
// because any other selection supersedes it — selecting a staging file while
// one is open must show that file, not the one the finder opened.
let currentDiffFiles = $derived(
	selectedCompareFile
		? shownDiff(compareFileDiffs, compareLoadedDiffs, {
				source: compare,
				path: selectedCompareFile,
			})
		: selectedCommitFile
			? shownDiff(commitFileDiffs, commitLoadedDiffs, {
					source: selectedCommitOid,
					path: selectedCommitFile,
				})
			: selectedFile
				? stagingDiffFiles
				: selectedCurrentFile
					? currentFileDiffs
					: stagingDiffFiles,
);

// The current file while it is the one on screen: every other selection
// supersedes it in `currentDiffFiles` above, and the rebase editor covers the
// pane while it is open.
let shownCurrentFile = $derived(
	!showRebaseEditor &&
		selectedCompareFile === null &&
		selectedCommitFile === null &&
		selectedFile === null
		? selectedCurrentFile
		: null,
);

// The diffKind the active DiffPanel renders under — mirrors the template prop
// (a conflicted file shows via MergeEditor, never DiffPanel, so it folds to the
// commit kind there too). Lifted to a derived so the matcher's ViewDescriptor
// and the rendered DiffPanel agree on one source of truth. The conflicted case
// is folded out, so this never widens to DiffKind's "conflicted" variant.
//
// Its branch order is currentDiffFiles' order, and the two must stay that way
// or the panel renders one selection's content under another's kind. A
// current-file view sits last because every other selection supersedes it: the
// finder does not clear them, exactly as they do not clear each other.
let diffKind = $derived<PanelDiffKind>(
	selectedCommitFile
		? "commit"
		: selectedFile?.kind === "conflicted"
			? "commit"
			: selectedFile
				? selectedFile.kind
				: selectedCurrentFile
					? "current_file"
					: "commit",
);

// The new-side path of the file shown in DiffPanel. FileDiff carries only a
// single (current) path — no old/new pair — so Old-side rename comments match
// by this new path and otherwise fall to panel-only (plan §6, acceptable v1).
let selectedDiffPath = $derived(
	selectedCommitFile ?? selectedFile?.path ?? selectedCurrentFile ?? null,
);

let currentSourceMode = $derived(
	selectedCompareFile
		? compareDiffMode
		: selectedCommitFile
			? commitDiffMode
			: selectedFile
				? stagingDiffMode
				: null,
);
let currentSourceError = $derived(
	selectedCompareFile
		? compareDiffError
		: selectedCommitFile
			? commitDiffError
			: selectedFile
				? stagingDiffError
				: selectedCurrentFile
					? currentFileError
					: null,
);
let currentSourceLoading = $derived(
	selectedCompareFile
		? compareDiffLoading
		: selectedCommitFile
			? commitDiffLoading
			: selectedFile
				? stagingDiffLoading
				: selectedCurrentFile
					? currentFileLoading
					: false,
);

// The payload on screen answers a different content mode than the one asked
// for, so it is the wrong shape rather than merely old: the viewer hides it
// instead of keeping it up through the fetch (TRUNK-232).
//
// Adding the current-file selection here would read a view that is forced to
// full-file content as one still waiting for the global mode's payload.
let currentSourcePayloadStale = $derived(
	Boolean(selectedCompareFile || selectedCommitFile || selectedFile) &&
		!currentSourceError &&
		currentSourceMode !== contentMode,
);

// ViewDescriptor for the current diff. resolveViewOid handles per-kind OID
// selection (commit→commitOid, unstaged/staged→snapshots, conflicted→null), so
// we only supply the commit oid + the session's current snapshot OIDs.
let viewDescriptor = $derived<ViewDescriptor>({
	kind: diffKind,
	commitOid: commitDetail?.oid ?? null,
	snapshots: reviewComments.snapshots,
});

// The pick of a shown review outlives review mode, so reading
// reviewComments.diffThreads outside it would hide the active review's
// threads, and every new comment, from each ordinary diff.
let diffThreads = $derived(
	reviewMode ? reviewComments.diffThreads : reviewComments.threads,
);

// Comments matching the file currently shown in DiffPanel. Empty when no file
// is selected.
let viewComments = $derived(
	selectedDiffPath && !selectedCompareFile
		? commentsForView(diffThreads, viewDescriptor, selectedDiffPath)
		: [],
);

// Rebase owns a separate focused commit/file pair while its takeover is open.
// Give that pair the same raw-thread matcher as the normal diff so review badges
// and comment cards follow the commit the rebase editor is actually showing.
let rebaseViewDescriptor = $derived<ViewDescriptor>({
	kind: "commit",
	commitOid: rebaseFocusedCommitDetail?.oid ?? null,
	snapshots: reviewComments.snapshots,
});
let rebaseViewComments = $derived(
	rebaseDiffFile
		? commentsForView(
				reviewComments.threads,
				rebaseViewDescriptor,
				rebaseDiffFile,
			)
		: [],
);

const diffComposerTarget = $derived.by((): ReviewComposerTarget => {
	if (showRebaseEditor)
		return {
			context: "rebase",
			kind: "commit",
			commitOid: rebaseFocusedCommitDetail?.oid ?? null,
			compareBaseOid: null,
			filePath: rebaseDiffFile,
		};
	if (diffKind === "commit")
		return {
			context: "normal",
			kind: "commit",
			commitOid: selectedCompareFile
				? (compare?.targetOid ?? null)
				: (selectedCommitOid ?? null),
			compareBaseOid: selectedCompareFile ? (compare?.baseOid ?? null) : null,
			filePath: selectedCompareFile ?? selectedDiffPath,
		};
	return {
		context: "normal",
		kind: diffKind,
		commitOid: null,
		compareBaseOid: null,
		filePath: selectedDiffPath,
	};
});
const diffComposerSession = $derived(
	reviewEditors.composer(diffComposerTarget, reviewComments.activeReviewId),
);

// One presentation projection feeds every count surface. The manager remains
// raw so lifecycle actions, copy/end, and review inventory never lose settled
// threads when a filter changes.
let presentation = $derived(
	buildCommentCounts(
		reviewComments.threads,
		reviewComments.snapshots,
		reviewFilter,
	),
);

function toneForThreads(
	threads: Thread[],
	filter: ReviewFilter,
): ReviewTone | null {
	let tone: ReviewTone | null = null;
	for (const thread of threads) {
		const next = badgeToneForThread(thread, filter);
		if (next !== null) tone = combineReviewTone(tone, next);
	}
	return tone;
}

// Only the comments governed by the current pane receive the small toolbar
// badge. The same thread set feeds both its count and its tone.
let currentViewComments = $derived.by<Thread[]>(() => {
	if (compare) return [];
	if (showRebaseEditor) {
		if (rebaseDiffFile) return rebaseViewComments;
		if (rebaseFocusedCommitDetail) {
			return reviewComments.threads.filter(
				(t) =>
					t.anchor === null && t.commit_oid === rebaseFocusedCommitDetail?.oid,
			);
		}
		return [];
	}
	if (showDiff && selectedDiffPath) return viewComments;
	const selectedCommit = commitDetail;
	if (selectedCommitOid && selectedCommit) {
		return reviewComments.threads.filter(
			(t) => t.anchor === null && t.commit_oid === selectedCommit.oid,
		);
	}
	return [];
});

let inlineCommentCount = $derived(
	countBadgeThreads(currentViewComments, reviewFilter),
);

let inlineCommentTone = $derived(
	toneForThreads(currentViewComments, reviewFilter),
);

// Total threads in the active review, for the Review button badge — independent
// of which pane the user is looking at and of hiding review threads, like the
// panel it opens. 0 with no threads, so the badge hides.
let reviewCommentTotal = $derived(
	countBadgeThreads(reviewComments.threads, threadFilter),
);
let reviewCommentTone = $derived(
	toneForThreads(reviewComments.threads, threadFilter),
);

// Report both counts up through untrack: App's setCommentCounts copies the
// counts map (`new Map(commentCounts)`) before writing it, so calling the
// callback inside a tracked effect would make this effect depend on the very
// state it writes → effect_update_depth_exceeded. Reading both derived values
// before the untrack callback keeps the report one-way yet re-fires when either
// count changes.
$effect(() => {
	const view = inlineCommentCount;
	const total = reviewCommentTotal;
	const viewTone = inlineCommentTone;
	const totalTone = reviewCommentTone;
	untrack(() => oncommentcountschange?.({ view, total, viewTone, totalTone }));
});

// The topmost row of HEAD's chain is HEAD itself, detached or not, as the WIP
// row's anchor reads it.
$effect(() => {
	const oid = graphDisplayItems.find((c) => c.in_head_chain)?.oid ?? null;
	untrack(() => onshownheadchange?.(oid));
});

async function loadDirtyCounts() {
	const seq = ++dirtyCountsSeq;
	const path = repoPath;
	try {
		const result = await safeInvoke<DirtyCounts>("get_dirty_counts", {
			path,
		});
		if (!repoViewActive || path !== repoPath || seq !== dirtyCountsSeq) return;
		dirtyCounts = result;
		ondirtychange?.(result);
	} catch {
		// non-fatal -- keep previous counts
	}
}

const dirtyCountsRefresh = createCoalescedTask(scheduler, loadDirtyCounts);

onDestroy(() => {
	repoViewActive = false;
	commitDiffLoadSeq += 1;
	compareDiffLoadSeq += 1;
	rebaseDiffLoadSeq += 1;
	currentFileGeneration += 1;
	repoNotification.dispose();
	displayedDiffNotification.dispose();
	dirtyCountsRefresh.dispose();
	selectedDiffRefresh.dispose();
	currentFileRefresh.dispose();
});

function handleRefresh() {
	refreshSignal += 1;
	graphRefreshSignal += 1;
	sidebarRefreshSignal += 1;
}

function clearStagingDiff() {
	selectGeneration += 1;
	pendingSelectedDiff = null;
	selectedFile = null;
	stagingDiffFiles = [];
	stagingDiffLoading = false;
	stagingDiffError = null;
	stagingDiffMode = null;
}

// A bulk action, a commit or a terminal can move the open file out of the list it
// was opened from. A conflicted selection describes a conflict, so once the file
// is no longer conflicted there is nothing left for the merge editor to show,
// whatever ended the operation. An unstaged or staged file follows itself into
// the other list, and closes when it left both.
function keepSelectionListed(s: WorkingTreeStatus) {
	const selected = selectedFile;
	if (selected === null) return;

	const listed = (kind: keyof WorkingTreeStatus) =>
		s[kind].some((file) => file.path === selected.path);
	if (listed(selected.kind)) return;

	if (selected.kind === "conflicted") {
		clearStagingDiff();
		return;
	}

	const other = selected.kind === "unstaged" ? "staged" : "unstaged";
	if (!listed(other)) {
		clearStagingDiff();
		return;
	}

	selectedFile = { path: selected.path, kind: other };
	void refetchFileDiff(selected.path, other);
}

// Every status refresh passes through here, the ones that follow an abort, a
// skip or a Continue included, so the open file is checked against each.
function handleStatusChange(s: WorkingTreeStatus) {
	// Mount already reads the counters once. Only subsequent list changes need
	// another walk; the first staging status is an independent initial read.
	const filesMoved = cachedStatus !== null && !listsSameFiles(cachedStatus, s);
	cachedStatus = s;

	// Staging and discarding emit no repo-changed, so without this the graph's
	// working-tree row keeps its old counts until the file watcher fires.
	if (filesMoved) void dirtyCountsRefresh.run();

	keepSelectionListed(s);
}

function clearCommitFileDiff() {
	commitDiffLoadSeq += 1;
	selectedCommitFile = null;
	commitDiffLoading = false;
	commitDiffError = null;
	diffInViewPath = null;
	commitEmpty = false;
}

function snapshotNavigationIntent(): () => boolean {
	const intent = navigationIntent;
	const path = repoPath;

	return () =>
		repoViewActive && path === repoPath && intent === navigationIntent;
}

function cancelPendingCommitSelection() {
	navigationIntent += 1;
	commitSelectGeneration += 1;
	requestedCommitOid = selectedCommitOid;
}

function clearCommit() {
	navigationIntent += 1;
	commitSelectGeneration += 1;
	commitDiffLoadSeq += 1;
	requestedCommitOid = null;
	selectedCommitOid = null;
	commitDetail = null;
	commitDetailStat = null;
	commitFileDiffs = [];
	commitLoadedDiffs = noLoadedDiffs();
	selectedCommitFile = null;
	diffInViewPath = null;
	commitEmpty = false;
	commitDiffLoading = false;
	commitDiffError = null;
}

function buildDiffOptions(): DiffRequestOptions {
	return diffPreferences.requestOptions(contentMode);
}

/** The working-tree paths whose content the open views are showing. */
function openFilePaths(): Set<string> {
	const paths = new Set<string>();
	if (selectedFile && selectedFile.kind !== "conflicted") {
		paths.add(selectedFile.path);
	}
	if (selectedCurrentFile !== null) paths.add(selectedCurrentFile);
	return paths;
}

/**
 * Whether a change confined to `changed` can alter what the open views show. A
 * staged diff reads the index rather than the working tree, and an operation
 * that rewrites HEAD moves what every diff compares against, so any write under
 * `.git` counts alongside a write to the open file itself. An empty `changed`
 * is a change whose extent the writer could not state, so it concerns
 * everything.
 */
function concernsOpenFiles(changed: readonly string[]): boolean {
	if (changed.length === 0) return true;

	const open = openFilePaths();
	return changed.some(
		(path) => open.has(path) || path === ".git" || path.startsWith(".git/"),
	);
}

function requestStagingFileDiff(
	repo: string,
	kind: "unstaged" | "staged",
	filePath: string,
	options: DiffRequestOptions,
): Promise<FileDiff[]> {
	return safeInvoke<FileDiff[]>(
		kind === "unstaged" ? "diff_unstaged" : "diff_staged",
		{ path: repo, filePath, options },
	);
}

function requestCommitFileDiff(
	repo: string,
	oid: string,
	filePath: string,
	options: DiffRequestOptions,
): Promise<FileDiff[]> {
	return safeInvoke<FileDiff[]>("diff_commit_file", {
		path: repo,
		oid,
		filePath,
		options,
	});
}

function requestCompareFileDiff(
	repo: string,
	baseOid: string | null,
	targetOid: string,
	filePath: string,
	options: DiffRequestOptions,
): Promise<FileDiff[]> {
	return safeInvoke<FileDiff[]>("diff_compare_file", {
		path: repo,
		baseOid,
		targetOid,
		filePath,
		options,
	});
}

async function fileFromCurrentRead(
	request: Promise<FileDiff[]>,
	filePath: string,
	requestIsCurrent: () => boolean,
): Promise<FileDiff | null> {
	try {
		const files = await request;
		if (!requestIsCurrent()) return null;

		return files.find((file) => file.path === filePath) ?? null;
	} catch (error) {
		if (!requestIsCurrent()) return null;

		throw error;
	}
}

async function loadFullFileForComment(
	filePath: string,
): Promise<FileDiff | null> {
	const options = { ...buildDiffOptions(), showFullFile: true };
	const fireRepo = repoPath;

	if (selectedCompareFile === filePath && compare) {
		const firePair = compare;
		const loadSeq = compareDiffLoadSeq;

		return await fileFromCurrentRead(
			requestCompareFileDiff(
				fireRepo,
				firePair.baseOid,
				firePair.targetOid,
				filePath,
				options,
			),
			filePath,
			() =>
				repoViewActive &&
				repoPath === fireRepo &&
				compareDiffLoadSeq === loadSeq &&
				compare === firePair &&
				selectedCompareFile === filePath,
		);
	}

	if (selectedCommitFile === filePath && selectedCommitOid) {
		const fireOid = selectedCommitOid;
		const loadSeq = commitDiffLoadSeq;

		return await fileFromCurrentRead(
			requestCommitFileDiff(fireRepo, fireOid, filePath, options),
			filePath,
			() =>
				repoViewActive &&
				repoPath === fireRepo &&
				commitDiffLoadSeq === loadSeq &&
				selectedCommitOid === fireOid &&
				selectedCommitFile === filePath,
		);
	}

	if (selectedFile?.path === filePath && selectedFile.kind !== "conflicted") {
		const kind = selectedFile.kind;
		const generation = selectGeneration;

		return await fileFromCurrentRead(
			requestStagingFileDiff(fireRepo, kind, filePath, options),
			filePath,
			() =>
				repoViewActive &&
				repoPath === fireRepo &&
				selectGeneration === generation &&
				selectedFile?.path === filePath &&
				selectedFile.kind === kind,
		);
	}

	return null;
}

function loadErrorMessage(error: unknown): string {
	return errorMessage(error, "Failed to load diff");
}

/** WIP row clicked -- switch to staging view and auto-open right pane if collapsed. */
function handleWipClick() {
	if (compare !== null) clearCompare();
	clearCommit();
	// Auto-open right pane if collapsed (LAYOUT-01)
	if (rightPaneCollapsed) {
		onrightpanecollapsedchange(false);
	}
}

async function focusDraftSummary() {
	handleWipClick();
	await tick();
	await stagingPanelRef?.focusDraftSummary();
}

function handleDiffClose() {
	cancelPendingCommitSelection();
	if (selectedCurrentFile) closeCurrentFile();
	else if (selectedCompareFile) closeCompareFile();
	else if (selectedFile) clearStagingDiff();
	else clearCommitFileDiff();
}

function advanceToNextFile(
	currentPath: string,
	section: "unstaged" | "staged" | "conflicted",
) {
	if (!cachedStatus) {
		clearStagingDiff();
		return;
	}
	const rawFiles = cachedStatus[section];
	// Use the same ordering the visual list uses
	const orderedPaths = treeViewEnabled
		? collectFilePaths(buildTree(rawFiles))
		: rawFiles.map((f) => f.path);
	const idx = orderedPaths.indexOf(currentPath);
	const nextPath =
		idx >= 0 ? (orderedPaths[idx + 1] ?? orderedPaths[idx - 1]) : undefined;
	// The last file of the unstaged or staged list stays open, and the status
	// that follows the action carries it into the other list, or closes it when
	// it left both. A resolved conflict has no other list to go to.
	if (nextPath) {
		handleFileSelect(nextPath, section);
	} else if (section === "conflicted") {
		clearStagingDiff();
	}
}

function handleFileResolved() {
	if (selectedFile) {
		advanceToNextFile(selectedFile.path, "conflicted");
	} else {
		clearStagingDiff();
	}
}

async function handleFileSelect(
	path: string,
	kind: "unstaged" | "staged" | "conflicted",
) {
	cancelPendingCommitSelection();
	// Close the review panel (swap to diff) so the clicked file is visible
	// (260531-l02d), the open one included, which stays mounted under the panel.
	if (reviewSession.state.reviewActive) reviewSession.showDiff();
	if (selectedFile?.path === path && selectedFile?.kind === kind) return;

	selectedFile = { path, kind };
	if (!repoPath) return;

	if (kind === "conflicted") {
		// MergeEditor loads its own data via get_merge_sides
		selectGeneration += 1;
		pendingSelectedDiff = null;
		stagingDiffFiles = [];
		stagingDiffLoading = false;
		stagingDiffError = null;
		stagingDiffMode = null;
		return;
	}

	await loadSelectedFileDiff(path, kind, undefined, true);
}

// Idempotent selection — never clears, never toggles. Loads commit detail
// for `oid` (or no-ops if already selected with detail loaded). This is the
// seam the review-panel jump binds to: the jump gesture must never
// clear the very target it's about to scroll to.
async function selectCommitIdempotent(oid: string) {
	navigationIntent += 1;
	// A jump or navigation lands on a single commit's diff, so any open compare
	// dissolves — otherwise the compare pane keeps rendering over the target.
	// applySelection starts this read before publishing its comparison, so the
	// reset happens in the same turn as the gesture that requested it.
	if (compare !== null) clearCompare();

	// Auto-open right pane if collapsed (LAYOUT-01). Review mode has none to open.
	if (rightPaneCollapsed && !reviewMode) {
		onrightpanecollapsedchange(false);
	}

	// Selecting a commit/ref while the review panel is open swaps the center pane to
	// the diff so the user sees what they clicked (260531-l02d). showDiff is also what
	// the jump gesture does, so this is consistent (and harmless when review is off).
	if (reviewSession.state.reviewActive) reviewSession.showDiff();

	// A new generation would discard the read already under way and start it over.
	if (
		commitRead?.oid === oid &&
		commitRead.generation === commitSelectGeneration
	) {
		await commitRead.landed;
		return;
	}

	const gen = ++commitSelectGeneration;
	requestedCommitOid = oid;
	if (selectedCommitOid === oid && commitDetail?.oid === oid) return;
	if (!repoPath) return;

	const landed = readCommit({ path: repoPath, oid, gen });
	commitRead = { oid, generation: gen, landed };
	await landed;
}

async function readCommit({
	path,
	oid,
	gen,
}: {
	path: string;
	oid: string;
	gen: number;
}) {
	// Statistics supplement usable details and files; failure only omits totals.
	const statistics = safeInvoke<DiffStat>("commit_stat", {
		path,
		oid,
	}).catch(() => null);
	try {
		const [files, detail] = await Promise.all([
			safeInvoke<FileDiff[]>("list_commit_files", {
				path,
				oid,
			}),
			safeInvoke<CommitDetailType>("get_commit_detail", {
				path,
				oid,
			}),
		]);
		const isCurrent = () =>
			repoViewActive && path === repoPath && gen === commitSelectGeneration;
		if (!isCurrent()) return;

		const target =
			diffInViewPath === null
				? null
				: resolveDiffTarget(
						diffInViewPath,
						files.map((f) => f.path),
						treeViewEnabled,
					);
		const opened =
			target?.kind === "file"
				? await readCommitFileAhead(path, oid, target.path)
				: null;
		if (!isCurrent()) return;

		clearStagingDiff();
		selectedCommitFile = null;
		commitEmpty = false;
		selectedCommitOid = oid;
		commitDetailStat = null;
		commitFileDiffs = files;
		commitDetail = detail;
		if (target?.kind === "file" && opened) {
			commitLoadedDiffs = withLoadedDiff(
				commitLoadedDiffs,
				{ source: oid, path: target.path },
				opened,
			);
		}
		void statistics.then((stat) => {
			if (
				stat === null ||
				!repoViewActive ||
				path !== repoPath ||
				selectedCommitOid !== oid ||
				commitDetail?.oid !== oid
			)
				return;

			commitDetailStat = stat;
		});

		// Diff-in-view navigation: reconcile the remembered path against the new
		// commit's file list. Lives inline here, never in an $effect — an effect
		// reading and writing selection state loops (svelte_effect_callback_loop).
		if (target !== null && diffInViewPath !== null) {
			if (target.kind === "file") {
				await selectCommitFileIdempotent(target.path);
			} else {
				commitEmpty = true;
			}
		}
	} catch (error) {
		if (!repoViewActive || path !== repoPath || gen !== commitSelectGeneration)
			return;

		reportErrorToast(error, "Could not load commit details");
		clearCommit();
	}
}

/** Reads the diff a pager step will open before the step publishes the new
 *  commit, so the pane goes from one commit's diff to the next and never shows
 *  a loading pane between them. A failed read yields null: the open after the
 *  publish reads the file again and reports that failure. */
async function readCommitFileAhead(
	repo: string,
	oid: string,
	filePath: string,
): Promise<LoadedDiff | null> {
	const options = buildDiffOptions();
	try {
		const [diff] = await requestCommitFileDiff(repo, oid, filePath, options);

		return diff ? { diff, options } : null;
	} catch {
		return null;
	}
}

function clearCompare() {
	compareDiffLoadSeq += 1;
	compare = null;
	compareBaseDetail = null;
	compareTargetDetail = null;
	compareFileDiffs = [];
	compareLoadedDiffs = noLoadedDiffs();
	compareStat = null;
	selectedCompareFile = null;
	compareDiffLoading = false;
	compareDiffError = null;
	compareGeneration++;
}

function handleCompareClose() {
	navigationIntent += 1;
	clearCompare();
}

// Resolves true when the pair's files loaded and the pair is still the one shown.
async function applyCompare(pair: ComparePair | null): Promise<boolean> {
	navigationIntent += 1;
	if (pair === null) {
		if (compare !== null) clearCompare();
		return false;
	}
	compare = pair;
	selectedCompareFile = null;
	const gen = ++compareGeneration;
	if (rightPaneCollapsed) {
		onrightpanecollapsedchange(false);
	}
	if (!repoPath) return false;
	try {
		const [files, stat, baseDetail, targetDetail] = await Promise.all([
			safeInvoke<FileDiff[]>("list_compare_files", {
				path: repoPath,
				baseOid: pair.baseOid,
				targetOid: pair.targetOid,
			}),
			safeInvoke<DiffStat>("compare_stat", {
				path: repoPath,
				baseOid: pair.baseOid,
				targetOid: pair.targetOid,
			}).catch(() => null),
			pair.baseOid
				? safeInvoke<CommitDetailType>("get_commit_detail", {
						path: repoPath,
						oid: pair.baseOid,
					})
				: Promise.resolve(null),
			safeInvoke<CommitDetailType>("get_commit_detail", {
				path: repoPath,
				oid: pair.targetOid,
			}),
		]);
		if (gen !== compareGeneration) return false;

		compareFileDiffs = files;
		compareStat = stat;
		compareBaseDetail = baseDetail;
		compareTargetDetail = targetDetail;
		// A file picked from the previous pair's list while this one loaded
		// closes when this pair leaves it alone.
		const openFile = selectedCompareFile;
		if (openFile !== null && !files.some((file) => file.path === openFile)) {
			closeCompareFile();
		}
		return true;
	} catch (e) {
		if (gen !== compareGeneration) return false;

		reportErrorToast(e, "Failed to load comparison");
		clearCompare();
		return false;
	}
}

async function applySelection(next: SelectionState) {
	let selection: Promise<void> | undefined;
	if (next.selectedOid === null) {
		if (requestedCommitOid !== null) clearCommit();
	} else if (next.selectedOid !== requestedCommitOid) {
		selection = selectCommitIdempotent(next.selectedOid);
	}
	await Promise.all([selection, applyCompare(next.compare)]);
}

async function handleCompareCommits(baseOid: string, targetOid: string) {
	await applySelection({
		selectedOid: baseOid,
		compare: { baseOid, targetOid, picked: [baseOid, targetOid] },
	});
}

function firstParentOfLoaded(oid: string): string | null {
	return graphDisplayItems.find((c) => c.oid === oid)?.parent_oids[0] ?? null;
}

// The open file stays open across a swap, now diffed the other way. A rename
// lists under its new name in one direction and its old name in the other.
async function handleCompareSwap() {
	const openFile = selectedCompareFile;
	const swapped = await applyCompare(
		swapCompare({ selectedOid: requestedCommitOid, compare }).compare,
	);
	if (!swapped || openFile === null || selectedCompareFile !== null) return;

	const reopened = compareFileDiffs.find(
		(file) => file.path === openFile || file.old_path === openFile,
	);
	if (reopened) await handleCompareFileSelect(reopened.path);
}

// Fetch one file's Base → Target diff for the pair shown when it was asked
// for. A slow response for an old pair is dropped rather than shown against the
// new one (same hazard as reloadCommitFile's fireOid).
async function reloadCompareFile(
	filePath: string,
	options: DiffRequestOptions,
) {
	if (!repoPath || !compare) return;
	const fireRepo = repoPath;
	const firePair = compare;
	const loadSeq = ++compareDiffLoadSeq;
	const requestIsCurrent = () =>
		repoViewActive &&
		loadSeq === compareDiffLoadSeq &&
		repoPath === fireRepo &&
		compare === firePair &&
		selectedCompareFile === filePath;
	compareDiffLoading = true;
	compareDiffError = null;
	try {
		const fileDiffs = await requestCompareFileDiff(
			fireRepo,
			firePair.baseOid,
			firePair.targetOid,
			filePath,
			options,
		);
		if (!requestIsCurrent()) return;

		if (fileDiffs[0]) {
			compareLoadedDiffs = withLoadedDiff(
				compareLoadedDiffs,
				{ source: firePair, path: filePath },
				{ diff: fileDiffs[0], options: { ...options } },
			);
		}
		compareDiffLoading = false;
	} catch (error) {
		if (!requestIsCurrent()) return;
		compareDiffLoading = false;
		compareDiffError = loadErrorMessage(error);
	}
}

function closeCompareFile() {
	compareDiffLoadSeq += 1;
	selectedCompareFile = null;
	compareDiffLoading = false;
	compareDiffError = null;
}

async function handleCompareFileSelect(path: string) {
	navigationIntent += 1;
	if (selectedCompareFile === path) return;

	selectedCompareFile = path;
	await reloadCompareFile(path, buildDiffOptions());
}

// Graph clicks: a plain click selects the commit, the selected one included,
// and dissolves any compare; cmd/shift route through the compare state
// machine. The rune uses `selectCommitIdempotent` directly.
async function handleCommitSelect(oid: string, mods?: SelectModifiers) {
	const current: SelectionState = { selectedOid: requestedCommitOid, compare };
	if (mods?.compare) {
		await applySelection(cmdClick(current, oid));
		return;
	}

	if (mods?.range) {
		const order = graphDisplayItems
			.filter((c) => c.oid !== "__wip__")
			.map((c) => c.oid);
		await applySelection(shiftClick(current, oid, order, firstParentOfLoaded));
		return;
	}

	if (compare !== null) {
		await applySelection(plainClick(current, oid));
		return;
	}

	await selectCommitIdempotent(oid);
}

/** Navigate to a commit from the detail-pane pager or topology chips: select it
 * and center the graph on it. Mirrors the tail of handleRefNavigate. */
async function navigateToCommit(oid: string) {
	const selection = selectCommitIdempotent(oid);
	const isCurrent = snapshotNavigationIntent();

	await selection;
	if (!isCurrent() || requestedCommitOid !== oid || selectedCommitOid !== oid)
		return;

	await commitGraphRef?.scrollToOid(oid, isCurrent);
}

/** Resolve a ref name or OID to a commit OID, select it, and scroll the graph to it (GRAPH-03). */
async function handleRefNavigate(refNameOrOid: string) {
	if (!repoPath) return;

	cancelPendingCommitSelection();
	const isCurrent = snapshotNavigationIntent();
	const path = repoPath;
	let oid: string;

	// If it looks like a full git OID (40 hex chars), use directly (stash case)
	if (/^[0-9a-f]{40}$/i.test(refNameOrOid)) {
		oid = refNameOrOid;
	} else {
		// Resolve ref name to OID via backend
		try {
			oid = await safeInvoke<string>("resolve_ref", {
				path,
				refName: refNameOrOid,
			});
		} catch {
			return; // ref not found -- ignore silently
		}
	}

	if (!isCurrent()) return;

	await navigateToCommit(oid);
}

function countDiffLines(fileDiffs: FileDiff[]): number {
	let total = 0;
	for (const fd of fileDiffs) {
		for (const hunk of fd.hunks) total += hunk.lines.length;
	}
	return total;
}

async function reloadCommitFile(
	path: string,
	options: DiffRequestOptions,
	observeOpen = false,
) {
	if (!repoPath || !selectedCommitOid) return;

	const fireRepo = repoPath;
	const fireOid = selectedCommitOid;
	const loadSeq = ++commitDiffLoadSeq;
	const requestIsCurrent = () =>
		repoViewActive &&
		loadSeq === commitDiffLoadSeq &&
		repoPath === fireRepo &&
		selectedCommitOid === fireOid &&
		selectedCommitFile === path;

	commitDiffLoading = true;
	commitDiffError = null;

	try {
		const load = async () => {
			const fileDiffs = await requestCommitFileDiff(
				fireRepo,
				fireOid,
				path,
				options,
			);
			if (!requestIsCurrent()) return;

			if (fileDiffs[0]) {
				commitLoadedDiffs = withLoadedDiff(
					commitLoadedDiffs,
					{ source: fireOid, path },
					{ diff: fileDiffs[0], options: { ...options } },
				);
			}
			commitDiffLoading = false;
		};

		if (observeOpen) {
			await span("diff.openCommitFile", async (observation) => {
				observation.attr("path", path);
				await load();
				if (!requestIsCurrent()) return;
				observation.attr(
					"lines",
					countDiffLines(
						shownDiff(commitFileDiffs, commitLoadedDiffs, {
							source: fireOid,
							path,
						}),
					),
				);
				observation.attr("fullFile", String(options.showFullFile));
			});
		} else {
			await load();
		}
	} catch (error) {
		if (!requestIsCurrent()) return;
		commitDiffLoading = false;
		commitDiffError = loadErrorMessage(error);
	}
}

// Idempotent file selection, which never clears and never toggles. Loads the
// diff for `path` (or no-ops if already loaded). This is the seam the rune
// binds to: the jump gesture must never clear the file it's about to scroll
// into, otherwise rightPaneMode='diff' lands on a view with no selected file.
async function selectCommitFileIdempotent(path: string) {
	if (selectedCommitFile === path) return;

	selectedCommitFile = path;
	diffInViewPath = path;
	// Close the review panel (swap to diff) so the clicked file is visible (260531-l02d).
	if (reviewSession.state.reviewActive) reviewSession.showDiff();

	const options = buildDiffOptions();
	const loaded = loadedDiffFor(commitLoadedDiffs, {
		source: selectedCommitOid,
		path,
	});
	if (
		loaded &&
		loaded.options.contextLines === options.contextLines &&
		loaded.options.ignoreWhitespace === options.ignoreWhitespace &&
		loaded.options.showFullFile === options.showFullFile
	) {
		commitDiffLoadSeq += 1;
		commitDiffLoading = false;
		commitDiffError = null;

		return;
	}

	await reloadCommitFile(path, options, true);
}

// CommitDetail file clicks. A click on the open file keeps it open. The rune
// uses `selectCommitFileIdempotent` directly.
async function handleCommitFileSelect(path: string) {
	cancelPendingCommitSelection();
	await selectCommitFileIdempotent(path);
}

async function readSelectedFileDiff(): Promise<void> {
	const load = pendingSelectedDiff;
	if (!load) return;
	const repo = repoPath;
	try {
		const reloadOptions = load.options;
		const result = await requestStagingFileDiff(
			repo,
			load.kind,
			load.path,
			reloadOptions,
		);
		if (
			!repoViewActive ||
			repo !== repoPath ||
			load.generation !== selectGeneration ||
			selectedFile?.path !== load.path ||
			selectedFile.kind !== load.kind
		)
			return;
		// A fresh array, even of identical data, resets the pane's selection and
		// folds. Every index write re-reads the open file, so only a real change
		// may replace it.
		if (!sameData(stagingDiffFiles, result)) stagingDiffFiles = result;
		stagingDiffMode = load.mode;
		stagingDiffError = null;
	} catch (error) {
		if (
			!repoViewActive ||
			repo !== repoPath ||
			load.generation !== selectGeneration ||
			selectedFile?.path !== load.path ||
			selectedFile.kind !== load.kind
		)
			return;
		if (load.reportError) reportErrorToast(error, "Failed to load diff");
		stagingDiffError = loadErrorMessage(error);
	} finally {
		if (repoViewActive && load.generation === selectGeneration) {
			stagingDiffLoading = false;
		}
	}
}

function prepareSelectedFileDiff(
	path: string,
	kind: "unstaged" | "staged",
	options: DiffRequestOptions | undefined,
	reportError: boolean,
	advanceGeneration = true,
): void {
	if (advanceGeneration) selectGeneration += 1;
	const requestOptions = options ?? buildDiffOptions();
	pendingSelectedDiff = {
		path,
		kind,
		options: requestOptions,
		generation: selectGeneration,
		reportError,
		mode: modeFor(requestOptions),
	};
	stagingDiffLoading = true;
	stagingDiffError = null;
}

async function loadSelectedFileDiff(
	path: string,
	kind: "unstaged" | "staged",
	options: DiffRequestOptions | undefined,
	reportError: boolean,
): Promise<void> {
	prepareSelectedFileDiff(path, kind, options, reportError);
	await selectedDiffRefresh.run();
}

async function refetchFileDiff(
	path: string,
	kind: "unstaged" | "staged" | "conflicted",
	options?: DiffRequestOptions,
): Promise<void> {
	if (!repoPath || kind === "conflicted") return;
	await loadSelectedFileDiff(path, kind, options, false);
}

function handleTreeViewToggle() {
	treeViewEnabled = !treeViewEnabled;
	setTreeViewEnabled(treeViewEnabled);
}

// Load initial data
$effect(() => {
	void repoPath;
	void dirtyCountsRefresh.run();
	getTreeViewEnabled().then((v) => {
		if (repoViewActive) treeViewEnabled = v;
	});
});

// Rehydrate the persisted WIP commit draft once, before the first StagingPanel
// mount. CommitForm seeds its fields from props at init, so the StagingPanel
// render is gated on `draftLoaded` (below) — mounting before this resolves would
// seed from "" and never pick up the draft.
let commitRecoveryError = $state<string | null>(null);
const commitRecovery = getCommitDraft(untrack(() => repoPath))
	.then((d) => {
		if (d) {
			wipSubject = d.subject;
			wipBody = d.body;
		}
		draftLoaded = true;
	})
	.catch((error) => {
		commitRecoveryError = errorMessage(
			error,
			"Could not restore the saved commit draft",
		);
		reportErrorToast(error, "Could not restore the saved commit draft");
	});

const commitDraftTimer = createOwnedTimer();
let unsavedDraft: CommitDraft | null = null;
let initialDraftEffect = true;
$effect(() => {
	const subject = wipSubject;
	const body = wipBody;
	if (!draftLoaded) return;
	if (initialDraftEffect) {
		initialDraftEffect = false;
		return;
	}

	commitDraftTimer.cancel();
	unsavedDraft = null;
	if (subject === "" && body === "") {
		void clearCommitDraft(repoPath).catch((error) =>
			reportErrorToast(error, "Could not save commit draft"),
		);
		return;
	}
	unsavedDraft = { subject, body };
	commitDraftTimer.arm(saveUnsavedDraft, 400);
});

function saveUnsavedDraft() {
	const draft = unsavedDraft;
	unsavedDraft = null;
	if (draft === null) return;

	void setCommitDraft(repoPath, draft).catch((error) =>
		reportErrorToast(error, "Could not save commit draft"),
	);
}

onDestroy(saveUnsavedDraft);

let reviewRecoveryLoaded = $state(false);
let reviewRecoveryError = $state<string | null>(null);
const reviewRecovery = getReviewUpdateSnapshot(untrack(() => repoPath))
	.then(async (saved) => {
		if (!saved || !repoViewActive) return;
		const persisted = await getDraft(repoPath);
		const expected = saved.captured.anchor;
		const actual = persisted?.anchor;
		if (
			!persisted ||
			persisted.text !== saved.text ||
			persisted.whole_file !== (saved.captured.wholeFile === true) ||
			!actual ||
			actual.commit_oid !== expected.commit_oid ||
			actual.file_path !== expected.file_path ||
			actual.source !== expected.source ||
			actual.side !== expected.side ||
			actual.start_line !== expected.start_line ||
			actual.end_line !== expected.end_line
		)
			throw new Error(
				"The saved update draft differs from the current draft. Both have been retained for recovery.",
			);
		await reviewComments.refresh();
		if (reviewComments.activeReviewId !== saved.reviewId)
			throw new Error(
				"Switch back to the draft's original review and reopen this tab to recover it. The draft has been retained.",
			);
		const target = saved.target;
		if (target.context !== "normal" || !target.filePath)
			throw new Error("The saved comment view cannot be restored.");
		if (target.kind === "commit" && target.commitOid) {
			await selectCommitIdempotent(target.commitOid);
			await selectCommitFileIdempotent(target.filePath);
		} else if (target.kind === "staged" || target.kind === "unstaged") {
			await handleFileSelect(target.filePath, target.kind);
		} else {
			await openCurrentFile(target.filePath);
		}
		if (!repoViewActive) return;
		await restoreReviewUpdateComposer(reviewEditors, saved);
		await tick();
		if (
			diffComposerSession !== reviewEditors.composer(target, saved.reviewId) ||
			!showDiff ||
			currentSourceError
		)
			throw new Error(
				"The saved comment view could not open. The draft has been retained for recovery.",
			);
		await clearReviewUpdateSnapshot(repoPath);
	})
	.catch((error) => {
		reviewRecoveryError = errorMessage(
			error,
			"Could not restore the saved comment draft",
		);
		reportErrorToast(error, "Could not restore the saved comment draft");
	})
	.finally(() => {
		reviewRecoveryLoaded = true;
	});

void Promise.all([commitRecovery, reviewRecovery]).then(() => {
	if (repoViewActive)
		onrecoveryready?.(commitRecoveryError ?? reviewRecoveryError);
});

registerUpdateParticipant({
	capture: () => {
		const draft = { subject: wipSubject, body: wipBody };
		const review = reviewEditors.captureUpdate();
		const path = repoPath;
		return {
			generation: JSON.stringify([
				path,
				draft,
				review.generation,
				draftLoaded,
				reviewRecoveryLoaded,
			]),
			blocker:
				commitRecoveryError ??
				(!draftLoaded || !reviewRecoveryLoaded
					? "Wait for saved drafts to finish loading before restarting."
					: (reviewRecoveryError ?? review.blocker)),
			flush: async (permit) => {
				commitDraftTimer.cancel();
				unsavedDraft = null;
				await flushCommitDraftForUpdate(path, draft, permit);
				await flushReviewComposerForUpdate(path, review.composer, permit);
			},
			discard: () => clearReviewUpdateSnapshot(path),
		};
	},
});

function newestGraphRevision(
	current: number | undefined,
	received: number,
): number {
	return Math.max(current ?? 0, received);
}

// Ref publications wait for activation; local changes refresh worktree readers
// immediately. File-specific diffs exclude writes to unrelated paths (TRUNK-232).
$effect(() => {
	const path = repoPath;
	return subscribeToRepoChanges(path, {
		includeRefs: true,
		listenerSettled() {
			repoListenerSettled = true;
		},
		invalidate(event) {
			const changed = event.paths;
			refreshImmediately = event.command_completed ?? false;
			const notify = (task: CoalescedTask) => requestRepoChange(task, event);
			if (event.refs_only && event.graph_revision !== undefined) {
				pendingRefsRevision = newestGraphRevision(
					pendingRefsRevision,
					event.graph_revision,
				);
				return;
			}
			if (event.graph_revision !== undefined) {
				cachedGraphRevision = newestGraphRevision(
					cachedGraphRevision,
					event.graph_revision,
				);
				refreshSignal += 1;
				worktreeRefreshSignal += 1;
				sidebarRefreshSignal += 1;
			} else notify(repoNotification);
			notify(dirtyCountsRefresh);
			if (!concernsOpenFiles(changed)) return;

			notify(displayedDiffNotification);

			const selected = selectedFile;
			if (selected && selected.kind !== "conflicted") {
				prepareSelectedFileDiff(
					selected.path,
					selected.kind,
					undefined,
					false,
					false,
				);
				notify(selectedDiffRefresh);
			}
			const currentFile = selectedCurrentFile;
			if (currentFile !== null) {
				prepareCurrentFileRead(currentFile, false);
				notify(currentFileRefresh);
			}
		},
	});
});

$effect(() => {
	if (!tabActive || pendingRefsRevision === undefined) return;
	const revision = pendingRefsRevision;
	untrack(() => {
		cachedGraphRevision = newestGraphRevision(cachedGraphRevision, revision);
		pendingRefsRevision = undefined;
		sidebarRefreshSignal += 1;
	});
});

// Escape key handler for closing diffs
$effect(() => {
	function handleKeydown(e: KeyboardEvent) {
		if (isUpdateFrozen()) return;
		// Visited RepoViews stay mounted, so this window listener fires in
		// hidden tabs too — only the active tab may act on Escape.
		if (!tabActive) return;
		if (e.key !== "Escape") return;
		// The diff's own Escape, which clears a line selection, has already run.
		if (e.defaultPrevented) return;
		// An Escape typed into a field, the merge output included, is the field's.
		if (focusInEditable(document.activeElement)) return;
		// The diff or merge editor under the review panel is the one ending the
		// review returns to, so an Escape on the panel leaves it.
		if (reviewPanelShown) return;

		// The plan the rebase editor holds is lost when it closes, so Escape only
		// closes the diff open over it.
		if (showRebaseEditor) {
			if (rebaseDiffFile !== null) {
				e.preventDefault();
				closeRebaseDiff();
			}
		} else if (showDiff || showMergeEditor) {
			e.preventDefault();
			handleDiffClose();
		} else if (compare !== null) {
			e.preventDefault();
			handleCompareClose();
		} else if (requestedCommitOid !== null) {
			e.preventDefault();
			clearCommit();
		}
	}
	window.addEventListener("keydown", handleKeydown);
	return () => window.removeEventListener("keydown", handleKeydown);
});

// Single MessageEditor instance hosted here (D-04). The title is a $props on
// MessageEditor set BEFORE open() (D-03), so we flip a reactive $state var per
// operation: "Merge commit message" for merge, "Revert commit message" for revert.
let messageEditorRef = $state<MessageEditor | null>(null);
let editorTitle = $state("Merge commit message");
async function handleOpenMessageEditor(
	defaultValue: string,
	title: string,
): Promise<string | null> {
	editorTitle = title;
	return (await messageEditorRef?.open(defaultValue)) ?? null;
}

async function branchNameAt(oid: string): Promise<string | null> {
	try {
		const refs = await safeInvoke<RefsResponse>("list_refs", {
			path: repoPath,
		});
		for (const b of [...refs.local, ...refs.remote]) {
			try {
				const branchOid = await safeInvoke<string>("resolve_ref", {
					path: repoPath,
					refName: b.name,
				});
				if (branchOid === oid) return b.name;
			} catch {
				// ref resolution failed -- skip
			}
		}
	} catch {
		// listing refs failed -- no name to offer
	}

	return null;
}

async function resolveBase(oid: string | null): Promise<RebaseBase> {
	if (oid === null) return { kind: "root" };

	const name = await branchNameAt(oid);
	if (name === null) return { kind: "commit", oid };

	return { kind: "branch", name };
}

async function handleOpenRebaseEditor(baseOid: string, inclusive = false) {
	if (!repoPath) return;
	try {
		const todo = await safeInvoke<RebaseTodo>("get_rebase_todo", {
			path: repoPath,
			baseOid,
			inclusive,
		});
		if (todo.items.length === 0) {
			showToast(
				`Every commit on ${headBranch ?? "HEAD"} is already on that branch, so there is nothing to rebase.`,
				"success",
			);
			return;
		}

		rebaseEditorCommits = todo.items;
		rebaseBaseOid = todo.base_oid;
		rebaseBranchName = headBranch ?? "HEAD";
		const base = await resolveBase(todo.base_oid);
		rebaseFocusedCommitDetail = null;
		rebaseFocusedCommitStat = null;
		rebaseFocusedFileDiffs = [];
		rebaseLoadedDiffs = noLoadedDiffs();
		rebaseFocusedFileSelected = null;
		rebaseBase = base;
	} catch (e) {
		reportErrorToast(e, "Failed to load commits for rebase");
	}
}

function handleRebaseEditorClose() {
	rebaseFocusLoadSeq++;
	closeRebaseDiff();
	rebaseEditorCommits = [];
	rebaseBaseOid = null;
	rebaseBranchName = "";
	rebaseBase = null;
	rebaseFocusedCommitDetail = null;
	rebaseFocusedCommitStat = null;
	rebaseFocusedFileDiffs = [];
	rebaseLoadedDiffs = noLoadedDiffs();
}

function handleRebaseDiffClose() {
	closeRebaseDiff();
}

function handleRebaseDetailClose() {
	rebaseFocusedCommitDetail = null;
	rebaseFocusedCommitStat = null;
}

async function handleRebaseFocusChange(oid: string) {
	if (!repoPath) return;
	const loadSeq = ++rebaseFocusLoadSeq;
	const requestIsCurrent = () => loadSeq === rebaseFocusLoadSeq;
	closeRebaseDiff();
	try {
		const [detail, files, stat] = await Promise.all([
			safeInvoke<CommitDetailType>("get_commit_detail", {
				path: repoPath,
				oid,
			}),
			safeInvoke<FileDiff[]>("list_commit_files", {
				path: repoPath,
				oid,
			}),
			safeInvoke<DiffStat>("commit_stat", {
				path: repoPath,
				oid,
			}).catch(() => null),
		]);
		if (!requestIsCurrent()) return;

		rebaseFocusedCommitDetail = detail;
		rebaseFocusedFileDiffs = files;
		rebaseFocusedCommitStat = stat;

		// A file picked while these loaded was read against the commit drawn
		// before them, so it opens again on this one, or closes if this commit
		// leaves it alone.
		const openFile = rebaseDiffFile;
		if (openFile === null) return;

		if (files.some((file) => file.path === openFile)) {
			void reloadRebaseFile(openFile, buildDiffOptions());
		} else {
			closeRebaseDiff();
		}
	} catch {
		if (!requestIsCurrent()) return;

		rebaseFocusedCommitDetail = null;
		rebaseFocusedFileDiffs = [];
		rebaseFocusedCommitStat = null;
		// A file picked while these loaded has no commit left to be read against.
		closeRebaseDiff();
	}
}

async function reloadRebaseFile(path: string, options: DiffRequestOptions) {
	const oid = rebaseFocusedOid;
	if (!repoPath || !oid) return;

	const fireRepo = repoPath;
	const loadSeq = ++rebaseDiffLoadSeq;
	const requestIsCurrent = () =>
		repoViewActive &&
		loadSeq === rebaseDiffLoadSeq &&
		repoPath === fireRepo &&
		rebaseFocusedOid === oid &&
		rebaseDiffFile === path;
	rebaseDiffLoading = true;
	rebaseDiffError = null;

	try {
		const fileDiffs = await requestCommitFileDiff(fireRepo, oid, path, options);
		if (!requestIsCurrent()) return;

		if (fileDiffs[0]) {
			rebaseLoadedDiffs = withLoadedDiff(
				rebaseLoadedDiffs,
				{ source: oid, path },
				{ diff: fileDiffs[0], options: { ...options } },
			);
		}
		rebaseDiffLoading = false;
	} catch (e) {
		if (!requestIsCurrent()) return;

		rebaseDiffLoading = false;
		rebaseDiffError = loadErrorMessage(e);
		reportErrorToast(e, "Failed to load diff");
	}
}

async function loadRebaseFullFileForComment(
	filePath: string,
): Promise<FileDiff | null> {
	const oid = rebaseFocusedCommitDetail?.oid;
	if (!repoPath || !oid || rebaseDiffFile !== filePath) return null;

	const fireRepo = repoPath;
	const loadSeq = rebaseDiffLoadSeq;
	const options = { ...buildDiffOptions(), showFullFile: true };

	return await fileFromCurrentRead(
		requestCommitFileDiff(fireRepo, oid, filePath, options),
		filePath,
		() =>
			repoViewActive &&
			repoPath === fireRepo &&
			rebaseDiffLoadSeq === loadSeq &&
			rebaseFocusedCommitDetail?.oid === oid &&
			rebaseDiffFile === filePath,
	);
}

function closeRebaseDiff() {
	rebaseDiffLoadSeq++;
	rebaseFocusedFileSelected = null;
	rebaseDiffFile = null;
	rebaseDiffLoading = false;
	rebaseDiffError = null;
}

async function handleRebaseFileSelect(path: string) {
	if (rebaseFocusedFileSelected === path) return;

	rebaseFocusedFileSelected = path;
	rebaseDiffFile = path;
	await reloadRebaseFile(path, buildDiffOptions());
}

// The main pane stays mounted under the rebase editor, so a change of options
// reloads both: the pane would otherwise show the old options' payload under
// the new options' toolbar once the editor closes.
async function reloadOpenDiffs() {
	await Promise.all([
		showRebaseEditor && rebaseDiffFile
			? reloadRebaseFile(rebaseDiffFile, buildDiffOptions())
			: undefined,
		reloadShownDiff(),
	]);
}

async function reloadShownDiff() {
	const options = buildDiffOptions();
	if (selectedFile && selectedFile.kind !== "conflicted") {
		await refetchFileDiff(selectedFile.path, selectedFile.kind, options);
	} else if (selectedCompareFile && compare) {
		await reloadCompareFile(selectedCompareFile, options);
	} else if (selectedCommitFile && selectedCommitOid) {
		await reloadCommitFile(selectedCommitFile, options);
	}
}

// The content mode and the diff settings are shared by every tab, so a change
// made in any tab reloads the diff each mounted tab shows, hidden ones too.
let observedOptions = untrack(buildDiffOptions);
$effect(() => {
	const options = buildDiffOptions();
	if (sameData(options, observedOptions)) return;
	observedOptions = options;
	void reloadOpenDiffs();
});

/** The pane's Retry, which re-reads whatever the pane is showing. A current-file
 *  view carries no request options, which is why it is not reached through the
 *  options reload above: the shared options have nothing to change about it. */
async function retryVisibleDiff(): Promise<void> {
	const currentFile = shownCurrentFile;
	if (currentFile !== null) {
		prepareCurrentFileRead(currentFile, false);
		await currentFileRefresh.run();
		return;
	}
	await reloadShownDiff();
}

async function handleRebaseStart(
	todoItems: {
		oid: string;
		action: string;
		summary: string;
		newMessage: string | null;
	}[],
) {
	if (!repoPath) return;
	try {
		const result = await safeInvoke<{ kind: "completed" | "stopped" }>(
			"start_interactive_rebase",
			{ path: repoPath, baseOid: rebaseBaseOid, todoItems },
		);
		handleRebaseEditorClose();
		// The rebase rewrites the commits a selection or an open diff names.
		clearStagingDiff();
		clearCommit();
		if (result.kind === "stopped") {
			showToast("Rebase stopped — resolve it in the staging panel", "error");
		}
	} catch (e) {
		reportErrorToast(e, "Rebase failed");
	}
}
</script>

<div
	class="flex-1 overflow-hidden flex flex-col"
	{@attach inertWhile(!tabActive)}
>
	<PushRecoveryPrompt {repoPath} {remoteState} {refreshSignal} />
	<main
		class="flex-1 overflow-hidden flex relative"
		{@attach sidePanes.observeRow}
	>
		<!-- The graph and the panes stay mounted under the rebase editor, so leaving it
		     returns to the rows, scroll position and selection the user left. -->
		<div
			class="flex flex-1 overflow-hidden"
			class:invisible={showRebaseEditor}
			{@attach inertWhile(showRebaseEditor)}
		>
			<!-- Review mode puts the reviews where the branches were. The sidebar stays
			     mounted under it, since the graph's first page waits on its read. -->
			<div
				class="shrink-0 overflow-hidden grid"
				style:width="{sidePanes.sidebar.width}px"
				hidden={reviewMode}
				{@attach inertWhile(leftPaneCollapsed)}
			>
				<BranchSidebar
					onrefschange={(refs) => {
						headBranch = refs.local.find((branch) => branch.is_head)?.name;
					}}
					{repoPath}
					onrefreshed={handleRefresh}
					onvisibilitychanged={(graph) => commitGraphRef?.showGraph(graph)}
					onvisibilityresolved={() => {
						refVisibilityResolved = true;
					}}
					{repoListenerSettled}
					loadedRows={() => commitGraphRef?.loadedRows() ?? 0}
					onrefnavigate={handleRefNavigate}
					refreshSignal={sidebarRefreshSignal}
					{refreshImmediately}
					workingTreeDirty={wipCount > 0}
					onopenrebaseeditor={handleOpenRebaseEditor}
					onopenmessageeditor={handleOpenMessageEditor}
				/>
			</div>
			{#if reviewMode && !leftPaneCollapsed}
				<div
					class="shrink-0 overflow-hidden flex flex-col"
					style:width="{sidePanes.sidebar.width}px"
					bind:this={reviewListPane}
				>
					<LazyView load={() => import("./ReviewList.svelte")} label="reviews">
						{#snippet children(ReviewList)}
							<ReviewList {repoPath} {reviewComments} />
						{/snippet}
					</LazyView>
				</div>
			{/if}
			<Splitter
				variant="pane"
				aria-label="Resize sidebar"
				value={sidePanes.sidebar.width}
				min={0}
				max={sidePanes.sidebar.max}
				onstep={sidePanes.sidebar.step}
				ontoggle={sidePanes.sidebar.toggle}
				onmousedown={sidePanes.sidebar.startResize}
			/>
			<div class="flex-1 overflow-hidden relative">
				{#if reviewMode}
					<!-- Review panel claims the center pane (UI-SPEC:133). When the user selects a
             commit/file/ref (or jumps from a comment), rightPaneMode flips to 'diff' and
             the SAME full DiffPanel below renders — with the correct per-source diffKind
             and the complete handler set — rather than a separate stripped mount. The old
             diffKind="commit" clone here rendered every review diff (including dirty files
             reached via the panel→diff swap) as a commit diff, which dropped the staging
             buttons and mis-resolved comment anchors (260531-l02e). The panel stays
             mounted, hidden, while that diff shows, so closing the diff returns to the
             thread the jump left from rather than to the top of a fresh panel. Wrapper uses
             height:100% (not flex:1) so the ReviewPanel scroll body has a constrained
             height — its parent .flex-1 is a flex *child* (Phase 72 gap closure). -->
					<div
						class="flex flex-col h-full min-h-0 overflow-hidden"
						hidden={!reviewPanelShown}
					>
						<LazyView
							{onready}
							active={reviewPanelShown}
							load={() => import("./ReviewPanel.svelte")}
							label="review"
						>
							{#snippet children(ReviewPanel)}
								<ReviewPanel
									{repoPath}
									session={reviewSession}
									{reviewComments}
									{threadFilter}
									{onthreadfilterchange}
									editorSessionForThread={editorSessionForPanelThread}
									{editorNoteSessionFor}
									onJump={handleReviewJump}
									onJumpToCommit={handleReviewJumpToCommit}
									oncommentonfile={openFileFinder}
									onopenfile={openCurrentFile}
									headBranch={headBranch ?? null}
									shown={reviewPanelShown}
									keysActive={tabActive &&
										reviewPanelShown &&
										!showRebaseEditor}
									{windowFocused}
									reviewList={reviewListPane}
								/>
							{/snippet}
						</LazyView>
					</div>
				{/if}
				{#if showMergeEditor && selectedFile}
					{@const conflictedFile = selectedFile}
					<!-- Kept mounted under the review panel like the diff below, so the
             sides taken and the text typed survive the review. -->
					<div
						class="absolute inset-0"
						class:invisible={reviewPanelShown}
						{@attach inertWhile(reviewPanelShown)}
					>
						<LazyView
							active={!reviewPanelShown}
							{onready}
							load={() => import("./MergeEditor.svelte")}
							label="merge editor"
						>
							{#snippet children(MergeEditor)}
								<MergeEditor
									{repoPath}
									filePath={conflictedFile.path}
									onclose={handleDiffClose}
									onresolved={handleFileResolved}
								/>
							{/snippet}
						</LazyView>
					</div>
				{:else if showDiff}
					<!-- Single DiffPanel mount, shared by normal and review mode. In review mode
             rightPaneMode==='diff' routes here (260531-l02e); bind:this exposes the
             jump-to-comment scroll seam, and onclose returns to the review panel.
             While the review panel holds the pane the diff stays mounted under it,
             hidden and inert, the way the graph does, so ending the review returns
             to the line the user left rather than to the top of a fresh mount. -->
					<div
						class="absolute inset-0"
						class:invisible={reviewPanelShown}
						{@attach inertWhile(reviewPanelShown)}
					>
						<LazyView
							{onready}
							active={!reviewPanelShown}
							load={() => import("./DiffPanel.svelte")}
							label="diff"
						>
							{#snippet children(DiffPanel)}
								<DiffPanel
									bind:this={diffPanelRef}
									{diffPreferences}
									keysActive={tabActive &&
										!showRebaseEditor &&
										!reviewPanelShown}
									fileDiffs={currentDiffFiles}
									commitDetail={selectedCompareFile
										? compareTargetDetail
										: commitDetail}
									compareBaseOid={selectedCompareFile
										? (compareBaseDetail?.oid ?? null)
										: null}
									selectedPath={selectedCompareFile ?? selectedDiffPath}
									{diffKind}
									emptyCommit={commitEmpty}
									{repoPath}
									takesComments={diffTakesComments({
										compare: selectedCompareFile !== null,
										reviewMode,
										threadsHidden: reviewThreadsHidden,
									})}
									{reviewFilter}
									{viewComments}
									activeReviewId={reviewComments.activeReviewId}
									activeReview={reviewComments.activeReview}
									editorSessionForThread={editorSessionForDiffThread}
									composerSession={diffComposerSession}
									composerTarget={diffComposerTarget}
									refreshToken={diffRefreshToken}
									{contentMode}
									{oncontentmodechange}
									loading={currentSourceLoading}
									payloadStale={currentSourcePayloadStale}
									loadError={currentSourceError}
									onloadfullfile={loadFullFileForComment}
									onretry={() => {
										void retryVisibleDiff();
									}}
									onhunkaction={async (filePath) => {
										if (selectedFile) {
											await refetchFileDiff(filePath, selectedFile.kind);
										}
										await stagingPanelRef?.loadStatus();
									}}
									onfileemptied={(filePath, action) => {
										if (selectedFile?.path === filePath) {
											const { kind } = selectedFile;
											advanceToNextFile(filePath, kind);
											stagingPanelRef?.optimisticMove(filePath, kind, action);
											void stagingPanelRef
												?.loadStatus()
												.catch((error) =>
													reportErrorToast(error, "Failed to refresh status"),
												);
										}
									}}
									onclose={reviewSession.state.reviewActive
										? () => {
												handleDiffClose();
												reviewSession.showPanel();
											}
										: handleDiffClose}
									backLabel={reviewMode ? "Review" : null}
								/>
							{/snippet}
						</LazyView>
					</div>
				{/if}
				<div
					class="absolute inset-0"
					class:invisible={graphCovered}
					{@attach inertWhile(graphCovered)}
				>
					<CommitGraph
						{onready}
						bind:this={commitGraphRef}
						{repoPath}
						oncommitselect={handleCommitSelect}
						oncomparecommits={handleCompareCommits}
						oncommitnavigate={selectCommitIdempotent}
						oncommitschange={(items, hasMore) => {
							graphDisplayItems = items;
							graphHasMore = hasMore;
						}}
						{wipCount}
						wipMessage={wipSubject.trim()}
						{wipStats}
						onWipClick={handleWipClick}
						onFocusDraftSummary={focusDraftSummary}
						{draftSummaryFocused}
						refreshSignal={graphRefreshSignal}
						consumedRefreshSignal={consumedGraphRefreshSignal}
						onrefreshconsumed={(generation) => {
							consumedGraphRefreshSignal = Math.max(
								consumedGraphRefreshSignal,
								generation,
							);
						}}
						wipRefreshSignal={worktreeRefreshSignal}
						{cachedGraphRevision}
						{refreshImmediately}
						{selectedCommitOid}
						navigationCommitOid={requestedCommitOid}
						onopenrebaseeditor={handleOpenRebaseEditor}
						onopenmessageeditor={handleOpenMessageEditor}
						tabActive={tabActive && !graphCovered}
						commentCounts={presentation.byCommit}
						commentTallies={presentation.tallyByCommit}
						{reviewComments}
						{compareOids}
						visibilityResolved={refVisibilityResolved}
						{repoListenerSettled}
					/>
				</div>
			</div>
			<Splitter
				variant="pane"
				aria-label="Resize detail pane"
				value={sidePanes.detailPane.width}
				min={0}
				max={sidePanes.detailPane.max}
				hidden={reviewMode}
				onstep={sidePanes.detailPane.step}
				ontoggle={sidePanes.detailPane.toggle}
				onmousedown={sidePanes.detailPane.startResize}
			/>
			<div
				class="shrink-0 overflow-hidden flex flex-col"
				style:width="{sidePanes.detailPane.width}px"
				hidden={reviewMode}
				{@attach inertWhile(rightPaneCollapsed)}
			>
				{#if compare && compareTargetDetail}
					{@const comparisonTarget = compareTargetDetail}
					<LazyView
						load={() => import("./ComparePanel.svelte")}
						label="comparison"
						oncancel={handleCompareClose}
					>
						{#snippet children(ComparePanel)}
							<ComparePanel
								base={compareBaseDetail}
								target={comparisonTarget}
								fileDiffs={compareFileDiffs}
								stat={compareStat}
								selectedFile={selectedCompareFile}
								onfileselect={handleCompareFileSelect}
								onswap={handleCompareSwap}
								onclose={handleCompareClose}
								{treeViewEnabled}
								ontreeviewtoggle={handleTreeViewToggle}
							/>
						{/snippet}
					</LazyView>
				{:else if selectedCommitOid && commitDetail}
					{@const selectedDetail = commitDetail}
					<LazyView
						load={() => import("./CommitDetail.svelte")}
						label="commit details"
						oncancel={clearCommit}
					>
						{#snippet children(CommitDetail)}
							<CommitDetail
								commitDetail={selectedDetail}
								stat={commitDetailStat}
								fileDiffs={commitFileDiffs}
								selectedFile={selectedCommitFile}
								onfileselect={handleCommitFileSelect}
								onclose={clearCommit}
								{repoPath}
								{reviewComments}
								{reviewFilter}
								commentCounts={presentation.byFile}
								commentTallies={presentation.tallyByFile}
								activeReviewId={reviewComments.activeReviewId}
								editorSessionForThread={editorSessionForCommitNoteThread}
								{editorDraftFor}
								{treeViewEnabled}
								ontreeviewtoggle={handleTreeViewToggle}
								nav={commitNav}
								navigationNav={requestedCommitNav}
								pagerKeys={tabActive && !reviewMode && !showRebaseEditor}
								onnavigate={navigateToCommit}
							/>
						{/snippet}
					</LazyView>
				{:else if draftLoaded}
					<StagingPanel
						bind:this={stagingPanelRef}
						{repoPath}
						currentBranch={headBranch}
						initialSubject={wipSubject}
						{commitFormSession}
						initialBody={wipBody}
						onfileselect={handleFileSelect}
						onsubjectchange={(v) => (wipSubject = v)}
						onbodychange={(v) => (wipBody = v)}
						ondraftsummaryfocuschange={(focused) =>
							(draftSummaryFocused = focused)}
						onfileadvance={(path, kind) => {
							if (selectedFile?.path === path && selectedFile?.kind === kind) {
								advanceToNextFile(path, kind);
							}
						}}
						selectedPath={selectedFile?.path ?? null}
						selectedKind={selectedFile?.kind ?? null}
						onstatuschange={handleStatusChange}
						{treeViewEnabled}
						ontreeviewtoggle={handleTreeViewToggle}
						onopenmessageeditor={handleOpenMessageEditor}
						{reviewComments}
						commentCounts={presentation.byFile}
						commentTallies={presentation.tallyByFile}
					/>
				{/if}
			</div>
		</div>
		{#if rebaseBase}
			{@const editorBase = rebaseBase}
			<section
				aria-label="Interactive rebase"
				class="absolute inset-0 flex overflow-hidden"
			>
				<div class="flex-1 overflow-hidden">
					<div
						class="h-full flex-col"
						class:flex={!rebaseDiffFile}
						class:hidden={rebaseDiffFile}
					>
						<LazyView
							{onready}
							active={!rebaseDiffFile}
							load={() => import("./RebaseEditor.svelte")}
							label="rebase editor"
							oncancel={handleRebaseEditorClose}
						>
							{#snippet children(RebaseEditor)}
								<RebaseEditor
									{repoPath}
									commits={rebaseEditorCommits}
									branchName={rebaseBranchName}
									base={editorBase}
									onclose={handleRebaseEditorClose}
									onstart={handleRebaseStart}
									onfocuschange={handleRebaseFocusChange}
								/>
							{/snippet}
						</LazyView>
					</div>
					{#if rebaseDiffFile}
						<LazyView
							{onready}
							oncancel={handleRebaseDiffClose}
							load={() => import("./DiffPanel.svelte")}
							label="diff"
						>
							{#snippet children(DiffPanel)}
								<DiffPanel
									{diffPreferences}
									keysActive={tabActive}
									fileDiffs={rebaseShownDiff}
									commitDetail={rebaseFocusedCommitDetail}
									selectedPath={rebaseDiffFile}
									diffKind="commit"
									{repoPath}
									takesComments={diffTakesComments({
										compare: false,
										reviewMode: false,
										threadsHidden: reviewThreadsHidden,
									})}
									{reviewFilter}
									viewComments={rebaseViewComments}
									activeReviewId={reviewComments.activeReviewId}
									activeReview={reviewComments.activeReview}
									editorSessionForThread={editorSessionForDiffThread}
									composerSession={diffComposerSession}
									composerTarget={diffComposerTarget}
									{contentMode}
									{oncontentmodechange}
									loading={rebaseDiffLoading}
									payloadStale={rebaseDiffFile !== null &&
										!rebaseDiffError &&
										rebaseDiffMode !== contentMode}
									loadError={rebaseDiffError}
									onloadfullfile={loadRebaseFullFileForComment}
									onretry={() => {
										if (rebaseDiffFile)
											void reloadRebaseFile(rebaseDiffFile, buildDiffOptions());
									}}
									onclose={handleRebaseDiffClose}
								/>
							{/snippet}
						</LazyView>
					{/if}
				</div>
				<Splitter
					variant="pane"
					aria-label="Resize detail pane"
					value={sidePanes.rebaseDetailPane.width}
					min={0}
					max={sidePanes.rebaseDetailPane.max}
					onstep={sidePanes.rebaseDetailPane.step}
					ontoggle={sidePanes.rebaseDetailPane.toggle}
					onmousedown={sidePanes.rebaseDetailPane.startResize}
				/>
				<div
					class="shrink-0 overflow-hidden flex flex-col"
					style:width="{sidePanes.rebaseDetailPane.width}px"
					{@attach inertWhile(rightPaneCollapsed)}
				>
					{#if rebaseFocusedCommitDetail}
						{@const focusedDetail = rebaseFocusedCommitDetail}
						<LazyView
							load={() => import("./CommitDetail.svelte")}
							label="commit details"
							oncancel={handleRebaseDetailClose}
						>
							{#snippet children(CommitDetail)}
								<CommitDetail
									commitDetail={focusedDetail}
									stat={rebaseFocusedCommitStat}
									fileDiffs={rebaseFocusedFileDiffs}
									selectedFile={rebaseFocusedFileSelected}
									onfileselect={handleRebaseFileSelect}
									onclose={handleRebaseDetailClose}
									{repoPath}
									{reviewComments}
									{reviewFilter}
									commentCounts={presentation.byFile}
									commentTallies={presentation.tallyByFile}
									activeReviewId={reviewComments.activeReviewId}
									editorSessionForThread={editorSessionForCommitNoteThread}
									{editorDraftFor}
									{treeViewEnabled}
									ontreeviewtoggle={handleTreeViewToggle}
								/>
							{/snippet}
						</LazyView>
					{:else}
						<div
							class="flex items-center justify-center h-full text-text-muted text-body"
						>
							Select a commit to view details
						</div>
					{/if}
				</div>
			</section>
		{/if}
	</main>
</div>

{#if finderOpen}
	<FileFinder
		files={finderFiles}
		commentCounts={presentation.byCurrentFile}
		commentTallies={presentation.tallyByCurrentFile}
		onselect={openCurrentFile}
		onclose={() => (finderOpen = false)}
	/>
{/if}

<!-- Single MessageEditor host (D-04). Renders nothing until open() is called;
     the threaded onopenmessageeditor callback drives merge/revert message edits. -->
<MessageEditor bind:this={messageEditorRef} title={editorTitle} />

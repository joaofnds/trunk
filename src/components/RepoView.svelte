<script lang="ts">
import { listen } from "@tauri-apps/api/event";
import { onDestroy, untrack } from "svelte";
import { buildTree, collectFilePaths } from "../lib/build-tree.js";
import { createCoalescedTask } from "../lib/coalesced-task.js";
import { buildCommentCounts } from "../lib/comment-counts.js";
import {
	commentsForView,
	type PanelDiffKind,
	type ViewDescriptor,
} from "../lib/comment-matching.js";
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
import { errorMessage, reportErrorToast } from "../lib/error-report.js";
import { patchLoadedDiff } from "../lib/file-status.js";
import { safeInvoke } from "../lib/invoke.js";
import { span } from "../lib/perf.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import { subscribeToRepoChanges } from "../lib/repo-change-subscription.js";
import { createReviewComments } from "../lib/review-comments.svelte.js";
import {
	createReviewEditorStore,
	type ReviewComposerTarget,
	type ReviewEditorHost,
	type ReviewEditorStore,
} from "../lib/review-editors.svelte.js";
import {
	badgeToneForThread,
	combineReviewTone,
	countBadgeThreads,
} from "../lib/review-filter.js";
import { createReviewSession } from "../lib/review-session.svelte.js";
import { getScheduler } from "../lib/scheduler.js";
import {
	clearCommitDraft,
	getCommitDraft,
	getDiffContextLines,
	getDiffIgnoreWhitespace,
	getFetchIntervalMs,
	getTreeViewEnabled,
	setCommitDraft,
	setLeftPaneCollapsed,
	setLeftPaneWidth,
	setRightPaneCollapsed,
	setRightPaneWidth,
	setTreeViewEnabled,
} from "../lib/store.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	CommitDetail as CommitDetailType,
	ContentMode,
	DiffRequestOptions,
	DiffStat,
	FileDiff,
	GraphCommit,
	GraphResponse,
	RebaseTodo,
	RebaseTodoItem,
	RefsResponse,
	ReviewFilter,
	ReviewTone,
	Side,
	Thread,
	TrackedFile,
	WipStats,
	WorkingTreeStatus,
} from "../lib/types.js";
import type { UndoRedoManager } from "../lib/undo-redo.svelte.js";
import BranchSidebar from "./BranchSidebar.svelte";
import CommitDetail from "./CommitDetail.svelte";
import CommitGraph from "./CommitGraph.svelte";
import ComparePanel from "./ComparePanel.svelte";
import DiffPanel from "./DiffPanel.svelte";
import FileFinder from "./FileFinder.svelte";
import MergeEditor from "./MergeEditor.svelte";
import MessageEditor from "./MessageEditor.svelte";
import PushRecoveryPrompt from "./PushRecoveryPrompt.svelte";
import RebaseEditor from "./RebaseEditor.svelte";
import ReviewPanel from "./ReviewPanel.svelte";
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
	repoPath: string;
	repoName: string;
	remoteState: RemoteState;
	undoRedo: UndoRedoManager;
	leftPaneWidth: number;
	leftPaneCollapsed: boolean;
	rightPaneWidth: number;
	rightPaneCollapsed: boolean;
	windowVisible: boolean;
	// Whether this is the active tab. Every tab stays mounted, so window-global
	// menu events (search-toggle) need it to tell themselves apart.
	tabActive: boolean;
	// Review mode is toggled by the OS menu (review-toggle) at the App level so the
	// global event only affects the active tab; App passes the flag down per tab.
	reviewActive: boolean;
	// Global review presentation filter, owned by App (persisted pref).
	reviewFilter?: ReviewFilter;
	contentMode: ContentMode;
	oncontentmodechange: (mode: ContentMode) => void;
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
	onleftpanecollapsedchange: (collapsed: boolean) => void;
	onrightpanecollapsedchange: (collapsed: boolean) => void;
	onleftpanewidthchange: (width: number) => void;
	onrightpanewidthchange: (width: number) => void;
}

let {
	repoPath,
	repoName,
	remoteState,
	undoRedo,
	leftPaneWidth,
	leftPaneCollapsed,
	rightPaneWidth,
	rightPaneCollapsed,
	windowVisible,
	tabActive,
	reviewActive,
	reviewFilter = "all",
	contentMode,
	oncontentmodechange,
	onreviewpanelshowingchange,
	oncommentcountschange,
	onleftpanecollapsedchange,
	onrightpanecollapsedchange,
	onleftpanewidthchange,
	onrightpanewidthchange,
}: Props = $props();
const scheduler = getScheduler();
let repoViewActive = true;

const repoNotification = createCoalescedTask(scheduler, async () => {
	handleRefresh();
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
const reviewEditors: ReviewEditorStore = createReviewEditorStore();
onDestroy(() => reviewComments.destroy());

const editorSessionFor = (host: ReviewEditorHost) => (thread: Thread) =>
	reviewEditors.thread(reviewComments.activeReviewId, host, thread.id);
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
		if (reviewSession.state.reviewActive) reviewSession.showPanel();
	}).then((fn) => {
		unlisten = fn;
	});
	return () => unlisten?.();
});

// DiffPanel ref for jump-to-range scroll+highlight (Phase 69 / D-07).
let diffPanelRef = $state<{
	scrollToLine: (startLine: number, endLine: number, side: Side) => void;
} | null>(null);

// Bind the panel's jump affordance to the rune, wiring the existing RepoView
// machinery as the rune's navigation seams. The rune uses the IDEMPOTENT
// variants — handleCommitSelect/handleCommitFileSelect are toggles for graph
// and CommitDetail clicks (clicking the selected row clears it). The jump
// gesture must never clear the very target it's about to scroll to, otherwise
// the panel→diff swap lands on a blank diff with no selection (CR-03 / WR-04).
function handleReviewJump(comment: Thread) {
	reviewSession.jumpTo(comment, {
		selectCommit: selectCommitIdempotent,
		selectFile: selectCommitFileIdempotent,
		scrollToRange: (startLine, endLine, side) => {
			// The panel→diff swap destroys ReviewPanel and mounts a fresh DiffPanel;
			// diffPanelRef is bound during that render. Poll up to ~0.5s of frames
			// until it's available, then toast on exhaustion — the previous 3-frame
			// budget would silently no-op on slow machines or under heavy reactivity
			// work, contradicting the "never silently no-ops" guarantee (WR-05).
			// Budget passed explicitly at the seed call so the dependency is visible
			// (subsumes IN-04's brittle default-parameter call site).
			const SCROLL_RETRY_BUDGET = 30;
			const tryScroll = (retries: number) => {
				if (diffPanelRef) {
					diffPanelRef.scrollToLine(startLine, endLine, side);
				} else if (retries > 0) {
					requestAnimationFrame(() => tryScroll(retries - 1));
				} else {
					showToast("Could not scroll to comment location", "error");
				}
			};
			requestAnimationFrame(() => tryScroll(SCROLL_RETRY_BUDGET));
		},
	});
}

// Commit-header click in the review panel: select the commit (loads detail)
// and scroll the graph to it. Panel stays open — no view swap. Uses the
// idempotent variant so re-clicking the currently-selected commit's header
// does not toggle it off (CR-03's sister path).
async function handleReviewJumpToCommit(oid: string) {
	await selectCommitIdempotent(oid);
	await commitGraphRef?.scrollToOid(oid);
}

// Per-repo state
let refreshSignal = $state(0);
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
let selectedDiffEmptyGeneration = -1;

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
		if (seq !== finderLoadSeq || reviewFilter === "none") return;
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
		currentFileDiffs = result;
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
let commitDetail = $state<CommitDetailType | null>(null);
let commitDetailStat = $state<DiffStat | null>(null);
// Replace this array wholesale: $state.raw ignores an in-place mutation, so a
// push here updates nothing on screen.
let commitFileDiffs = $state.raw<FileDiff[]>([]);
let selectedCommitFile = $state<string | null>(null);
let commitDiffLoadSeq = 0;
let commitDiffLoading = $state(false);
let commitDiffError = $state<string | null>(null);
let commitDiffMode = $state<ContentMode | null>(null);
// Bumped on every selectCommitIdempotent call so an out-of-order commit-switch
// response can't clobber a newer one, and a failed switch's catch arm can tell
// it's still the latest before clearing state.
let commitSelectGeneration = 0;

// Compare selection (TRUNK-1): the Base → Target pair picked in the graph.
// Detail/file state loads per pair; a stale response is dropped by generation.
let compare = $state<ComparePair | null>(null);
let compareBaseDetail = $state<CommitDetailType | null>(null);
let compareTargetDetail = $state<CommitDetailType | null>(null);
// Replace this array wholesale: $state.raw ignores an in-place mutation, so a
// push here updates nothing on screen.
let compareFileDiffs = $state.raw<FileDiff[]>([]);
let compareStat = $state<DiffStat | null>(null);
let selectedCompareFile = $state<string | null>(null);
let compareGeneration = 0;
let compareDiffLoadSeq = 0;
let compareDiffLoading = $state(false);
let compareDiffError = $state<string | null>(null);
let compareDiffMode = $state<ContentMode | null>(null);
let compareOids = $derived<ReadonlySet<string>>(
	new Set(compare ? compare.picked : []),
);

// The WIP-inclusive display list + pagination state CommitGraph reports via
// oncommitschange, cached here so commitNav below can be recomputed on every
// selectedCommitOid change without requiring CommitGraph to be mounted — it
// unmounts for the whole duration of diff-in-view navigation (showDiff true).
let graphDisplayItems = $state<GraphCommit[]>([]);
let graphHasMore = $state(false);
let commitNav = $derived(
	computeCommitNav(graphDisplayItems, selectedCommitOid ?? null, graphHasMore),
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
	scrollToOid: (oid: string) => Promise<void>;
	showGraph: (graph: GraphResponse) => void;
	loadedRows: () => number;
} | null>(null);

// Gates CommitGraph's first page load on BranchSidebar's stored-visibility read, so
// the graph never paints open_repo's unfiltered default first (TRUNK-128). Starts
// false on every mount -- RepoView is remounted per repoPath via {#key} in App.svelte,
// so this does not need its own reset effect.
let refVisibilityResolved = $state(false);

// Rebase editor state
let showRebaseEditor = $state(false);
let rebaseEditorCommits = $state<RebaseTodoItem[]>([]);
let rebaseBaseOid = $state<string | null>(null);
let rebaseBranchName = $state("");
let rebaseBaseName = $state("");
let rebaseFocusedCommitDetail = $state<CommitDetailType | null>(null);
let rebaseFocusedCommitStat = $state<DiffStat | null>(null);
// Replace this array wholesale: $state.raw ignores an in-place mutation, so a
// push here updates nothing on screen.
let rebaseFocusedFileDiffs = $state.raw<FileDiff[]>([]);
let rebaseFocusedFileSelected = $state<string | null>(null);
let rebaseDiffFile = $state<string | null>(null);
let rebaseFocusLoadSeq = 0;
let rebaseDiffLoadSeq = 0;
let rebaseDiffLoading = $state(false);
let rebaseDiffError = $state<string | null>(null);
let rebaseDiffMode = $state<ContentMode | null>(null);

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
let showMergeEditor = $derived(selectedFile?.kind === "conflicted");

// The diffs to display: filtered commit file diff, staging diff, or the whole
// of a tracked file opened through the finder. A current-file view is last
// because any other selection supersedes it — selecting a staging file while
// one is open must show that file, not the one the finder opened.
let currentDiffFiles = $derived(
	selectedCompareFile
		? compareFileDiffs.filter((f) => f.path === selectedCompareFile)
		: selectedCommitFile
			? commitFileDiffs.filter((f) => f.path === selectedCommitFile)
			: selectedFile
				? stagingDiffFiles
				: selectedCurrentFile
					? currentFileDiffs
					: stagingDiffFiles,
);

// Whether the current-file view is the one on screen: every other selection
// supersedes it in `currentDiffFiles` above, and the rebase takeover replaces
// the pane outright.
let currentFileShown = $derived(
	selectedCurrentFile !== null &&
		!showRebaseEditor &&
		selectedCompareFile === null &&
		selectedCommitFile === null &&
		selectedFile === null,
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
let currentSourceLoading = $derived.by(() => {
	const loading = selectedCompareFile
		? compareDiffLoading
		: selectedCommitFile
			? commitDiffLoading
			: selectedFile
				? stagingDiffLoading
				: selectedCurrentFile
					? currentFileLoading
					: false;
	// A current-file view is forced to full-file content, so the global mode it
	// does not follow must not read as a payload still on its way.
	const hasRequestBackedSelection = Boolean(
		selectedCompareFile || selectedCommitFile || selectedFile,
	);
	return (
		loading ||
		(hasRequestBackedSelection &&
			!currentSourceError &&
			currentSourceMode !== contentMode)
	);
});

// ViewDescriptor for the current diff. resolveViewOid handles per-kind OID
// selection (commit→commitOid, unstaged/staged→snapshots, conflicted→null), so
// we only supply the commit oid + the session's current snapshot OIDs.
let viewDescriptor = $derived<ViewDescriptor>({
	kind: diffKind,
	commitOid: commitDetail?.oid ?? null,
	snapshots: reviewComments.snapshots,
});

// Comments matching the file currently shown in DiffPanel. Empty when no file
// is selected.
let viewComments = $derived(
	selectedDiffPath && !selectedCompareFile
		? commentsForView(reviewComments.threads, viewDescriptor, selectedDiffPath)
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

function toneForThreads(threads: Thread[]): ReviewTone | null {
	let tone: ReviewTone | null = null;
	for (const thread of threads) {
		const next = badgeToneForThread(thread, reviewFilter);
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

let inlineCommentTone = $derived(toneForThreads(currentViewComments));

// Total threads in the active review, for the Review button badge — independent
// of which pane the user is looking at. 0 with no threads, so the badge hides.
let reviewCommentTotal = $derived(
	countBadgeThreads(reviewComments.threads, reviewFilter),
);
let reviewCommentTone = $derived(toneForThreads(reviewComments.threads));

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

$effect(() => {
	if (reviewFilter === "none") {
		finderLoadSeq += 1;
		finderOpen = false;
	}
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
	} catch {
		// non-fatal -- keep previous counts
	}
}

async function loadHeadBranch() {
	const path = repoPath;
	try {
		const refs = await safeInvoke<RefsResponse>("list_refs", {
			path,
		});
		if (!repoViewActive || path !== repoPath) return;
		headBranch = refs.local.find((b) => b.is_head)?.name;
	} catch {
		// non-fatal -- keep previous value
	}
}

const dirtyCountsRefresh = createCoalescedTask(scheduler, loadDirtyCounts);
const headBranchRefresh = createCoalescedTask(scheduler, loadHeadBranch);

onDestroy(() => {
	repoViewActive = false;
	commitDiffLoadSeq += 1;
	compareDiffLoadSeq += 1;
	rebaseDiffLoadSeq += 1;
	currentFileGeneration += 1;
	repoNotification.dispose();
	dirtyCountsRefresh.dispose();
	headBranchRefresh.dispose();
	selectedDiffRefresh.dispose();
	currentFileRefresh.dispose();
});

function handleRefresh() {
	refreshSignal += 1;
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

// Every status refresh passes through here, including the one that follows an
// abort, a skip, or a Continue that finished. A conflicted selection describes a
// conflict, so when the status no longer lists that file as conflicted there is
// nothing left for the merge editor to show, whatever ended the operation.
function handleStatusChange(s: WorkingTreeStatus) {
	cachedStatus = s;

	if (
		selectedFile?.kind === "conflicted" &&
		!s.conflicted.some((file) => file.path === selectedFile?.path)
	) {
		clearStagingDiff();
	}
}

function clearCommitFileDiff() {
	commitDiffLoadSeq += 1;
	selectedCommitFile = null;
	commitDiffLoading = false;
	commitDiffError = null;
	commitDiffMode = null;
	diffInViewPath = null;
	commitEmpty = false;
}

function clearCommit() {
	commitDiffLoadSeq += 1;
	selectedCommitOid = null;
	commitDetail = null;
	commitDetailStat = null;
	commitFileDiffs = [];
	selectedCommitFile = null;
	diffInViewPath = null;
	commitEmpty = false;
	commitDiffLoading = false;
	commitDiffError = null;
	commitDiffMode = null;
}

// Request-local options are cached here; global content mode is owned by App
// and is derived at the request boundary so mounted tabs cannot drift.
let cachedDiffOptions = $state<Omit<DiffRequestOptions, "showFullFile">>({
	contextLines: 3,
	ignoreWhitespace: false,
});

$effect(() => {
	void repoPath; // re-load when repo changes
	Promise.all([getDiffContextLines(), getDiffIgnoreWhitespace()])
		.then(([contextLines, ignoreWhitespace]) => {
			cachedDiffOptions = { contextLines, ignoreWhitespace };
		})
		.catch(() => {});
});

function buildDiffOptions(): DiffRequestOptions {
	return { ...cachedDiffOptions, showFullFile: contentMode === "full" };
}

function modeFor(options: DiffRequestOptions): ContentMode {
	return options.showFullFile ? "full" : "hunk";
}

function loadErrorMessage(error: unknown): string {
	return errorMessage(error, "Failed to load diff");
}

function rememberLocalDiffOptions(options: DiffRequestOptions): void {
	cachedDiffOptions = {
		contextLines: options.contextLines,
		ignoreWhitespace: options.ignoreWhitespace,
	};
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

function handleDiffClose() {
	if (selectedCurrentFile) closeCurrentFile();
	else if (selectedCompareFile) selectedCompareFile = null;
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
	if (nextPath) {
		handleFileSelect(nextPath, section);
	} else {
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
	if (selectedFile?.path === path && selectedFile?.kind === kind) {
		clearStagingDiff();
		return;
	}
	selectedFile = { path, kind };
	// Close the review panel (swap to diff) so the clicked file is visible (260531-l02d).
	if (reviewSession.state.reviewActive) reviewSession.showDiff();
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
// seam the review-panel jump binds to (CR-03): the jump gesture must never
// clear the very target it's about to scroll to.
async function selectCommitIdempotent(oid: string) {
	// A jump or navigation lands on a single commit's diff, so any open compare
	// dissolves — otherwise the compare pane keeps rendering over the target.
	// Safe under applySelection: every transition that changes the anchor also
	// returns a null compare, so the applyCompare that follows never re-fetches.
	if (compare !== null) clearCompare();
	if (selectedCommitOid === oid && commitDetail !== null) return;
	// Switching to commit view -- close any open staging diff
	clearStagingDiff();
	selectedCommitFile = null;
	commitEmpty = false;

	// Auto-open right pane if collapsed (LAYOUT-01)
	if (rightPaneCollapsed) {
		onrightpanecollapsedchange(false);
	}

	selectedCommitOid = oid;
	const gen = ++commitSelectGeneration;
	// Selecting a commit/ref while the review panel is open swaps the center pane to
	// the diff so the user sees what they clicked (260531-l02d). showDiff is also what
	// the jump gesture does, so this is consistent (and harmless when review is off).
	if (reviewSession.state.reviewActive) reviewSession.showDiff();
	if (!repoPath) return;
	try {
		const [files, detail, stat] = await Promise.all([
			safeInvoke<FileDiff[]>("list_commit_files", {
				path: repoPath,
				oid,
			}),
			safeInvoke<CommitDetailType>("get_commit_detail", {
				path: repoPath,
				oid,
			}),
			safeInvoke<DiffStat>("commit_stat", {
				path: repoPath,
				oid,
			}).catch(() => null),
		]);
		if (gen !== commitSelectGeneration) return;
		commitFileDiffs = files;
		commitDetail = detail;
		commitDetailStat = stat;

		// Diff-in-view navigation: reconcile the remembered path against the new
		// commit's file list. Lives inline here, never in an $effect — an effect
		// reading and writing selection state loops (svelte_effect_callback_loop).
		if (diffInViewPath !== null) {
			const target = resolveDiffTarget(
				diffInViewPath,
				files.map((f) => f.path),
				treeViewEnabled,
			);
			if (target.kind === "file") {
				await selectCommitFileIdempotent(target.path);
			} else {
				commitEmpty = true;
			}
		}
	} catch {
		if (gen !== commitSelectGeneration) return;
		commitFileDiffs = [];
		commitDetail = null;
		commitDetailStat = null;
		commitEmpty = false;
		diffInViewPath = null;
	}
}

function clearCompare() {
	compareDiffLoadSeq += 1;
	compare = null;
	compareBaseDetail = null;
	compareTargetDetail = null;
	compareFileDiffs = [];
	compareStat = null;
	selectedCompareFile = null;
	compareDiffLoading = false;
	compareDiffError = null;
	compareDiffMode = null;
	compareGeneration++;
}

async function applyCompare(pair: ComparePair | null) {
	if (pair === null) {
		if (compare !== null) clearCompare();
		return;
	}
	compare = pair;
	selectedCompareFile = null;
	const gen = ++compareGeneration;
	if (rightPaneCollapsed) {
		onrightpanecollapsedchange(false);
	}
	if (!repoPath) return;
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
		if (gen !== compareGeneration) return;
		compareFileDiffs = files;
		compareStat = stat;
		compareBaseDetail = baseDetail;
		compareTargetDetail = targetDetail;
	} catch (e) {
		if (gen !== compareGeneration) return;
		reportErrorToast(e, "Failed to load comparison");
		clearCompare();
	}
}

async function applySelection(next: SelectionState) {
	if (next.selectedOid === null) {
		if (selectedCommitOid !== null) clearCommit();
	} else if (next.selectedOid !== selectedCommitOid) {
		await selectCommitIdempotent(next.selectedOid);
	}
	await applyCompare(next.compare);
}

function firstParentOfLoaded(oid: string): string | null {
	return graphDisplayItems.find((c) => c.oid === oid)?.parent_oids[0] ?? null;
}

async function handleCompareSwap() {
	await applyCompare(
		swapCompare({ selectedOid: selectedCommitOid, compare }).compare,
	);
}

// Fetch one file's Base → Target diff and patch the lightweight list entry
// with it. The pair is captured at fire time so a slow response for an old
// pair can't patch the new pair's list (same hazard as
// selectCommitFileIdempotent's fireOid).
async function reloadCompareFile(
	filePath: string,
	options: DiffRequestOptions,
) {
	if (!repoPath || !compare) return;
	const fireRepo = repoPath;
	const firePair = compare;
	const loadSeq = ++compareDiffLoadSeq;
	const requestMode = modeFor(options);
	const requestIsCurrent = () =>
		repoViewActive &&
		loadSeq === compareDiffLoadSeq &&
		repoPath === fireRepo &&
		compare === firePair &&
		selectedCompareFile === filePath;
	compareDiffLoading = true;
	compareDiffError = null;
	try {
		const fileDiffs = await safeInvoke<FileDiff[]>("diff_compare_file", {
			path: fireRepo,
			baseOid: firePair.baseOid,
			targetOid: firePair.targetOid,
			filePath,
			options,
		});
		if (!requestIsCurrent()) return;
		compareFileDiffs = patchLoadedDiff(compareFileDiffs, filePath, fileDiffs);
		compareDiffMode = requestMode;
		compareDiffLoading = false;
	} catch (error) {
		if (!requestIsCurrent()) return;
		compareDiffLoading = false;
		compareDiffError = loadErrorMessage(error);
	}
}

// Compare file clicks toggle like commit-detail file clicks.
async function handleCompareFileSelect(path: string) {
	if (selectedCompareFile === path) {
		compareDiffLoadSeq += 1;
		selectedCompareFile = null;
		compareDiffLoading = false;
		compareDiffError = null;
		compareDiffMode = null;
		return;
	}
	selectedCompareFile = path;
	await reloadCompareFile(path, buildDiffOptions());
}

// Graph clicks: a plain click keeps the existing toggle (re-clicking the
// selected commit clears it) and dissolves any compare; cmd/shift route
// through the compare state machine. The rune uses `selectCommitIdempotent`
// directly.
async function handleCommitSelect(oid: string, mods?: SelectModifiers) {
	const current: SelectionState = { selectedOid: selectedCommitOid, compare };
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
	if (selectedCommitOid === oid) {
		clearCommit();
		return;
	}
	await selectCommitIdempotent(oid);
}

/** Navigate to a commit from the detail-pane pager or topology chips: select it
 * (idempotent — never toggles) and center the graph on it. Mirrors the tail of
 * handleRefNavigate without the toggle hazard of handleCommitSelect. */
async function navigateToCommit(oid: string) {
	await selectCommitIdempotent(oid);
	await commitGraphRef?.scrollToOid(oid);
}

/** Resolve a ref name or OID to a commit OID, select it, and scroll the graph to it (GRAPH-03). */
async function handleRefNavigate(refNameOrOid: string) {
	if (!repoPath) return;

	let oid: string;

	// If it looks like a full git OID (40 hex chars), use directly (stash case)
	if (/^[0-9a-f]{40}$/i.test(refNameOrOid)) {
		oid = refNameOrOid;
	} else {
		// Resolve ref name to OID via backend
		try {
			oid = await safeInvoke<string>("resolve_ref", {
				path: repoPath,
				refName: refNameOrOid,
			});
		} catch {
			return; // ref not found -- ignore silently
		}
	}

	// Select commit (loads detail into right pane, also auto-opens pane via handleCommitSelect)
	await handleCommitSelect(oid);

	// Scroll graph to the commit row
	await commitGraphRef?.scrollToOid(oid);
}

function countDiffLines(fileDiffs: FileDiff[]): number {
	let total = 0;
	for (const fd of fileDiffs) {
		for (const hunk of fd.hunks) total += hunk.lines.length;
	}
	return total;
}

// Idempotent file selection — never clears, never toggles. Loads the diff
// for `path` (or no-ops if already loaded). This is the seam the rune binds
// to (WR-04): the jump gesture must never clear the file it's about to scroll
// into, otherwise rightPaneMode='diff' lands on a view with no selected file.
async function reloadCommitFile(
	path: string,
	options: DiffRequestOptions,
	observeOpen = false,
) {
	if (!repoPath || !selectedCommitOid) return;
	const fireRepo = repoPath;
	const fireOid = selectedCommitOid;
	const loadSeq = ++commitDiffLoadSeq;
	const requestMode = modeFor(options);
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
			const fileDiffs = await safeInvoke<FileDiff[]>("diff_commit_file", {
				path: fireRepo,
				oid: fireOid,
				filePath: path,
				options,
			});
			if (!requestIsCurrent()) return;
			commitFileDiffs = patchLoadedDiff(commitFileDiffs, path, fileDiffs);
			commitDiffMode = requestMode;
			commitDiffLoading = false;
		};

		if (observeOpen) {
			await span("diff.openCommitFile", async (observation) => {
				observation.attr("path", path);
				await load();
				if (!requestIsCurrent()) return;
				observation.attr(
					"lines",
					countDiffLines(commitFileDiffs.filter((file) => file.path === path)),
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

async function selectCommitFileIdempotent(path: string) {
	if (selectedCommitFile === path) return;
	selectedCommitFile = path;
	diffInViewPath = path;
	// Close the review panel (swap to diff) so the clicked file is visible (260531-l02d).
	if (reviewSession.state.reviewActive) reviewSession.showDiff();
	await reloadCommitFile(path, buildDiffOptions(), true);
}

// Toggle wrapper for CommitDetail file clicks: re-clicking the selected file
// clears it. The rune uses `selectCommitFileIdempotent` directly.
async function handleCommitFileSelect(path: string) {
	if (selectedCommitFile === path) {
		clearCommitFileDiff();
		return;
	}
	await selectCommitFileIdempotent(path);
}

async function readSelectedFileDiff(): Promise<void> {
	const load = pendingSelectedDiff;
	if (!load) return;
	const repo = repoPath;
	try {
		const command = load.kind === "unstaged" ? "diff_unstaged" : "diff_staged";
		const reloadOptions = load.options;
		const result = await safeInvoke<FileDiff[]>(command, {
			path: repo,
			filePath: load.path,
			options: reloadOptions,
		});
		if (
			!repoViewActive ||
			repo !== repoPath ||
			load.generation !== selectGeneration ||
			selectedFile?.path !== load.path ||
			selectedFile.kind !== load.kind
		)
			return;
		stagingDiffFiles = result;
		stagingDiffMode = load.mode;
		stagingDiffError = null;
		if (
			result.length === 0 ||
			result.every((file) => file.hunks.length === 0)
		) {
			selectedDiffEmptyGeneration = load.generation;
		}
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
): number {
	if (advanceGeneration) selectGeneration += 1;
	const generation = selectGeneration;
	const requestOptions = options ?? buildDiffOptions();
	selectedDiffEmptyGeneration = -1;
	pendingSelectedDiff = {
		path,
		kind,
		options: requestOptions,
		generation,
		reportError,
		mode: modeFor(requestOptions),
	};
	stagingDiffLoading = true;
	stagingDiffError = null;
	return generation;
}

async function loadSelectedFileDiff(
	path: string,
	kind: "unstaged" | "staged",
	options: DiffRequestOptions | undefined,
	reportError: boolean,
): Promise<boolean> {
	const generation = prepareSelectedFileDiff(path, kind, options, reportError);
	await selectedDiffRefresh.run();
	return selectedDiffEmptyGeneration === generation;
}

async function refetchFileDiff(
	path: string,
	kind: "unstaged" | "staged" | "conflicted",
	options?: DiffRequestOptions,
): Promise<boolean> {
	if (!repoPath || kind === "conflicted") return false;
	return loadSelectedFileDiff(path, kind, options, false);
}

function handleTreeViewToggle() {
	treeViewEnabled = !treeViewEnabled;
	setTreeViewEnabled(treeViewEnabled);
}

// Load initial data
$effect(() => {
	void repoPath;
	void dirtyCountsRefresh.run();
	void headBranchRefresh.run();
	getTreeViewEnabled().then((v) => {
		if (repoViewActive) treeViewEnabled = v;
	});
});

// Rehydrate the persisted WIP commit draft once, before the first StagingPanel
// mount. CommitForm seeds its fields from props at init, so the StagingPanel
// render is gated on `draftLoaded` (below) — mounting before this resolves would
// seed from "" and never pick up the draft.
getCommitDraft(untrack(() => repoPath)).then((d) => {
	if (d) {
		wipSubject = d.subject;
		wipBody = d.body;
	}
	draftLoaded = true;
});

// Debounce-persist the draft to disk. Empty drafts clear the entry immediately
// (no debounce window) so a hard kill right after committing or clearing can't
// resurface stale text. Guarded on `draftLoaded` so the initial rehydration
// doesn't trigger a write before the load resolves.
$effect(() => {
	const subject = wipSubject;
	const body = wipBody;
	if (!draftLoaded) return;

	if (subject.trim() === "" && body.trim() === "") {
		clearCommitDraft(repoPath);
		return;
	}

	const timer = setTimeout(() => {
		setCommitDraft(repoPath, { subject, body });
	}, 400);
	return () => clearTimeout(timer);
});

// Silent periodic background fetch. Pauses while the window is unfocused;
// backend swallows auth/rebase/busy cases so errors never surface.
$effect(() => {
	const path = repoPath;
	let timer: ReturnType<typeof setInterval> | undefined;
	let cancelled = false;

	(async () => {
		const intervalMs = await getFetchIntervalMs();
		if (cancelled || intervalMs <= 0) return;
		timer = setInterval(() => {
			// A remote op releases the per-repo lock before refresh_graph runs, so
			// without the isRunning guard an autonomous fetch races into that gap.
			if (!windowVisible || remoteState.isRunning) return;
			safeInvoke("git_fetch_background", { path }).catch(() => {});
		}, intervalMs);
	})();

	return () => {
		cancelled = true;
		if (timer) clearInterval(timer);
	};
});

// Listen for repo-changed events scoped to this repo
$effect(() => {
	const path = repoPath;
	return subscribeToRepoChanges(path, {
		invalidate() {
			repoNotification.invalidate();
			dirtyCountsRefresh.invalidate();
			headBranchRefresh.invalidate();
			const selected = selectedFile;
			if (selected && selected.kind !== "conflicted") {
				prepareSelectedFileDiff(
					selected.path,
					selected.kind,
					undefined,
					false,
					false,
				);
				selectedDiffRefresh.invalidate();
			}
			const currentFile = selectedCurrentFile;
			if (currentFile !== null) {
				prepareCurrentFileRead(currentFile, false);
				currentFileRefresh.invalidate();
			}
		},
	});
});

// Escape key handler for closing diffs
$effect(() => {
	function handleKeydown(e: KeyboardEvent) {
		// Every tab's RepoView stays mounted, so this window listener fires in
		// hidden tabs too — only the active tab may act on Escape.
		if (!tabActive) return;
		if (e.key !== "Escape" || showRebaseEditor) return;
		if (showDiff || showMergeEditor) {
			e.preventDefault();
			handleDiffClose();
		} else if (compare !== null) {
			e.preventDefault();
			clearCompare();
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

async function resolveBaseName(base: string | null): Promise<string> {
	if (base === null) return "root";

	return (await branchNameAt(base)) ?? base.slice(0, 7);
}

async function handleOpenRebaseEditor(baseOid: string, inclusive = false) {
	if (!repoPath) return;
	try {
		const todo = await safeInvoke<RebaseTodo>("get_rebase_todo", {
			path: repoPath,
			baseOid,
			inclusive,
		});
		if (todo.items.length === 0) return;
		rebaseEditorCommits = todo.items;
		rebaseBaseOid = todo.base_oid;
		rebaseBranchName = headBranch ?? "HEAD";
		rebaseBaseName = await resolveBaseName(todo.base_oid);
		// Clear any open diffs/selections before showing editor
		clearStagingDiff();
		clearCommit();
		rebaseFocusedCommitDetail = null;
		rebaseFocusedCommitStat = null;
		rebaseFocusedFileDiffs = [];
		rebaseFocusedFileSelected = null;
		showRebaseEditor = true;
	} catch (e) {
		reportErrorToast(e, "Failed to load commits for rebase");
	}
}

function handleRebaseEditorClose() {
	rebaseFocusLoadSeq++;
	rebaseDiffLoadSeq++;
	showRebaseEditor = false;
	rebaseEditorCommits = [];
	rebaseBaseOid = null;
	rebaseBranchName = "";
	rebaseBaseName = "";
	rebaseFocusedCommitDetail = null;
	rebaseFocusedCommitStat = null;
	rebaseFocusedFileDiffs = [];
	rebaseFocusedFileSelected = null;
	rebaseDiffFile = null;
	rebaseDiffLoading = false;
	rebaseDiffError = null;
	rebaseDiffMode = null;
}

async function handleRebaseFocusChange(oid: string) {
	if (!repoPath) return;
	const loadSeq = ++rebaseFocusLoadSeq;
	const requestIsCurrent = () => loadSeq === rebaseFocusLoadSeq;
	rebaseFocusedFileSelected = null;
	rebaseDiffFile = null;
	rebaseDiffLoadSeq++;
	rebaseDiffLoading = false;
	rebaseDiffError = null;
	rebaseDiffMode = null;
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
	} catch {
		if (!requestIsCurrent()) return;

		rebaseFocusedCommitDetail = null;
		rebaseFocusedFileDiffs = [];
		rebaseFocusedCommitStat = null;
	}
}

async function reloadRebaseFile(path: string, options: DiffRequestOptions) {
	const oid = rebaseFocusedCommitDetail?.oid;
	if (!repoPath || !oid) return;

	const fireRepo = repoPath;
	const loadSeq = ++rebaseDiffLoadSeq;
	const requestMode = modeFor(options);
	const requestIsCurrent = () =>
		repoViewActive &&
		loadSeq === rebaseDiffLoadSeq &&
		repoPath === fireRepo &&
		rebaseFocusedCommitDetail?.oid === oid &&
		rebaseDiffFile === path;
	rebaseDiffLoading = true;
	rebaseDiffError = null;

	try {
		const fileDiffs = await safeInvoke<FileDiff[]>("diff_commit_file", {
			path: fireRepo,
			oid,
			filePath: path,
			options,
		});
		if (!requestIsCurrent()) return;

		rebaseFocusedFileDiffs = patchLoadedDiff(
			rebaseFocusedFileDiffs,
			path,
			fileDiffs,
		);
		rebaseDiffMode = requestMode;
		rebaseDiffLoading = false;
	} catch (e) {
		if (!requestIsCurrent()) return;

		rebaseDiffLoading = false;
		rebaseDiffError = loadErrorMessage(e);
		reportErrorToast(e, "Failed to load diff");
	}
}

async function handleRebaseFileSelect(path: string) {
	if (rebaseFocusedFileSelected === path) {
		rebaseDiffLoadSeq++;
		rebaseFocusedFileSelected = null;
		rebaseDiffFile = null;
		rebaseDiffLoading = false;
		rebaseDiffError = null;
		rebaseDiffMode = null;
		return;
	}

	rebaseFocusedFileSelected = path;
	rebaseDiffFile = path;
	await reloadRebaseFile(path, buildDiffOptions());
}

async function reloadVisibleDiffForCurrentMode() {
	const options = buildDiffOptions();
	if (showRebaseEditor && rebaseDiffFile) {
		await reloadRebaseFile(rebaseDiffFile, options);
	} else if (selectedFile && selectedFile.kind !== "conflicted") {
		await refetchFileDiff(selectedFile.path, selectedFile.kind, options);
	} else if (selectedCompareFile && compare) {
		await reloadCompareFile(selectedCompareFile, options);
	} else if (selectedCommitFile && selectedCommitOid) {
		await reloadCommitFile(selectedCommitFile, options);
	}
}

let observedContentMode = untrack(() => contentMode);
$effect(() => {
	const nextMode = contentMode;
	if (nextMode === observedContentMode) return;
	observedContentMode = nextMode;
	void reloadVisibleDiffForCurrentMode();
});

/** The pane's Retry, which re-reads whatever the pane is showing. A current-file
 *  view carries no request options, which is why it is not reached through the
 *  mode reload above: the global mode has nothing to change about it. */
async function retryVisibleDiff(): Promise<void> {
	if (currentFileShown && selectedCurrentFile !== null) {
		prepareCurrentFileRead(selectedCurrentFile, false);
		await currentFileRefresh.run();
		return;
	}
	await reloadVisibleDiffForCurrentMode();
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
	const baseOid = rebaseBaseOid;
	handleRebaseEditorClose();
	try {
		const result = await safeInvoke<{ kind: "completed" | "stopped" }>(
			"start_interactive_rebase",
			{ path: repoPath, baseOid, todoItems },
		);
		if (result.kind === "stopped") {
			showToast("Rebase stopped — resolve it in the staging panel", "error");
		}
	} catch (e) {
		reportErrorToast(e, "Rebase failed");
	}
}

function startLeftResize(e: MouseEvent) {
	e.preventDefault();
	const startX = e.clientX;
	const startWidth = leftPaneCollapsed ? 0 : leftPaneWidth;

	function onMouseMove(ev: MouseEvent) {
		const newWidth = Math.max(0, startWidth + ev.clientX - startX);
		if (newWidth < 50) {
			onleftpanecollapsedchange(true);
		} else {
			onleftpanecollapsedchange(false);
			onleftpanewidthchange(Math.min(600, newWidth));
		}
	}

	function onMouseUp() {
		if (leftPaneCollapsed) {
			setLeftPaneCollapsed(true);
		} else {
			setLeftPaneWidth(leftPaneWidth);
			setLeftPaneCollapsed(false);
		}
		window.removeEventListener("mousemove", onMouseMove);
		window.removeEventListener("mouseup", onMouseUp);
	}

	window.addEventListener("mousemove", onMouseMove);
	window.addEventListener("mouseup", onMouseUp);
}

function startRightResize(e: MouseEvent) {
	e.preventDefault();
	const startX = e.clientX;
	const startWidth = rightPaneCollapsed ? 0 : rightPaneWidth;

	function onMouseMove(ev: MouseEvent) {
		const newWidth = Math.max(0, startWidth - (ev.clientX - startX));
		if (newWidth < 50) {
			onrightpanecollapsedchange(true);
		} else {
			onrightpanecollapsedchange(false);
			onrightpanewidthchange(Math.min(700, newWidth));
		}
	}

	function onMouseUp() {
		if (rightPaneCollapsed) {
			setRightPaneCollapsed(true);
		} else {
			setRightPaneWidth(rightPaneWidth);
			setRightPaneCollapsed(false);
		}
		window.removeEventListener("mousemove", onMouseMove);
		window.removeEventListener("mouseup", onMouseUp);
	}

	window.addEventListener("mousemove", onMouseMove);
	window.addEventListener("mouseup", onMouseUp);
}
</script>

<style>
  .pane-divider {
    width: 4px;
    flex-shrink: 0;
    cursor: col-resize;
    background: linear-gradient(to right, transparent 1.5px, var(--line-strong) 1.5px, var(--line-strong) 2.5px, transparent 2.5px);
    transition: background 0.15s;
  }
  .pane-divider:hover {
    background: linear-gradient(to right, transparent 1px, var(--color-accent) 1px, var(--color-accent) 3px, transparent 3px);
  }
</style>

<div class="flex-1 overflow-hidden flex flex-col">
  <PushRecoveryPrompt {repoPath} {remoteState} {refreshSignal} />
  <main class="flex-1 overflow-hidden flex">
    {#if showRebaseEditor}
      <!-- Full-window takeover for interactive rebase -->
      <div class="flex-1 overflow-hidden">
        <div style="height: 100%; {rebaseDiffFile ? 'display: none;' : 'display: flex; flex-direction: column;'}">
          <RebaseEditor
            {repoPath}
            commits={rebaseEditorCommits}
            branchName={rebaseBranchName}
            baseName={rebaseBaseName}
            onclose={handleRebaseEditorClose}
            onstart={handleRebaseStart}
            onfocuschange={handleRebaseFocusChange}
          />
        </div>
        {#if rebaseDiffFile}
          <DiffPanel
            fileDiffs={rebaseFocusedFileDiffs.filter((f) => f.path === rebaseDiffFile)}
            commitDetail={rebaseFocusedCommitDetail}
            selectedPath={rebaseDiffFile}
            diffKind="commit"
            {repoPath}
            reviewCommentsVisible={reviewFilter !== "none"}
            {reviewFilter}
            viewComments={rebaseViewComments}
            activeReviewId={reviewComments.activeReviewId}
            editorSessionForThread={editorSessionForDiffThread}
            composerSession={diffComposerSession}
            composerTarget={diffComposerTarget}
            {contentMode}
            {oncontentmodechange}
            loading={rebaseDiffLoading || (rebaseDiffFile !== null && !rebaseDiffError && rebaseDiffMode !== contentMode)}
            loadError={rebaseDiffError}
            onretry={() => { if (rebaseDiffFile) void reloadRebaseFile(rebaseDiffFile, buildDiffOptions()); }}
            ondiffoptionschange={async (options) => {
			  rememberLocalDiffOptions(options);
              if (rebaseDiffFile) await reloadRebaseFile(rebaseDiffFile, options);
            }}
            onclose={() => { rebaseDiffFile = null; }}
          />
        {/if}
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="pane-divider" onmousedown={startRightResize}></div>
      <div style="width: {rightPaneCollapsed ? 0 : rightPaneWidth}px; flex-shrink: 0; overflow: hidden; display: flex; flex-direction: column;">
        {#if rebaseFocusedCommitDetail}
          <CommitDetail
            commitDetail={rebaseFocusedCommitDetail}
            stat={rebaseFocusedCommitStat}
            fileDiffs={rebaseFocusedFileDiffs}
            selectedFile={rebaseFocusedFileSelected}
            onfileselect={handleRebaseFileSelect}
            onclose={() => { rebaseFocusedCommitDetail = null; rebaseFocusedCommitStat = null; }}
            {repoPath}
            reviewComments={reviewComments}
            reviewCommentsVisible={reviewFilter !== "none"}
            {reviewFilter}
            commentCounts={presentation.byFile}
            commentTones={presentation.toneByFile}
            activeReviewId={reviewComments.activeReviewId}
            editorSessionForThread={editorSessionForCommitNoteThread}
            editorDraftFor={editorDraftFor}
            {treeViewEnabled}
            ontreeviewtoggle={handleTreeViewToggle}
          />
        {:else}
          <div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--color-text-muted); font-size: 13px;">
            Select a commit to view details
          </div>
        {/if}
      </div>
    {:else}
    <div style="width: {leftPaneCollapsed ? 0 : leftPaneWidth}px; flex-shrink: 0; overflow: hidden; display: flex; flex-direction: column;">
      <BranchSidebar {repoPath} onrefreshed={handleRefresh} onvisibilitychanged={(graph) => commitGraphRef?.showGraph(graph)} onvisibilityresolved={() => { refVisibilityResolved = true; }} loadedRows={() => commitGraphRef?.loadedRows() ?? 0} onstashselect={handleCommitSelect} onrefnavigate={handleRefNavigate} {refreshSignal} workingTreeDirty={wipCount > 0} onopenrebaseeditor={handleOpenRebaseEditor} onopenmessageeditor={handleOpenMessageEditor} />
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pane-divider" style="display: {leftPaneCollapsed ? 'none' : 'block'};" onmousedown={startLeftResize}></div>
    <div class="flex-1 overflow-hidden">
      {#if reviewSession.state.reviewActive && !(reviewSession.state.rightPaneMode === 'diff' && showDiff)}
        <!-- Review panel claims the center pane (UI-SPEC:133). When the user selects a
             commit/file/ref (or jumps from a comment), rightPaneMode flips to 'diff' and
             the SAME full DiffPanel below renders — with the correct per-source diffKind
             and the complete handler set — rather than a separate stripped mount. The old
             diffKind="commit" clone here rendered every review diff (including dirty files
             reached via the panel→diff swap) as a commit diff, which dropped the staging
             buttons and mis-resolved comment anchors (260531-l02e). Wrapper uses
             height:100% (not flex:1) so the ReviewPanel scroll body has a constrained
             height — its parent .flex-1 is a flex *child* (Phase 72 gap closure). -->
        <div class="flex flex-col" style="height: 100%; min-height: 0; overflow: hidden;">
          <ReviewPanel {repoPath} session={reviewSession} {reviewComments} {reviewFilter} editorSessionForThread={editorSessionForPanelThread} editorNoteSessionFor={editorNoteSessionFor} onJump={handleReviewJump} onJumpToCommit={handleReviewJumpToCommit} oncommentonfile={openFileFinder} />
        </div>
      {:else if showMergeEditor && selectedFile}
        <MergeEditor
          {repoPath}
          filePath={selectedFile.path}
          onclose={handleDiffClose}
          onresolved={handleFileResolved}
        />
      {:else if showDiff}
        <!-- Single DiffPanel mount, shared by normal and review mode. In review mode
             rightPaneMode==='diff' routes here (260531-l02e); bind:this exposes the
             jump-to-comment scroll seam, and onclose returns to the review panel. -->
        <DiffPanel
          bind:this={diffPanelRef}
          fileDiffs={currentDiffFiles}
          commitDetail={selectedCompareFile ? compareTargetDetail : commitDetail}
          compareBaseOid={selectedCompareFile ? (compareBaseDetail?.oid ?? null) : null}
          selectedPath={selectedCompareFile ?? selectedDiffPath}
          {diffKind}
          emptyCommit={commitEmpty}
          {repoPath}
          reviewCommentsVisible={selectedCompareFile ? false : reviewFilter !== "none"}
          {reviewFilter}
          {viewComments}
          activeReviewId={reviewComments.activeReviewId}
          editorSessionForThread={editorSessionForDiffThread}
          composerSession={diffComposerSession}
          composerTarget={diffComposerTarget}
          refreshToken={diffRefreshToken}
          {contentMode}
          {oncontentmodechange}
          loading={currentSourceLoading}
          loadError={currentSourceError}
          onretry={() => { void retryVisibleDiff(); }}
          onhunkaction={async (filePath) => {
            if (selectedFile) {
              const { path, kind } = selectedFile;
              const isEmpty = await refetchFileDiff(filePath, kind);
              if (isEmpty && selectedFile?.path === path && selectedFile?.kind === kind) {
                advanceToNextFile(path, kind);
              }
            }
          }}
          onfileemptied={(filePath, action) => {
            if (selectedFile?.path === filePath) {
              const { kind } = selectedFile;
              advanceToNextFile(filePath, kind);
              stagingPanelRef?.optimisticMove(filePath, kind, action);
            }
          }}
          ondiffoptionschange={async (options) => {
			rememberLocalDiffOptions(options);
            if (selectedFile && selectedFile.kind !== "conflicted") {
              await refetchFileDiff(selectedFile.path, selectedFile.kind, options);
            } else if (selectedCompareFile && compare) {
              await reloadCompareFile(selectedCompareFile, options);
            } else if (selectedCommitFile && selectedCommitOid) {
              await reloadCommitFile(selectedCommitFile, options);
            }
          }}
          onclose={reviewSession.state.reviewActive
            ? () => { handleDiffClose(); reviewSession.showPanel(); }
            : handleDiffClose}
        />
      {:else}
        <CommitGraph bind:this={commitGraphRef} {repoPath} oncommitselect={handleCommitSelect} oncommitschange={(items, hasMore) => { graphDisplayItems = items; graphHasMore = hasMore; }} {wipCount} wipMessage={wipSubject.trim() || '// WIP'} {wipStats} onWipClick={handleWipClick} {refreshSignal} {selectedCommitOid} onopenrebaseeditor={handleOpenRebaseEditor} onopenmessageeditor={handleOpenMessageEditor} {tabActive} reviewCommentsVisible={reviewFilter !== "none"} commentCounts={presentation.byCommit} commentTones={presentation.toneByCommit} {reviewComments} {compareOids} visibilityResolved={refVisibilityResolved} />
      {/if}
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="pane-divider" style="display: {rightPaneCollapsed ? 'none' : 'block'};" onmousedown={startRightResize}></div>
    <div style="width: {rightPaneCollapsed ? 0 : rightPaneWidth}px; flex-shrink: 0; overflow: hidden; display: flex; flex-direction: column;">
      {#if compare && compareTargetDetail}
        <ComparePanel
          base={compareBaseDetail}
          target={compareTargetDetail}
          fileDiffs={compareFileDiffs}
          stat={compareStat}
          selectedFile={selectedCompareFile}
          onfileselect={handleCompareFileSelect}
          onswap={handleCompareSwap}
          onclose={clearCompare}
          {treeViewEnabled}
          ontreeviewtoggle={handleTreeViewToggle}
        />
      {:else if selectedCommitOid && commitDetail}
        <CommitDetail
          {commitDetail}
          stat={commitDetailStat}
          fileDiffs={commitFileDiffs}
          selectedFile={selectedCommitFile}
          onfileselect={handleCommitFileSelect}
          onclose={clearCommit}
          {repoPath}
          {reviewComments}
          reviewCommentsVisible={reviewFilter !== "none"}
          {reviewFilter}
          commentCounts={presentation.byFile}
          commentTones={presentation.toneByFile}
          activeReviewId={reviewComments.activeReviewId}
          editorSessionForThread={editorSessionForCommitNoteThread}
          {editorDraftFor}
          {treeViewEnabled}
          ontreeviewtoggle={handleTreeViewToggle}
          nav={commitNav}
          onnavigate={navigateToCommit}
        />
      {:else if draftLoaded}
        <StagingPanel
          bind:this={stagingPanelRef}
          {repoPath}
          currentBranch={headBranch}
          initialSubject={wipSubject}
          initialBody={wipBody}
          onfileselect={handleFileSelect}
          onsubjectchange={(v) => (wipSubject = v)}
          onbodychange={(v) => (wipBody = v)}
          onfileresolved={handleFileResolved}
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
          reviewCommentsVisible={reviewFilter !== "none"}
          commentCounts={presentation.byFile}
          commentTones={presentation.toneByFile}
        />
      {/if}
    </div>
    {/if}
  </main>
</div>

{#if finderOpen}
  <FileFinder
    files={finderFiles}
    commentCounts={presentation.byCurrentFile}
    commentTones={presentation.toneByCurrentFile}
    onselect={openCurrentFile}
    onclose={() => (finderOpen = false)}
  />
{/if}

<!-- Single MessageEditor host (D-04). Renders nothing until open() is called;
     the threaded onopenmessageeditor callback drives merge/revert message edits. -->
<MessageEditor bind:this={messageEditorRef} title={editorTitle} />

<script lang="ts">
import { listen } from "@tauri-apps/api/event";
import { onDestroy, untrack } from "svelte";
import { buildTree, collectFilePaths } from "../lib/build-tree.js";
import {
	commentsForView,
	type DiffKind,
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
import { reportErrorToast } from "../lib/error-report.js";
import { patchLoadedDiff } from "../lib/file-status.js";
import { safeInvoke } from "../lib/invoke.js";
import { span } from "../lib/perf.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import { createReviewComments } from "../lib/review-comments.svelte.js";
import { createReviewSession } from "../lib/review-session.svelte.js";
import {
	clearCommitDraft,
	getCommitDraft,
	getDiffContextLines,
	getDiffIgnoreWhitespace,
	getDiffShowFullFile,
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
	DiffRequestOptions,
	DiffStat,
	FileDiff,
	GraphCommit,
	RebaseTodo,
	RebaseTodoItem,
	RefsResponse,
	Side,
	Thread,
	WipStats,
	WorkingTreeStatus,
} from "../lib/types.js";
import type { UndoRedoManager } from "../lib/undo-redo.svelte.js";
import BranchSidebar from "./BranchSidebar.svelte";
import CommitDetail from "./CommitDetail.svelte";
import CommitGraph from "./CommitGraph.svelte";
import ComparePanel from "./ComparePanel.svelte";
import DiffPanel from "./DiffPanel.svelte";
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
	// Global "show inline comments" toggle, owned by App (persisted pref). Defaulted
	// here so the gate stays green until App threads it down.
	showInlineComments?: boolean;
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
	oncommentcountschange?: (counts: { view: number; total: number }) => void;
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
	showInlineComments = true,
	onreviewpanelshowingchange,
	oncommentcountschange,
	onleftpanecollapsedchange,
	onrightpanecollapsedchange,
	onleftpanewidthchange,
	onrightpanewidthchange,
}: Props = $props();

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
const reviewComments = createReviewComments(untrack(() => repoPath));
onDestroy(() => reviewComments.destroy());

$effect(() => {
	reviewSession.setReviewActive(reviewActive);
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
let selectGeneration = 0;
// Bumped on every debounced repo-changed so the rendered-markdown preview
// refetches alongside Source's fileDiffs (the fs watcher only reaches Source's
// data path; the preview holds its own fetch).
let diffRefreshToken = $state(0);
let cachedStatus = $state<WorkingTreeStatus | null>(null);
let stagingPanelRef = $state<StagingPanel | null>(null);

// Commit selection (from CommitGraph)
let selectedCommitOid = $state<string | null>(null);
let commitDetail = $state<CommitDetailType | null>(null);
// Replace this array wholesale: $state.raw ignores an in-place mutation, so a
// push here updates nothing on screen.
let commitFileDiffs = $state.raw<FileDiff[]>([]);
let selectedCommitFile = $state<string | null>(null);
// Bumped on every selectCommitIdempotent call so an out-of-order commit-switch
// response can't clobber a newer one, and a failed switch's catch arm can tell
// it's still the latest before clearing state.
let commitSelectGeneration = 0;

// Compare selection (TRUNK-001): the Base → Target pair picked in the graph.
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
} | null>(null);

// Rebase editor state
let showRebaseEditor = $state(false);
let rebaseEditorCommits = $state<RebaseTodoItem[]>([]);
let rebaseBaseOid = $state<string | null>(null);
let rebaseBranchName = $state("");
let rebaseBaseName = $state("");
let rebaseFocusedCommitDetail = $state<CommitDetailType | null>(null);
// Replace this array wholesale: $state.raw ignores an in-place mutation, so a
// push here updates nothing on screen.
let rebaseFocusedFileDiffs = $state.raw<FileDiff[]>([]);
let rebaseFocusedFileSelected = $state<string | null>(null);
let rebaseDiffFile = $state<string | null>(null);

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
		selectedCompareFile !== null,
);
let showMergeEditor = $derived(selectedFile?.kind === "conflicted");

// The diffs to display: filtered commit file diff, or staging diff
let currentDiffFiles = $derived(
	selectedCompareFile
		? compareFileDiffs.filter((f) => f.path === selectedCompareFile)
		: selectedCommitFile
			? commitFileDiffs.filter((f) => f.path === selectedCommitFile)
			: stagingDiffFiles,
);

// The diffKind the active DiffPanel renders under — mirrors the template prop
// (a conflicted file shows via MergeEditor, never DiffPanel, so it folds to the
// commit kind there too). Lifted to a derived so the matcher's ViewDescriptor
// and the rendered DiffPanel agree on one source of truth. The conflicted case
// is folded out, so this never widens to DiffKind's "conflicted" variant —
// keeping it assignable to DiffPanel's narrower prop union.
let diffKind = $derived<Exclude<DiffKind, "conflicted">>(
	selectedCommitFile
		? "commit"
		: selectedFile?.kind === "conflicted"
			? "commit"
			: (selectedFile?.kind ?? "commit"),
);

// The new-side path of the file shown in DiffPanel. FileDiff carries only a
// single (current) path — no old/new pair — so Old-side rename comments match
// by this new path and otherwise fall to panel-only (plan §6, acceptable v1).
let selectedDiffPath = $derived(
	selectedCommitFile ?? selectedFile?.path ?? null,
);

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

// Inline-comment badge count for the show-comments toggle: only the comments
// this toggle governs in the CURRENT view.
//   a diff open for a file → comments for that view/file
//   CommitDetail is the active right pane → commit-level notes for its oid
//   otherwise (commit graph / staging, no file) → 0 (nothing in this view)
let inlineCommentCount = $derived(
	compare
		? 0
		: showDiff && selectedDiffPath
			? viewComments.length
			: selectedCommitOid && commitDetail
				? reviewComments.threads.filter(
						(t) => t.anchor === null && t.commit_oid === commitDetail?.oid,
					).length
				: 0,
);

// Total threads in the active review, for the Review button badge — independent
// of which pane the user is looking at. 0 with no threads, so the badge hides.
let reviewCommentTotal = $derived(reviewComments.totalCount);

// Report both counts up through untrack: App's setCommentCounts copies the
// counts map (`new Map(commentCounts)`) before writing it, so calling the
// callback inside a tracked effect would make this effect depend on the very
// state it writes → effect_update_depth_exceeded. Reading both derived values
// before the untrack callback keeps the report one-way yet re-fires when either
// count changes.
$effect(() => {
	const view = inlineCommentCount;
	const total = reviewCommentTotal;
	untrack(() => oncommentcountschange?.({ view, total }));
});

async function loadDirtyCounts() {
	const seq = ++dirtyCountsSeq;
	try {
		const result = await safeInvoke<DirtyCounts>("get_dirty_counts", {
			path: repoPath,
		});
		if (seq !== dirtyCountsSeq) return;
		dirtyCounts = result;
	} catch {
		// non-fatal -- keep previous counts
	}
}

async function loadHeadBranch() {
	try {
		const refs = await safeInvoke<RefsResponse>("list_refs", {
			path: repoPath,
		});
		headBranch = refs.local.find((b) => b.is_head)?.name;
	} catch {
		// non-fatal -- keep previous value
	}
}

function handleRefresh() {
	refreshSignal += 1;
}

function clearStagingDiff() {
	selectedFile = null;
	stagingDiffFiles = [];
	stagingDiffLoading = false;
}

function clearCommitFileDiff() {
	selectedCommitFile = null;
	diffInViewPath = null;
	commitEmpty = false;
}

function clearCommit() {
	selectedCommitOid = null;
	commitDetail = null;
	commitFileDiffs = [];
	selectedCommitFile = null;
	diffInViewPath = null;
	commitEmpty = false;
}

// Cached diff options — loaded once on mount, updated via ondiffoptionschange callback.
// Avoids 3 prefs IPC reads per file click.
let cachedDiffOptions = $state<DiffRequestOptions>({
	contextLines: 3,
	ignoreWhitespace: false,
	showFullFile: false,
});

$effect(() => {
	void repoPath; // re-load when repo changes
	Promise.all([
		getDiffContextLines(),
		getDiffIgnoreWhitespace(),
		getDiffShowFullFile(),
	])
		.then(([contextLines, ignoreWhitespace, showFullFile]) => {
			cachedDiffOptions = { contextLines, ignoreWhitespace, showFullFile };
		})
		.catch(() => {});
});

function buildDiffOptions(): DiffRequestOptions {
	return cachedDiffOptions;
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
	if (selectedCompareFile) selectedCompareFile = null;
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
		stagingDiffFiles = [];
		return;
	}
	const gen = ++selectGeneration;
	stagingDiffLoading = true;
	try {
		const command = kind === "unstaged" ? "diff_unstaged" : "diff_staged";
		const options = buildDiffOptions();
		const result = await safeInvoke<FileDiff[]>(command, {
			path: repoPath,
			filePath: path,
			options,
		});
		if (gen !== selectGeneration) return;
		stagingDiffFiles = result;
	} catch (e) {
		if (gen !== selectGeneration) return;
		reportErrorToast(e, "Failed to load diff");
		stagingDiffFiles = [];
	} finally {
		if (gen === selectGeneration) {
			stagingDiffLoading = false;
		}
	}
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
		const [files, detail] = await Promise.all([
			safeInvoke<FileDiff[]>("list_commit_files", {
				path: repoPath,
				oid,
			}),
			safeInvoke<CommitDetailType>("get_commit_detail", {
				path: repoPath,
				oid,
			}),
		]);
		if (gen !== commitSelectGeneration) return;
		commitFileDiffs = files;
		commitDetail = detail;

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
		commitEmpty = false;
		diffInViewPath = null;
	}
}

function clearCompare() {
	compare = null;
	compareBaseDetail = null;
	compareTargetDetail = null;
	compareFileDiffs = [];
	compareStat = null;
	selectedCompareFile = null;
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

// Compare file clicks toggle like commit-detail file clicks, and patch the
// lightweight list entry with the full diff the same way.
async function handleCompareFileSelect(path: string) {
	if (selectedCompareFile === path) {
		selectedCompareFile = null;
		return;
	}
	selectedCompareFile = path;
	if (!repoPath || !compare) return;
	// Captured at fire time so a slow response for an old pair can't patch the
	// new pair's list (same hazard as selectCommitFileIdempotent's fireOid).
	const firePair = compare;
	try {
		const options = buildDiffOptions();
		const fileDiffs = await safeInvoke<FileDiff[]>("diff_compare_file", {
			path: repoPath,
			baseOid: firePair.baseOid,
			targetOid: firePair.targetOid,
			filePath: path,
			options,
		});
		if (compare !== firePair) return;
		compareFileDiffs = patchLoadedDiff(compareFileDiffs, path, fileDiffs);
	} catch {
		// Keep the lightweight entry — DiffPanel will show empty diff
	}
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
async function selectCommitFileIdempotent(path: string) {
	if (selectedCommitFile === path) return;
	selectedCommitFile = path;
	diffInViewPath = path;
	// Close the review panel (swap to diff) so the clicked file is visible (260531-l02d).
	if (reviewSession.state.reviewActive) reviewSession.showDiff();
	if (!repoPath || !selectedCommitOid) return;
	// Captured at fire time: a same-path reopen on a later commit switch can
	// resolve after this one, and the replacement below is path-keyed only, so
	// without this a slow response would patch the new commit's entry with the
	// old commit's hunks.
	const fireOid = selectedCommitOid;
	try {
		await span("diff.openCommitFile", async (observation) => {
			observation.attr("path", path);

			const options = buildDiffOptions();
			const fileDiffs = await safeInvoke<FileDiff[]>("diff_commit_file", {
				path: repoPath,
				oid: fireOid,
				filePath: path,
				options,
			});

			observation.attr("lines", countDiffLines(fileDiffs));
			observation.attr("fullFile", String(options.showFullFile));

			if (fireOid !== selectedCommitOid) return;
			// Replace the lightweight entry with the raw diff data
			commitFileDiffs = patchLoadedDiff(commitFileDiffs, path, fileDiffs);
		});
	} catch {
		// Keep the lightweight entry — DiffPanel will show empty diff
	}
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

async function refetchFileDiff(
	path: string,
	kind: "unstaged" | "staged" | "conflicted",
	options?: DiffRequestOptions,
): Promise<boolean> {
	if (!repoPath) return false;
	if (kind === "conflicted") return false; // MergeEditor handles its own data loading
	const gen = selectGeneration;
	try {
		const command = kind === "unstaged" ? "diff_unstaged" : "diff_staged";
		const reloadOptions = options ?? buildDiffOptions();
		const result = await safeInvoke<FileDiff[]>(command, {
			path: repoPath,
			filePath: path,
			options: reloadOptions,
		});
		if (gen !== selectGeneration) return false;
		stagingDiffFiles = result;
		return result.length === 0 || result.every((f) => f.hunks.length === 0);
	} catch {
		if (gen !== selectGeneration) return false;
		stagingDiffFiles = [];
		return false;
	}
}

function handleTreeViewToggle() {
	treeViewEnabled = !treeViewEnabled;
	setTreeViewEnabled(treeViewEnabled);
}

// Load initial data
$effect(() => {
	void repoPath;
	loadDirtyCounts();
	loadHeadBranch();
	getTreeViewEnabled().then((v) => {
		treeViewEnabled = v;
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
	let unlisten: (() => void) | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	const path = repoPath;

	listen<string>("repo-changed", (event) => {
		if (event.payload === path) {
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				handleRefresh();
				loadDirtyCounts();
				loadHeadBranch();
				diffRefreshToken += 1;
				if (selectedFile) {
					refetchFileDiff(selectedFile.path, selectedFile.kind);
				}
			}, 200);
		}
	}).then((fn) => {
		unlisten = fn;
	});

	return () => {
		unlisten?.();
		if (debounceTimer) clearTimeout(debounceTimer);
	};
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
		rebaseFocusedFileDiffs = [];
		rebaseFocusedFileSelected = null;
		showRebaseEditor = true;
	} catch (e) {
		reportErrorToast(e, "Failed to load commits for rebase");
	}
}

function handleRebaseEditorClose() {
	showRebaseEditor = false;
	rebaseEditorCommits = [];
	rebaseBaseOid = null;
	rebaseBranchName = "";
	rebaseBaseName = "";
	rebaseFocusedCommitDetail = null;
	rebaseFocusedFileDiffs = [];
	rebaseFocusedFileSelected = null;
	rebaseDiffFile = null;
}

async function handleRebaseFocusChange(oid: string) {
	if (!repoPath) return;
	rebaseFocusedFileSelected = null;
	rebaseDiffFile = null;
	try {
		const [detail, files] = await Promise.all([
			safeInvoke<CommitDetailType>("get_commit_detail", {
				path: repoPath,
				oid,
			}),
			safeInvoke<FileDiff[]>("list_commit_files", {
				path: repoPath,
				oid,
			}),
		]);
		rebaseFocusedCommitDetail = detail;
		rebaseFocusedFileDiffs = files;
	} catch {
		rebaseFocusedCommitDetail = null;
		rebaseFocusedFileDiffs = [];
	}
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
            fileDiffs={rebaseFocusedFileDiffs}
            selectedFile={rebaseFocusedFileSelected}
            onfileselect={(path) => {
              if (rebaseFocusedFileSelected === path) {
                rebaseFocusedFileSelected = null;
                rebaseDiffFile = null;
              } else {
                rebaseFocusedFileSelected = path;
                rebaseDiffFile = path;
              }
            }}
            onclose={() => { rebaseFocusedCommitDetail = null; }}
            {repoPath}
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
      <BranchSidebar {repoPath} onrefreshed={handleRefresh} onstashselect={handleCommitSelect} onrefnavigate={handleRefNavigate} {refreshSignal} onopenrebaseeditor={handleOpenRebaseEditor} onopenmessageeditor={handleOpenMessageEditor} />
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
          <ReviewPanel {repoPath} session={reviewSession} {reviewComments} onJump={handleReviewJump} onJumpToCommit={handleReviewJumpToCommit} />
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
          selectedPath={selectedCompareFile ?? selectedDiffPath}
          {diffKind}
          emptyCommit={commitEmpty}
          {repoPath}
          showInlineComments={selectedCompareFile ? false : showInlineComments}
          {viewComments}
          refreshToken={diffRefreshToken}
          loading={stagingDiffLoading}
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
            cachedDiffOptions = options;
            if (selectedFile && selectedFile.kind !== "conflicted") {
              await refetchFileDiff(selectedFile.path, selectedFile.kind, options);
            } else if (selectedCompareFile && compare) {
              const firePair = compare;
              try {
                const fileDiffs = await safeInvoke<FileDiff[]>("diff_compare_file", {
                  path: repoPath,
                  baseOid: firePair.baseOid,
                  targetOid: firePair.targetOid,
                  filePath: selectedCompareFile,
                  options,
                });
                if (compare === firePair) {
                  compareFileDiffs = patchLoadedDiff(compareFileDiffs, selectedCompareFile, fileDiffs);
                }
              } catch {
                // non-fatal
              }
            } else if (selectedCommitFile && selectedCommitOid) {
              try {
                const fileDiffs = await safeInvoke<FileDiff[]>("diff_commit_file", {
                  path: repoPath,
                  oid: selectedCommitOid,
                  filePath: selectedCommitFile,
                  options,
                });
                commitFileDiffs = patchLoadedDiff(commitFileDiffs, selectedCommitFile, fileDiffs);
              } catch {
                // non-fatal
              }
            }
          }}
          onclose={reviewSession.state.reviewActive
            ? () => { handleDiffClose(); reviewSession.showPanel(); }
            : handleDiffClose}
        />
      {:else}
        <CommitGraph bind:this={commitGraphRef} {repoPath} oncommitselect={handleCommitSelect} oncommitschange={(items, hasMore) => { graphDisplayItems = items; graphHasMore = hasMore; }} {wipCount} wipMessage={wipSubject.trim() || '// WIP'} {wipStats} onWipClick={handleWipClick} {refreshSignal} {selectedCommitOid} onopenrebaseeditor={handleOpenRebaseEditor} onopenmessageeditor={handleOpenMessageEditor} clearRedoStack={undoRedo.clear} {tabActive} {showInlineComments} {reviewComments} {compareOids} />
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
          fileDiffs={commitFileDiffs}
          selectedFile={selectedCommitFile}
          onfileselect={handleCommitFileSelect}
          onclose={clearCommit}
          {repoPath}
          {reviewComments}
          {showInlineComments}
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
          onstatuschange={(s) => { cachedStatus = s; }}
          clearRedoStack={undoRedo.clear}
          {treeViewEnabled}
          ontreeviewtoggle={handleTreeViewToggle}
          onopenmessageeditor={handleOpenMessageEditor}
          {reviewComments}
          {showInlineComments}
        />
      {/if}
    </div>
    {/if}
  </main>
</div>

<!-- Single MessageEditor host (D-04). Renders nothing until open() is called;
     the threaded onopenmessageeditor callback drives merge/revert message edits. -->
<MessageEditor bind:this={messageEditorRef} title={editorTitle} />

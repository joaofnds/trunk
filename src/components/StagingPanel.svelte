<script lang="ts">
import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
import FolderTree from "@lucide/svelte/icons/folder-tree";
import List from "@lucide/svelte/icons/list";
import Trash2 from "@lucide/svelte/icons/trash-2";
import { onDestroy } from "svelte";
import { copyText } from "../lib/clipboard.js";
import { createCoalescedTask } from "../lib/coalesced-task.js";
import { fileCountsForOid, fileTalliesForOid } from "../lib/comment-counts.js";
import { resolveViewOid } from "../lib/comment-matching.js";
import { errorMessage, reportErrorToast } from "../lib/error-report.js";
import { pathMenuEntriesOf } from "../lib/file-menu.js";
import { safeInvoke } from "../lib/invoke.js";
import {
	computeOutput,
	takeAllCurrent,
	takeAllIncoming,
} from "../lib/merge-parser.js";
import { subscribeToRepoChanges } from "../lib/repo-change-subscription.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import { getScheduler } from "../lib/scheduler.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	FileStatus,
	FileStatusType,
	MergeSides,
	OperationInfo,
	ReviewTally,
	WorkingTreeStatus,
} from "../lib/types.js";
import Badge from "../lib/ui/Badge.svelte";
import Button from "../lib/ui/Button.svelte";
import Row from "../lib/ui/Row.svelte";
import Splitter from "../lib/ui/Splitter.svelte";
import { registerUpdateBlocker } from "../lib/updates-context.js";
import BranchChip from "./BranchChip.svelte";
import CommitChip from "./CommitChip.svelte";
import CommitForm from "./CommitForm.svelte";
import OperationBanner from "./OperationBanner.svelte";
import TreeFileList from "./TreeFileList.svelte";

interface Props {
	repoPath: string;
	currentBranch?: string;
	onfileselect?: (
		path: string,
		kind: "unstaged" | "staged" | "conflicted",
	) => void;
	initialSubject?: string;
	initialBody?: string;
	onsubjectchange?: (value: string) => void;
	onbodychange?: (value: string) => void;
	onfileadvance?: (
		path: string,
		kind: "unstaged" | "staged" | "conflicted",
	) => void;
	selectedPath?: string | null;
	selectedKind?: "unstaged" | "staged" | "conflicted" | null;
	onstatuschange?: (status: WorkingTreeStatus) => void;
	treeViewEnabled?: boolean;
	ontreeviewtoggle?: () => void;
	// Threaded from RepoView (76-03); consumed by the merge-continue / revert
	// flows in Plan 04. Declared here so RepoView can pass it without a
	// svelte-check unknown-prop error in the interim wave seam.
	onopenmessageeditor?: (
		defaultValue: string,
		title: string,
	) => Promise<string | null>;
	// Shared comments store, threaded from RepoView for the review snapshots.
	reviewComments?: ReviewCommentsManager;
	commentCounts: Map<string, number>;
	commentTallies: Map<string, ReviewTally>;
}

let {
	repoPath,
	currentBranch,
	initialSubject,
	initialBody,
	onfileselect,
	onsubjectchange,
	onbodychange,
	onfileadvance,
	selectedPath = null,
	selectedKind = null,
	onstatuschange,
	treeViewEnabled = false,
	ontreeviewtoggle,
	onopenmessageeditor,
	reviewComments,
	commentCounts,
	commentTallies,
}: Props = $props();
const scheduler = getScheduler();

let status = $state<WorkingTreeStatus | null>(null);

// Per-section comment counts. Each section keys its map through the SAME
// resolveViewOid the diff uses, so a badge can never disagree with the diff:
// unstaged → working_tree_snapshot, staged → index_snapshot. Conflicted files
// render via MergeEditor (no inline comments), so resolveViewOid('conflicted')
// is null → no badges there, matching what their merge view shows.
function sectionCounts(kind: "unstaged" | "staged"): Map<string, number> {
	const oid = resolveViewOid({
		kind,
		commitOid: null,
		snapshots: reviewComments?.snapshots ?? {
			working_tree_snapshot: null,
			index_snapshot: null,
		},
	});
	return fileCountsForOid(commentCounts, oid);
}

function sectionTones(kind: "unstaged" | "staged"): Map<string, ReviewTally> {
	const oid = resolveViewOid({
		kind,
		commitOid: null,
		snapshots: reviewComments?.snapshots ?? {
			working_tree_snapshot: null,
			index_snapshot: null,
		},
	});
	return fileTalliesForOid(commentTallies, oid);
}

let unstagedCommentCounts = $derived(sectionCounts("unstaged"));
let stagedCommentCounts = $derived(sectionCounts("staged"));
let unstagedCommentTallies = $derived(sectionTones("unstaged"));
let stagedCommentTallies = $derived(sectionTones("staged"));

export function optimisticMove(
	filePath: string,
	from: "unstaged" | "staged" | "conflicted",
	action: "stage" | "unstage" | "discard",
) {
	if (!status) return;
	const file = status[from].find((f) => f.path === filePath);
	if (!file) return;
	const updated = {
		...status,
		[from]: status[from].filter((f) => f.path !== filePath),
	};
	if (action === "stage") {
		updated.staged = [
			...status.staged.filter((f) => f.path !== filePath),
			file,
		];
	} else if (action === "unstage") {
		updated.unstaged = [
			...status.unstaged.filter((f) => f.path !== filePath),
			file,
		];
	}
	loadSeq += 1;
	status = updated;
	onstatuschange?.(status);
}

let unstaged_expanded = $state(true);
let staged_expanded = $state(true);
let loadingFiles = $state<Set<string>>(new Set());
let loadSeq = 0;
let panelActive = true;
let conflicted_expanded = $state(true);
let operationInfo = $state<OperationInfo | null>(null);

let expandAllSignal = $state(0);
let collapseAllSignal = $state(0);

let isMerge = $derived(operationInfo?.op_type === "Merge");
let isRebase = $derived(operationInfo?.op_type === "Rebase");
let isOperation = $derived(isMerge || isRebase);
// The user's own edits stay listed beside a merge's conflicts so they can be
// staged or discarded. An empty list under the conflicts is only noise.
let showUnstaged = $derived(
	!isRebase &&
		!(
			(status?.conflicted.length ?? 0) > 0 &&
			(status?.unstaged.length ?? 0) === 0
		),
);

let rebaseProgressNum = $derived(operationInfo?.progress?.split("/")[0] ?? "?");
let rebaseProgressTotal = $derived(
	operationInfo?.progress?.split("/")[1] ?? "?",
);
let rebaseMsgSummary = $state("");
let rebaseMsgBody = $state("");
let lastRebaseMessage = $state("");
let savedRebaseFields = $state({ summary: "", body: "" });

// Sync editable message when operation info changes (new rebase step)
$effect(() => {
	const raw = operationInfo?.rebase_message ?? "";
	if (raw !== lastRebaseMessage) {
		lastRebaseMessage = raw;
		const clean = raw
			.split("\n")
			.filter((l: string) => !l.startsWith("#"))
			.join("\n")
			.trim();
		const lines = clean.split("\n");
		savedRebaseFields = {
			summary: lines[0] ?? "",
			body: lines.slice(1).join("\n").replace(/^\n/, ""),
		};
		rebaseMsgSummary = savedRebaseFields.summary;
		rebaseMsgBody = savedRebaseFields.body;
	}
});
let totalCount = $derived(
	(status?.unstaged.length ?? 0) +
		(status?.staged.length ?? 0) +
		(status?.conflicted.length ?? 0),
);
let allResolved = $derived((status?.conflicted.length ?? 0) === 0);

async function loadOperationState(path = repoPath) {
	const result = await safeInvoke<OperationInfo>("get_operation_state", {
		path,
	});
	if (!panelActive || path !== repoPath) return;
	operationInfo = result;
}

async function refreshStatus() {
	const seq = ++loadSeq;
	const path = repoPath;
	const result = await safeInvoke<WorkingTreeStatus>("get_status", {
		path,
	});
	if (panelActive && path === repoPath && seq === loadSeq) {
		status = result;
		onstatuschange?.(result);
	}
	if (panelActive && path === repoPath) await loadOperationState(path);
}

const statusRefresh = createCoalescedTask(scheduler, refreshStatus);
onDestroy(() => {
	panelActive = false;
	loadSeq += 1;
	statusRefresh.dispose();
});

export async function loadStatus() {
	await statusRefresh.run();
}

async function refreshStatusOrReport() {
	await loadStatus().catch((error) =>
		reportErrorToast(error, "Failed to refresh status"),
	);
}

function filesUnder(
	files: readonly FileStatus[] | undefined,
	dirPath: string,
): FileStatus[] {
	return (files ?? []).filter(
		(f) => f.path.startsWith(`${dirPath}/`) || f.path === dirPath,
	);
}

function stopLoading(paths: readonly string[]) {
	const next = new Set(loadingFiles);
	for (const p of paths) next.delete(p);
	loadingFiles = next;
}

/** Runs a change to these files with each of them busy until the status is
 *  read back, so the click shows it was taken and no row action races it. */
async function changeFiles(
	paths: readonly string[],
	failure: string,
	change: () => Promise<unknown>,
) {
	loadingFiles = new Set([...loadingFiles, ...paths]);
	try {
		await change();
	} catch (e) {
		reportErrorToast(e, failure);
	}
	await refreshStatusOrReport();
	stopLoading(paths);
}

const MARKER_NAMES_SHOWN = 5;

/** Whether to mark these conflicted files resolved, asking first when any of
 *  them still holds conflict markers, which staging would commit as content. */
async function confirmResolved(filePaths: string[]): Promise<boolean> {
	const marked = await safeInvoke<string[]>("conflict_marker_files", {
		path: repoPath,
		filePaths,
	});
	if (marked.length === 0) return true;

	const shown = marked.slice(0, MARKER_NAMES_SHOWN).join("\n");
	const rest = marked.length - MARKER_NAMES_SHOWN;
	const names = rest > 0 ? `${shown}\nand ${rest} more` : shown;
	const one = marked.length === 1;
	const { ask } = await import("@tauri-apps/plugin-dialog");
	return ask(
		`${one ? "This file still holds" : "These files still hold"} conflict markers:\n\n${names}\n\nMark ${one ? "it" : "them"} resolved anyway? The markers will be committed as content.`,
		{
			title: "Conflict Markers Remain",
			kind: "warning",
			okLabel: "Mark Resolved",
			cancelLabel: "Cancel",
		},
	);
}

async function stageFile(filePath: string, from: "unstaged" | "conflicted") {
	loadingFiles = new Set([...loadingFiles, filePath]);
	try {
		if (from === "conflicted" && !(await confirmResolved([filePath]))) {
			stopLoading([filePath]);
			return;
		}
		await safeInvoke("stage_file", { path: repoPath, filePath });
		onfileadvance?.(filePath, from);
		optimisticMove(filePath, from, "stage");
	} catch (e) {
		reportErrorToast(e, "Stage failed");
	}
	await refreshStatusOrReport();
	stopLoading([filePath]);
}

async function unstageFile(filePath: string) {
	loadingFiles = new Set([...loadingFiles, filePath]);
	try {
		await safeInvoke("unstage_file", { path: repoPath, filePath });
		onfileadvance?.(filePath, "staged");
		optimisticMove(filePath, "staged", "unstage");
	} catch (e) {
		reportErrorToast(e, "Unstage failed");
	}
	await refreshStatusOrReport();
	stopLoading([filePath]);
}

async function stageDirectory(dirPath: string) {
	const filePaths = filesUnder(status?.unstaged, dirPath).map((f) => f.path);
	if (filePaths.length === 0) return;

	await changeFiles(filePaths, "Stage failed", () =>
		safeInvoke("stage_files", { path: repoPath, filePaths }),
	);
}

async function unstageDirectory(dirPath: string) {
	const filePaths = filesUnder(status?.staged, dirPath).map((f) => f.path);
	if (filePaths.length === 0) return;

	await changeFiles(filePaths, "Unstage failed", () =>
		safeInvoke("unstage_files", { path: repoPath, filePaths }),
	);
}

async function stageAll() {
	const paths = (status?.unstaged ?? []).map((f) => f.path);
	await changeFiles(paths, "Stage all failed", () =>
		safeInvoke("stage_all", { path: repoPath }),
	);
}

async function unstageAll() {
	const paths = (status?.staged ?? []).map((f) => f.path);
	await changeFiles(paths, "Unstage all failed", () =>
		safeInvoke("unstage_all", { path: repoPath }),
	);
}

async function handleDiscardFile(filePath: string, fileStatus: FileStatusType) {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const isUntracked = fileStatus === "New";
	const msg = isUntracked
		? `Delete ${filePath}? This file is untracked and will be permanently removed. This cannot be undone.`
		: `Discard changes to ${filePath}? This cannot be undone.`;
	const confirmed = await ask(msg, {
		title: isUntracked ? "Delete File" : "Discard Changes",
		kind: "warning",
	});
	if (!confirmed) return;
	try {
		await safeInvoke("discard_file", { path: repoPath, filePath });
		onfileadvance?.(filePath, "unstaged");
		optimisticMove(filePath, "unstaged", "discard");
		showToast(`Discarded ${filePath}`, "success");
		await loadStatus();
	} catch (e) {
		reportErrorToast(e, "Discard failed");
	}
}

async function handleDiscardDirectory(dirPath: string) {
	const files = filesUnder(status?.unstaged, dirPath);
	if (files.length === 0) return;

	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		`Discard all changes in ${dirPath}/ (${files.length} file${files.length === 1 ? "" : "s"})? This cannot be undone.`,
		{ title: "Discard Directory Changes", kind: "warning" },
	);
	if (!confirmed) return;

	const filePaths = files.map((f) => f.path);
	await changeFiles(filePaths, "Discard failed", async () => {
		await safeInvoke("discard_files", { path: repoPath, filePaths });
		showToast(
			`Discarded ${files.length} file${files.length === 1 ? "" : "s"} in ${dirPath}/`,
			"success",
		);
	});
}

async function showUnstagedContextMenu(
	_e: MouseEvent,
	filePath: string,
	fileStatus: FileStatusType,
) {
	const { Menu, MenuItem, PredefinedMenuItem } = await import(
		"@tauri-apps/api/menu"
	);
	const isUntracked = fileStatus === "New";
	const absPath = `${repoPath}/${filePath}`;
	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					copyText(filePath);
				},
			}),
			await MenuItem.new({
				text: "Copy Absolute Path",
				action: () => {
					copyText(absPath);
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: "Stage File",
				action: () => {
					stageFile(filePath, "unstaged");
				},
			}),
			await MenuItem.new({
				text: isUntracked ? "Delete File" : "Discard Changes",
				action: () => {
					handleDiscardFile(filePath, fileStatus).catch(() => {});
				},
			}),
		],
	});
	await menu.popup();
}

async function showUnstagedDirContextMenu(_e: MouseEvent, dirPath: string) {
	const { Menu, MenuItem, PredefinedMenuItem } = await import(
		"@tauri-apps/api/menu"
	);
	const absPath = `${repoPath}/${dirPath}`;
	const files = filesUnder(status?.unstaged, dirPath);
	if (files.length === 0) return;

	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					copyText(dirPath);
				},
			}),
			await MenuItem.new({
				text: "Copy Absolute Path",
				action: () => {
					copyText(absPath);
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: `Stage All (${files.length})`,
				action: () => {
					stageDirectory(dirPath);
				},
			}),
			await MenuItem.new({
				text: `Discard All (${files.length})`,
				action: () => {
					handleDiscardDirectory(dirPath).catch(() => {});
				},
			}),
		],
	});
	await menu.popup();
}

async function showStagedContextMenu(
	_e: MouseEvent,
	filePath: string,
	oldPath: string | null,
) {
	const { Menu, MenuItem, PredefinedMenuItem } = await import(
		"@tauri-apps/api/menu"
	);
	const menu = await Menu.new({
		items: [
			...(await Promise.all(
				pathMenuEntriesOf(repoPath, filePath, oldPath).map((entry) =>
					MenuItem.new({
						text: entry.text,
						action: () => {
							copyText(entry.value);
						},
					}),
				),
			)),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: "Unstage File",
				action: () => {
					unstageFile(filePath);
				},
			}),
		],
	});
	await menu.popup();
}

async function showStagedDirContextMenu(_e: MouseEvent, dirPath: string) {
	const { Menu, MenuItem, PredefinedMenuItem } = await import(
		"@tauri-apps/api/menu"
	);
	const absPath = `${repoPath}/${dirPath}`;
	const files = filesUnder(status?.staged, dirPath);
	if (files.length === 0) return;

	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					copyText(dirPath);
				},
			}),
			await MenuItem.new({
				text: "Copy Absolute Path",
				action: () => {
					copyText(absPath);
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: `Unstage All (${files.length})`,
				action: () => {
					unstageDirectory(dirPath);
				},
			}),
		],
	});
	await menu.popup();
}

async function resolveConflictedFile(
	filePath: string,
	side: "ours" | "theirs",
) {
	try {
		const sides = await safeInvoke<MergeSides>("get_merge_sides", {
			path: repoPath,
			filePath,
		});
		// The same result the editor's Take All buttons give: the conflicting
		// lines come from the chosen side and the rest is the text git merged,
		// since the menu item and the button carry the same name.
		const taken =
			side === "ours"
				? takeAllCurrent(sides.regions)
				: takeAllIncoming(sides.regions);
		const content = computeOutput(sides.regions, taken);
		await safeInvoke("save_merge_result", {
			path: repoPath,
			filePath,
			content,
		});
		onfileadvance?.(filePath, "conflicted");
		await loadStatus();
	} catch (e) {
		reportErrorToast(e, "Resolution failed");
	}
}

async function showConflictedContextMenu(_e: MouseEvent, filePath: string) {
	const { Menu, MenuItem, PredefinedMenuItem } = await import(
		"@tauri-apps/api/menu"
	);
	const absPath = `${repoPath}/${filePath}`;
	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Take All Current",
				action: () => {
					resolveConflictedFile(filePath, "ours").catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Take All Incoming",
				action: () => {
					resolveConflictedFile(filePath, "theirs").catch(() => {});
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					copyText(filePath);
				},
			}),
			await MenuItem.new({
				text: "Copy Absolute Path",
				action: () => {
					copyText(absPath);
				},
			}),
		],
	});
	await menu.popup();
}

async function resolveDirectory(dirPath: string) {
	const filePaths = filesUnder(status?.conflicted, dirPath).map((f) => f.path);
	if (filePaths.length === 0) return;

	await resolveFiles(filePaths);
}

async function showConflictedDirContextMenu(_e: MouseEvent, dirPath: string) {
	const { Menu, MenuItem, PredefinedMenuItem } = await import(
		"@tauri-apps/api/menu"
	);
	const absPath = `${repoPath}/${dirPath}`;
	const files = filesUnder(status?.conflicted, dirPath);
	if (files.length === 0) return;

	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					copyText(dirPath);
				},
			}),
			await MenuItem.new({
				text: "Copy Absolute Path",
				action: () => {
					copyText(absPath);
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: `Resolve All (${files.length})`,
				action: () => {
					resolveDirectory(dirPath);
				},
			}),
		],
	});
	await menu.popup();
}

async function handleDiscardAll() {
	const paths = (status?.unstaged ?? []).map((f) => f.path);
	const count = paths.length;
	if (count === 0) return;

	const files = `${count} file${count === 1 ? "" : "s"}`;
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		`Discard all changes to ${files}? This cannot be undone.`,
		{ title: "Discard All Changes", kind: "warning" },
	);
	if (!confirmed) return;

	await changeFiles(paths, "Discard all failed", async () => {
		await safeInvoke("discard_all", { path: repoPath });
		showToast(`Discarded all changes (${files})`, "success");
	});
}

// ---------- Merge-mode actions ----------
async function markAllResolved() {
	await resolveFiles((status?.conflicted ?? []).map((f) => f.path));
}

async function resolveFiles(filePaths: string[]) {
	await changeFiles(filePaths, "Resolution failed", async () => {
		if (!(await confirmResolved(filePaths))) return;
		await safeInvoke("stage_files", { path: repoPath, filePaths });
	});
}

let mergeLoading = $state(false);

// Route the merge-continue commit through the single host-owned MessageEditor.
// The default comes verbatim from git's MERGE_MSG (MSG-04 — never constructed in
// the frontend); cancel/empty returns null and makes no commit (D-02 — the
// in-progress merge stays visible and recoverable, so this button is also the
// clean-merge retry affordance).
async function runMergeContinue() {
	mergeLoading = true;
	try {
		const def = await safeInvoke<string | null>("get_merge_message", {
			path: repoPath,
		});
		const msg = await onopenmessageeditor?.(def ?? "", "Merge commit message");
		if (msg == null) return;
		await safeInvoke("merge_continue", { path: repoPath, message: msg });
		showToast("Merge completed", "success");
	} catch (e) {
		reportErrorToast(e, "Merge commit failed");
	} finally {
		mergeLoading = false;
		await loadStatus();
	}
}

async function abortMerge() {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		"Abort merge? This will discard all merge progress and return to the previous state.",
		{ title: "Abort Merge", kind: "warning" },
	);
	if (!confirmed) return;
	mergeLoading = true;
	try {
		await safeInvoke("merge_abort", { path: repoPath });
		showToast("Merge aborted", "success");
	} catch (e) {
		reportErrorToast(e, "Abort failed");
	} finally {
		mergeLoading = false;
		await loadStatus();
	}
}

// ---------- Rebase-mode actions ----------
let rebaseLoading = $state(false);

async function continueRebase() {
	rebaseLoading = true;
	try {
		const msg = rebaseMsgBody.trim()
			? `${rebaseMsgSummary.trim()}\n\n${rebaseMsgBody.trim()}`
			: rebaseMsgSummary.trim();
		await safeInvoke("rebase_continue", {
			path: repoPath,
			message: msg || null,
		});
	} catch (e) {
		const msg = errorMessage(e, "");
		if (
			msg.toLowerCase().includes("conflict") ||
			msg.toLowerCase().includes("resolve")
		) {
			showToast("Resolve all conflicts before continuing", "error");
		} else {
			showToast(msg || "Rebase continue failed", "error");
		}
	} finally {
		rebaseLoading = false;
		await loadStatus();
	}
}

async function abortRebase() {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		"Abort rebase? This will return to the pre-rebase state.",
		{
			title: "Abort Rebase",
			kind: "warning",
		},
	);
	if (!confirmed) return;
	rebaseLoading = true;
	try {
		await safeInvoke("rebase_abort", { path: repoPath });
		showToast("Rebase aborted", "success");
	} catch (e) {
		reportErrorToast(e, "Abort failed");
	} finally {
		rebaseLoading = false;
		await loadStatus();
	}
}

async function skipRebase() {
	rebaseLoading = true;
	try {
		await safeInvoke("rebase_skip", { path: repoPath });
	} catch (e) {
		reportErrorToast(e, "Skip failed");
	} finally {
		rebaseLoading = false;
		await loadStatus();
	}
}

// --- Bottom form resize ---
const BOTTOM_MIN = 168;
const BOTTOM_MAX = 500;
let bottomHeight = $state(220);

function resizeBottom(height: number) {
	bottomHeight = Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, height));
}

function startBottomResize(e: MouseEvent) {
	e.preventDefault();
	const startY = e.clientY;
	const startHeight = bottomHeight;

	function onMouseMove(ev: MouseEvent) {
		resizeBottom(startHeight + startY - ev.clientY);
	}

	function onMouseUp() {
		window.removeEventListener("mousemove", onMouseMove);
		window.removeEventListener("mouseup", onMouseUp);
	}

	window.addEventListener("mousemove", onMouseMove);
	window.addEventListener("mouseup", onMouseUp);
}

// Initial load on mount
$effect(() => {
	if (repoPath) {
		void refreshStatusOrReport();
	}
});

// Auto-refresh on repo-changed event
$effect(() => {
	return subscribeToRepoChanges(repoPath, statusRefresh);
});
registerUpdateBlocker(() => {
	if (!isRebase) return null;

	return rebaseMsgSummary !== savedRebaseFields.summary ||
		rebaseMsgBody !== savedRebaseFields.body
		? "Save or discard the paused rebase message before restarting."
		: null;
});
</script>

{#snippet sectionTitle(label: string, count: number)}
	<span class="flex-1 min-w-0 inline-flex items-center gap-2">
		<span
			class="min-w-0 truncate text-text-muted text-caption font-semibold tracking-widest uppercase"
			>{label}</span
		>
		<Badge variant="label" tone="muted">{count}</Badge>
	</span>
{/snippet}

<div class="w-full min-w-0 flex flex-col h-full overflow-hidden bg-surface">
	<!-- Panel header -->
	<div
		class="h-bar bg-surface-raised shadow-hairline py-0 px-3 flex items-center justify-center gap-2 shrink-0"
	>
		<span class="flex-1 flex items-center justify-center gap-2 min-w-0">
			<span class="text-callout text-text">
				{`${totalCount} file${totalCount === 1 ? "" : "s"} changed`}
			</span>
			{#if currentBranch}
				<span class="text-small text-text-muted">on</span>
				<BranchChip name={currentBranch} />
			{/if}
		</span>
		{#if treeViewEnabled}
			<Button
				icon
				size="sm"
				variant="ghost"
				aria-label="Expand all directories"
				title="Expand All"
				onclick={(e) => {
					e.stopPropagation();
					expandAllSignal++;
				}}
			>
				<ChevronsUpDown size={14} />
			</Button>
			<Button
				icon
				size="sm"
				variant="ghost"
				aria-label="Collapse all directories"
				title="Collapse All"
				onclick={(e) => {
					e.stopPropagation();
					collapseAllSignal++;
				}}
			>
				<ChevronsDownUp size={14} />
			</Button>
		{/if}
		<Button
			icon
			size="sm"
			variant="ghost"
			role="switch"
			aria-checked={treeViewEnabled}
			aria-label={treeViewEnabled
				? "Switch to list view"
				: "Switch to tree view"}
			title={treeViewEnabled ? "List view" : "Tree view"}
			onclick={(e) => {
				e.stopPropagation();
				ontreeviewtoggle?.();
			}}
		>
			{#if treeViewEnabled}
				<FolderTree size={14} />
			{:else}
				<List size={14} />
			{/if}
		</Button>
	</div>

	<!-- Operation banners -->
	{#if isRebase && operationInfo}
		<!-- Rebase conflict/progress header -->
		{#if (status?.conflicted.length ?? 0) > 0}
			<div
				class="h-bar bg-badge-warning-bg shadow-hairline flex items-center justify-center gap-2 shrink-0"
			>
				<span class="text-badge-warning inline-flex items-center">
					<AlertTriangle size={12} />
				</span>
				<span class="text-callout font-semibold text-badge-warning"
					>Rebase conflicts detected</span
				>
			</div>
		{/if}
		<div
			class="h-bar shadow-hairline py-0 px-3 flex items-center justify-center gap-2 shrink-0 text-small text-text-muted"
		>
			Rebasing
			{#if operationInfo.source_branch}
				<BranchChip name={operationInfo.source_branch} />
			{/if}
			onto
			{#if operationInfo.target_branch}
				<BranchChip name={operationInfo.target_branch} />
			{:else if operationInfo.onto_oid}
				<CommitChip oid={operationInfo.onto_oid} />
			{/if}
		</div>
	{:else if operationInfo && operationInfo.op_type !== "None"}
		<OperationBanner
			info={operationInfo}
			{repoPath}
			resolved={allResolved}
			{onopenmessageeditor}
			onaction={() => {
				loadStatus();
			}}
		/>
	{/if}

	<!-- File sections: the expanded ones share the height evenly -->
	<div class="flex-1 flex flex-col overflow-hidden min-h-0">
		<!-- Conflicted Files section (rebase: always shown; otherwise only when conflicts exist) -->
		{#if isRebase || (status?.conflicted.length ?? 0) > 0}
			<div
				class="flex flex-col overflow-hidden min-h-0"
				class:flex-1={conflicted_expanded && staged_expanded}
				class:section-capped={conflicted_expanded && !staged_expanded}
			>
				<Row
					variant="band"
					reveal="always"
					onclick={() => (conflicted_expanded = !conflicted_expanded)}
				>
					<span class="text-text-muted inline-flex items-center mr-1">
						{#if conflicted_expanded}
							<ChevronDown size={12} />
						{:else}
							<ChevronRight size={12} />
						{/if}
					</span>
					{@render sectionTitle(
						"Conflicted Files",
						status?.conflicted.length ?? 0,
					)}
					{#snippet actions()}
						{#if (status?.conflicted.length ?? 0) > 0}
							<Button size="sm" variant="success" onclick={markAllResolved}>
								Mark All Resolved
							</Button>
						{/if}
					{/snippet}
				</Row>

				{#if conflicted_expanded}
					<TreeFileList
						files={status?.conflicted ?? []}
						treeMode={treeViewEnabled}
						actionLabel="+"
						{loadingFiles}
						onfileaction={(path) => stageFile(path, "conflicted")}
						onfileclick={(path) => onfileselect?.(path, "conflicted")}
						onfilecontextmenu={(e, path) => showConflictedContextMenu(e, path)}
						ondirectoryaction={(dirPath) => resolveDirectory(dirPath)}
						ondirectorycontextmenu={(e, dirPath) =>
							showConflictedDirContextMenu(e, dirPath)}
						selectedPath={selectedKind === "conflicted" ? selectedPath : null}
						{expandAllSignal}
						{collapseAllSignal}
					/>
				{/if}
			</div>
		{/if}

		<!-- Unstaged Files section (hidden during a rebase, and beside conflicts when it would be empty) -->
		{#if showUnstaged}
			<div
				data-testid="staging-unstaged-section"
				class="flex flex-col overflow-hidden min-h-0"
				class:flex-1={unstaged_expanded && staged_expanded}
				class:section-capped={unstaged_expanded && !staged_expanded}
			>
				<Row
					variant="band"
					reveal="always"
					onclick={() => (unstaged_expanded = !unstaged_expanded)}
				>
					<span class="text-text-muted inline-flex items-center mr-1">
						{#if unstaged_expanded}
							<ChevronDown size={12} />
						{:else}
							<ChevronRight size={12} />
						{/if}
					</span>
					{@render sectionTitle("Unstaged Files", status?.unstaged.length ?? 0)}
					{#snippet actions()}
						{#if (status?.unstaged.length ?? 0) > 0}
							<Button
								icon
								size="sm"
								variant="danger"
								onclick={handleDiscardAll}
								aria-label="Discard all changes"
								tooltip="Discard All"
							>
								<Trash2 size={14} aria-hidden="true" />
							</Button>
							<Button
								size="sm"
								variant="success"
								onclick={stageAll}
								aria-label="Stage all changes"
							>
								Stage All
							</Button>
						{/if}
					{/snippet}
				</Row>

				{#if unstaged_expanded}
					<TreeFileList
						files={status?.unstaged ?? []}
						treeMode={treeViewEnabled}
						actionLabel="+"
						{loadingFiles}
						onfileaction={(path) => stageFile(path, "unstaged")}
						onfileclick={(path) => onfileselect?.(path, "unstaged")}
						onfilecontextmenu={(e, path, file) =>
							showUnstagedContextMenu(e, path, file.status)}
						ondirectoryaction={(dirPath) => stageDirectory(dirPath)}
						ondirectorycontextmenu={(e, dirPath) =>
							showUnstagedDirContextMenu(e, dirPath)}
						selectedPath={selectedKind === "unstaged" ? selectedPath : null}
						commentCounts={unstagedCommentCounts}
						commentTallies={unstagedCommentTallies}
						{expandAllSignal}
						{collapseAllSignal}
					/>
				{/if}
			</div>
		{/if}

		<!-- Staged Files section -->
		<div
			data-testid="staging-staged-section"
			class="flex flex-col overflow-hidden min-h-0"
			class:flex-1={staged_expanded && unstaged_expanded}
			class:section-capped={staged_expanded && !unstaged_expanded}
		>
			<Row
				variant="band"
				reveal="always"
				onclick={() => (staged_expanded = !staged_expanded)}
			>
				<span class="text-text-muted inline-flex items-center mr-1">
					{#if staged_expanded}
						<ChevronDown size={12} />
					{:else}
						<ChevronRight size={12} />
					{/if}
				</span>
				{@render sectionTitle(
					isOperation ? "Resolved Files" : "Staged Files",
					status?.staged.length ?? 0,
				)}
				{#snippet actions()}
					{#if (status?.staged.length ?? 0) > 0}
						<Button
							size="sm"
							variant="warning"
							onclick={unstageAll}
							aria-label="Unstage all"
						>
							Unstage All
						</Button>
					{/if}
				{/snippet}
			</Row>

			{#if staged_expanded}
				<TreeFileList
					files={status?.staged ?? []}
					treeMode={treeViewEnabled}
					actionLabel="−"
					{loadingFiles}
					onfileaction={(path) => unstageFile(path)}
					onfileclick={(path) => onfileselect?.(path, "staged")}
					onfilecontextmenu={(e, path, file) =>
						showStagedContextMenu(e, path, file.old_path ?? null)}
					ondirectoryaction={(dirPath) => unstageDirectory(dirPath)}
					ondirectorycontextmenu={(e, dirPath) =>
						showStagedDirContextMenu(e, dirPath)}
					selectedPath={selectedKind === "staged" ? selectedPath : null}
					commentCounts={stagedCommentCounts}
					commentTallies={stagedCommentTallies}
					{expandAllSignal}
					{collapseAllSignal}
				/>
			{/if}
		</div>

		<!-- Spacer: absorbs remaining space when a section is collapsed -->
		{#if !(unstaged_expanded && staged_expanded)}
			<div class="flex-1"></div>
		{/if}
	</div>

	{#if isRebase && operationInfo}
		<Splitter
			variant="bar"
			aria-label="Resize rebase form"
			value={bottomHeight}
			min={BOTTOM_MIN}
			max={BOTTOM_MAX}
			onstep={(delta) => resizeBottom(bottomHeight - delta)}
			onmousedown={startBottomResize}
		/>
		<!-- Rebase progress + actions (GitKraken style) -->
		<div
			class="p-2 flex flex-col gap-2 shrink-0 overflow-hidden"
			style:height="{bottomHeight}px"
		>
			<div class="text-small leading-normal text-text-muted mb-1">
				Rebasing commit {rebaseProgressNum} out of {rebaseProgressTotal}
			</div>
			<input
				type="text"
				bind:value={rebaseMsgSummary}
				placeholder="Commit message summary"
				class="w-full box-border border border-border bg-surface text-text rounded h-control py-1 px-2 text-callout"
			>
			<textarea
				bind:value={rebaseMsgBody}
				placeholder="Description (optional)"
				class="w-full flex-1 min-h-0 box-border border border-border bg-surface text-text rounded py-1 px-2 text-callout leading-normal resize-none"
			></textarea>
			<div class="grid">
				<Button
					size="lg"
					variant="success"
					onclick={continueRebase}
					disabled={rebaseLoading || !allResolved}
				>
					Continue Rebase
				</Button>
			</div>
			<div class="grid grid-cols-2 gap-2">
				<div class="grid">
					<Button
						size="lg"
						variant="warning"
						onclick={skipRebase}
						disabled={rebaseLoading}
					>
						Skip
					</Button>
				</div>
				<div class="grid">
					<Button
						size="lg"
						variant="danger"
						onclick={abortRebase}
						disabled={rebaseLoading}
					>
						Abort Rebase
					</Button>
				</div>
			</div>
		</div>
	{:else if isMerge}
		<Splitter variant="bar" fixed />
		<!-- Merge-continue actions. The commit message is edited in the host-owned
         MessageEditor modal (runMergeContinue), not an inline form. -->
		<div class="flex shrink-0 gap-2 p-2">
			<div class="grid flex-1">
				<Button
					size="lg"
					variant="success"
					onclick={runMergeContinue}
					disabled={!allResolved || mergeLoading}
				>
					{mergeLoading ? "Committing..." : "Commit merge"}
				</Button>
			</div>
			<Button
				size="lg"
				variant="danger"
				onclick={abortMerge}
				disabled={mergeLoading}
			>
				Abort Merge
			</Button>
		</div>
	{:else}
		<Splitter variant="bar" fixed />
		<!-- CommitForm — normal mode -->
		<CommitForm
			{repoPath}
			stagedCount={status?.staged.length ?? 0}
			{initialSubject}
			{initialBody}
			{onsubjectchange}
			{onbodychange}
		/>
	{/if}
</div>

<style>
/* A section left open on its own stops short of the other section's collapsed bar */
.section-capped {
	max-height: calc(100% - var(--bar-h));
}
</style>

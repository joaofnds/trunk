<script lang="ts">
import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
import FolderTree from "@lucide/svelte/icons/folder-tree";
import List from "@lucide/svelte/icons/list";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { onDestroy } from "svelte";
import { buildTree, collectFilePaths } from "../lib/build-tree.js";
import { createCoalescedTask } from "../lib/coalesced-task.js";
import { fileCountsForOid, fileTonesForOid } from "../lib/comment-counts.js";
import { resolveViewOid } from "../lib/comment-matching.js";
import { errorMessage, reportErrorToast } from "../lib/error-report.js";
import { pathMenuEntriesOf } from "../lib/file-menu.js";
import { safeInvoke } from "../lib/invoke.js";
import { subscribeToRepoChanges } from "../lib/repo-change-subscription.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import { getScheduler } from "../lib/scheduler.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	FileStatusType,
	MergeSides,
	OperationInfo,
	ReviewTone,
	WorkingTreeStatus,
} from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import Row from "../lib/ui/Row.svelte";
import CommitForm from "./CommitForm.svelte";
import FileRow from "./FileRow.svelte";
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
	onfileresolved?: () => void;
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
	// Shared comments store + center-pane toggle, threaded from RepoView so the
	// per-file count badges read the one source of truth.
	reviewComments?: ReviewCommentsManager;
	reviewCommentsVisible?: boolean;
	commentCounts?: Map<string, number>;
	commentTones?: Map<string, ReviewTone>;
}

let {
	repoPath,
	currentBranch,
	initialSubject,
	initialBody,
	onfileselect,
	onsubjectchange,
	onbodychange,
	onfileresolved,
	onfileadvance,
	selectedPath = null,
	selectedKind = null,
	onstatuschange,
	treeViewEnabled = false,
	ontreeviewtoggle,
	onopenmessageeditor,
	reviewComments,
	reviewCommentsVisible = false,
	commentCounts,
	commentTones,
}: Props = $props();
const scheduler = getScheduler();

let status = $state<WorkingTreeStatus | null>(null);

// Per-section comment counts. Each section keys its map through the SAME
// resolveViewOid the diff uses, so a badge can never disagree with the diff:
// unstaged → working_tree_snapshot, staged → index_snapshot. Conflicted files
// render via MergeEditor (no inline comments), so resolveViewOid('conflicted')
// is null → no badges there, matching what their merge view shows.
let countsEnabled = $derived(
	reviewCommentsVisible &&
		((reviewComments?.hasThreads ?? false) || (commentCounts?.size ?? 0) > 0),
);

function sectionCounts(kind: "unstaged" | "staged"): Map<string, number> {
	if (!countsEnabled) return new Map();
	const oid = resolveViewOid({
		kind,
		commitOid: null,
		snapshots: reviewComments?.snapshots ?? {
			working_tree_snapshot: null,
			index_snapshot: null,
		},
	});
	return fileCountsForOid(
		commentCounts ?? reviewComments?.countByFile ?? new Map(),
		oid,
	);
}

function sectionTones(kind: "unstaged" | "staged"): Map<string, ReviewTone> {
	if (!countsEnabled) return new Map();
	const oid = resolveViewOid({
		kind,
		commitOid: null,
		snapshots: reviewComments?.snapshots ?? {
			working_tree_snapshot: null,
			index_snapshot: null,
		},
	});
	return fileTonesForOid(commentTones ?? new Map(), oid);
}

let unstagedCommentCounts = $derived(sectionCounts("unstaged"));
let stagedCommentCounts = $derived(sectionCounts("staged"));
let unstagedCommentTones = $derived(sectionTones("unstaged"));
let stagedCommentTones = $derived(sectionTones("staged"));

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

let rebaseProgressNum = $derived(operationInfo?.progress?.split("/")[0] ?? "?");
let rebaseProgressTotal = $derived(
	operationInfo?.progress?.split("/")[1] ?? "?",
);
let rebaseMsgSummary = $state("");
let rebaseMsgBody = $state("");
let lastRebaseMessage = $state("");

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
		rebaseMsgSummary = lines[0] ?? "";
		rebaseMsgBody = lines.slice(1).join("\n").replace(/^\n/, "");
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

async function loadStatus() {
	await statusRefresh.run();
}

async function stageFile(filePath: string) {
	loadingFiles = new Set([...loadingFiles, filePath]);
	await safeInvoke("stage_file", { path: repoPath, filePath });
	onfileadvance?.(filePath, "unstaged");
	optimisticMove(filePath, "unstaged", "stage");
	await loadStatus();
	const next = new Set(loadingFiles);
	next.delete(filePath);
	loadingFiles = next;
}

async function unstageFile(filePath: string) {
	loadingFiles = new Set([...loadingFiles, filePath]);
	await safeInvoke("unstage_file", { path: repoPath, filePath });
	onfileadvance?.(filePath, "staged");
	optimisticMove(filePath, "staged", "unstage");
	await loadStatus();
	const next = new Set(loadingFiles);
	next.delete(filePath);
	loadingFiles = next;
}

async function stageDirectory(dirPath: string) {
	const directMatches = (status?.unstaged ?? []).filter(
		(f) => f.path.startsWith(`${dirPath}/`) || f.path === dirPath,
	);
	const pathsToStage = directMatches.map((f) => f.path);
	if (pathsToStage.length === 0) return;

	loadingFiles = new Set([...loadingFiles, ...pathsToStage]);
	await safeInvoke("stage_files", { path: repoPath, filePaths: pathsToStage });
	await loadStatus();
	const next = new Set(loadingFiles);
	for (const p of pathsToStage) next.delete(p);
	loadingFiles = next;
}

async function unstageDirectory(dirPath: string) {
	const directMatches = (status?.staged ?? []).filter(
		(f) => f.path.startsWith(`${dirPath}/`) || f.path === dirPath,
	);
	const pathsToUnstage = directMatches.map((f) => f.path);
	if (pathsToUnstage.length === 0) return;

	loadingFiles = new Set([...loadingFiles, ...pathsToUnstage]);
	await safeInvoke("unstage_files", {
		path: repoPath,
		filePaths: pathsToUnstage,
	});
	await loadStatus();
	const next = new Set(loadingFiles);
	for (const p of pathsToUnstage) next.delete(p);
	loadingFiles = next;
}

async function stageAll() {
	await safeInvoke("stage_all", { path: repoPath });
	await loadStatus();
}

async function unstageAll() {
	await safeInvoke("unstage_all", { path: repoPath });
	await loadStatus();
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
	const files = (status?.unstaged ?? []).filter(
		(f) => f.path.startsWith(`${dirPath}/`) || f.path === dirPath,
	);
	if (files.length === 0) return;

	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		`Discard all changes in ${dirPath}/ (${files.length} file${files.length === 1 ? "" : "s"})? This cannot be undone.`,
		{ title: "Discard Directory Changes", kind: "warning" },
	);
	if (!confirmed) return;

	try {
		await Promise.all(
			files.map((f) =>
				safeInvoke("discard_file", { path: repoPath, filePath: f.path }),
			),
		);
		await loadStatus();
		showToast(`Discarded ${files.length} files in ${dirPath}/`, "success");
	} catch (e) {
		reportErrorToast(e, "Discard failed");
	}
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
					writeText(filePath).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Copy Absolute Path",
				action: () => {
					writeText(absPath).catch(() => {});
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: "Stage File",
				action: () => {
					stageFile(filePath);
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
	const files = (status?.unstaged ?? []).filter(
		(f) => f.path.startsWith(`${dirPath}/`) || f.path === dirPath,
	);
	if (files.length === 0) return;

	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					writeText(dirPath).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Copy Absolute Path",
				action: () => {
					writeText(absPath).catch(() => {});
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
							writeText(entry.value).catch(() => {});
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
	const files = (status?.staged ?? []).filter(
		(f) => f.path.startsWith(`${dirPath}/`) || f.path === dirPath,
	);
	if (files.length === 0) return;

	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					writeText(dirPath).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Copy Absolute Path",
				action: () => {
					writeText(absPath).catch(() => {});
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
		const content = side === "ours" ? sides.ours : sides.theirs;
		await safeInvoke("save_merge_result", {
			path: repoPath,
			filePath,
			content,
		});
		onfileresolved?.();
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
					writeText(filePath).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Copy Absolute Path",
				action: () => {
					writeText(absPath).catch(() => {});
				},
			}),
		],
	});
	await menu.popup();
}

async function resolveDirectory(dirPath: string) {
	const files = (status?.conflicted ?? []).filter(
		(f) => f.path.startsWith(`${dirPath}/`) || f.path === dirPath,
	);
	if (files.length === 0) return;
	for (const f of files) {
		await safeInvoke("stage_file", { path: repoPath, filePath: f.path });
	}
	await loadStatus();
}

async function unresolveDirectory(dirPath: string) {
	const files = (status?.staged ?? []).filter(
		(f) => f.path.startsWith(`${dirPath}/`) || f.path === dirPath,
	);
	if (files.length === 0) return;
	for (const f of files) {
		await safeInvoke("unstage_file", { path: repoPath, filePath: f.path });
	}
	await loadStatus();
}

async function showConflictedDirContextMenu(_e: MouseEvent, dirPath: string) {
	const { Menu, MenuItem, PredefinedMenuItem } = await import(
		"@tauri-apps/api/menu"
	);
	const absPath = `${repoPath}/${dirPath}`;
	const files = (status?.conflicted ?? []).filter(
		(f) => f.path.startsWith(`${dirPath}/`) || f.path === dirPath,
	);
	if (files.length === 0) return;

	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					writeText(dirPath).catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Copy Absolute Path",
				action: () => {
					writeText(absPath).catch(() => {});
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: `Resolve All (${files.length})`,
				action: () => {
					resolveDirectory(dirPath);
				},
			}),
			await MenuItem.new({
				text: `Unresolve All (${files.length})`,
				action: () => {
					unresolveDirectory(dirPath);
				},
			}),
		],
	});
	await menu.popup();
}

async function handleDiscardAll() {
	const count = status?.unstaged.length ?? 0;
	if (count === 0) return;
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		`Discard all changes to ${count} file${count === 1 ? "" : "s"}? This cannot be undone.`,
		{ title: "Discard All Changes", kind: "warning" },
	);
	if (!confirmed) return;
	try {
		await safeInvoke("discard_all", { path: repoPath });
		await loadStatus();
		showToast(`Discarded all changes (${count} files)`, "success");
	} catch (e) {
		reportErrorToast(e, "Discard all failed");
	}
}

// ---------- Merge-mode actions ----------
async function markAllResolved() {
	for (const f of status?.conflicted ?? []) {
		await safeInvoke("stage_file", { path: repoPath, filePath: f.path });
	}
	await loadStatus();
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
let bottomHeight = $state(180);

function startBottomResize(e: MouseEvent) {
	e.preventDefault();
	const startY = e.clientY;
	const startHeight = bottomHeight;

	function onMouseMove(ev: MouseEvent) {
		const delta = startY - ev.clientY;
		bottomHeight = Math.max(100, Math.min(500, startHeight + delta));
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
		void loadStatus().catch((error) =>
			reportErrorToast(error, "Failed to refresh status"),
		);
	}
});

// Auto-refresh on repo-changed event
$effect(() => {
	return subscribeToRepoChanges(repoPath, statusRefresh);
});
</script>

{#snippet sectionCount(n: number)}
	<span
		class="inline-flex items-center justify-center min-w-4 h-4 py-0 px-1 rounded bg-surface-chip text-text font-mono font-semibold text-caption section-count shrink-0"
		>{n}</span
	>
{/snippet}

<div class="w-full min-w-0 flex flex-col h-full overflow-hidden bg-surface">
	<!-- Panel header -->
	<div
		class="h-bar bg-surface-raised shadow-hairline py-0 px-3 flex items-center justify-center gap-2 shrink-0"
	>
		<span class="flex-1 flex items-center justify-center gap-2 min-w-0">
			<span class="text-callout text-text">
				{`${totalCount} file${totalCount === 1 ? '' : 's'} changed`}
			</span>
			{#if currentBranch}
				<span class="text-small text-text-muted">on</span>
				<!-- inline-block, not inline-flex: text-overflow does not apply to a
             flex container, so a long branch name would hard-clip instead of
             showing an ellipsis. line-height does the vertical centring. -->
				<span
					class="branch-chip rounded-full py-0 px-2 text-small h-control-sm inline-block leading-control-sm font-semibold whitespace-nowrap overflow-hidden text-ellipsis min-w-0"
				>
					{currentBranch}
				</span>
			{/if}
		</span>
		{#if treeViewEnabled}
			<Button
				icon
				size="sm"
				variant="ghost"
				aria-label="Expand all directories"
				title="Expand All"
				onclick={(e) => { e.stopPropagation(); expandAllSignal++; }}
			>
				<ChevronsUpDown size={14} />
			</Button>
			<Button
				icon
				size="sm"
				variant="ghost"
				aria-label="Collapse all directories"
				title="Collapse All"
				onclick={(e) => { e.stopPropagation(); collapseAllSignal++; }}
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
			aria-label={treeViewEnabled ? 'Switch to list view' : 'Switch to tree view'}
			title={treeViewEnabled ? 'List view' : 'Tree view'}
			onclick={(e) => { e.stopPropagation(); ontreeviewtoggle?.(); }}
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
				<span
					class="rounded-full py-0 px-2 text-caption h-control-sm inline-block leading-control-sm text-bg font-semibold"
					style:background="var(--lane-{operationInfo.source_color_index ?? 0})"
					>{operationInfo.source_branch}</span
				>
			{/if}
			onto
			{#if operationInfo.target_branch}
				<span
					class="rounded-full py-0 px-2 text-caption h-control-sm inline-block leading-control-sm text-bg font-semibold"
					style:background="var(--lane-{operationInfo.target_color_index ?? 0})"
					>{operationInfo.target_branch}</span
				>
			{/if}
		</div>
	{:else if operationInfo && operationInfo.op_type !== 'None'}
		<OperationBanner
			info={operationInfo}
			{repoPath}
			{onopenmessageeditor}
			onaction={() => { loadStatus(); }}
		/>
	{/if}

	<!-- File sections flex container (50/50 split when both expanded) -->
	<div class="flex-1 flex flex-col overflow-hidden min-h-0">
		<!-- Conflicted Files section (rebase: always shown; non-rebase: only when conflicts exist) -->
		{#if !isMerge && (isRebase || (status?.conflicted.length ?? 0) > 0)}
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
					<span class="text-badge-warning inline-flex items-center mr-1">
						<AlertTriangle size={12} />
					</span>
					<span
						class="text-text-muted text-caption font-semibold tracking-widest uppercase flex-1 inline-flex items-center gap-2"
					>
						<span>Conflicted Files</span>
						{@render sectionCount(status?.conflicted.length ?? 0)}
					</span>
					{#snippet actions()}
						<Button size="sm" variant="warning" onclick={markAllResolved}
							>Mark All Resolved</Button
						>
					{/snippet}
				</Row>

				{#if conflicted_expanded}
					<TreeFileList
						files={status?.conflicted ?? []}
						treeMode={treeViewEnabled}
						actionLabel=""
						onfileaction={() => {}}
						onfileclick={(path) => onfileselect?.(path, 'conflicted')}
						onfilecontextmenu={(e, path) => showConflictedContextMenu(e, path)}
						ondirectorycontextmenu={(e, dirPath) => showConflictedDirContextMenu(e, dirPath)}
						selectedPath={selectedKind === 'conflicted' ? selectedPath : null}
						{expandAllSignal}
						{collapseAllSignal}
					/>
				{/if}
			</div>
		{/if}

		<!-- Unstaged Files section (hidden during rebase — only conflicted + resolved shown) -->
		{#if !isRebase}
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
					{#if isMerge}
						<span class="text-badge-warning inline-flex items-center mr-1">
							<AlertTriangle size={12} />
						</span>
						<span
							class="text-text-muted text-caption font-semibold tracking-widest uppercase flex-1 whitespace-nowrap inline-flex items-center gap-2"
						>
							<span>Conflicted Files</span>
							{@render sectionCount(status?.conflicted.length ?? 0)}
						</span>
					{:else}
						<span
							class="text-text-muted text-caption font-semibold tracking-widest uppercase flex-1 inline-flex items-center gap-2"
						>
							<span>Unstaged Files</span>
							{@render sectionCount(status?.unstaged.length ?? 0)}
						</span>
					{/if}
					{#snippet actions()}
						{#if isMerge}
							{#if (status?.conflicted.length ?? 0) > 0}
								<Button
									size="sm"
									variant="success"
									onclick={markAllResolved}
									aria-label="Mark all as resolved"
								>
									Mark All as Resolved
								</Button>
							{/if}
						{:else if (status?.unstaged.length ?? 0) > 0}
							<div class="flex gap-1">
								<Button
									size="sm"
									variant="danger"
									onclick={handleDiscardAll}
									aria-label="Discard all changes"
								>
									Discard All
								</Button>
								<Button
									size="sm"
									variant="success"
									onclick={stageAll}
									aria-label="Stage all changes"
								>
									Stage All Changes
								</Button>
							</div>
						{/if}
					{/snippet}
				</Row>

				{#if unstaged_expanded}
					{#if isMerge}
						<TreeFileList
							files={status?.conflicted ?? []}
							treeMode={treeViewEnabled}
							actionLabel="+"
							{loadingFiles}
							onfileaction={(path) => stageFile(path)}
							onfileclick={(path) => onfileselect?.(path, 'conflicted')}
							onfilecontextmenu={(e, path) => showConflictedContextMenu(e, path)}
							ondirectoryaction={(dirPath) => stageDirectory(dirPath)}
							ondirectorycontextmenu={(e, dirPath) => showConflictedDirContextMenu(e, dirPath)}
							selectedPath={selectedKind === 'conflicted' ? selectedPath : null}
							{expandAllSignal}
							{collapseAllSignal}
						/>
					{:else}
						<TreeFileList
							files={status?.unstaged ?? []}
							treeMode={treeViewEnabled}
							actionLabel="+"
							{loadingFiles}
							onfileaction={(path) => stageFile(path)}
							onfileclick={(path) => onfileselect?.(path, 'unstaged')}
							onfilecontextmenu={(e, path, file) => showUnstagedContextMenu(e, path, file.status)}
							ondirectoryaction={(dirPath) => stageDirectory(dirPath)}
							ondirectorycontextmenu={(e, dirPath) => showUnstagedDirContextMenu(e, dirPath)}
							selectedPath={selectedKind === 'unstaged' ? selectedPath : null}
							commentCounts={unstagedCommentCounts}
							commentTones={unstagedCommentTones}
							{expandAllSignal}
							{collapseAllSignal}
						/>
					{/if}
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
				<span
					class="text-text-muted text-caption font-semibold tracking-widest uppercase flex-1 inline-flex items-center gap-2"
				>
					<span>{isOperation ? 'Resolved Files' : 'Staged Files'}</span>
					{@render sectionCount(status?.staged.length ?? 0)}
				</span>
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
					onfileclick={(path) => onfileselect?.(path, 'staged')}
					onfilecontextmenu={(e, path, file) => showStagedContextMenu(e, path, file.old_path ?? null)}
					ondirectoryaction={(dirPath) => unstageDirectory(dirPath)}
					ondirectorycontextmenu={(e, dirPath) => showStagedDirContextMenu(e, dirPath)}
					selectedPath={selectedKind === 'staged' ? selectedPath : null}
					commentCounts={stagedCommentCounts}
					commentTones={stagedCommentTones}
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

	<!-- Draggable divider above bottom area -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		onmousedown={startBottomResize}
		class="shrink-0 bottom-resize-handle"
	></div>

	{#if isRebase && operationInfo}
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
			<div class="grid grid-cols-6 gap-2">
				<div class="col-span-3 grid">
					<Button
						size="lg"
						variant="success"
						onclick={continueRebase}
						disabled={rebaseLoading || !allResolved}
					>
						Continue Rebase
					</Button>
				</div>
				<div class="col-span-1 grid">
					<Button
						size="lg"
						variant="warning"
						onclick={skipRebase}
						disabled={rebaseLoading}
					>
						Skip
					</Button>
				</div>
				<div class="col-span-2 grid">
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
		<!-- Merge-continue actions. The commit message is edited in the host-owned
         MessageEditor modal (runMergeContinue), not an inline form. -->
		<div class="grid shrink-0 grid-cols-5 gap-2 p-2">
			<div class="col-span-3 grid">
				<Button
					size="lg"
					variant="success"
					onclick={runMergeContinue}
					disabled={!allResolved || mergeLoading}
				>
					{mergeLoading ? 'Committing...' : 'Commit merge'}
				</Button>
			</div>
			<div class="col-span-2 grid">
				<Button
					size="lg"
					variant="danger"
					onclick={abortMerge}
					disabled={mergeLoading}
				>
					Abort Merge
				</Button>
			</div>
		</div>
	{:else}
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
.section-count {
	letter-spacing: 0;
}

.branch-chip {
	background: color-mix(in oklch, var(--lane-0) 14%, transparent);
	box-shadow: inset 0 0 0 1px
		color-mix(in oklch, var(--lane-0) 50%, transparent);
	color: var(--lane-0);
}

/* Hides its own height behind a 1px rule, so the grab area is wider than the line it draws */
.bottom-resize-handle {
	height: 4px;
	cursor: row-resize;
	background: linear-gradient(
		to bottom,
		transparent 1px,
		var(--color-border) 1px,
		var(--color-border) 2px,
		transparent 2px
	);
	transition: background 0.15s;
}

/* A section left open on its own stops short of the other section's collapsed bar */
.section-capped {
	max-height: calc(100% - var(--bar-h));
}
</style>

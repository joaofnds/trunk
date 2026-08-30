<script lang="ts">
import {
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	FolderTree,
	List,
} from "@lucide/svelte";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { buildTree, collectFilePaths } from "../lib/build-tree.js";
import { fileCountsForOid } from "../lib/comment-counts.js";
import { resolveViewOid } from "../lib/comment-matching.js";
import { errorMessage, reportErrorToast } from "../lib/error-report.js";
import { safeInvoke } from "../lib/invoke.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import type {
	FileStatusType,
	MergeSides,
	OperationInfo,
	WorkingTreeStatus,
} from "../lib/types.js";
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
	clearRedoStack: () => void;
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
	showInlineComments?: boolean;
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
	clearRedoStack,
	treeViewEnabled = false,
	ontreeviewtoggle,
	onopenmessageeditor,
	reviewComments,
	showInlineComments = false,
}: Props = $props();

let status = $state<WorkingTreeStatus | null>(null);

// Per-section comment counts. Each section keys its map through the SAME
// resolveViewOid the diff uses, so a badge can never disagree with the diff:
// unstaged → working_tree_snapshot, staged → index_snapshot. Conflicted files
// render via MergeEditor (no inline comments), so resolveViewOid('conflicted')
// is null → no badges there, matching what their merge view shows.
let countsEnabled = $derived(
	showInlineComments && (reviewComments?.hasThreads ?? false),
);

function sectionCounts(kind: "unstaged" | "staged"): Map<string, number> {
	if (!countsEnabled || !reviewComments) return new Map();
	const oid = resolveViewOid({
		kind,
		commitOid: null,
		snapshots: reviewComments.snapshots,
	});
	return fileCountsForOid(reviewComments.countByFile, oid);
}

let unstagedCommentCounts = $derived(sectionCounts("unstaged"));
let stagedCommentCounts = $derived(sectionCounts("staged"));

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

async function loadOperationState() {
	const result = await safeInvoke<OperationInfo>("get_operation_state", {
		path: repoPath,
	});
	operationInfo = result;
}

async function loadStatus() {
	const seq = ++loadSeq;
	const result = await safeInvoke<WorkingTreeStatus>("get_status", {
		path: repoPath,
	});
	if (seq === loadSeq) {
		status = result;
		onstatuschange?.(result);
	}
	await loadOperationState();
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

async function showStagedContextMenu(_e: MouseEvent, filePath: string) {
	const { Menu, MenuItem, PredefinedMenuItem } = await import(
		"@tauri-apps/api/menu"
	);
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
	if (repoPath) loadStatus();
});

// Auto-refresh on repo-changed event
$effect(() => {
	let unlisten: (() => void) | undefined;
	listen<string>("repo-changed", (event) => {
		if (event.payload === repoPath) loadStatus();
	}).then((fn) => {
		unlisten = fn;
	});
	return () => {
		unlisten?.();
	};
});
</script>

{#snippet sectionCount(n: number)}
  <span style="display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 var(--space-1); border-radius: var(--radius); background: var(--bg-3); color: var(--fg-1); font-family: var(--font-mono); font-weight: 600; font-size: 10px; letter-spacing: 0; flex-shrink: 0;">{n}</span>
{/snippet}

<div style="
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-1);
">
  <!-- Panel header -->
  <div style="
    height: var(--bar-h);
    background: var(--bg-2);
    box-shadow: inset 0 -1px 0 var(--color-border);
    padding: 0 var(--space-3);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    flex-shrink: 0;
  ">
    <span style="flex: 1; display: flex; align-items: center; justify-content: center; gap: var(--space-2); min-width: 0;">
      <span style="font-size: 12px; color: var(--color-text);">
        {totalCount} file{totalCount === 1 ? '' : 's'} changed
      </span>
      {#if currentBranch}
        <span style="font-size: 11px; color: var(--color-text-muted);">on</span>
        <span style="
          background: color-mix(in oklch, var(--lane-0) 14%, transparent);
          box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--lane-0) 50%, transparent);
          border-radius: var(--radius-pill);
          padding: 0 var(--space-2);
          font-size: 11px;
          height: var(--control-sm-h);
          display: inline-flex;
          align-items: center;
          color: var(--lane-0);
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          min-width: 0;
        ">
          {currentBranch}
        </span>
      {/if}
    </span>
    {#if treeViewEnabled}
      <button
        aria-label="Expand all directories"
        title="Expand All"
        onclick={(e) => { e.stopPropagation(); expandAllSignal++; }}
        style="
          background: none;
          border: none;
          cursor: pointer;
          color: var(--color-text-muted);
          display: flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: var(--control-sm-h);
          border-radius: var(--radius);
          flex-shrink: 0;
          padding: 0;
        "
      >
        <ChevronsUpDown size={14} />
      </button>
      <button
        aria-label="Collapse all directories"
        title="Collapse All"
        onclick={(e) => { e.stopPropagation(); collapseAllSignal++; }}
        style="
          background: none;
          border: none;
          cursor: pointer;
          color: var(--color-text-muted);
          display: flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: var(--control-sm-h);
          border-radius: var(--radius);
          flex-shrink: 0;
          padding: 0;
        "
      >
        <ChevronsDownUp size={14} />
      </button>
    {/if}
    <button
      role="switch"
      aria-checked={treeViewEnabled}
      aria-label={treeViewEnabled ? 'Switch to list view' : 'Switch to tree view'}
      title={treeViewEnabled ? 'List view' : 'Tree view'}
      onclick={(e) => { e.stopPropagation(); ontreeviewtoggle?.(); }}
      style="
        background: none;
        border: none;
        cursor: pointer;
        color: var(--color-text-muted);
        display: flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: var(--control-sm-h);
        border-radius: var(--radius);
        flex-shrink: 0;
        padding: 0;
      "
    >
      {#if treeViewEnabled}
        <FolderTree size={14} />
      {:else}
        <List size={14} />
      {/if}
    </button>
  </div>

  <!-- Operation banners -->
  {#if isRebase && operationInfo}
    <!-- Rebase conflict/progress header -->
    {#if (status?.conflicted.length ?? 0) > 0}
      <div style="
        height: var(--bar-h);
        background: var(--color-badge-warning-bg);
        box-shadow: inset 0 -1px 0 var(--color-border);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-2);
        flex-shrink: 0;
      ">
        <span style="color: var(--color-badge-warning); display: inline-flex; align-items: center;">
          <AlertTriangle size={12} />
        </span>
        <span style="font-size: 12px; font-weight: 600; color: var(--color-badge-warning);">Rebase conflicts detected</span>
      </div>
    {/if}
    <div style="
      height: var(--bar-h);
      box-shadow: inset 0 -1px 0 var(--color-border);
      padding: 0 var(--space-3);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      flex-shrink: 0;
      font-size: 11px;
      color: var(--color-text-muted);
    ">
      Rebasing
      {#if operationInfo.source_branch}
        <span style="
          background: var(--lane-{operationInfo.source_color_index ?? 0});
          border-radius: var(--radius-pill);
          padding: 0 var(--space-2);
          font-size: 10px;
          height: var(--control-sm-h);
          display: inline-flex;
          align-items: center;
          color: var(--bg-0);
          font-weight: 700;
        ">{operationInfo.source_branch}</span>
      {/if}
      onto
      {#if operationInfo.target_branch}
        <span style="
          background: var(--lane-{operationInfo.target_color_index ?? 0});
          border-radius: var(--radius-pill);
          padding: 0 var(--space-2);
          font-size: 10px;
          height: var(--control-sm-h);
          display: inline-flex;
          align-items: center;
          color: var(--bg-0);
          font-weight: 700;
        ">{operationInfo.target_branch}</span>
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
  <div style="flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0;">
    <!-- Conflicted Files section (rebase: always shown; non-rebase: only when conflicts exist) -->
    {#if !isMerge && (isRebase || (status?.conflicted.length ?? 0) > 0)}
      <div style="
        {conflicted_expanded && staged_expanded ? 'flex: 1;' : conflicted_expanded ? 'max-height: calc(100% - 28px);' : ''}
        display: flex;
        flex-direction: column;
        overflow: hidden;
        min-height: 0;
      ">
        <div
          role="button"
          tabindex="0"
          onclick={() => (conflicted_expanded = !conflicted_expanded)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') conflicted_expanded = !conflicted_expanded; }}
          style="
            height: var(--bar-h);
            box-shadow: inset 0 -1px 0 var(--color-border);
            padding: 0 var(--space-2);
            display: flex;
            align-items: center;
            cursor: pointer;
            flex-shrink: 0;
          "
        >
          <span style="color: var(--color-text-muted); display: inline-flex; align-items: center; margin-right: var(--space-1);">
            {#if conflicted_expanded}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
          </span>
          <span style="color: var(--color-badge-warning); display: inline-flex; align-items: center; margin-right: var(--space-1);">
            <AlertTriangle size={12} />
          </span>
          <span style="color: var(--fg-2); font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; flex: 1; display: inline-flex; align-items: center; gap: var(--space-2);">
            <span>Conflicted Files</span>{@render sectionCount(status?.conflicted.length ?? 0)}
          </span>
          <button
            onclick={(e) => { e.stopPropagation(); markAllResolved(); }}
            style="
              display: inline-flex;
              align-items: center;
              justify-content: center;
              background: var(--color-warning-bg);
              color: var(--color-warning);
              border: 1px solid var(--color-warning-border);
              border-radius: var(--radius);
              font-size: 10px;
              font-weight: 600;
              height: var(--control-sm-h);
              padding: 0 var(--space-2);
              cursor: pointer;
            "
          >Mark All Resolved</button>
        </div>

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
    <div data-testid="staging-unstaged-section" style="
      {unstaged_expanded && staged_expanded ? 'flex: 1;' : unstaged_expanded ? 'max-height: calc(100% - 28px);' : ''}
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 0;
    ">
      <div
        role="button"
        tabindex="0"
        onclick={() => (unstaged_expanded = !unstaged_expanded)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') unstaged_expanded = !unstaged_expanded; }}
        style="
          height: var(--bar-h);
          box-shadow: inset 0 -1px 0 var(--color-border);
          padding: 0 var(--space-2);
          display: flex;
          align-items: center;
          cursor: pointer;
          flex-shrink: 0;
        "
      >
        <span style="color: var(--color-text-muted); display: inline-flex; align-items: center; margin-right: var(--space-1);">
          {#if unstaged_expanded}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
        </span>
        {#if isMerge}
          <span style="color: var(--color-badge-warning); display: inline-flex; align-items: center; margin-right: var(--space-1);">
            <AlertTriangle size={12} />
          </span>
          <span style="color: var(--fg-2); font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; flex: 1; white-space: nowrap; display: inline-flex; align-items: center; gap: var(--space-2);">
            <span>Conflicted Files</span>{@render sectionCount(status?.conflicted.length ?? 0)}
          </span>
          {#if (status?.conflicted.length ?? 0) > 0}
            <button
              onclick={(e) => { e.stopPropagation(); markAllResolved(); }}
              style="
                display: inline-flex;
                align-items: center;
                justify-content: center;
                background: var(--color-success-bg);
                color: var(--color-success);
                font-size: 11px;
                border: 1px solid var(--color-success-border);
                border-radius: var(--radius);
                cursor: pointer;
                height: var(--control-sm-h);
                padding: 0 var(--space-2);
                white-space: nowrap;
              "
              aria-label="Mark all as resolved"
            >
              Mark All as Resolved
            </button>
          {/if}
        {:else}
          <span style="color: var(--fg-2); font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; flex: 1; display: inline-flex; align-items: center; gap: var(--space-2);">
            <span>Unstaged Files</span>{@render sectionCount(status?.unstaged.length ?? 0)}
          </span>
          {#if (status?.unstaged.length ?? 0) > 0}
            <button
              onclick={(e) => { e.stopPropagation(); handleDiscardAll(); }}
              style="
                display: inline-flex;
                align-items: center;
                justify-content: center;
                background: var(--color-danger-bg);
                color: var(--color-danger);
                font-size: 11px;
                border: 1px solid var(--color-danger-border);
                border-radius: var(--radius);
                cursor: pointer;
                height: var(--control-sm-h);
                padding: 0 var(--space-2);
                white-space: nowrap;
              "
              aria-label="Discard all changes"
            >
              Discard All
            </button>
            <button
              onclick={(e) => { e.stopPropagation(); stageAll(); }}
              style="
                display: inline-flex;
                align-items: center;
                justify-content: center;
                background: var(--color-success-bg);
                color: var(--color-success);
                font-size: 11px;
                border: 1px solid var(--color-success-border);
                border-radius: var(--radius);
                cursor: pointer;
                height: var(--control-sm-h);
                padding: 0 var(--space-2);
                white-space: nowrap;
                margin-left: var(--space-1);
              "
              aria-label="Stage all changes"
            >
              Stage All Changes
            </button>
          {/if}
        {/if}
      </div>

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
            {expandAllSignal}
            {collapseAllSignal}
          />
        {/if}
      {/if}
    </div>
    {/if}

    <!-- Staged Files section -->
    <div data-testid="staging-staged-section" style="
      {staged_expanded && unstaged_expanded ? 'flex: 1;' : staged_expanded ? 'max-height: calc(100% - 28px);' : ''}
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 0;
    ">
      <div
        role="button"
        tabindex="0"
        onclick={() => (staged_expanded = !staged_expanded)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') staged_expanded = !staged_expanded; }}
        style="
          height: var(--bar-h);
          box-shadow: inset 0 -1px 0 var(--color-border);
          padding: 0 var(--space-2);
          display: flex;
          align-items: center;
          cursor: pointer;
          flex-shrink: 0;
        "
      >
        <span style="color: var(--color-text-muted); display: inline-flex; align-items: center; margin-right: var(--space-1);">
          {#if staged_expanded}<ChevronDown size={12} />{:else}<ChevronRight size={12} />{/if}
        </span>
        <span style="color: var(--fg-2); font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; flex: 1; display: inline-flex; align-items: center; gap: var(--space-2);">
          <span>{isOperation ? 'Resolved Files' : 'Staged Files'}</span>{@render sectionCount(status?.staged.length ?? 0)}
        </span>
        {#if (status?.staged.length ?? 0) > 0}
          <button
            onclick={(e) => { e.stopPropagation(); unstageAll(); }}
            style="
              display: inline-flex;
              align-items: center;
              justify-content: center;
              background: var(--color-warning-bg);
              color: var(--color-warning);
              font-size: 11px;
              border: 1px solid var(--color-warning-border);
              border-radius: var(--radius);
              cursor: pointer;
              height: var(--control-sm-h);
              padding: 0 var(--space-2);
              white-space: nowrap;
            "
            aria-label="Unstage all"
          >
            Unstage All
          </button>
        {/if}
      </div>

      {#if staged_expanded}
        <TreeFileList
          files={status?.staged ?? []}
          treeMode={treeViewEnabled}
          actionLabel="−"
          {loadingFiles}
          onfileaction={(path) => unstageFile(path)}
          onfileclick={(path) => onfileselect?.(path, 'staged')}
          onfilecontextmenu={(e, path) => showStagedContextMenu(e, path)}
          ondirectoryaction={(dirPath) => unstageDirectory(dirPath)}
          ondirectorycontextmenu={(e, dirPath) => showStagedDirContextMenu(e, dirPath)}
          selectedPath={selectedKind === 'staged' ? selectedPath : null}
          commentCounts={stagedCommentCounts}
          {expandAllSignal}
          {collapseAllSignal}
        />
      {/if}
    </div>

    <!-- Spacer: absorbs remaining space when a section is collapsed -->
    {#if !(unstaged_expanded && staged_expanded)}
      <div style="flex: 1;"></div>
    {/if}
  </div>

  <!-- Draggable divider above bottom area -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    onmousedown={startBottomResize}
    style="
      flex-shrink: 0;
      height: 4px;
      cursor: row-resize;
      background: linear-gradient(to bottom, transparent 1px, var(--color-border) 1px, var(--color-border) 2px, transparent 2px);
      transition: background 0.15s;
    "
  ></div>

  {#if isRebase && operationInfo}
    <!-- Rebase progress + actions (GitKraken style) -->
    <div style="
      padding: var(--space-2);
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      height: {bottomHeight}px;
      flex-shrink: 0;
      overflow: hidden;
    ">
      <div style="font-size: 11px; color: var(--color-text-muted); margin-bottom: var(--space-1);">
        Rebasing commit {rebaseProgressNum} out of {rebaseProgressTotal}
      </div>
      <input
        type="text"
        bind:value={rebaseMsgSummary}
        placeholder="Commit message summary"
        style="
          width: 100%;
          box-sizing: border-box;
          border: 1px solid var(--color-border);
          background: var(--color-surface);
          color: var(--color-text);
          border-radius: var(--radius);
          padding: var(--space-1) var(--space-2);
          font-size: 12px;
        "
      />
      <textarea
        bind:value={rebaseMsgBody}
        placeholder="Description (optional)"
        style="
          width: 100%;
          flex: 1;
          min-height: 0;
          box-sizing: border-box;
          border: 1px solid var(--color-border);
          background: var(--color-surface);
          color: var(--color-text);
          border-radius: var(--radius);
          padding: var(--space-1) var(--space-2);
          font-size: 12px;
          resize: none;
        "
      ></textarea>
      <div style="display: flex; gap: var(--space-2);">
        <button
          onclick={continueRebase}
          disabled={rebaseLoading || !allResolved}
          style="
            flex: 3;
            height: var(--control-lg-h);
            background: var(--color-success-bg);
            color: var(--color-success);
            border: 1px solid var(--color-success-border);
            border-radius: var(--radius);
            font-size: 12px;
            font-weight: 600;
            cursor: {allResolved && !rebaseLoading ? 'pointer' : 'not-allowed'};
            opacity: {allResolved && !rebaseLoading ? 1 : 0.4};
          "
        >
          Continue Rebase
        </button>
        <button
          onclick={skipRebase}
          disabled={rebaseLoading}
          style="
            flex: 1;
            height: var(--control-lg-h);
            background: var(--color-warning-bg);
            color: var(--color-warning);
            border: 1px solid var(--color-warning-border);
            border-radius: var(--radius);
            font-size: 12px;
            font-weight: 600;
            cursor: {rebaseLoading ? 'not-allowed' : 'pointer'};
            opacity: {rebaseLoading ? 0.4 : 1};
          "
        >
          Skip
        </button>
        <button
          onclick={abortRebase}
          disabled={rebaseLoading}
          style="
            flex: 2;
            height: var(--control-lg-h);
            background: var(--color-danger-bg);
            color: var(--color-danger);
            border: 1px solid var(--color-danger-border);
            border-radius: var(--radius);
            font-size: 12px;
            font-weight: 600;
            cursor: {rebaseLoading ? 'not-allowed' : 'pointer'};
            opacity: {rebaseLoading ? 0.4 : 1};
          "
        >
          Abort Rebase
        </button>
      </div>
    </div>
  {:else if isMerge}
    <!-- Merge-continue actions. The commit message is edited in the host-owned
         MessageEditor modal (runMergeContinue), not an inline form. -->
    <div style="
      padding: var(--space-2);
      display: flex;
      gap: var(--space-2);
      flex-shrink: 0;
    ">
      <button
        onclick={runMergeContinue}
        disabled={!allResolved || mergeLoading}
        style="
          flex: 3;
          height: var(--control-lg-h);
          background: var(--color-success-bg);
          color: var(--color-success);
          border: 1px solid var(--color-success-border);
          border-radius: var(--radius);
          font-size: 12px;
          cursor: {allResolved && !mergeLoading ? 'pointer' : 'not-allowed'};
          opacity: {allResolved && !mergeLoading ? 1 : 0.4};
        "
      >
        {mergeLoading ? 'Committing...' : 'Commit merge'}
      </button>
      <button
        onclick={abortMerge}
        disabled={mergeLoading}
        style="
          flex: 2;
          height: var(--control-lg-h);
          background: var(--color-danger-bg);
          color: var(--color-danger);
          border: 1px solid var(--color-danger-border);
          border-radius: var(--radius);
          font-size: 12px;
          cursor: {mergeLoading ? 'not-allowed' : 'pointer'};
          opacity: {mergeLoading ? 0.4 : 1};
        "
      >
        Abort Merge
      </button>
    </div>
  {:else}
    <!-- CommitForm — normal mode -->
    <CommitForm {repoPath} stagedCount={status?.staged.length ?? 0} {initialSubject} {initialBody} {onsubjectchange} {onbodychange} {clearRedoStack} />
  {/if}
</div>

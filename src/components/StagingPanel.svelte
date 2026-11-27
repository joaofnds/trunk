<script lang="ts">
import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import Trash2 from "@lucide/svelte/icons/trash-2";
import { onDestroy } from "svelte";
import { copyText } from "../lib/clipboard.js";
import { createCoalescedTask } from "../lib/coalesced-task.js";
import { fileCountsForOid, fileTalliesForOid } from "../lib/comment-counts.js";
import { resolveViewOid } from "../lib/comment-matching.js";
import type { CommitFormSession } from "../lib/commit-form-session.svelte.js";
import { ask } from "../lib/dialog.js";
import { errorMessage, reportErrorToast } from "../lib/error-report.js";
import { fileMenuPosition, pathMenuEntriesOf } from "../lib/file-menu.js";
import { displayPath, fileKey, gitPathArgument } from "../lib/file-status.js";
import { filterShortcut } from "../lib/filter-shortcut.js";
import { isTrunkError, safeInvoke } from "../lib/invoke.js";
import {
	computeOutput,
	takeAllCurrent,
	takeAllIncoming,
} from "../lib/merge-parser.js";
import { createMergePicks, type MergePicksStore } from "../lib/merge-picks.js";
import { nativeMenu } from "../lib/native-menu.js";
import { createPathFilter } from "../lib/path-filter.js";
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
import FileViewControls from "./FileViewControls.svelte";
import ListFilter from "./ListFilter.svelte";
import OperationBanner from "./OperationBanner.svelte";
import TreeFileList, { type DirectoryExpansion } from "./TreeFileList.svelte";

interface Props {
	mergePicks?: MergePicksStore;
	repoPath: string;
	currentBranch?: string;
	onfileselect?: (
		path: string,
		kind: "unstaged" | "staged" | "conflicted",
	) => void;
	commitFormSession?: CommitFormSession;
	ondraftsummaryfocuschange?: (focused: boolean) => void;
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
	mergePicks = createMergePicks(),
	currentBranch,
	commitFormSession,
	onfileselect,
	ondraftsummaryfocuschange,
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

let panelWidth = $state(0);
const compactHeader = $derived(panelWidth > 0 && panelWidth < 280);

let status = $state.raw<WorkingTreeStatus | null>(null);
let query = $state("");
let filterOpen = $state(false);
let filter = $state<ListFilter>();

const filterUnstaged = $derived(createPathFilter(status?.unstaged ?? []));
const filterStaged = $derived(createPathFilter(status?.staged ?? []));
const filterConflicted = $derived(createPathFilter(status?.conflicted ?? []));
const unstagedMatches = $derived(filterUnstaged(query));
const stagedMatches = $derived(filterStaged(query));
const conflictedMatches = $derived(filterConflicted(query));

export function filteredFiles(section: keyof WorkingTreeStatus) {
	if (!status) return undefined;
	return {
		unstaged: unstagedMatches,
		staged: stagedMatches,
		conflicted: conflictedMatches,
	}[section];
}

function matchLabel(verb: string, count: number) {
	return `${verb} ${count} ${count === 1 ? "match" : "matches"}`;
}

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

let commitForm = $state<CommitForm>();

/** Focuses the commit draft's Summary. A merge or a rebase in progress shows
 *  no commit form, so there is nothing to focus then. */
export async function focusDraftSummary() {
	await commitForm?.focusDraftSummary();
}

export function optimisticMove(
	filePath: string,
	from: "unstaged" | "staged" | "conflicted",
	action: "stage" | "unstage" | "discard",
) {
	if (!status) return;
	const file = status[from].find((f) => fileKey(f) === filePath);
	if (!file) return;
	const updated = {
		...status,
		[from]: status[from].filter((f) => fileKey(f) !== filePath),
	};
	if (action === "stage") {
		updated.staged = [
			...status.staged.filter((f) => fileKey(f) !== filePath),
			file,
		];
	} else if (action === "unstage") {
		updated.unstaged = [
			...status.unstaged.filter((f) => fileKey(f) !== filePath),
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

let conflictedTree = $state<TreeFileList | null>(null);
let unstagedTree = $state<TreeFileList | null>(null);
let stagedTree = $state<TreeFileList | null>(null);
const fileTrees = $derived([conflictedTree, unstagedTree, stagedTree]);
const directoryExpansion = $derived.by((): DirectoryExpansion => {
	let anyExpanded = false;
	for (const tree of fileTrees) {
		const expansion = tree?.directoryExpansion();
		if (expansion === "expandable") return "expandable";
		if (expansion === "expanded") anyExpanded = true;
	}

	return anyExpanded ? "expanded" : "empty";
});

function setDirectoriesExpanded(expanded: boolean) {
	for (const tree of fileTrees) tree?.setDirectoriesExpanded(expanded);
}

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
let bare = $state(false);
let allResolved = $derived((status?.conflicted.length ?? 0) === 0);

async function loadOperationState(path = repoPath) {
	const result = await safeInvoke<OperationInfo>("get_operation_state", {
		path,
	});
	if (!panelActive || path !== repoPath) return;
	operationInfo = result;
}

/** The working tree's status, or null for a bare repository, which has none. */
async function readStatus(path: string): Promise<WorkingTreeStatus | null> {
	try {
		return await safeInvoke<WorkingTreeStatus>("get_status", { path });
	} catch (e) {
		if (isTrunkError(e) && e.code === "git_bare_repo") return null;
		throw e;
	}
}

async function refreshStatus() {
	const seq = ++loadSeq;
	const path = repoPath;
	const result = await readStatus(path);
	if (panelActive && path === repoPath && seq === loadSeq) {
		bare = result === null;
		if (result === null) return;
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
	const directory = gitPathArgument(dirPath);
	const encoder = new TextEncoder();
	const bytes =
		typeof directory === "string" ? encoder.encode(directory) : directory;
	return (files ?? []).filter((file) => {
		if (typeof directory === "string" && !file.path_bytes)
			return file.path.startsWith(`${directory}/`);
		const path = file.path_bytes ?? encoder.encode(file.path);
		return (
			path[bytes.length] === 47 && bytes.every((byte, i) => path[i] === byte)
		);
	});
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
async function confirmResolved(marked: string[]): Promise<boolean> {
	if (marked.length === 0) return true;

	const shown = marked.slice(0, MARKER_NAMES_SHOWN).join("\n");
	const rest = marked.length - MARKER_NAMES_SHOWN;
	const names = rest > 0 ? `${shown}\nand ${rest} more` : shown;
	const one = marked.length === 1;
	return ask(
		`${one ? "This file still holds" : "These files still hold"} conflict markers:\n\n${names}\n\nMark ${one ? "it" : "them"} resolved anyway? The markers will be committed as content.`,
		{
			title: "Conflict Markers Remain",
			kind: "warning",
			okLabel: "Mark Resolved",
		},
	);
}

/** Staging the working file bypasses the draft in Output. Keep that draft
 * until the user agrees and Git has accepted this exact resolution action. */
async function stageWorkingResolution(filePaths: string[]): Promise<boolean> {
	if (filePaths.some((path) => displayPath(path) !== path)) {
		showToast(
			"Resolve filenames containing non-UTF-8 bytes with Git in the terminal.",
			"error",
		);
		return false;
	}
	const repo = repoPath;
	if (filePaths.some((path) => mergePicks.isSaving(repo, path))) return false;
	const finish = filePaths.map((path) => mergePicks.startSave(repo, path));
	try {
		const { files, marked } = await safeInvoke<{
			files: { path: string; revision: string }[];
			marked: string[];
		}>("prepare_mark_resolved", { path: repo, filePaths });
		if (repo !== repoPath) return false;
		const drafts = filePaths.filter(
			(path) => mergePicks.draftText(repo, path) !== undefined,
		);
		if (
			drafts.length &&
			!(await ask(
				`Stage the working files and discard edited Output for ${drafts.slice(0, MARKER_NAMES_SHOWN).join(", ")}${drafts.length > MARKER_NAMES_SHOWN ? " and more" : ""}?`,
				{
					title: "Discard Edited Output",
					kind: "warning",
					okLabel: "Stage Working Files",
				},
			))
		)
			return false;
		if (
			repo !== repoPath ||
			!(await confirmResolved(marked)) ||
			repo !== repoPath
		)
			return false;
		await safeInvoke("mark_conflicts_resolved", { path: repo, files });
		for (const path of filePaths) mergePicks.forget(repo, path);
		return repo === repoPath;
	} finally {
		for (const done of finish) done?.();
	}
}

async function stageFile(filePath: string, from: "unstaged" | "conflicted") {
	loadingFiles = new Set([...loadingFiles, filePath]);
	try {
		if (from === "conflicted") {
			if (!(await stageWorkingResolution([filePath]))) {
				stopLoading([filePath]);
				return;
			}
		} else {
			await safeInvoke("stage_file", {
				path: repoPath,
				filePath: gitPathArgument(filePath),
			});
		}
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
		await safeInvoke("unstage_file", {
			path: repoPath,
			filePath: gitPathArgument(filePath),
		});
		onfileadvance?.(filePath, "staged");
		optimisticMove(filePath, "staged", "unstage");
	} catch (e) {
		reportErrorToast(e, "Unstage failed");
	}
	await refreshStatusOrReport();
	stopLoading([filePath]);
}

async function stageFiles(files: readonly FileStatus[]) {
	const filePaths = files.map(fileKey);
	await changeFiles(filePaths, "Stage failed", () =>
		safeInvoke("stage_files", {
			path: repoPath,
			filePaths: filePaths.map(gitPathArgument),
		}),
	);
}

async function unstageFiles(files: readonly FileStatus[]) {
	const filePaths = files.map(fileKey);
	await changeFiles(filePaths, "Unstage failed", () =>
		safeInvoke("unstage_files", {
			path: repoPath,
			filePaths: filePaths.map(gitPathArgument),
		}),
	);
}

async function stageAll() {
	if (query) return stageFiles(unstagedMatches);

	const paths = unstagedMatches.map(fileKey);
	await changeFiles(paths, "Stage all failed", () =>
		safeInvoke("stage_all", { path: repoPath }),
	);
}

async function unstageAll() {
	if (query) return unstageFiles(stagedMatches);

	const paths = stagedMatches.map(fileKey);
	await changeFiles(paths, "Unstage all failed", () =>
		safeInvoke("unstage_all", { path: repoPath }),
	);
}

async function handleDiscardFile(filePath: string, fileStatus: FileStatusType) {
	const isUntracked = fileStatus === "New";
	const msg = isUntracked
		? `Delete ${displayPath(filePath)}? This file is untracked and will be permanently removed. This cannot be undone.`
		: `Discard changes to ${displayPath(filePath)}? This cannot be undone.`;
	const confirmed = await ask(msg, {
		title: isUntracked ? "Delete File" : "Discard Changes",
		kind: "warning",
		okLabel: isUntracked ? "Delete" : "Discard",
	});
	if (!confirmed) return;
	await changeFiles([filePath], "Discard failed", async () => {
		await safeInvoke("discard_file", {
			path: repoPath,
			filePath: gitPathArgument(filePath),
		});
		onfileadvance?.(filePath, "unstaged");
		optimisticMove(filePath, "unstaged", "discard");
		showToast(`Discarded ${displayPath(filePath)}`, "success");
	});
}

function cannotBeUndone(files: readonly FileStatus[]): string {
	const untracked = files.filter((f) => f.status === "New").length;
	if (untracked === 0) return "This cannot be undone.";
	return `This deletes ${untracked} untracked file${untracked === 1 ? "" : "s"} and cannot be undone.`;
}

async function handleDiscardDirectory(dirPath: string, files: FileStatus[]) {
	if (files.length === 0) return;

	const repo = repoPath;
	const count = `${files.length} ${files.length === 1 ? "file" : "files"}`;
	const scope = query
		? `changes to the ${count} matching the filter in ${displayPath(dirPath)}/`
		: `all changes in ${displayPath(dirPath)}/ (${count})`;
	const confirmed = await ask(`Discard ${scope}? ${cannotBeUndone(files)}`, {
		title: "Discard Directory Changes",
		kind: "warning",
		okLabel: query ? matchLabel("Discard", files.length) : "Discard",
	});
	if (!confirmed) return;

	const filePaths = files.map(fileKey);
	await changeFiles(filePaths, "Discard failed", async () => {
		await safeInvoke("discard_files", {
			path: repo,
			filePaths: filePaths.map(gitPathArgument),
		});
		showToast(
			`Discarded ${files.length} file${files.length === 1 ? "" : "s"} in ${displayPath(dirPath)}/`,
			"success",
		);
	});
}

async function showUnstagedContextMenu(
	anchor: DOMRect | undefined,
	filePath: string,
	fileStatus: FileStatusType,
) {
	const { Menu, MenuItem, PredefinedMenuItem } = await nativeMenu();
	const isUntracked = fileStatus === "New";
	const absPath = `${repoPath}/${displayPath(filePath)}`;
	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					copyText(displayPath(filePath));
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
	await menu.popup(fileMenuPosition(anchor));
}

async function showUnstagedDirContextMenu(
	anchor: DOMRect | undefined,
	dirPath: string,
) {
	const { Menu, MenuItem, PredefinedMenuItem } = await nativeMenu();
	const absPath = `${repoPath}/${displayPath(dirPath)}`;
	const files = filesUnder(unstagedMatches, dirPath);
	if (files.length === 0) return;

	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					copyText(displayPath(dirPath));
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
				text: query
					? matchLabel("Stage", files.length)
					: `Stage All (${files.length})`,
				action: () => {
					stageFiles(files);
				},
			}),
			await MenuItem.new({
				text: query
					? matchLabel("Discard", files.length)
					: `Discard All (${files.length})`,
				action: () => {
					void handleDiscardDirectory(dirPath, files).catch((error) =>
						reportErrorToast(error, "Discard failed"),
					);
				},
			}),
		],
	});
	await menu.popup(fileMenuPosition(anchor));
}

async function showStagedContextMenu(
	anchor: DOMRect | undefined,
	filePath: string,
	oldPath: string | null,
) {
	const { Menu, MenuItem, PredefinedMenuItem } = await nativeMenu();
	const menu = await Menu.new({
		items: [
			...(await Promise.all(
				pathMenuEntriesOf(repoPath, displayPath(filePath), oldPath).map(
					(entry) =>
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
	await menu.popup(fileMenuPosition(anchor));
}

async function showStagedDirContextMenu(
	anchor: DOMRect | undefined,
	dirPath: string,
) {
	const { Menu, MenuItem, PredefinedMenuItem } = await nativeMenu();
	const absPath = `${repoPath}/${displayPath(dirPath)}`;
	const files = filesUnder(stagedMatches, dirPath);
	if (files.length === 0) return;

	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					copyText(displayPath(dirPath));
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
				text: query
					? matchLabel("Unstage", files.length)
					: `Unstage All (${files.length})`,
				action: () => {
					unstageFiles(files);
				},
			}),
		],
	});
	await menu.popup(fileMenuPosition(anchor));
}

async function resolveConflictedFile(
	filePath: string,
	side: "ours" | "theirs",
) {
	const repo = repoPath;
	const finish = mergePicks.startSave(repo, filePath);
	if (!finish) return;
	let submitted: { revision: string; content: string } | undefined;
	try {
		const sides = await safeInvoke<MergeSides>("get_merge_sides", {
			purpose: "resolution",
			path: repo,
			filePath,
		});
		if (repo !== repoPath) return;
		const draft = mergePicks.draftText(repo, filePath);
		if (
			draft !== undefined &&
			!(await ask(
				`Replace your edited Output for ${filePath} with the ${side === "ours" ? "Current" : "Incoming"} resolution and stage it?`,
				{
					title: "Replace Edited Output",
					kind: "warning",
					okLabel: "Replace and Stage",
				},
			))
		)
			return;
		if (repo !== repoPath) return;
		// The same result the editor's Take All buttons give: the conflicting
		// lines come from the chosen side and the rest is the text git merged,
		// since the menu item and the button carry the same name.
		const taken =
			side === "ours"
				? takeAllCurrent(sides.regions)
				: takeAllIncoming(sides.regions);
		const content = computeOutput(sides.regions, taken);
		submitted = { revision: sides.revision, content };
		await safeInvoke("save_merge_result", {
			expectedRevision: sides.revision,
			path: repo,
			filePath,
			content,
		});
		mergePicks.forget(repo, filePath);
		if (repo !== repoPath) return;
		onfileadvance?.(filePath, "conflicted");
		await loadStatus();
	} catch (e) {
		if (submitted && isTrunkError(e) && e.code === "merge_recovery_volume") {
			mergePicks.set(repo, filePath, submitted.revision, {
				taken: new Set(),
				typed: submitted.content,
			});
			mergePicks.refused(
				repo,
				filePath,
				submitted.revision,
				submitted.content,
				e.message,
			);
			showToast(
				`Open ${filePath} in the merge editor and choose Copy draft. The working file and Git directory are on different volumes.`,
				"error",
			);
		} else if (isTrunkError(e) && typeof e.working_revision === "string") {
			showToast(
				`${e.message} Your resolution is in ${filePath}. Use + on that file to stage it when ready.`,
				"error",
			);
		} else {
			reportErrorToast(e, "Resolution failed");
		}
	} finally {
		finish();
	}
}

async function showConflictedContextMenu(
	anchor: DOMRect | undefined,
	filePath: string,
) {
	const { Menu, MenuItem, PredefinedMenuItem } = await nativeMenu();
	const textResolution =
		status?.conflicted.find((file) => fileKey(file) === filePath)
			?.can_take_sides === true;
	const absPath = `${repoPath}/${displayPath(filePath)}`;
	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Take All Current",
				enabled: textResolution,
				action: () => {
					resolveConflictedFile(filePath, "ours").catch(() => {});
				},
			}),
			await MenuItem.new({
				text: "Take All Incoming",
				enabled: textResolution,
				action: () => {
					resolveConflictedFile(filePath, "theirs").catch(() => {});
				},
			}),
			await PredefinedMenuItem.new({ item: "Separator" }),
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					copyText(displayPath(filePath));
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
	await menu.popup(fileMenuPosition(anchor));
}

async function resolveDirectory(dirPath: string) {
	const filePaths = filesUnder(conflictedMatches, dirPath).map(fileKey);
	if (filePaths.length === 0) return;

	await resolveFiles(filePaths);
}

async function showConflictedDirContextMenu(
	anchor: DOMRect | undefined,
	dirPath: string,
) {
	const repo = repoPath;
	const absPath = `${repo}/${displayPath(dirPath)}`;
	const filePaths = filesUnder(conflictedMatches, dirPath).map(fileKey);
	if (filePaths.length === 0) return;
	const { Menu, MenuItem, PredefinedMenuItem } = await nativeMenu();
	const menu = await Menu.new({
		items: [
			await MenuItem.new({
				text: "Copy Relative Path",
				action: () => {
					copyText(displayPath(dirPath));
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
				text: query
					? matchLabel("Resolve", filePaths.length)
					: `Resolve All (${filePaths.length})`,
				action: () => {
					if (repo === repoPath) void resolveFiles(filePaths);
				},
			}),
		],
	});
	await menu.popup(fileMenuPosition(anchor));
}

async function handleDiscardAll() {
	const repo = repoPath;
	const filtered = Boolean(query);
	const unstaged = unstagedMatches;
	const paths = unstaged.map(fileKey);
	const count = paths.length;
	if (count === 0) return;

	const files = `${count} file${count === 1 ? "" : "s"}`;
	const confirmed = await ask(
		`Discard all changes to ${files}${filtered ? " matching the filter" : ""}? ${cannotBeUndone(unstaged)}`,
		{
			title: query ? "Discard Matching Changes" : "Discard All Changes",
			kind: "warning",
			okLabel: query ? matchLabel("Discard", count) : "Discard All",
		},
	);
	if (!confirmed) return;

	await changeFiles(paths, "Discard all failed", async () => {
		await safeInvoke("discard_all", {
			path: repo,
			filePaths: paths.map(gitPathArgument),
		});
		showToast(
			filtered
				? `Discarded changes to ${files}`
				: `Discarded all changes (${files})`,
			"success",
		);
	});
}

// ---------- Merge-mode actions ----------
async function markAllResolved() {
	await resolveFiles(conflictedMatches.map(fileKey));
}

async function resolveFiles(filePaths: string[]) {
	await changeFiles(filePaths, "Resolution failed", async () => {
		await stageWorkingResolution(filePaths);
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
	const confirmed = await ask(
		"Abort merge? This will discard all merge progress and return to the previous state.",
		{ title: "Abort Merge", kind: "warning", okLabel: "Abort Merge" },
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
	const confirmed = await ask(
		"Abort rebase? This will return to the pre-rebase state.",
		{
			title: "Abort Rebase",
			kind: "warning",
			okLabel: "Abort Rebase",
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

{#snippet sectionTitle(label: string, count: number, shown: number)}
	<span class="flex-1 min-w-0 inline-flex items-center gap-2">
		<span class="min-w-0 truncate text-callout font-semibold text-text"
			>{label}</span
		>
		<Badge variant="label" tone="muted"
			>{query ? `${shown} of ${count}` : count}</Badge
		>
	</span>
{/snippet}

<div
	bind:clientWidth={panelWidth}
	use:filterShortcut={() => filter?.focus()}
	class="w-full min-w-0 flex flex-col h-full overflow-hidden bg-surface"
>
	{#if bare}
		<p class="m-auto px-4 text-body text-center text-text-muted">
			This is a bare repository. It has no working tree, so there are no changes
			to stage or commit.
		</p>
	{:else}
		<!-- Panel header -->
		<div
			class={[
				"h-bar bg-surface-raised shadow-hairline py-0 flex items-center justify-center shrink-0",
				compactHeader ? "gap-1 px-2" : "gap-2 px-3",
			]}
		>
			{#if !filterOpen}
				<span
					class={[
						"flex-1 flex items-center min-w-0",
						compactHeader ? "gap-1" : "gap-2 justify-center",
					]}
				>
					<span class="shrink-0 text-callout text-text">
						{compactHeader
							? `${totalCount} changed`
							: `${totalCount} file${totalCount === 1 ? "" : "s"} changed`}
					</span>
					{#if currentBranch}
						<span
							class={compactHeader ? "sr-only" : "text-small text-text-muted"}
							>on</span
						>
						<BranchChip name={currentBranch} />
					{/if}
				</span>
			{/if}
			<ListFilter
				bind:this={filter}
				label="Filter files"
				bind:query
				bind:open={filterOpen}
			/>
			<FileViewControls
				treeMode={treeViewEnabled}
				expansion={directoryExpansion}
				onsetexpanded={setDirectoriesExpanded}
				onbulkkeydown={(event) => filter?.handleKeydown(event)}
				onviewtoggle={() => ontreeviewtoggle?.()}
			/>
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
					class:shrink-0={!conflicted_expanded}
				>
					<Row
						variant="band"
						wrapActions
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
						{#if compactHeader}
							{@const count = status?.conflicted.length ?? 0}
							<span
								class="flex-1 min-w-0 truncate text-caption font-semibold text-text-muted"
							>
								{query ? `${conflictedMatches.length} of ${count}` : count}
								{count === 1 ? "conflict" : "conflicts"}
							</span>
						{:else}
							{@render sectionTitle(
								"Conflicted files",
								status?.conflicted.length ?? 0,
								conflictedMatches.length,
							)}
						{/if}
						{#snippet actions()}
							{#if conflictedMatches.length > 0}
								<Button size="sm" variant="success" onclick={markAllResolved}>
									{query
										? matchLabel("Resolve", conflictedMatches.length)
										: "Mark All Resolved"}
								</Button>
							{/if}
						{/snippet}
					</Row>

					{#if conflicted_expanded}
						<TreeFileList
							bind:this={conflictedTree}
							files={conflictedMatches}
							filterQuery={query}
							treeMode={treeViewEnabled}
							actionLabel="+"
							{loadingFiles}
							onfileaction={(path) => stageFile(path, "conflicted")}
							onfileclick={(path) => onfileselect?.(path, "conflicted")}
							onfilecontextmenu={(e, path) =>
								showConflictedContextMenu(e, path)}
							ondirectoryaction={(dirPath) => resolveDirectory(dirPath)}
							ondirectorycontextmenu={(e, dirPath) =>
								showConflictedDirContextMenu(e, dirPath)}
							selectedPath={selectedKind === "conflicted" ? selectedPath : null}
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
					class:shrink-0={!unstaged_expanded}
				>
					<Row
						variant="band"
						wrapActions
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
						{@render sectionTitle(
							"Unstaged files",
							status?.unstaged.length ?? 0,
							unstagedMatches.length,
						)}
						{#snippet actions()}
							{#if unstagedMatches.length > 0}
								<Button
									icon
									size="sm"
									variant="danger"
									onclick={handleDiscardAll}
									aria-label={query
										? matchLabel("Discard", unstagedMatches.length)
										: "Discard all changes"}
									tooltip={query
										? matchLabel("Discard", unstagedMatches.length)
										: "Discard All"}
								>
									<Trash2 size={14} aria-hidden="true" />
								</Button>
								<Button
									size="sm"
									variant="success"
									onclick={stageAll}
									aria-label={query ? undefined : "Stage all changes"}
								>
									{query
										? matchLabel("Stage", unstagedMatches.length)
										: "Stage All"}
								</Button>
							{/if}
						{/snippet}
					</Row>

					{#if unstaged_expanded}
						<TreeFileList
							bind:this={unstagedTree}
							files={unstagedMatches}
							filterQuery={query}
							treeMode={treeViewEnabled}
							actionLabel="+"
							{loadingFiles}
							onfileaction={(path) => stageFile(path, "unstaged")}
							onfileclick={(path) => onfileselect?.(path, "unstaged")}
							onfilecontextmenu={(e, path, file) =>
								showUnstagedContextMenu(e, path, file.status)}
							ondirectoryaction={(dirPath) =>
								stageFiles(filesUnder(unstagedMatches, dirPath))}
							ondirectorycontextmenu={(e, dirPath) =>
								showUnstagedDirContextMenu(e, dirPath)}
							selectedPath={selectedKind === "unstaged" ? selectedPath : null}
							commentCounts={unstagedCommentCounts}
							commentTallies={unstagedCommentTallies}
						/>
					{/if}
				</div>
			{/if}

			<!-- Staged Files section -->
			<div
				data-testid="staging-staged-section"
				class="flex flex-col overflow-hidden min-h-0"
				class:flex-1={staged_expanded && unstaged_expanded}
				class:shrink-0={!staged_expanded}
			>
				<Row
					variant="band"
					wrapActions
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
						isOperation ? "Resolved files" : "Staged files",
						status?.staged.length ?? 0,
						stagedMatches.length,
					)}
					{#snippet actions()}
						{#if stagedMatches.length > 0}
							<Button
								size="sm"
								variant="warning"
								onclick={unstageAll}
								aria-label={query ? undefined : "Unstage all"}
							>
								{query
									? matchLabel("Unstage", stagedMatches.length)
									: "Unstage All"}
							</Button>
						{/if}
					{/snippet}
				</Row>

				{#if staged_expanded}
					<TreeFileList
						bind:this={stagedTree}
						files={stagedMatches}
						filterQuery={query}
						treeMode={treeViewEnabled}
						actionLabel="−"
						{loadingFiles}
						onfileaction={(path) => unstageFile(path)}
						onfileclick={(path) => onfileselect?.(path, "staged")}
						onfilecontextmenu={(e, path, file) =>
							showStagedContextMenu(e, path, file.old_path ?? null)}
						ondirectoryaction={(dirPath) =>
							unstageFiles(filesUnder(stagedMatches, dirPath))}
						ondirectorycontextmenu={(e, dirPath) =>
							showStagedDirContextMenu(e, dirPath)}
						selectedPath={selectedKind === "staged" ? selectedPath : null}
						commentCounts={stagedCommentCounts}
						commentTallies={stagedCommentTallies}
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
				data-testid="rebase-footer"
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
							Abort
						</Button>
					</div>
				</div>
			</div>
		{:else if isMerge}
			<Splitter variant="bar" fixed />
			<!-- Merge-continue actions. The commit message is edited in the host-owned
	         MessageEditor modal (runMergeContinue), not an inline form. -->
			<div class="flex flex-wrap shrink-0 gap-2 p-2" data-testid="merge-footer">
				<div class="grid grow-3">
					<Button
						size="lg"
						variant="success"
						onclick={runMergeContinue}
						disabled={!allResolved || mergeLoading}
					>
						{mergeLoading ? "Committing..." : "Commit merge"}
					</Button>
				</div>
				<div class="grid grow">
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
			<Splitter variant="bar" fixed />
			<!-- CommitForm — normal mode -->
			<CommitForm
				{repoPath}
				stagedCount={status?.staged.length ?? 0}
				showStagedCount={Boolean(query)}
				session={commitFormSession}
				{ondraftsummaryfocuschange}
				bind:this={commitForm}
			/>
		{/if}
	{/if}
</div>

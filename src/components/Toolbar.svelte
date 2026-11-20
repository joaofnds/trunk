<script lang="ts">
import Archive from "@lucide/svelte/icons/archive";
import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
import ArrowUp from "@lucide/svelte/icons/arrow-up";
import ClipboardCheck from "@lucide/svelte/icons/clipboard-check";
import GitBranch from "@lucide/svelte/icons/git-branch";
import LoaderCircle from "@lucide/svelte/icons/loader-circle";
import MessageSquare from "@lucide/svelte/icons/message-square";
import Redo2 from "@lucide/svelte/icons/redo-2";
import Undo2 from "@lucide/svelte/icons/undo-2";
import { emit } from "@tauri-apps/api/event";
import { SvelteSet } from "svelte/reactivity";
import { deletedReport } from "../lib/branch-delete.js";
import {
	CHECKOUT_CONFLICT_MESSAGE,
	checkedOutMessage,
	isCheckoutConflict,
} from "../lib/checkout.js";
import { createCoalescedTask } from "../lib/coalesced-task.js";
import { forDisplay, MAX_PATH_CHARS } from "../lib/display-text.js";
import { reportErrorToast } from "../lib/error-report.js";
import { isTrunkError, safeInvoke } from "../lib/invoke.js";
import { focusInEditable, keyChord, onMac } from "../lib/keyboard.js";
import { pullCheckedOut, pushCheckedOut } from "../lib/remote-op.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import { subscribeToRepoChanges } from "../lib/repo-change-subscription.js";
import { getScheduler } from "../lib/scheduler.js";
import { isStashing, popStash, saveStash } from "../lib/stash-actions.js";
import { clearErrorToasts, showToast } from "../lib/toast.svelte.js";
import type { DeletedBranch, ReviewTone, StashEntry } from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import ButtonGroup from "../lib/ui/ButtonGroup.svelte";
import {
	deletionToUndo,
	pendingRedo as pendingRedoIn,
	pushRedo,
	type RedoEntry,
	reofferDeletion,
	takeDeletion,
	takeRedo,
} from "../lib/undo-redo.svelte.js";
import { isUpdateFrozen } from "../lib/updates-lifecycle.js";
import InputDialog from "./InputDialog.svelte";
import PullDropdown from "./PullDropdown.svelte";

interface Props {
	repoPath: string;
	remoteState: RemoteState;
	// The commit the graph shows as HEAD, or null before it has shown one. Undo
	// takes back this commit and no other.
	shownHeadOid: string | null;
	reviewActive: boolean;
	// Whether the active review tab's center pane shows the review panel (vs. a diff).
	// Defaults true so a consumer that only sets reviewActive still styles correctly
	// (260531-l02e).
	reviewPanelShowing?: boolean;
	// Hides review threads in the graph and the diff. The review panel keeps them.
	reviewThreadsHidden?: boolean;
	// Comments in the current view (the review threads toggle's badge).
	viewCommentCount?: number;
	// Total comments in the session (Review button badge).
	reviewCommentCount?: number;
	viewCommentTone?: ReviewTone | null;
	reviewCommentTone?: ReviewTone | null;
	onreviewthreadshiddenchange?: (hidden: boolean) => void;
}

let {
	repoPath,
	remoteState,
	shownHeadOid,
	reviewActive,
	reviewPanelShowing = true,
	reviewThreadsHidden = false,
	viewCommentCount = 0,
	reviewCommentCount = 0,
	viewCommentTone = null,
	reviewCommentTone = null,
	onreviewthreadshiddenchange,
}: Props = $props();
const scheduler = getScheduler();
const pushing = $derived(
	remoteState.isRunning && remoteState.lastOp === "push",
);

// The Review button reflects whether the review PANEL is showing, not merely that a
// session is alive: active only when reviewActive AND the center pane shows the panel.
const reviewButtonActive = $derived(reviewActive && reviewPanelShowing);

function handleReviewToggle() {
	// While a diff is showing inside an active review, the button returns to the
	// panel rather than ending the session (which is the panel-state / menu action).
	if (reviewActive && !reviewPanelShowing) {
		void emit("review-show-panel");
		return;
	}
	void emit("review-toggle");
}

function handleReviewThreadsToggle() {
	onreviewthreadshiddenchange?.(!reviewThreadsHidden);
}

// Branch creation dialog state
let branchDialogOpen = $state(false);

// Undo/redo state
let canUndo = $state(false);
// Where HEAD is, refreshed on the same beat as canUndo. A pending redo names the
// position it belongs on, and offering it anywhere else would move the branch
// off history the user made since.
let headOid = $state<string | null>(null);
// An undo or redo moves HEAD, and the next one is decided against where it
// lands. A second Undo pressed meanwhile would undo a second commit, and a Redo
// would meet the old position, be refused, and bury the commit just undone. A
// second Pop would pop the next stash. Neither is what the user asked for. Each
// repository is held on its own, since the toolbar follows the active tab.
const movingHeadIn = new SvelteSet<string>();
const poppingIn = new SvelteSet<string>();

let pendingRedo = $derived(pendingRedoIn(repoPath));
let canRedo = $derived(pendingRedo !== null && pendingRedo.headOid === headOid);
let deletion = $derived(
	deletionToUndo(repoPath, { headOid, canUndoCommit: canUndo }),
);
let undoAllowed = $derived(
	!movingHeadIn.has(repoPath) &&
		(deletion !== null || (canUndo && shownHeadOid !== null)),
);
let redoAllowed = $derived(canRedo && !movingHeadIn.has(repoPath));
let undoTooltip = $derived(
	deletion !== null ? `Undo delete of branch ${branchLabel(deletion)}` : "Undo",
);
let redoTooltip = $derived(
	canRedo && pendingRedo?.kind === "delete"
		? `Redo delete of branch ${branchLabel(pendingRedo.deleted)}`
		: "Redo",
);

function branchLabel(deleted: DeletedBranch): string {
	return forDisplay(deleted.name, MAX_PATH_CHARS);
}

async function readUndoState(path: string) {
	let nextCanUndo = false;
	let nextHeadOid: string | null = null;
	try {
		nextCanUndo = await safeInvoke<boolean>("check_undo_available", {
			path,
		});
	} catch {}
	try {
		nextHeadOid = await safeInvoke<string | null>("head_oid", { path });
	} catch {}
	return { canUndoCommit: nextCanUndo, headOid: nextHeadOid };
}

// Check undo availability on mount and repo changes
$effect(() => {
	const path = repoPath;
	let active = true;
	const refresh = createCoalescedTask(scheduler, async () => {
		const next = await readUndoState(path);
		if (!active) return;
		canUndo = next.canUndoCommit;
		headOid = next.headOid;
	});
	void refresh.run();

	const unsubscribe = subscribeToRepoChanges(path, refresh);

	return () => {
		active = false;
		refresh.dispose();
		unsubscribe();
	};
});

// Undo decides between a delete and a commit against HEAD as it is when pressed,
// since the toolbar's view of it can trail a commit that just landed.
async function handleUndo() {
	if (!undoAllowed) return;
	const path = repoPath;
	const expectedHeadOid = shownHeadOid;

	movingHeadIn.add(path);
	try {
		const now = await readUndoState(path);
		if (path === repoPath) {
			canUndo = now.canUndoCommit;
			headOid = now.headOid;
		}
		if (deletionToUndo(path, now) !== null) {
			await undoDeletion(path, now.headOid);
		} else if (now.canUndoCommit && expectedHeadOid !== null) {
			await undoCommit(path, expectedHeadOid);
		}
	} finally {
		movingHeadIn.delete(path);
	}
}

async function undoCommit(path: string, expectedHeadOid: string) {
	try {
		// The backend refuses once HEAD is not this commit, so a commit a pull or
		// the terminal made, which the graph has not shown yet, is never taken back.
		const result = await safeInvoke<{
			head_oid: string;
			undone_oid: string;
		}>("undo_commit", { path, expectedHeadOid });
		pushRedo({
			kind: "commit",
			undoneOid: result.undone_oid,
			headOid: result.head_oid,
			repoPath: path,
		});
		if (path === repoPath) headOid = result.head_oid;
		clearErrorToasts();
	} catch (e) {
		reportErrorToast(e, "Undo failed");
	}
}

// A branch made since under the same name, or a commit the repository no
// longer has, refuses every later try too, so the entry goes rather than staying
// on offer to fail the same way. A redo delete meets the same once the branch is
// checked out somewhere, which is a new action on it.
const UNDO_NEVER_LANDS = new Set(["branch_exists", "restore_missing"]);
const REDO_NEVER_LANDS: Record<RedoEntry["kind"], Set<string>> = {
	commit: new Set(["redo_missing"]),
	delete: new Set([
		"redo_missing",
		"redo_stale",
		"cannot_delete_head",
		"branch_in_use",
	]),
};

async function undoDeletion(path: string, seenHeadOid: string | null) {
	const deleted = takeDeletion(path);
	if (deleted === null) return;

	try {
		await safeInvoke("restore_branch", {
			path,
			deletion: deleted.deletion,
			seenHeadOid,
		});
		pushRedo({ kind: "delete", deleted, headOid: seenHeadOid, repoPath: path });
		showToast(`Restored branch ${branchLabel(deleted)}`);
	} catch (e) {
		if (!(isTrunkError(e) && UNDO_NEVER_LANDS.has(e.code))) {
			reofferDeletion(path, deleted);
		}
		reportErrorToast(e, "Undo failed");
	}
}

async function handleRedo() {
	const path = repoPath;
	if (!redoAllowed) return;
	const entry = takeRedo(path);
	if (entry === null) return;

	movingHeadIn.add(path);
	try {
		await redo(entry);
	} catch (e) {
		if (!(isTrunkError(e) && REDO_NEVER_LANDS[entry.kind].has(e.code))) {
			pushRedo(entry);
		}
		reportErrorToast(e, "Redo failed");
	} finally {
		movingHeadIn.delete(path);
	}
}

async function redo(entry: RedoEntry) {
	if (entry.kind === "delete") {
		const deleted = await safeInvoke<DeletedBranch>("redo_branch_delete", {
			path: entry.repoPath,
			branchName: entry.deleted.name,
			expectedTip: entry.deleted.tip,
		});
		reofferDeletion(entry.repoPath, deleted);
		showToast(deletedReport(deleted));
		return;
	}
	await safeInvoke("redo_commit", {
		path: entry.repoPath,
		undoneOid: entry.undoneOid,
		expectedHeadOid: entry.headOid,
		expectedRepoPath: entry.repoPath,
	});
	clearErrorToasts();
}

// Cmd is the shortcut key on macOS, where Ctrl+Z belongs to nothing, and Ctrl
// or the system key elsewhere.
function historyStep(chord: string): "undo" | "redo" | null {
	const modifiers = onMac() ? ["Meta"] : ["Ctrl", "Meta"];
	for (const modifier of modifiers) {
		if (chord === `${modifier}+z`) return "undo";
		if (chord === `${modifier}+Shift+z`) return "redo";
	}
	return null;
}

// A focused field undoes its own typing, an open dialog is still asking the
// user something, and an update in preparation has frozen the app, so in each
// the keys are not the repository's. A held key repeats, and each repeat would
// step one more commit.
function handleUndoRedoKey(e: KeyboardEvent) {
	const step = historyStep(keyChord(e));
	if (step === null) return;
	if (isUpdateFrozen()) return;
	if (focusInEditable(document.activeElement)) return;
	if (document.querySelector("dialog[open]")) return;

	e.preventDefault();
	if (e.repeat) return;
	void (step === "redo" ? handleRedo() : handleUndo());
}

function handlePull() {
	void pullCheckedOut(remoteState, repoPath);
}

function handlePush() {
	void pushCheckedOut(remoteState, repoPath);
}

function handleStash() {
	void saveStash(repoPath, "");
}

async function handlePop() {
	const path = repoPath;
	if (poppingIn.has(path)) return;

	poppingIn.add(path);
	try {
		const stashes = await safeInvoke<StashEntry[]>("list_stashes", { path });
		const latest = stashes[0];
		if (!latest) {
			showToast("No stash to pop", "error");
			return;
		}
		await popStash(path, latest.oid);
	} catch (e) {
		reportErrorToast(e, "Failed to read the stashes");
	} finally {
		poppingIn.delete(path);
	}
}

function handleBranch() {
	branchDialogOpen = true;
}

async function handleBranchCreate(values: Record<string, string>) {
	branchDialogOpen = false;
	const name = values.name?.trim();
	if (!name) return;
	try {
		await safeInvoke("create_branch", { path: repoPath, name });
		showToast(checkedOutMessage(name), "success");
	} catch (e) {
		if (isCheckoutConflict(e)) {
			showToast(CHECKOUT_CONFLICT_MESSAGE, "error");
		} else {
			reportErrorToast(e, "Failed to create branch");
		}
	}
}
</script>

<style>
.toolbar {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding: 0 var(--space-3) 0 var(--space-2);
}

.toolbar-group {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}

.toolbar-divider {
	width: 1px;
	height: calc(9 * var(--u) / 2);
	background: var(--color-border);
	flex-shrink: 0;
}

.toolbar-badge {
	position: absolute;
	top: calc(-2 * var(--u));
	right: calc(-2 * var(--u));
	min-width: calc(4 * var(--u));
	height: calc(4 * var(--u));
	padding: 0 var(--space-1);
	display: flex;
	align-items: center;
	justify-content: center;
	border-radius: var(--radius-pill);
	/* A ring of the bar's own color parts the badge from a pressed button,
	   which is painted in the same accent. */
	box-shadow: 0 0 0 2px var(--color-surface);
	background: var(--color-accent);
	color: var(--color-on-accent);
	font-size: var(--text-caption);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-none);
}

.toolbar-badge.tone-open {
	background: var(--color-thread-open);
}
.toolbar-badge.tone-addressed {
	background: var(--color-thread-addressed);
}
.toolbar-badge.tone-done {
	background: var(--color-thread-done);
}
.toolbar-badge.tone-dismissed {
	background: var(--color-thread-dismissed);
}
.toolbar-badge.tone-stale {
	background: var(--color-thread-stale);
}
</style>

<svelte:window onkeydown={handleUndoRedoKey} />

<div data-tauri-drag-region class="toolbar">
	<div class="toolbar-group">
		<Button
			icon
			disabled={!undoAllowed}
			onclick={handleUndo}
			aria-label="Undo"
			tooltip={undoTooltip}
		>
			<Undo2 size={14} />
		</Button>
		<Button
			icon
			disabled={!redoAllowed}
			onclick={handleRedo}
			aria-label="Redo"
			tooltip={redoTooltip}
		>
			<Redo2 size={14} />
		</Button>
	</div>

	<div class="toolbar-divider"></div>

	<div class="toolbar-group">
		<PullDropdown
			{repoPath}
			disabled={remoteState.isRunning}
			{remoteState}
			onpull={handlePull}
		/>
		<Button
			icon
			disabled={remoteState.isRunning}
			onclick={handlePush}
			aria-label="Push"
			aria-busy={pushing || undefined}
			tooltip={pushing ? "Pushing…" : "Push"}
		>
			{#if pushing}
				<LoaderCircle size={14} class="animate-spin" />
			{:else}
				<ArrowUp size={14} />
			{/if}
		</Button>
	</div>

	<div class="toolbar-divider"></div>

	<div class="toolbar-group">
		<Button icon onclick={handleBranch} aria-label="Branch" tooltip="Branch">
			<GitBranch size={14} />
		</Button>
		<Button
			icon
			disabled={isStashing(repoPath)}
			onclick={handleStash}
			aria-label="Stash"
			tooltip="Stash"
		>
			<Archive size={14} />
		</Button>
		<Button
			icon
			disabled={poppingIn.has(repoPath)}
			onclick={handlePop}
			aria-label="Pop"
			tooltip="Pop"
		>
			<ArchiveRestore size={14} />
		</Button>
	</div>

	<div class="toolbar-divider"></div>

	<div class="toolbar-group">
		<ButtonGroup tone={reviewThreadsHidden ? "neutral" : "accent"}>
			<Button
				icon
				joined
				aria-pressed={!reviewThreadsHidden}
				aria-label={reviewThreadsHidden
					? "Show review threads"
					: "Hide review threads"}
				tooltip={reviewThreadsHidden
					? "Show review threads"
					: "Hide review threads"}
				onclick={handleReviewThreadsToggle}
			>
				<MessageSquare size={14} />
				{#if viewCommentCount > 0}
					<span
						class="toolbar-badge tone-{viewCommentTone ?? "open"}"
						role="img"
						aria-label="{viewCommentCount} review comments in this view"
						>{viewCommentCount}</span
					>
				{/if}
			</Button>
		</ButtonGroup>
		<Button
			icon
			aria-pressed={reviewButtonActive}
			aria-label="Review"
			tooltip="Review"
			onclick={handleReviewToggle}
		>
			<ClipboardCheck size={14} />
			{#if reviewCommentCount > 0}
				<span
					class="toolbar-badge tone-{reviewCommentTone ?? "open"}"
					role="img"
					aria-label="{reviewCommentCount} review comments in this review"
					>{reviewCommentCount}</span
				>
			{/if}
		</Button>
	</div>
</div>

{#if branchDialogOpen}
	<InputDialog
		title="Create Branch"
		fields={[
			{
				key: "name",
				label: "Branch name",
				placeholder: "feature/my-branch",
				required: true,
			},
		]}
		onsubmit={handleBranchCreate}
		oncancel={() => (branchDialogOpen = false)}
	/>
{/if}

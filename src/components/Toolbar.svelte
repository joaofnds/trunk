<script module lang="ts">
import { slide } from "svelte/transition";

export function reviewFilterSlide(node: Element) {
	const reduceMotion =
		typeof window !== "undefined" &&
		window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
	return slide(node, { axis: "x", duration: reduceMotion ? 0 : 160 });
}
</script>

<script lang="ts">
import Archive from "@lucide/svelte/icons/archive";
import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
import ArrowUp from "@lucide/svelte/icons/arrow-up";
import ClipboardCheck from "@lucide/svelte/icons/clipboard-check";
import GitBranch from "@lucide/svelte/icons/git-branch";
import MessageSquare from "@lucide/svelte/icons/message-square";
import Redo2 from "@lucide/svelte/icons/redo-2";
import Undo2 from "@lucide/svelte/icons/undo-2";
import { emit, listen } from "@tauri-apps/api/event";
import { createCoalescedTask } from "../lib/coalesced-task.js";
import { reportErrorToast } from "../lib/error-report.js";
import { isTrunkError, safeInvoke } from "../lib/invoke.js";
import { runRemoteOp } from "../lib/remote-op.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import { subscribeToRepoChanges } from "../lib/repo-change-subscription.js";
import {
	isValidReviewFilter,
	REVIEW_FILTER_OPTIONS,
} from "../lib/review-filter.js";
import { getScheduler } from "../lib/scheduler.js";
import { showToast } from "../lib/toast.svelte.js";
import type { ReviewFilter, ReviewTone, StashEntry } from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import ButtonGroup from "../lib/ui/ButtonGroup.svelte";
import type { UndoRedoManager } from "../lib/undo-redo.svelte.js";
import InputDialog from "./InputDialog.svelte";
import PullDropdown from "./PullDropdown.svelte";

interface Props {
	repoPath: string;
	remoteState: RemoteState;
	undoRedo: UndoRedoManager;
	reviewActive: boolean;
	// Whether the active review tab's center pane shows the review panel (vs. a diff).
	// Defaults true so a consumer that only sets reviewActive still styles correctly
	// (260531-l02e).
	reviewPanelShowing?: boolean;
	reviewFilter?: ReviewFilter;
	// Comments in the current view (review-filter badge).
	viewCommentCount?: number;
	// Total comments in the session (Review button badge).
	reviewCommentCount?: number;
	viewCommentTone?: ReviewTone | null;
	reviewCommentTone?: ReviewTone | null;
	onreviewfilterchange?: (filter: ReviewFilter) => void;
}

let {
	repoPath,
	remoteState,
	undoRedo,
	reviewActive,
	reviewPanelShowing = true,
	reviewFilter = "all",
	viewCommentCount = 0,
	reviewCommentCount = 0,
	viewCommentTone = null,
	reviewCommentTone = null,
	onreviewfilterchange,
}: Props = $props();
const scheduler = getScheduler();
let lastVisibleReviewFilter = $state<Exclude<ReviewFilter, "none">>("all");

$effect(() => {
	if (reviewFilter !== "none") lastVisibleReviewFilter = reviewFilter;
});

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
	onreviewfilterchange?.(
		reviewFilter === "none" ? lastVisibleReviewFilter : "none",
	);
}

// Listen to remote-progress events from backend (relocated from StatusBar)
$effect(() => {
	let unlisten: (() => void) | undefined;
	const path = repoPath;

	listen<{ path: string; line: string }>("remote-progress", (event) => {
		if (event.payload.path === path) {
			remoteState.progressLine = event.payload.line;
		}
	}).then((fn) => {
		unlisten = fn;
	});

	return () => {
		unlisten?.();
	};
});

// Branch creation dialog state
let branchDialogOpen = $state(false);

// Undo/redo state
let canUndo = $state(false);
// Where HEAD is, refreshed on the same beat as canUndo. A pending redo names the
// position it belongs on, and offering it anywhere else would commit the undone
// message onto unrelated history.
let headOid = $state<string | null>(null);

let pendingRedo = $derived(
	undoRedo.state.redoStack[undoRedo.state.redoStack.length - 1] ?? null,
);
let canRedo = $derived(
	pendingRedo !== null &&
		headOid !== null &&
		pendingRedo.headOid === headOid &&
		pendingRedo.repoPath === repoPath,
);

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
	return { canUndo: nextCanUndo, headOid: nextHeadOid };
}

// Check undo availability on mount and repo changes
$effect(() => {
	const path = repoPath;
	let active = true;
	const refresh = createCoalescedTask(scheduler, async () => {
		const next = await readUndoState(path);
		if (!active) return;
		canUndo = next.canUndo;
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

async function handleUndo() {
	try {
		const result = await safeInvoke<{
			subject: string;
			body: string | null;
			head_oid: string;
		}>("undo_commit", {
			path: repoPath,
		});
		undoRedo.push({
			subject: result.subject,
			body: result.body,
			headOid: result.head_oid,
			repoPath,
		});
		headOid = result.head_oid;
	} catch (e) {
		console.error("undo failed:", e);
	}
}

async function handleRedo() {
	// The button is gated on the same condition, so this only catches HEAD moving
	// between the render and the click.
	if (!canRedo) return;
	const entry = undoRedo.pop();
	if (!entry) return;
	try {
		await safeInvoke("redo_commit", {
			path: repoPath,
			subject: entry.subject,
			body: entry.body,
			expectedHeadOid: entry.headOid,
			expectedRepoPath: entry.repoPath,
		});
	} catch (e) {
		console.error("redo failed:", e);
		// Push back on failure
		undoRedo.push(entry);
	}
}

function handlePull() {
	runRemoteOp(remoteState, repoPath, "git_pull", "Pulled successfully");
}

function handlePush() {
	runRemoteOp(remoteState, repoPath, "git_push", "Pushed successfully");
}

async function handleStash() {
	try {
		await safeInvoke("stash_save", { path: repoPath, message: "" });
		showToast("Stash created", "success");
	} catch (e) {
		console.error("stash_save failed:", e);
		reportErrorToast(e, "Failed to create stash");
	}
}

async function handlePop() {
	try {
		const stashes = await safeInvoke<StashEntry[]>("list_stashes", {
			path: repoPath,
		});
		const latest = stashes[0];
		if (!latest) {
			showToast("No stash to apply", "error");
			return;
		}
		await safeInvoke("stash_pop", { path: repoPath, oid: latest.oid });
		showToast("Stash applied", "success");
	} catch (e) {
		console.error("stash_pop failed:", e);
		showToast("Failed to apply stash", "error");
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
		showToast(`Checked out ${name}`, "success");
	} catch (e) {
		if (isTrunkError(e) && e.code === "dirty_workdir") {
			showToast(
				"Branch created (checkout skipped — uncommitted changes)",
				"success",
			);
		} else {
			showToast("Failed to create branch", "error");
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
	height: 18px;
	background: var(--color-border);
	flex-shrink: 0;
}

.toolbar-badge {
	position: absolute;
	top: calc(-1 * var(--space-2));
	right: calc(-1 * var(--space-2));
	min-width: 16px;
	height: 16px;
	padding: 0 var(--space-1);
	display: flex;
	align-items: center;
	justify-content: center;
	border-radius: var(--radius-pill);
	background: var(--color-accent);
	color: var(--color-on-accent);
	font-size: var(--text-caption);
	font-weight: var(--weight-semibold);
	line-height: var(--leading-none);
}

.review-filter-select {
	display: flex;
	align-items: center;
	overflow: hidden;
}
.review-filter-select select {
	max-width: 92px;
	height: var(--control-h);
	border: none;
	border-radius: var(--radius);
	background: transparent;
	color: var(--color-text-strong);
	font: inherit;
	font-size: var(--text-small);
	padding: 0 var(--space-2);
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

<div data-tauri-drag-region class="toolbar">
	<div class="toolbar-group">
		<Button
			icon
			disabled={!canUndo}
			onclick={handleUndo}
			aria-label="Undo"
			tooltip="Undo"
		>
			<Undo2 size={14} />
		</Button>
		<Button
			icon
			disabled={!canRedo}
			onclick={handleRedo}
			aria-label="Redo"
			tooltip="Redo"
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
			tooltip="Push"
		>
			<ArrowUp size={14} />
		</Button>
	</div>

	<div class="toolbar-divider"></div>

	<div class="toolbar-group">
		<Button icon onclick={handleBranch} aria-label="Branch" tooltip="Branch">
			<GitBranch size={14} />
		</Button>
		<Button icon onclick={handleStash} aria-label="Stash" tooltip="Stash">
			<Archive size={14} />
		</Button>
		<Button icon onclick={handlePop} aria-label="Pop" tooltip="Pop">
			<ArchiveRestore size={14} />
		</Button>
	</div>

	<div class="toolbar-divider"></div>

	<div class="toolbar-group">
		<ButtonGroup tone={reviewFilter !== "none" ? "accent" : "neutral"}>
			{#if reviewFilter !== "none"}
				<label
					class="review-filter-select"
					title="Filter review threads"
					transition:reviewFilterSlide
				>
					<span class="sr-only">Review filter</span>
					<select
						aria-label="Review filter selection"
						aria-describedby="review-filter-help"
						value={reviewFilter}
						onchange={(event) => {
              const value = (event.currentTarget as HTMLSelectElement).value;
              if (isValidReviewFilter(value)) onreviewfilterchange?.(value);
            }}
					>
						{#each REVIEW_FILTER_OPTIONS as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
					<span id="review-filter-help" class="sr-only">
						All threads shows every card; its badges count only open and
						addressed threads. Other filters show matching thread states. Use
						the review threads button to hide review content and creation
						controls.
					</span>
				</label>
			{/if}
			<Button
				icon
				joined
				aria-pressed={reviewFilter !== "none"}
				aria-label={reviewFilter === "none" ? "Show review threads" : "Hide review threads"}
				tooltip={reviewFilter === "none" ? "Show review threads" : "Hide review threads"}
				onclick={handleReviewThreadsToggle}
			>
				<MessageSquare size={14} />
				{#if viewCommentCount > 0}
					<span
						class="toolbar-badge tone-{viewCommentTone ?? 'open'}"
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
					class="toolbar-badge tone-{reviewCommentTone ?? 'open'}"
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
		fields={[{ key: 'name', label: 'Branch name', placeholder: 'feature/my-branch', required: true }]}
		onsubmit={handleBranchCreate}
		oncancel={() => (branchDialogOpen = false)}
	/>
{/if}

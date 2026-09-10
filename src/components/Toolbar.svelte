<script lang="ts">
import Archive from "@lucide/svelte/icons/archive";
import ArchiveRestore from "@lucide/svelte/icons/archive-restore";
import ArrowDown from "@lucide/svelte/icons/arrow-down";
import ArrowUp from "@lucide/svelte/icons/arrow-up";
import ClipboardCheck from "@lucide/svelte/icons/clipboard-check";
import GitBranch from "@lucide/svelte/icons/git-branch";
import MessageSquare from "@lucide/svelte/icons/message-square";
import Redo2 from "@lucide/svelte/icons/redo-2";
import Undo2 from "@lucide/svelte/icons/undo-2";
import { emit, listen } from "@tauri-apps/api/event";
import { isTrunkError, safeInvoke } from "../lib/invoke.js";
import { runRemoteOp } from "../lib/remote-op.js";
import type { RemoteState } from "../lib/remote-state.svelte.js";
import {
	isValidReviewFilter,
	REVIEW_FILTER_OPTIONS,
} from "../lib/review-filter.js";
import { showToast } from "../lib/toast.svelte.js";
import { tooltip } from "../lib/tooltip.js";
import type { ReviewFilter, ReviewTone, StashEntry } from "../lib/types.js";
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

async function checkUndoAvailable() {
	try {
		canUndo = await safeInvoke<boolean>("check_undo_available", {
			path: repoPath,
		});
	} catch {
		canUndo = false;
	}
	try {
		headOid = await safeInvoke<string | null>("head_oid", { path: repoPath });
	} catch {
		headOid = null;
	}
}

// Check undo availability on mount and repo changes
$effect(() => {
	// Re-run when repoPath changes
	void repoPath;
	checkUndoAvailable();

	const unlistenPromise = listen<string>("repo-changed", (event) => {
		if (event.payload === repoPath) {
			checkUndoAvailable();
		}
	});

	return () => {
		unlistenPromise.then((fn) => fn());
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
		showToast("Failed to create stash", "error");
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
    background: var(--line);
    flex-shrink: 0;
  }

  .toolbar-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--control-h);
    height: var(--control-h);
    /* The toolbar is a flex row, so without this a crowded window narrows the
       buttons off their declared square. */
    flex-shrink: 0;
    padding: 0;
    /* Paint, not length: a border under border-box would cost the button 2px
       of the height its token declares. */
    box-shadow: inset 0 0 0 1px var(--line);
    border-radius: var(--radius);
    background: transparent;
    color: var(--fg-1);
    cursor: pointer;
  }
  .toolbar-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .toolbar-btn:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .toolbar-btn:disabled {
    opacity: 0.45;
    color: var(--fg-3);
    cursor: default;
    pointer-events: none;
  }

  .toolbar-btn.toolbar-btn-active {
    background: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
    color: var(--accent-fg);
  }
  .toolbar-btn.toolbar-btn-active:hover:not(:disabled) {
    background: var(--accent-hi);
    box-shadow: inset 0 0 0 1px var(--accent-hi);
  }

  .toolbar-btn-badged {
    position: relative;
  }

  .toolbar-badge {
    position: absolute;
    top: -6px;
    right: -6px;
    min-width: 16px;
    height: 16px;
    padding: 0 var(--space-1);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-pill);
    background: var(--accent);
    color: var(--accent-fg);
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
  }

  .review-filter-control {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    height: var(--control-h);
    padding: 0 var(--space-1);
    color: var(--color-text-muted);
    border-radius: var(--radius);
  }
  .review-filter-control:hover,
  .review-filter-control:focus-within {
    color: var(--color-text);
    background: var(--bg-hover);
  }
  .review-filter-control select {
    max-width: 92px;
    height: var(--control-sm-h);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
    font-size: 11px;
    padding: 0 var(--space-1);
  }
  .toolbar-badge.tone-open { background: var(--color-thread-open); }
  .toolbar-badge.tone-addressed { background: var(--color-thread-addressed); }
  .toolbar-badge.tone-done { background: var(--color-thread-done); }
  .toolbar-badge.tone-dismissed { background: var(--color-thread-dismissed); }
  .toolbar-badge.tone-stale { background: var(--color-thread-stale); }

  .btn-group {
    display: inline-flex;
    align-items: stretch;
    height: var(--control-h);
    flex-shrink: 0;
    /* Paint, not length: a real border would take 2px out of the content box
       and leave the group's own children overflowing it. */
    box-shadow: inset 0 0 0 1px var(--line);
    border-radius: var(--radius);
  }
  .btn-group .toolbar-btn {
    box-shadow: none;
    border-radius: var(--radius) 0 0 var(--radius);
  }

</style>

<div data-tauri-drag-region class="toolbar">
  <div class="toolbar-group">
    <button class="toolbar-btn" disabled={!canUndo} onclick={handleUndo} aria-label="Undo" use:tooltip={"Undo"}>
      <Undo2 size={14} />
    </button>
    <button class="toolbar-btn" disabled={!canRedo} onclick={handleRedo} aria-label="Redo" use:tooltip={"Redo"}>
      <Redo2 size={14} />
    </button>
  </div>

  <div class="toolbar-divider"></div>

  <div class="toolbar-group">
    <div class="btn-group">
      <button class="toolbar-btn" disabled={remoteState.isRunning} onclick={handlePull} aria-label="Pull" use:tooltip={"Pull"}>
        <ArrowDown size={14} />
      </button>
      <PullDropdown {repoPath} disabled={remoteState.isRunning} {remoteState} />
    </div>
    <button class="toolbar-btn" disabled={remoteState.isRunning} onclick={handlePush} aria-label="Push" use:tooltip={"Push"}>
      <ArrowUp size={14} />
    </button>
  </div>

  <div class="toolbar-divider"></div>

  <div class="toolbar-group">
    <button class="toolbar-btn" onclick={handleBranch} aria-label="Branch" use:tooltip={"Branch"}>
      <GitBranch size={14} />
    </button>
    <button class="toolbar-btn" onclick={handleStash} aria-label="Stash" use:tooltip={"Stash"}>
      <Archive size={14} />
    </button>
    <button class="toolbar-btn" onclick={handlePop} aria-label="Pop" use:tooltip={"Pop"}>
      <ArchiveRestore size={14} />
    </button>
  </div>

  <div class="toolbar-divider"></div>

  <div class="toolbar-group">
    <label class="review-filter-control" title="Filter review threads">
      <MessageSquare size={14} />
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
			All threads shows every card; its badges count only open and addressed threads.
			Other filters show matching thread states, and Hide all removes review content
			and creation controls.
		</span>
      {#if viewCommentCount > 0}
        <span
          class="toolbar-badge tone-{viewCommentTone ?? 'open'}"
          aria-label="{viewCommentCount} review comments in this view"
        >{viewCommentCount}</span>
      {/if}
    </label>
    <button
      class="toolbar-btn toolbar-btn-badged"
      class:toolbar-btn-active={reviewButtonActive}
      aria-pressed={reviewButtonActive}
      aria-label="Review"
      use:tooltip={"Review"}
      onclick={handleReviewToggle}
    >
      <ClipboardCheck size={14} />
      {#if reviewCommentCount > 0}
        <span
          class="toolbar-badge tone-{reviewCommentTone ?? 'open'}"
          aria-label="{reviewCommentCount} review comments in this review"
        >{reviewCommentCount}</span>
      {/if}
    </button>
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

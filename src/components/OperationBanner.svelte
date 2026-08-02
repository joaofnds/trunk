<script lang="ts">
import { GitBranch, GitMerge } from "@lucide/svelte";
import { safeInvoke, type TrunkError } from "../lib/invoke.js";
import { showToast } from "../lib/toast.svelte.js";
import type { OperationInfo } from "../lib/types.js";

interface Props {
	info: OperationInfo;
	repoPath: string;
	onaction?: () => void;
	// Threaded RepoView -> StagingPanel -> OperationBanner so the Revert
	// Continue button can reach the single host-owned MessageEditor (OQ-2).
	onopenmessageeditor?: (
		defaultValue: string,
		title: string,
	) => Promise<string | null>;
}

let { info, repoPath, onaction, onopenmessageeditor }: Props = $props();
let loading = $state(false);

let isMerge = $derived(info.op_type === "Merge");
let isRebase = $derived(info.op_type === "Rebase");
let isRevert = $derived(info.op_type === "Revert");
let isCherryPick = $derived(info.op_type === "CherryPick");

let sourceBranch = $derived(info.source_branch ?? "???");
let targetBranch = $derived(info.target_branch ?? "???");
let sourceColor = $derived(`var(--lane-${(info.source_color_index ?? 1) % 8})`);
let targetColor = $derived(`var(--lane-${(info.target_color_index ?? 0) % 8})`);

let label = $derived.by(() => {
	if (info.op_type === "CherryPick") return "Cherry-pick in progress";
	if (info.op_type === "Revert") return "Revert in progress";
	return "";
});

async function handleContinue() {
	loading = true;
	try {
		const cmd = isMerge ? "merge_continue" : "rebase_continue";
		await safeInvoke(cmd, { path: repoPath });
		showToast(isMerge ? "Merge completed" : "Rebase continued", "success");
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Continue failed", "error");
	} finally {
		loading = false;
		onaction?.();
	}
}

async function handleSkip() {
	loading = true;
	try {
		await safeInvoke("rebase_skip", { path: repoPath });
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Skip failed", "error");
	} finally {
		loading = false;
		onaction?.();
	}
}

async function handleAbort() {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const opName = isMerge ? "merge" : "rebase";
	const confirmed = await ask(
		`Abort ${opName}? This will discard all ${opName} progress and return to the previous state.`,
		{
			title: `Abort ${opName.charAt(0).toUpperCase() + opName.slice(1)}`,
			kind: "warning",
		},
	);
	if (!confirmed) return;
	loading = true;
	try {
		const cmd = isMerge ? "merge_abort" : "rebase_abort";
		await safeInvoke(cmd, { path: repoPath });
		showToast(
			`${opName.charAt(0).toUpperCase() + opName.slice(1)} aborted`,
			"success",
		);
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Abort failed", "error");
	} finally {
		loading = false;
		onaction?.();
	}
}

// Revert recovery (MSG-06). A Revert state previously rendered no buttons,
// trapping a cancelled revert in REVERT_HEAD. Continue routes the commit message
// through the host-owned MessageEditor (default verbatim from MERGE_MSG); cancel
// (null) makes no commit and leaves the revert recoverable (D-02). Abort runs
// `git revert --abort`.
async function handleRevertContinue() {
	loading = true;
	try {
		const def = await safeInvoke<string | null>("get_merge_message", {
			path: repoPath,
		});
		const msg = await onopenmessageeditor?.(def ?? "", "Revert commit message");
		if (msg == null) return;
		await safeInvoke("revert_continue", { path: repoPath, message: msg });
		showToast("Revert completed", "success");
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Continue failed", "error");
	} finally {
		loading = false;
		onaction?.();
	}
}

async function handleCherryPickContinue() {
	loading = true;
	try {
		const def = await safeInvoke<string | null>("get_merge_message", {
			path: repoPath,
		});
		const msg = await onopenmessageeditor?.(
			def ?? "",
			"Cherry-pick commit message",
		);
		if (msg == null) return;
		await safeInvoke("cherry_pick_continue", { path: repoPath, message: msg });
		showToast("Cherry-pick completed", "success");
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Continue failed", "error");
	} finally {
		loading = false;
		onaction?.();
	}
}

async function handleCherryPickAbort() {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		"Abort cherry-pick? This will discard the in-progress cherry-pick and return to the previous state.",
		{ title: "Abort Cherry-pick", kind: "warning" },
	);
	if (!confirmed) return;
	loading = true;
	try {
		await safeInvoke("cherry_pick_abort", { path: repoPath });
		showToast("Cherry-pick aborted", "success");
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Abort failed", "error");
	} finally {
		loading = false;
		onaction?.();
	}
}

async function handleRevertAbort() {
	const { ask } = await import("@tauri-apps/plugin-dialog");
	const confirmed = await ask(
		"Abort revert? This will discard the in-progress revert and return to the previous state.",
		{ title: "Abort Revert", kind: "warning" },
	);
	if (!confirmed) return;
	loading = true;
	try {
		await safeInvoke("revert_abort", { path: repoPath });
		showToast("Revert aborted", "success");
	} catch (e) {
		const err = e as TrunkError;
		showToast(err.message ?? "Abort failed", "error");
	} finally {
		loading = false;
		onaction?.();
	}
}
</script>

<div style="
  flex-shrink: 0;
  padding: 8px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--color-border);
  background: {isMerge ? 'var(--color-banner-warning-bg)' : 'var(--color-banner-info-bg)'};
  border-left: 3px solid {isMerge ? 'var(--color-banner-warning-border)' : 'var(--color-banner-info-border)'};
">
  <span style="color: {isMerge ? 'var(--color-banner-warning-border)' : 'var(--color-banner-info-border)'}; display: inline-flex; align-items: center; flex-shrink: 0;">
    {#if isMerge}<GitMerge size={14} />{:else}<GitBranch size={14} />{/if}
  </span>
  <div style="font-size: 12px; color: var(--color-text); flex: 1; overflow: hidden; display: flex; align-items: center; gap: 4px; white-space: nowrap;">
    {#if isMerge || isRebase}
      <span style="flex-shrink: 0;">{isMerge ? 'Merging' : 'Rebasing'}</span>
      <span style="
        background: {sourceColor};
        border-radius: 9999px;
        padding: 0 6px;
        font-size: 11px;
        line-height: 16px;
        color: var(--bg-0);
        font-weight: 700;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      ">{sourceBranch}</span>
      <span style="flex-shrink: 0;">{isMerge ? 'into' : 'onto'}</span>
      <span style="
        background: {targetColor};
        border-radius: 9999px;
        padding: 0 6px;
        font-size: 11px;
        line-height: 16px;
        color: var(--bg-0);
        font-weight: 700;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      ">{targetBranch}</span>
      {#if isRebase && info.progress}
        <span style="color: var(--color-text-muted);">({info.progress})</span>
      {/if}
    {:else}
      <span>{label}</span>
    {/if}
  </div>
  {#if isRebase}
    <div style="display: flex; gap: 4px; flex-shrink: 0;">
      <button
        onclick={handleContinue}
        disabled={loading}
        style="
          background: var(--color-success-bg);
          color: var(--color-success);
          font-size: 11px;
          border: 1px solid var(--color-success-border);
          border-radius: 4px;
          cursor: pointer;
          padding: 2px 8px;
          white-space: nowrap;
        "
      >Continue</button>
      <button
        onclick={handleSkip}
        disabled={loading}
        style="
          background: var(--color-warning-bg);
          color: var(--color-warning);
          font-size: 11px;
          border: 1px solid var(--color-warning-border);
          border-radius: 4px;
          cursor: pointer;
          padding: 2px 8px;
          white-space: nowrap;
        "
      >Skip</button>
      <button
        onclick={handleAbort}
        disabled={loading}
        style="
          background: var(--color-danger-bg);
          color: var(--color-danger);
          font-size: 11px;
          border: 1px solid var(--color-danger-border);
          border-radius: 4px;
          cursor: pointer;
          padding: 2px 8px;
          white-space: nowrap;
        "
      >Abort</button>
    </div>
  {/if}
  {#if isCherryPick}
    <div style="display: flex; gap: 4px; flex-shrink: 0;">
      <button
        onclick={handleCherryPickContinue}
        disabled={loading}
        style="
          background: var(--color-success-bg);
          color: var(--color-success);
          font-size: 11px;
          border: 1px solid var(--color-success-border);
          border-radius: 4px;
          cursor: pointer;
          padding: 2px 8px;
          white-space: nowrap;
        "
      >Continue</button>
      <button
        onclick={handleCherryPickAbort}
        disabled={loading}
        style="
          background: var(--color-danger-bg);
          color: var(--color-danger);
          font-size: 11px;
          border: 1px solid var(--color-danger-border);
          border-radius: 4px;
          cursor: pointer;
          padding: 2px 8px;
          white-space: nowrap;
        "
      >Abort</button>
    </div>
  {/if}
  {#if isRevert}
    <div style="display: flex; gap: 4px; flex-shrink: 0;">
      <button
        onclick={handleRevertContinue}
        disabled={loading}
        style="
          background: var(--color-success-bg);
          color: var(--color-success);
          font-size: 11px;
          border: 1px solid var(--color-success-border);
          border-radius: 4px;
          cursor: pointer;
          padding: 2px 8px;
          white-space: nowrap;
        "
      >Continue</button>
      <button
        onclick={handleRevertAbort}
        disabled={loading}
        style="
          background: var(--color-danger-bg);
          color: var(--color-danger);
          font-size: 11px;
          border: 1px solid var(--color-danger-border);
          border-radius: 4px;
          cursor: pointer;
          padding: 2px 8px;
          white-space: nowrap;
        "
      >Abort</button>
    </div>
  {/if}
</div>

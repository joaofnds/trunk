<script lang="ts">
import GitBranch from "@lucide/svelte/icons/git-branch";
import GitMerge from "@lucide/svelte/icons/git-merge";
import { reportErrorToast } from "../lib/error-report.js";
import { safeInvoke } from "../lib/invoke.js";
import { showToast } from "../lib/toast.svelte.js";
import type { OperationInfo } from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import Chip from "../lib/ui/Chip.svelte";
import BranchChip from "./BranchChip.svelte";

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
		reportErrorToast(e, "Continue failed");
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
		reportErrorToast(e, "Skip failed");
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
		reportErrorToast(e, "Abort failed");
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
		reportErrorToast(e, "Continue failed");
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
		reportErrorToast(e, "Continue failed");
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
		reportErrorToast(e, "Abort failed");
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
		reportErrorToast(e, "Abort failed");
	} finally {
		loading = false;
		onaction?.();
	}
}
</script>

{#snippet branch(name: string | null)}
	{#if name === null}
		<Chip variant="label">???</Chip>
	{:else}
		<BranchChip {name} />
	{/if}
{/snippet}

<div
	class="shrink-0 min-h-banded-lg py-1 px-3 flex items-center gap-2"
	style:box-shadow="inset 0 -1px 0 var(--color-border), inset 3px 0 0 {isMerge ? 'var(--color-banner-warning-border)' : 'var(--color-banner-info-border)'}"
	style:background={isMerge ? 'var(--color-banner-warning-bg)' : 'var(--color-banner-info-bg)'}
>
	<span
		class="inline-flex items-center shrink-0"
		style:color={isMerge ? 'var(--color-banner-warning-border)' : 'var(--color-banner-info-border)'}
	>
		{#if isMerge}
			<GitMerge size={14} />
		{:else}
			<GitBranch size={14} />
		{/if}
	</span>
	<div
		class="text-callout text-text flex-1 overflow-hidden flex items-center gap-1 whitespace-nowrap"
	>
		{#if isMerge || isRebase}
			<span class="shrink-0">{isMerge ? 'Merging' : 'Rebasing'}</span>
			{@render branch(info.source_branch)}
			<span class="shrink-0">{isMerge ? 'into' : 'onto'}</span>
			{@render branch(info.target_branch)}
			{#if isRebase && info.progress}
				<span class="text-text-muted">({info.progress})</span>
			{/if}
		{:else}
			<span>{label}</span>
		{/if}
	</div>
	{#if isRebase}
		<div class="flex gap-1 shrink-0">
			<Button
				size="sm"
				variant="success"
				onclick={handleContinue}
				disabled={loading}
				>Continue</Button
			>
			<Button
				size="sm"
				variant="warning"
				onclick={handleSkip}
				disabled={loading}
				>Skip</Button
			>
			<Button
				size="sm"
				variant="danger"
				onclick={handleAbort}
				disabled={loading}
				>Abort</Button
			>
		</div>
	{/if}
	{#if isCherryPick}
		<div class="flex gap-1 shrink-0">
			<Button
				size="sm"
				variant="success"
				onclick={handleCherryPickContinue}
				disabled={loading}
				>Continue</Button
			>
			<Button
				size="sm"
				variant="danger"
				onclick={handleCherryPickAbort}
				disabled={loading}
				>Abort</Button
			>
		</div>
	{/if}
	{#if isRevert}
		<div class="flex gap-1 shrink-0">
			<Button
				size="sm"
				variant="success"
				onclick={handleRevertContinue}
				disabled={loading}
				>Continue</Button
			>
			<Button
				size="sm"
				variant="danger"
				onclick={handleRevertAbort}
				disabled={loading}
				>Abort</Button
			>
		</div>
	{/if}
</div>

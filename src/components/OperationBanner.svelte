<script lang="ts">
import GitBranch from "@lucide/svelte/icons/git-branch";
import GitMerge from "@lucide/svelte/icons/git-merge";
import { ask } from "../lib/dialog.js";
import { reportErrorToast } from "../lib/error-report.js";
import { safeInvoke } from "../lib/invoke.js";
import { showToast } from "../lib/toast.svelte.js";
import type { Conclusion, OperationInfo } from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import BranchChip from "./BranchChip.svelte";

interface Props {
	info: OperationInfo;
	repoPath: string;
	/** Whether every conflicted file is resolved, which Continue waits for. */
	resolved: boolean;
	onaction?: () => void;
	// Threaded RepoView -> StagingPanel -> OperationBanner so the Revert
	// Continue button can reach the single host-owned MessageEditor (OQ-2).
	onopenmessageeditor?: (
		defaultValue: string,
		title: string,
	) => Promise<string | null>;
}

let { info, repoPath, resolved, onaction, onopenmessageeditor }: Props =
	$props();
let loading = $state(false);

let isMerge = $derived(info.op_type === "Merge");
let isRevert = $derived(info.op_type === "Revert");
let isCherryPick = $derived(info.op_type === "CherryPick");

let label = $derived.by(() => {
	if (info.op_type === "CherryPick") return "Cherry-picking";
	if (info.op_type === "Revert") return "Reverting";
	return "";
});

interface Continuation {
	command: "cherry_pick_continue" | "revert_continue";
	/** The operation as a sentence names it. */
	noun: string;
	completed: string;
	editorTitle: string;
}

// Continue asks the backend first, which ends an operation whose resolution left
// nothing to commit. Only a resolution that changes something opens the host-owned
// MessageEditor (default verbatim from MERGE_MSG), and cancelling it (null) makes no
// commit and leaves the operation recoverable (D-02).
async function continueOperation(continuation: Continuation) {
	const { command, noun, completed, editorTitle } = continuation;
	loading = true;
	try {
		let conclusion = await safeInvoke<Conclusion>(command, {
			path: repoPath,
			message: null,
		});
		if (conclusion === "needs_message") {
			const def = await safeInvoke<string | null>("get_merge_message", {
				path: repoPath,
			});
			const msg = await onopenmessageeditor?.(def ?? "", editorTitle);
			if (msg == null) return;
			conclusion = await safeInvoke<Conclusion>(command, {
				path: repoPath,
				message: msg,
			});
		}
		showToast(
			conclusion === "skipped"
				? `Nothing was left to commit, so the ${noun} ended without a commit.`
				: completed,
			"success",
		);
	} catch (e) {
		reportErrorToast(e, "Continue failed");
	} finally {
		loading = false;
		onaction?.();
	}
}

function handleRevertContinue() {
	return continueOperation({
		command: "revert_continue",
		noun: "revert",
		completed: "Revert completed",
		editorTitle: "Revert commit message",
	});
}

function handleCherryPickContinue() {
	return continueOperation({
		command: "cherry_pick_continue",
		noun: "cherry-pick",
		completed: "Cherry-pick completed",
		editorTitle: "Cherry-pick commit message",
	});
}

async function handleCherryPickAbort() {
	const confirmed = await ask(
		"Abort cherry-pick? This will discard the in-progress cherry-pick and return to the previous state.",
		{
			title: "Abort Cherry-pick",
			kind: "warning",
			okLabel: "Abort Cherry-pick",
		},
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
	const confirmed = await ask(
		"Abort revert? This will discard the in-progress revert and return to the previous state.",
		{ title: "Abort Revert", kind: "warning", okLabel: "Abort Revert" },
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

<div
	class="shrink-0 min-h-banded-lg py-1 px-3 flex items-center gap-2"
	style:box-shadow="inset 0 -1px 0 var(--color-border), inset 3px 0 0 {isMerge
		? "var(--color-banner-warning-border)"
		: "var(--color-banner-info-border)"}"
	style:background={isMerge
		? "var(--color-banner-warning-bg)"
		: "var(--color-banner-info-bg)"}
>
	<span
		class="inline-flex items-center shrink-0"
		style:color={isMerge
			? "var(--color-banner-warning-border)"
			: "var(--color-banner-info-border)"}
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
		{#if isMerge}
			<span class="shrink-0">Merging</span>
			{#if info.source_branch !== null}
				<BranchChip name={info.source_branch} />
			{/if}
			{#if info.target_branch !== null}
				<span class="shrink-0">into</span>
				<BranchChip name={info.target_branch} />
			{/if}
		{:else}
			<span>{label}</span>
		{/if}
	</div>
	{#if isCherryPick}
		<div class="flex gap-1 shrink-0">
			<Button
				size="sm"
				variant="success"
				onclick={handleCherryPickContinue}
				disabled={loading || !resolved}
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
				disabled={loading || !resolved}
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

<script lang="ts">
import { untrack } from "svelte";
import { reportErrorToast } from "../lib/error-report.js";
import { safeInvoke } from "../lib/invoke.js";
import { showToast } from "../lib/toast.svelte.js";
import type { HeadCommitMessage } from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import Tab from "../lib/ui/Tab.svelte";
import TabStrip from "../lib/ui/TabStrip.svelte";

interface Props {
	repoPath: string;
	stagedCount: number;
	initialSubject?: string;
	initialBody?: string;
	onsubjectchange?: (value: string) => void;
	onbodychange?: (value: string) => void;
}

let {
	repoPath,
	stagedCount,
	initialSubject,
	initialBody,
	onsubjectchange,
	onbodychange,
}: Props = $props();

let draftSubject = $state(untrack(() => initialSubject) ?? "");
let draftBody = $state(untrack(() => initialBody) ?? "");
let amendSubject = $state("");
let amendBody = $state("");
let mode = $state<"commit" | "amend" | "stash">("commit");
let committing = $state(false);
let subjectError = $state("");
let stagedError = $state("");

function getSubject() {
	return mode === "amend" ? amendSubject : draftSubject;
}

function setSubject(value: string) {
	if (subjectError) subjectError = "";
	if (mode === "amend") {
		amendSubject = value;
	} else {
		draftSubject = value;
		onsubjectchange?.(value);
	}
}

function getBody() {
	return mode === "amend" ? amendBody : draftBody;
}

function setBody(value: string) {
	if (mode === "amend") {
		amendBody = value;
	} else {
		draftBody = value;
		onbodychange?.(value);
	}
}

function clearDraft() {
	draftSubject = "";
	onsubjectchange?.("");
	draftBody = "";
	onbodychange?.("");
}

let counterVisible = $derived(getSubject().length >= 60);
let subjectOverLimit = $derived(getSubject().length > 72);

let buttonLabel = $derived.by(() => {
	if (committing) {
		return mode === "commit"
			? "Committing..."
			: mode === "amend"
				? "Amending..."
				: "Stashing...";
	}
	return mode === "commit" ? "Commit" : mode === "amend" ? "Amend" : "Stash";
});

// Clear stagedError when stagedCount changes or mode changes
$effect(() => {
	// access reactive values to track them
	const _staged = stagedCount;
	const _mode = mode;
	stagedError = "";
});

async function handleModeSwitch(newMode: "commit" | "amend" | "stash") {
	if (newMode === mode) return;
	mode = newMode;
	subjectError = "";

	// Entering amend with an empty amend buffer: seed it from HEAD. A non-empty
	// buffer holds kept amend edits — leave them alone. The draft is never read
	// or written here, so it survives untouched.
	if (newMode === "amend" && amendSubject === "" && amendBody === "") {
		try {
			const msg = await safeInvoke<HeadCommitMessage>(
				"get_head_commit_message",
				{
					path: repoPath,
				},
			);
			// Guard the stale prefill: only apply if we're still in amend with an
			// untouched buffer. Leaving amend or typing during the fetch invalidates it.
			if (mode === "amend" && amendSubject === "" && amendBody === "") {
				amendSubject = msg.subject;
				amendBody = msg.body ?? "";
			}
		} catch (e) {
			console.error("Failed to get HEAD commit message:", e);
		}
	}
}

async function handleSubmit() {
	subjectError = "";
	stagedError = "";

	const subject = mode === "amend" ? amendSubject : draftSubject;
	const body = mode === "amend" ? amendBody : draftBody;

	// Stash mode: subject is optional (stash name). Commit/amend: subject required.
	if (mode !== "stash" && !subject.trim()) {
		subjectError = "Subject is required";
		return;
	}

	// All modes require staged files (except amend which can amend message-only).
	// Stash mode repeats the backend's nothing_to_stash wording, so the guard and
	// stash_save name the same next step wherever the user reaches stashing from.
	if (mode !== "amend" && stagedCount === 0) {
		stagedError =
			mode === "stash"
				? "Nothing to stash — stage changes first."
				: "No files staged";
		return;
	}

	committing = true;
	try {
		if (mode === "amend") {
			await safeInvoke("amend_commit", {
				path: repoPath,
				subject: subject.trim(),
				body: body.trim() || null,
			});
			// Amend never touches the WIP draft: clear only the amend buffer so the
			// next amend re-fetches fresh HEAD, and leave the draft (and its parent
			// callbacks) alone.
			amendSubject = "";
			amendBody = "";
		} else if (mode === "stash") {
			await safeInvoke("stash_save", {
				path: repoPath,
				message: subject.trim(),
			});
			showToast("Stash created", "success");
			clearDraft();
		} else {
			await safeInvoke("create_commit", {
				path: repoPath,
				subject: subject.trim(),
				body: body.trim() || null,
			});
			clearDraft();
		}
		mode = "commit"; // Always reset to commit mode after any successful operation
	} catch (e) {
		const action =
			mode === "commit" ? "Commit" : mode === "amend" ? "Amend" : "Stash";
		console.error(`${action} failed:`, e);
		if (mode === "stash") {
			reportErrorToast(e, "Stash failed");
		}
	} finally {
		committing = false;
	}
}
</script>

<div class="flex flex-col shrink-0">
	<TabStrip aria-label="Commit mode">
		{#each [['commit', 'Commit'], ['amend', 'Amend'], ['stash', 'Stash']] as [tab, label]}
			<Tab
				selected={mode === tab}
				disabled={committing}
				onclick={() => handleModeSwitch(tab as 'commit' | 'amend' | 'stash')}
			>
				{label}
			</Tab>
		{/each}
	</TabStrip>

	<div class="p-2 flex flex-col gap-2">
		<!-- Subject field -->
		<div class="relative">
			<input
				data-testid="commit-form-subject"
				type="text"
				bind:value={getSubject, setSubject}
				placeholder={mode === 'stash' ? 'Stash name (optional)' : 'Summary (required)'}
				class="w-full box-border border border-border bg-bg text-text rounded h-control-lg py-0 pl-3 pr-counter text-callout"
			>
			{#if counterVisible}
				<span
					data-testid="subject-counter"
					data-over={subjectOverLimit}
					class="absolute top-1/2 right-2 -translate-y-1/2 pointer-events-none font-mono text-caption"
					style:color={subjectOverLimit ? 'var(--color-danger)' : 'var(--color-text-subtle)'}
					>{getSubject().length}/72</span
				>
			{/if}
		</div>
		{#if subjectError}
			<span class="error-text text-small">{subjectError}</span>
		{/if}

		<!-- Body field -->
		<textarea
			bind:value={getBody, setBody}
			rows={3}
			placeholder="Description (optional)"
			class="w-full box-border border border-border bg-bg text-text rounded py-2 px-3 text-callout resize-y"
		></textarea>

		<!-- Staged error -->
		{#if stagedError}
			<span class="error-text text-small">{stagedError}</span>
		{/if}

		<div class="grid">
			<Button
				size="lg"
				variant="primary"
				data-testid="commit-form-submit"
				onclick={handleSubmit}
				disabled={committing}
			>
				{buttonLabel}
			</Button>
		</div>
	</div>
</div>

<style>
.error-text {
	color: var(--color-danger);
}

.pr-counter {
	padding-right: var(--counter-gutter);
}
</style>

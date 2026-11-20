<script lang="ts">
import { onDestroy, tick, untrack } from "svelte";
import { reportErrorToast } from "../lib/error-report.js";
import { isTrunkError, safeInvoke, type TrunkError } from "../lib/invoke.js";
import { shortcutModifier } from "../lib/keyboard.js";
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
	/** The Summary field took or lost the focus while it holds the commit draft. */
	ondraftsummaryfocuschange?: (focused: boolean) => void;
}

let {
	repoPath,
	stagedCount,
	initialSubject,
	initialBody,
	onsubjectchange,
	onbodychange,
	ondraftsummaryfocuschange,
}: Props = $props();

let draftSubject = $state(untrack(() => initialSubject) ?? "");
let draftBody = $state(untrack(() => initialBody) ?? "");
let amendSubject = $state("");
let amendBody = $state("");
// The commit the amend buffer is aimed at, and the message it was filled with.
// The amend names that commit, and the backend refuses once HEAD is another, so
// a pull or a commit landing meanwhile is never replaced under this message.
let amendHeadOid = $state<string | null>(null);
let amendSeed = { subject: "", body: "" };
let amendSeeding = 0;
let mode = $state<"commit" | "amend" | "stash">("commit");
let committing = $state(false);
let subjectError = $state("");
let stagedError = $state("");
let subjectInput = $state<HTMLInputElement>();
let subjectFocused = $state(false);
// Commit and Stash both edit the draft, as getSubject says; Amend edits HEAD's message.
const draftSummaryFocused = $derived(subjectFocused && mode !== "amend");
let reportedDraftSummaryFocus = false;

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

function clearCommittedSubject(subject: string) {
	if (draftSubject !== subject) return;

	draftSubject = "";
	onsubjectchange?.("");
}

function clearCommittedBody(body: string) {
	if (draftBody !== body) return;

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
	void stagedCount;
	void mode;
	stagedError = "";
});

async function handleModeSwitch(newMode: "commit" | "amend" | "stash") {
	if (newMode === mode) return;
	mode = newMode;
	subjectError = "";

	// An amend buffer the user has not edited shows HEAD as it is now, since the
	// commit it was filled from may be gone. Edits are kept, and stay aimed at the
	// commit they were written for. The draft is never read or written here.
	if (newMode === "amend" && amendUntouched()) {
		try {
			await seedAmend();
		} catch (e) {
			console.error("Failed to get HEAD commit message:", e);
		}
	}
}

/** Puts the caret at the end of the commit draft's Summary, returning the form
 *  to Commit first, since the draft is what the uncommitted-changes row shows.
 *  A submit in flight keeps its mode, and its success returns the form to Commit. */
export async function focusDraftSummary() {
	if (!committing) await handleModeSwitch("commit");
	await tick();
	if (!subjectInput) return;

	const end = subjectInput.value.length;
	subjectInput.focus();
	subjectInput.setSelectionRange(end, end);
}

function reportDraftSummaryFocus(focused: boolean) {
	if (focused === reportedDraftSummaryFocus) return;
	reportedDraftSummaryFocus = focused;
	ondraftsummaryfocuschange?.(focused);
}

$effect(() => reportDraftSummaryFocus(draftSummaryFocused));

// Removing the focused field need not fire a blur, which would leave the
// WIP row drawing its pencil for a field that is gone.
onDestroy(() => reportDraftSummaryFocus(false));

function amendUntouched() {
	return amendSubject === amendSeed.subject && amendBody === amendSeed.body;
}

// Aim the amend at HEAD, and show HEAD's message unless the user has edited the
// buffer, during this read included. Answers HEAD, or null when a later read or
// leaving Amend made this one moot.
async function seedAmend(): Promise<HeadCommitMessage | null> {
	const seeding = ++amendSeeding;
	const head = await safeInvoke<HeadCommitMessage>("get_head_commit_message", {
		path: repoPath,
	});
	if (seeding !== amendSeeding || mode !== "amend") return null;
	amendHeadOid = head.oid;
	if (amendUntouched()) {
		amendSubject = head.subject;
		amendBody = head.body ?? "";
		amendSeed = { subject: amendSubject, body: amendBody };
	}
	return head;
}

async function handleSubmit() {
	if (committing) return;

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
			const expectedHeadOid = await amendTarget();
			await safeInvoke("amend_commit", {
				path: repoPath,
				subject: subject.trim(),
				body: body.trim() || null,
				expectedHeadOid,
			});
			// Amend never touches the WIP draft: clear only the amend buffer so the
			// next amend re-fetches fresh HEAD, and leave the draft (and its parent
			// callbacks) alone.
			amendSubject = "";
			amendBody = "";
			amendSeed = { subject: "", body: "" };
			amendHeadOid = null;
		} else if (mode === "stash") {
			await safeInvoke("stash_save", {
				path: repoPath,
				message: subject.trim(),
			});
			showToast("Stash created", "success");
			clearCommittedSubject(subject);
			clearCommittedBody(body);
		} else {
			await safeInvoke("create_commit", {
				path: repoPath,
				subject: subject.trim(),
				body: body.trim() || null,
			});
			clearCommittedSubject(subject);
			clearCommittedBody(body);
		}
		mode = "commit"; // Always reset to commit mode after any successful operation
	} catch (e) {
		if (mode === "stash") {
			reportErrorToast(e, "Stash failed");
		} else if (isTrunkError(e) && e.code === "amend_stale") {
			await retargetAmend(e);
		} else {
			const action = mode === "commit" ? "Commit" : "Amend";
			reportErrorToast(e, `${action} failed`);
		}
	} finally {
		committing = false;
	}
}

// A buffer whose HEAD read failed names no commit, and its amend goes to HEAD.
async function amendTarget(): Promise<string> {
	if (amendHeadOid !== null) return amendHeadOid;
	const head = await safeInvoke<HeadCommitMessage>("get_head_commit_message", {
		path: repoPath,
	});
	return head.oid;
}

// HEAD is not the commit the amend was aimed at. The next Amend goes to the commit
// HEAD is now, and the toast names it, so it replaces only a commit the user was
// told about: under its own message when the buffer was not edited, or under the
// edits when it was.
async function retargetAmend(refusal: TrunkError) {
	const edited = !amendUntouched();
	let head: HeadCommitMessage | null = null;
	try {
		head = await seedAmend();
	} catch {}
	const next =
		head === null
			? ""
			: `. HEAD is now "${head.subject}". ${edited ? "Amend again to amend it with this message." : "The form now shows its message."}`;
	reportErrorToast(
		{ ...refusal, message: refusal.message + next },
		"Amend failed",
	);
}

// A held key or the second click of a double click repeats a submit the user
// already made, and after a refused amend it would amend the commit the toast
// has only just named.
function submitOnModEnter(e: KeyboardEvent) {
	if (e.key !== "Enter" || !shortcutModifier(e) || e.isComposing) return;

	e.preventDefault();
	if (e.repeat) return;

	void handleSubmit();
}

function submitOnClick(e: MouseEvent) {
	if (e.detail > 1) return;

	void handleSubmit();
}
</script>

<div class="flex flex-col shrink-0">
	<TabStrip aria-label="Commit mode">
		{#each [
			["commit", "Commit"],
			["amend", "Amend"],
			["stash", "Stash"],
		] as [tab, label]}
			<Tab
				selected={mode === tab}
				disabled={committing}
				onclick={() => handleModeSwitch(tab as "commit" | "amend" | "stash")}
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
				bind:this={subjectInput}
				bind:value={getSubject, setSubject}
				onfocus={() => (subjectFocused = true)}
				onblur={() => (subjectFocused = false)}
				onkeydown={submitOnModEnter}
				placeholder={mode === "stash"
					? "Stash name (optional)"
					: "Summary (required)"}
				class="w-full box-border border border-border bg-bg text-text rounded h-control-lg py-0 pl-3 pr-counter text-callout"
			>
			{#if counterVisible}
				<span
					data-testid="subject-counter"
					data-over={subjectOverLimit}
					class="absolute top-1/2 right-2 -translate-y-1/2 pointer-events-none font-mono text-caption"
					style:color={subjectOverLimit
						? "var(--color-danger)"
						: "var(--color-text-subtle)"}
					>{getSubject().length}/72</span
				>
			{/if}
		</div>
		{#if subjectError}
			<span class="error-text text-small leading-normal">{subjectError}</span>
		{/if}

		<!-- Body field -->
		<textarea
			bind:value={getBody, setBody}
			onkeydown={submitOnModEnter}
			rows={3}
			placeholder="Description (optional)"
			class="w-full box-border border border-border bg-bg text-text rounded py-2 px-3 text-callout leading-normal resize-y"
		></textarea>

		<!-- Staged error -->
		{#if stagedError}
			<span class="error-text text-small leading-normal">{stagedError}</span>
		{/if}

		<div class="grid">
			<Button
				size="lg"
				variant="primary"
				data-testid="commit-form-submit"
				onclick={submitOnClick}
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

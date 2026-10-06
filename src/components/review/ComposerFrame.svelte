<script lang="ts">
import type { Snippet } from "svelte";
import type { Review } from "../../lib/types.js";
import Button from "../../lib/ui/Button.svelte";

interface Props {
	/** The icon and line naming what the comment is on. */
	heading: Snippet;
	/** The active review's id and title, null while the host has not read them. */
	activeReview: Pick<Review, "id" | "title"> | null;
	activeReviewId: string | null;
	placeholder: string;
	text: string;
	busy: boolean;
	submitLabel: string;
	submitDisabled: boolean;
	onsubmit: () => void;
	oncancel: () => void;
	oninput?: () => void;
	/** What Escape does in the text; nothing when absent. */
	onescape?: () => void;
}

let {
	heading,
	activeReview,
	activeReviewId,
	placeholder,
	text = $bindable(),
	busy,
	submitLabel,
	submitDisabled,
	onsubmit,
	oncancel,
	oninput,
	onescape,
}: Props = $props();

const headingId = $props.id();

// Focus the textarea as soon as the composer mounts (it mounts fresh on each open)
// so the user can type immediately without clicking into it.
let textareaEl = $state<HTMLTextAreaElement | null>(null);
$effect(() => {
	textareaEl?.focus();
});

function onkeydown(event: KeyboardEvent) {
	if (event.key === "Escape" && onescape) {
		event.preventDefault();
		onescape();
		return;
	}
	if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
	event.preventDefault();
	onsubmit();
}
</script>

<!--
	A comment being written: what it is on, the review it lands in, the text, and
	the way to submit or abandon it. The host owns what submitting writes.
-->
<fieldset class="comment-composer" aria-labelledby={headingId}>
	<header class="composer-header">
		<span class="composer-preview" id={headingId}>{@render heading()}</span>
		<span class="flex-1"></span>
		<p class="composer-landing">
			Lands in
			{#if activeReview}
				<span class="font-mono text-text">{activeReview.id}</span>
				<span class="text-text truncate">{activeReview.title}</span>
			{:else if activeReviewId}
				<span class="font-mono text-text">{activeReviewId}</span>
			{:else}
				<span class="text-text">a new review</span>
			{/if}
		</p>
	</header>
	<textarea
		bind:this={textareaEl}
		class="composer-textarea"
		{placeholder}
		disabled={busy}
		bind:value={text}
		{oninput}
		{onkeydown}
	></textarea>
	<footer class="composer-actions">
		<span class="composer-hint"><kbd>⌘</kbd><kbd>↵</kbd> submit</span>
		<span class="flex-1"></span>
		<Button size="sm" variant="ghost" disabled={busy} onclick={oncancel}
			>Cancel</Button
		>
		<Button
			variant="primary"
			size="sm"
			data-testid="comment-submit"
			disabled={submitDisabled}
			onclick={onsubmit}
		>
			{submitLabel}
		</Button>
	</footer>
</fieldset>

<style>
.comment-composer {
	display: flex;
	min-width: 0;
	margin: 0;
	padding: 0;
	flex-direction: column;
	width: 100%;
	box-sizing: border-box;
	background: var(--color-comment-card-bg);
	border: 1px solid var(--color-accent-border);
	border-radius: var(--radius);
	overflow: hidden;
}

.comment-composer:focus-within {
	border-color: var(--color-accent);
}

.composer-header {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-1) var(--space-2);
	border-bottom: 1px solid var(--color-border);
}

.composer-preview {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--color-text-strong);
	font-size: var(--text-small);
	font-weight: var(--weight-medium);
}

.composer-landing {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	margin: 0;
	min-width: 0;
	color: var(--color-text-muted);
	font-size: var(--text-small);
	white-space: nowrap;
}

.composer-textarea {
	min-height: calc(15 * var(--u));
	resize: vertical;
	padding: var(--space-2);
	font-size: var(--text-callout);
	font-family: var(--font-sans);
	color: var(--color-text);
	background: var(--color-comment-card-bg);
	border: none;
	box-sizing: border-box;
}

.composer-textarea:focus {
	outline: none;
}

.composer-actions {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-1) var(--space-2);
	border-top: 1px solid var(--color-border);
}

.composer-hint {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	color: var(--color-text-subtle);
	font-size: var(--text-caption);
}

.composer-hint kbd {
	padding: 0 var(--space-1);
	border: 1px solid var(--color-border);
	border-radius: var(--radius);
	font-family: var(--font-sans);
}
</style>

<script lang="ts">
import type { Snippet } from "svelte";
import { reviewTitle } from "../../lib/review-title.js";
import type { Review } from "../../lib/types.js";
import Keycap from "../../lib/ui/Keycap.svelte";
import Tag from "../../lib/ui/Tag.svelte";
import CommentEditor from "./CommentEditor.svelte";

interface Props {
	/** The icon and line naming what the comment is on. */
	heading: Snippet;
	/** The active review's id and title, null while the host has not read them. */
	activeReview: Pick<Review, "id" | "title"> | null;
	activeReviewId: string | null;
	/** What the landing line calls the review a comment starts when none is active. */
	newReviewName?: string;
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
	/** Fill a box of fixed height, as a diff row is, with the text taking the
	 *  slack; the text cannot be dragged taller than the box. */
	fill?: boolean;
	/** Whether a shift-click on a line number stretches the range, which the
	 *  hint then says. */
	extendHint?: boolean;
}

let {
	heading,
	activeReview,
	activeReviewId,
	newReviewName = "a new review",
	placeholder,
	text = $bindable(),
	busy,
	submitLabel,
	submitDisabled,
	onsubmit,
	oncancel,
	oninput,
	onescape,
	fill = false,
	extendHint = false,
}: Props = $props();

const headingId = $props.id();
</script>

<!--
	A comment being written: what it is on, the review it lands in, the text, and
	the way to submit or abandon it. The host owns what submitting writes.
-->
<fieldset class="comment-composer" aria-labelledby={headingId}>
	<header class="composer-header">
		<span class="composer-preview" id={headingId}>{@render heading()}</span>
		<p class="composer-landing">
			Lands in
			{#if activeReview}
				<Tag variant="label">{activeReview.id}</Tag>
				<span class="composer-landing-name">{reviewTitle(activeReview)}</span>
			{:else if activeReviewId}
				<Tag variant="label">{activeReviewId}</Tag>
			{:else}
				<span class="composer-landing-name">{newReviewName}</span>
			{/if}
		</p>
	</header>
	<CommentEditor
		bind:text
		label="Comment"
		{placeholder}
		{busy}
		{submitLabel}
		{submitDisabled}
		{onsubmit}
		{oncancel}
		{oninput}
		{onescape}
		variant={fill ? "fill" : "flush"}
	>
		{#snippet hint()}
			{#if extendHint}
				<Keycap>⇧</Keycap>
				click a line number to extend ·{" "}
			{/if}
		{/snippet}
	</CommentEditor>
</fieldset>

<style>
/* A composer reads as the one live card in the diff: an accent edge and a soft
   accent ring set it apart from the threads around it. */
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
	box-shadow: 0 0 0 2px var(--color-accent-bg);
	overflow: hidden;
}

/* In a narrow pane the landing line and the buttons wrap under what comes
   before them rather than being cut off. */
.composer-header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-1) var(--space-2);
	min-height: var(--control-h);
	padding: var(--space-1) var(--space-3);
	background: var(--color-comment-card-header-bg);
	box-shadow: var(--shadow-hairline);
}

.composer-preview {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	color: var(--color-text-strong);
	font-size: var(--text-callout);
	font-weight: var(--weight-medium);
	white-space: nowrap;
}

.composer-landing {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	margin: 0 0 0 auto;
	min-width: 0;
	white-space: nowrap;
	color: var(--color-text-subtle);
	font-size: var(--text-small);
}

.composer-landing-name {
	overflow: hidden;
	text-overflow: ellipsis;
	color: var(--color-text);
	font-weight: var(--weight-medium);
}
</style>

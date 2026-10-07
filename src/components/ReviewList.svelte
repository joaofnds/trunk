<script lang="ts">
// The repo's reviews, one row each, in the left pane while review mode holds the
// window. Pressing a row shows that review; the radio beside it makes it the
// active one, where new comments land.

import Pencil from "@lucide/svelte/icons/pencil";
import Plus from "@lucide/svelte/icons/plus";
import Trash2 from "@lucide/svelte/icons/trash-2";
import { errorMessage } from "../lib/error-report.js";
import { safeInvoke } from "../lib/invoke.js";
import {
	activateReview,
	renameReview,
	startNewReview,
} from "../lib/review-actions.js";
import type { ReviewCommentsManager } from "../lib/review-comments.svelte.js";
import { showToast } from "../lib/toast.svelte.js";
import type { Review } from "../lib/types.js";
import Button from "../lib/ui/Button.svelte";
import Radio from "../lib/ui/Radio.svelte";
import Row from "../lib/ui/Row.svelte";
import RowAction from "../lib/ui/RowAction.svelte";
import StatePill from "./review/StatePill.svelte";

interface Props {
	repoPath: string;
	reviewComments: ReviewCommentsManager;
}

let { repoPath, reviewComments }: Props = $props();

const reviews = $derived(reviewComments.reviews);
const activeReviewId = $derived(reviewComments.activeReviewId);
const shownReviewId = $derived(reviewComments.shownReviewId);

function activate(id: string) {
	if (id === activeReviewId) return;
	void activateReview(repoPath, id);
}

let renamingId = $state<string | null>(null);
let renameText = $state("");

function openRename(review: Review) {
	renamingId = review.id;
	renameText = review.title;
}

function renameKeys(event: KeyboardEvent) {
	if (event.key === "Enter") commitRename();
	if (event.key === "Escape") renamingId = null;
}

function commitRename() {
	const id = renamingId;
	renamingId = null;
	if (id) void renameReview(repoPath, id, renameText);
}

let deleteConfirmingId = $state<string | null>(null);

async function deleteReview(id: string) {
	deleteConfirmingId = null;
	try {
		await safeInvoke("delete_review", { path: repoPath, reviewId: id });
	} catch (e) {
		showToast(errorMessage(e, "Failed to delete review"), "error");
	}
}

function deletePrompt(review: Review): string {
	const threads =
		review.thread_count === 0
			? ""
			: ` and its ${review.thread_count} ${review.thread_count === 1 ? "thread" : "threads"}`;
	const agent = review.published ? " The agent loses access to it." : "";
	return `${threads}?${agent} This can’t be undone.`;
}
</script>

<nav
	aria-label="Reviews"
	class="flex flex-col flex-1 min-h-0 bg-surface text-callout"
>
	<div class="flex items-center gap-2 h-bar shrink-0 pl-3 pr-1">
		<h2 class="flex-1 m-0 text-caption font-semibold uppercase text-text-muted">
			Reviews <span class="font-regular">{reviews.length}</span>
		</h2>
		<Button
			size="sm"
			variant="ghost"
			onclick={() => startNewReview(repoPath, reviewComments)}
			aria-label="New review"
			title="New review (becomes active)"
		>
			<Plus size={12} />
			<span>New</span>
		</Button>
	</div>
	<ul
		class="flex flex-col flex-1 min-h-0 overflow-auto list-none m-0 py-1 px-0"
	>
		{#each reviews as review (review.id)}
			{@const isActive = review.id === activeReviewId}
			{@const isShown = review.id === shownReviewId}
			<li class="review-item" class:review-item-shown={isShown}>
				<span class="review-item-radio">
					<Radio
						checked={isActive}
						aria-label="Active review {review.id}"
						title={isActive ? "Active: new comments land here" : "Make active"}
						onclick={() => activate(review.id)}
					/>
				</span>
				{#if renamingId === review.id}
					<div class="py-1 pr-2">
						<input
							bind:value={renameText}
							onblur={commitRename}
							onkeydown={renameKeys}
							aria-label="Review title"
							class="w-full bg-bg text-text border border-accent rounded h-control-sm py-0 px-1 text-callout"
						>
					</div>
				{:else}
					<Row
						variant="entry"
						reveal="fade"
						onclick={() => reviewComments.select(review.id)}
						ondblclick={() => openRename(review)}
						onkeydown={(e) => {
							if (e.key === "F2") {
								e.preventDefault();
								openRename(review);
							}
						}}
						title="Click to show · double-click or F2 to rename"
						aria-label="Show review {review.id}"
						aria-current={isShown ? "true" : undefined}
					>
						<span class="flex flex-col gap-1 min-w-0 w-full">
							<span
								class="min-w-0 font-medium text-text-strong leading-tight line-clamp-2 whitespace-normal text-balance"
								>{review.title}</span
							>
							<span
								class="flex items-center gap-2 min-w-0 font-mono text-caption text-text-subtle"
							>
								<span>{review.id}</span>
								<StatePill state={review.state} />
								<span class="flex-1"></span>
								<span
									title="{review.unresolved_count} unresolved of {review.thread_count}"
									>{review.unresolved_count > 0
										? `${review.unresolved_count}/${review.thread_count}`
										: review.thread_count}</span
								>
							</span>
						</span>
						{#snippet actions()}
							<RowAction
								onclick={() => openRename(review)}
								aria-label="Rename review {review.id}"
								title="Rename"
							>
								<Pencil size={12} />
							</RowAction>
							<RowAction
								tone="danger"
								onclick={() => {
									deleteConfirmingId = review.id;
								}}
								aria-label="Delete review {review.id}"
								title="Delete review"
							>
								<Trash2 size={12} />
							</RowAction>
						{/snippet}
					</Row>
				{/if}
				{#if deleteConfirmingId === review.id}
					<fieldset
						aria-label="Delete {review.title}?"
						class="review-confirm flex flex-col gap-2 m-0 p-2 rounded text-small leading-normal text-text"
					>
						<p class="m-0">
							Delete
							<b class="font-semibold text-text-strong">{review.title}</b
							><span>{deletePrompt(review)}</span>
						</p>
						<div class="flex justify-end gap-2">
							<Button
								size="sm"
								variant="ghost"
								onclick={() => {
									deleteConfirmingId = null;
								}}
								>Cancel</Button
							>
							<Button
								size="sm"
								variant="danger"
								onclick={() => deleteReview(review.id)}
								>Delete review</Button
							>
						</div>
					</fieldset>
				{/if}
			</li>
		{/each}
	</ul>
	<p
		class="flex items-center gap-2 shrink-0 m-0 py-2 px-3 shadow-hairline text-small text-text-subtle"
	>
		<Radio variant="mark" checked />
		Active review. New comments land here.
	</p>
</nav>

<style>
/* A review in the list: the radio that makes it active, beside the row that
   shows it, and under both the delete confirmation when it is asked for. */
.review-item {
	display: grid;
	grid-template-columns: auto minmax(0, 1fr);
	align-items: start;
}
.review-item-radio {
	display: flex;
	padding: var(--space-2) 0 0 var(--space-3);
}
.review-item-shown {
	background: var(--color-selected-row);
	box-shadow: inset 2px 0 0 var(--color-accent);
}
.review-confirm {
	grid-column: 1 / -1;
	margin: 0 var(--space-2) var(--space-2) var(--space-3);
	background: var(--color-danger-bg);
	border: 1px solid var(--color-danger-border);
}
</style>

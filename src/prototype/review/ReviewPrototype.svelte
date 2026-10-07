<script lang="ts">
// The review prototype: the review list beside the panel, or a file's diff with
// a thread inline, over mock data, so a design idea is an edit and a reload
// rather than a rebuild of the app.

import ReviewTitle from "../../components/review/ReviewTitle.svelte";
import StatePill from "../../components/review/StatePill.svelte";
import Radio from "../../lib/ui/Radio.svelte";
import Row from "../../lib/ui/Row.svelte";
import Tab from "../../lib/ui/Tab.svelte";
import TabStrip from "../../lib/ui/TabStrip.svelte";
import { inlineFile, reviews as mockReviews } from "./mock.js";
import ProtoInline from "./ProtoInline.svelte";
import ProtoPanel from "./ProtoPanel.svelte";

let reviews = $state(mockReviews);
let shownId = $state(mockReviews[0].id);
let activeId = $state(mockReviews[0].id);
let view = $state<"panel" | "inline">("panel");

const shownAt = $derived(reviews.findIndex((r) => r.id === shownId));

let inlineThread = $state(
	mockReviews[0].sections[0]?.groups[0]?.threads[0] ?? null,
);
</script>

<div class="flex h-screen flex-col bg-bg text-text">
	<TabStrip aria-label="Prototype view">
		<Tab selected={view === "panel"} onclick={() => (view = "panel")}
			>Review panel</Tab
		>
		<Tab selected={view === "inline"} onclick={() => (view = "inline")}
			>Inline in the diff</Tab
		>
	</TabStrip>

	{#if view === "panel"}
		<div class="proto-split min-h-0 flex-1">
			<nav
				aria-label="Reviews"
				class="proto-rail flex min-h-0 flex-col bg-surface text-callout"
			>
				<div
					class="flex h-bar shrink-0 items-center gap-2 pl-3 shadow-hairline"
				>
					<h2
						class="m-0 flex flex-1 items-center gap-2 text-caption font-semibold text-text-muted uppercase"
					>
						Reviews
						<span
							class="inline-flex h-control-xs items-center rounded bg-surface-chip px-1 font-mono font-regular text-text-muted"
							>{reviews.length}</span
						>
					</h2>
				</div>
				<ul class="m-0 list-none p-0">
					{#each reviews as review (review.id)}
						<li
							class="proto-rail-item"
							class:proto-rail-item-shown={review.id === shownId}
						>
							<span class="proto-rail-radio">
								<Radio
									checked={review.id === activeId}
									aria-label="Active review {review.id}"
									onclick={() => (activeId = review.id)}
								/>
							</span>
							<Row
								variant="entry"
								onclick={() => (shownId = review.id)}
								aria-label="Show review {review.id}"
							>
								<span
									class="line-clamp-2 min-w-0 font-medium whitespace-normal text-text-strong"
									><ReviewTitle title={review.title} /></span
								>
								{#snippet detail()}
									<span
										class="flex min-w-0 flex-1 items-center gap-2 font-mono text-caption text-text-subtle"
									>
										<span>{review.id}</span>
										<StatePill review={review.state} />
									</span>
								{/snippet}
							</Row>
						</li>
					{/each}
				</ul>
			</nav>
			<ProtoPanel
				bind:review={reviews[shownAt]}
				active={shownId === activeId}
			/>
		</div>
	{:else}
		<ProtoInline
			path={inlineFile.path}
			lines={inlineFile.lines}
			threadAfterLine={inlineFile.threadAfterLine}
			bind:thread={inlineThread}
		/>
	{/if}
</div>

<style>
.proto-split {
	display: grid;
	grid-template-columns: calc(88 * var(--u)) minmax(0, 1fr);
}
.proto-rail {
	box-shadow: inset -1px 0 0 var(--color-border);
}
.proto-rail-item {
	display: grid;
	grid-template-columns: auto minmax(0, 1fr);
	align-items: start;
}
.proto-rail-radio {
	display: flex;
	padding: var(--space-2) 0 0 var(--space-3);
}
.proto-rail-item-shown {
	background: var(--color-selected-row);
	box-shadow: inset 2px 0 0 var(--color-accent);
}
</style>

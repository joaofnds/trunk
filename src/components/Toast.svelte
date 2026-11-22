<script lang="ts">
import { fly } from "svelte/transition";
import { motionDuration } from "../lib/motion-duration.js";
import { dismissToast, type ToastKind, toasts } from "../lib/toast.svelte.js";
import Button from "../lib/ui/Button.svelte";
import ToastCard, { type ToastTone } from "../lib/ui/ToastCard.svelte";

const TONE: Record<ToastKind, ToastTone> = {
	success: "neutral",
	error: "danger",
};

let viewport = $state<HTMLDivElement>();
let list = $state<HTMLDivElement>();
let overflow = $state(false);
let earlier = $state(0);

function measure() {
	if (!viewport || !list) return;
	const top = viewport.getBoundingClientRect().top;
	overflow = viewport.scrollHeight > viewport.clientHeight;
	earlier = Array.from(list.children).filter(
		(card) => card.getBoundingClientRect().top < top - 1,
	).length;
}

$effect(() => {
	if (!viewport || !list) return;
	const observer = new ResizeObserver(measure);
	observer.observe(list);
	observer.observe(viewport);
	return () => observer.disconnect();
});

function revealEnd() {
	const card = earlier ? list?.firstElementChild : list?.lastElementChild;
	const button = card?.querySelector("button");
	button?.focus({ preventScroll: true });
	card?.scrollIntoView({ block: earlier ? "start" : "end" });
}
</script>

<div
	class="fixed bottom-4 left-4 right-4 w-fit max-w-toast toast-stack flex flex-col gap-1 z-50 pointer-events-none"
>
	{#if overflow && toasts.items.length > 1}
		<div class="pointer-events-auto">
			<Button size="sm" onclick={revealEnd}>
				{earlier
					? `${earlier} earlier notification${earlier === 1 ? "" : "s"}`
					: "Latest notifications"}
			</Button>
		</div>
	{/if}
	<div
		class="flex min-h-0 flex-col-reverse overflow-y-auto pointer-events-auto"
		data-scroll-thumb="none"
		bind:this={viewport}
		onscroll={measure}
	>
		<div class="flex shrink-0 flex-col gap-2" bind:this={list}>
			{#each toasts.items as toast (toast.id)}
				<div
					role="status"
					class="pointer-events-auto"
					transition:fly={{ y: 8, duration: motionDuration(150) }}
				>
					<ToastCard
						tone={TONE[toast.kind]}
						onclick={() => dismissToast(toast.id)}
					>
						{toast.message}
					</ToastCard>
				</div>
			{/each}
		</div>
	</div>
</div>

<style>
.toast-stack {
	max-height: calc(100% - 2 * var(--space-4));
}
</style>

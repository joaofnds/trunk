<script lang="ts">
import { fly } from "svelte/transition";
import { dismissToast, type ToastKind, toasts } from "../lib/toast.svelte.js";
import ToastCard, { type ToastTone } from "../lib/ui/ToastCard.svelte";

const TONE: Record<ToastKind, ToastTone> = {
	success: "neutral",
	error: "danger",
};
</script>

<div
	class="fixed bottom-4 right-4 flex flex-col gap-2 z-50 pointer-events-none"
>
	{#each toasts.items as toast (toast.id)}
		<div
			role="status"
			class="pointer-events-auto"
			transition:fly={{ y: 8, duration: 150 }}
		>
			<ToastCard tone={TONE[toast.kind]} onclick={() => dismissToast(toast.id)}>
				{toast.message}
			</ToastCard>
		</div>
	{/each}
</div>

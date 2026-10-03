<script lang="ts">
import { fly } from "svelte/transition";
import { dismissToast, toasts } from "../lib/toast.svelte.js";
import ToastCard from "../lib/ui/ToastCard.svelte";
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
			<ToastCard
				tone={toast.kind === 'error' ? 'danger' : 'neutral'}
				onclick={() => dismissToast(toast.id)}
			>
				{toast.message}
			</ToastCard>
		</div>
	{/each}
</div>

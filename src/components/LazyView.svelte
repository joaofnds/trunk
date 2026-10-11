<script lang="ts" generics="View extends Component<never>">
import { type Component, type Snippet, tick, untrack } from "svelte";
import Button from "../lib/ui/Button.svelte";

let {
	load,
	label,
	children,
	onready,
	oncancel,
	active = true,
}: {
	load: () => Promise<{ default: View }>;
	label: string;
	children: Snippet<[View]>;
	onready?: () => void;
	oncancel?: () => void;
	active?: boolean;
} = $props();
let pending = $state.raw(untrack(() => load()));

$effect(() => {
	const request = pending;
	if (!active) return;

	let current = true;
	const ready = async () => {
		await tick();
		if (current) onready?.();
	};
	void request.then(ready, ready);
	return () => {
		current = false;
	};
});
</script>

{#await pending}
	<div
		role="status"
		class="h-full flex flex-col items-center justify-center gap-2 text-text-subtle text-body"
	>
		Opening {label}…
		{#if oncancel}
			<Button onclick={oncancel}>Cancel</Button>
		{/if}
	</div>
{:then view}
	{@render children(view.default)}
{:catch}
	<div
		role="alert"
		class="h-full flex flex-col items-center justify-center gap-2 text-text-muted text-body"
	>
		Could not load {label}.
		<div class="flex gap-2">
			<Button onclick={() => { pending = load(); }}>Retry</Button>
			{#if oncancel}
				<Button onclick={oncancel}>Cancel</Button>
			{/if}
		</div>
	</div>
{/await}

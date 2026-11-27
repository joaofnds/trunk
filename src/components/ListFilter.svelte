<script lang="ts">
import FilterIcon from "@lucide/svelte/icons/list-filter";
import X from "@lucide/svelte/icons/x";
import { tick } from "svelte";
import Button from "../lib/ui/Button.svelte";

let {
	label,
	query = $bindable(""),
	open = $bindable(false),
}: {
	label: string;
	query?: string;
	open?: boolean;
} = $props();

let input = $state<HTMLInputElement>();
let host: HTMLElement;
let opener: HTMLElement | null = null;

export async function focus() {
	if (!open) {
		opener =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		open = true;
		await tick();
	}
	input?.focus();
	input?.select();
}

async function close() {
	query = "";
	open = false;
	await tick();
	const target =
		opener?.isConnected && opener !== document.body
			? opener
			: host?.querySelector("button");
	target?.focus({ preventScroll: true });
	opener = null;
}

function keydown(event: KeyboardEvent) {
	if (event.key === "Escape" && !event.isComposing) {
		event.preventDefault();
		event.stopPropagation();
		void close();
	}
}
</script>

<div
	bind:this={host}
	class={open
		? "flex min-w-0 flex-1 items-center gap-1"
		: "inline-flex shrink-0"}
>
	{#if open}
		<input
			type="text"
			class="h-control-sm flex-1 min-w-0 rounded border border-border bg-surface px-2 text-callout text-text"
			bind:this={input}
			bind:value={query}
			aria-label={label}
			placeholder={`${label}…`}
			onkeydown={keydown}
		>
		<Button
			icon
			variant="ghost"
			size="sm"
			aria-label={`Close ${label.toLowerCase()}`}
			tooltip="Clear and close filter (Esc)"
			onclick={close}
			onkeydown={keydown}
		>
			<X size={14} />
		</Button>
	{:else}
		<Button
			icon
			variant="ghost"
			size="sm"
			aria-label={label}
			tooltip={`${label} (/)`}
			onclick={focus}
		>
			<FilterIcon size={14} />
		</Button>
	{/if}
</div>

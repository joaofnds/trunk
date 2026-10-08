<script lang="ts" module>
export type FoldInset = "thread" | "group" | "file";
</script>

<script lang="ts">
// The bar over something that folds: the whole bar is the target that folds it,
// and the chevron is the keyboard path to the same toggle. What the bar holds
// lets the press through to the target unless it is a control itself, which
// takes `pointer-events-auto`.

import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import type { Snippet } from "svelte";
import Button from "../../lib/ui/Button.svelte";
import HitArea from "../../lib/ui/HitArea.svelte";

interface Props {
	collapsed: boolean;
	/** What the bar folds, named in the toggle's label. */
	noun: string;
	/** How far the content sits in from the bar's edges. */
	inset: FoldInset;
	ontoggle: () => void;
	/** Drawn before the chevron. */
	lead?: Snippet;
	children: Snippet;
}

let { collapsed, noun, inset, ontoggle, lead, children }: Props = $props();

const INSETS: Record<FoldInset, string> = {
	thread: "px-1",
	group: "px-4",
	file: "",
};

const label = $derived(`${collapsed ? "Expand" : "Collapse"} ${noun}`);
</script>

<div class="proto-fold">
	<HitArea
		cursor="pointer"
		aria-label={label}
		aria-expanded={!collapsed}
		onclick={ontoggle}
	/>
	<div class="proto-fold-content flex items-center gap-2 {INSETS[inset]}">
		{@render lead?.()}
		<span class="pointer-events-auto flex">
			<Button
				icon
				size="xs"
				variant="ghost"
				aria-expanded={!collapsed}
				aria-label={label}
				onclick={ontoggle}
			>
				{#if collapsed}
					<ChevronRight size={12} aria-hidden="true" />
				{:else}
					<ChevronDown size={12} aria-hidden="true" />
				{/if}
			</Button>
		</span>
		{@render children()}
	</div>
</div>

<style>
.proto-fold {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	block-size: 100%;
}
.proto-fold > :global(*) {
	grid-area: 1 / 1;
	min-width: 0;
}
.proto-fold-content {
	pointer-events: none;
}
</style>

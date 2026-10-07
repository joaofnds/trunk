<script lang="ts" module>
export type FoldInset = "thread";
</script>

<script lang="ts">
// The bar over something that folds: its whole background is the target that
// folds it, and the chevron is the keyboard's way to the same toggle, so the
// background is hidden from assistive tech. What the bar holds lets a press
// through to the background unless it is a control itself, which takes
// `pointer-events-auto`.

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
	children: Snippet;
}

let { collapsed, noun, inset, ontoggle, children }: Props = $props();

const INSETS: Record<FoldInset, string> = {
	thread: "px-1",
};

const label = $derived(`${collapsed ? "Expand" : "Collapse"} ${noun}`);
</script>

<div class="fold-bar min-w-0 flex-1">
	<HitArea
		cursor="pointer"
		aria-label={label}
		aria-hidden="true"
		onclick={ontoggle}
	/>
	<div class="fold-bar-content flex items-center gap-2 {INSETS[inset]}">
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
.fold-bar {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	align-self: stretch;
}
.fold-bar > :global(*) {
	grid-area: 1 / 1;
	min-width: 0;
}
.fold-bar-content {
	pointer-events: none;
}
</style>

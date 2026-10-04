<script lang="ts" module>
export type RowTone = "plain" | "muted" | "current";
export type RowReveal = "hover" | "always";
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";

interface Props extends Omit<HTMLButtonAttributes, "class" | "style"> {
	/** `muted` dims the text; `current` marks the one row that is checked out
	 *  with the accent tint, which the pointer does not change. */
	tone?: RowTone;
	/** The controls drawn at the row's trailing edge, beside the primary button. */
	actions?: Snippet;
	/** `hover` shows the actions under the pointer or focus; `always` keeps them. */
	reveal?: RowReveal;
}

let {
	tone = "plain",
	actions,
	reveal = "hover",
	type = "button",
	tabindex = 0,
	children,
	...rest
}: Props = $props();

const CONTAINER = "row group h-row mx-2 rounded text-callout";

const TONES: Record<RowTone, string> = {
	plain: "text-text font-regular hover:bg-hover",
	muted: "text-text-muted font-regular hover:bg-hover",
	current: "row-current text-text-strong font-semibold",
};

const PRIMARY =
	"col-start-1 col-span-2 row-start-1 grid grid-cols-subgrid " +
	"rounded text-left cursor-pointer";

const CONTENT = "flex items-center min-w-0 pl-2";

const ACTIONS =
	"col-start-2 row-start-1 flex items-center min-w-2 pointer-events-none";

const SHOWN = "ml-1 items-center *:pointer-events-auto";

const REVEALS: Record<RowReveal, string> = {
	hover: "hidden group-hover:flex group-focus-within:flex",
	always: "flex",
};
</script>

<!--
	One row of a list whose whole width is a control: a branch in the sidebar.
	The primary button spans the row and its actions sit over its trailing edge
	as siblings, so no control nests in another. The action column lets the
	pointer through everywhere but on an action, so a click in a gap still lands
	on the row.
-->
<div class={[CONTAINER, TONES[tone]]}>
	<button {type} {tabindex} class={PRIMARY} {...rest}>
		<span class={CONTENT}>{@render children?.()}</span>
	</button>
	<div class={ACTIONS}>
		{#if actions}
			<div class={[SHOWN, REVEALS[reveal]]}>{@render actions()}</div>
		{/if}
	</div>
</div>

<style>
.row {
	display: grid;
	grid-template-columns: minmax(0, 1fr) auto;
}
.row-current {
	background: color-mix(in oklch, var(--color-accent) 10%, transparent);
	box-shadow: inset 0 0 0 1px
		color-mix(in oklch, var(--color-accent) 28%, transparent);
}
</style>

<script lang="ts" module>
export type RowVariant = "inset" | "flush" | "header";
export type RowTone = "plain" | "muted" | "current";
export type RowReveal = "hover" | "always";
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";

interface Props extends Omit<HTMLButtonAttributes, "class" | "style"> {
	/** `inset` is a rounded row held off the list's edges and `flush` one that
	 *  runs to them with the arrow cursor, both taking the hover color; `header`
	 *  is the bar over a section, edge to edge, which does not. */
	variant?: RowVariant;
	/** `muted` dims the text; `current` marks the one row that is checked out
	 *  with the accent tint, which the pointer does not change. */
	tone?: RowTone;
	/** The controls drawn at the row's trailing edge, beside the primary button. */
	actions?: Snippet;
	/** `hover` shows the actions under the pointer or focus; `always` keeps them. */
	reveal?: RowReveal;
}

let {
	variant = "inset",
	tone = "plain",
	actions,
	reveal = "hover",
	type = "button",
	tabindex = 0,
	children,
	...rest
}: Props = $props();

const CONTAINER = "row group";

const SHAPES: Record<RowVariant, string> = {
	inset: "h-row mx-2 rounded text-callout",
	flush: "h-row text-callout",
	header: "h-bar",
};

const HOVERS: Record<RowVariant, string> = {
	inset: "hover:bg-hover",
	flush: "hover:bg-hover",
	header: "",
};

const TONES: Record<RowTone, string> = {
	plain: "text-text font-regular",
	muted: "text-text-muted font-regular",
	current: "row-current text-text-strong font-semibold",
};

const PRIMARY =
	"col-start-1 col-span-2 row-start-1 grid grid-cols-subgrid text-left";

const POINTERS: Record<RowVariant, string> = {
	inset: "rounded cursor-pointer",
	flush: "cursor-default",
	header: "cursor-pointer",
};

const CONTENT = "flex items-center min-w-0";

const LEADS: Record<RowVariant, string> = {
	inset: "pl-2",
	flush: "pl-3 gap-2",
	header: "pl-3",
};

const ACTIONS = "col-start-2 row-start-1 flex items-center pointer-events-none";

const TRAILS: Record<RowVariant, string> = {
	inset: "min-w-2",
	flush: "pr-2",
	header: "pr-2",
};

const SHOWN = "items-center *:pointer-events-auto";

const GAPS: Record<RowVariant, string> = {
	inset: "ml-1",
	flush: "ml-2",
	header: "ml-1",
};

const REVEALS: Record<RowReveal, string> = {
	hover: "hidden group-hover:flex group-focus-within:flex",
	always: "flex",
};
</script>

<!--
	One row of a list whose whole width is a control: a branch or a stash in the
	sidebar, or the header that folds its section.
	The primary button spans the row and its actions sit over its trailing edge
	as siblings, so no control nests in another. The action column lets the
	pointer through everywhere but on an action, so a click in a gap still lands
	on the row.
-->
<div
	class={[
		CONTAINER,
		SHAPES[variant],
		TONES[tone],
		tone !== "current" && HOVERS[variant],
	]}
>
	<button {type} {tabindex} class={[PRIMARY, POINTERS[variant]]} {...rest}>
		<span class={[CONTENT, LEADS[variant]]}>{@render children?.()}</span>
	</button>
	<div class={[ACTIONS, TRAILS[variant]]}>
		{#if actions}
			<div class={[SHOWN, GAPS[variant], REVEALS[reveal]]}
				>{@render actions()}</div
			>
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

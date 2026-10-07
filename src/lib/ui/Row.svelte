<script lang="ts" module>
export type RowVariant =
	| "inset"
	| "flush"
	| "header"
	| "band"
	| "entry"
	| "title"
	| "divider"
	| "fill"
	| "item"
	| "parent";
export type RowRole = "option" | "treeitem";
export type RowTone = "plain" | "muted" | "current";
export type RowReveal = "hover" | "pointer" | "fade" | "always";
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";

interface Props extends Omit<HTMLButtonAttributes, "class" | "style" | "role"> {
	/** `inset` is a rounded row held off the list's edges and `flush` one that
	 *  runs to them with the arrow cursor, both taking the hover color; `header`
	 *  is the bar over a section, edge to edge, which does not, and `band` the
	 *  one over a panel's section, which paints the hairline rule; `entry` is a
	 *  rounded row of a list that stands alone, as tall as its label and
	 *  padding; `title` is the bar that names the rows under it in a scrolling
	 *  list and `divider` the ruled one that parts two runs of them, both as
	 *  tall as the frame the list's layout reserves; `fill` takes the whole box
	 *  of a frame whose height and background its caller computes, and pads
	 *  nothing, so its children do; `item` is a row of a list or a tree that
	 *  runs to its edges and takes the hover color, and `parent` the row that
	 *  folds the items under it, which takes the surface color instead, both
	 *  starting their label at `indent`. */
	variant?: RowVariant;
	/** The role the primary button takes in a `role="listbox"` or a
	 *  `role="tree"`, in place of a button's. */
	role?: RowRole;
	/** Whether the list's cursor is on it, which paints it in the selected-row
	 *  color under the pointer too. Leave unset outside a listbox or a tree. */
	selected?: boolean;
	/** Where an `item` or a `parent` starts its label, as a length. */
	indent?: string;
	/** `muted` dims the text; `current` marks the one row that is checked out
	 *  with the accent tint, which the pointer does not change. */
	tone?: RowTone;
	/** The controls drawn at the row's trailing edge, beside the primary button. */
	actions?: Snippet;
	/** `hover` shows the actions under the pointer or focus and `fade` does the
	 *  same while holding their width at rest; `pointer` shows them under the
	 *  pointer alone, for a row that keeps the focus after a click; `always`
	 *  keeps them. */
	reveal?: RowReveal;
}

let {
	variant = "inset",
	role,
	selected,
	indent,
	tone = "plain",
	actions,
	reveal = "hover",
	type = "button",
	tabindex = 0,
	children,
	...rest
}: Props = $props();

const CONTAINER = "row group shrink-0";

const SHAPES: Record<RowVariant, string> = {
	inset: "h-row mx-2 rounded text-callout",
	flush: "h-row text-callout",
	header: "h-bar",
	band: "h-bar shadow-hairline",
	entry: "rounded",
	title: "size-full bg-surface shadow-hairline text-callout select-none",
	divider: "row-ruled size-full bg-surface text-small",
	fill: "size-full",
	item: "h-row text-callout",
	parent: "h-row text-callout",
};

const HOVERS: Record<RowVariant, string> = {
	inset: "hover:bg-hover",
	flush: "hover:bg-hover",
	header: "",
	band: "",
	entry: "hover:bg-hover",
	title: "",
	divider: "",
	fill: "",
	item: "hover:bg-hover",
	parent: "hover:bg-surface",
};

const TONES: Record<RowTone, string> = {
	plain: "text-text",
	muted: "text-text-muted",
	current: "row-current text-text-strong font-semibold",
};

const WEIGHTS: Record<RowVariant, string> = {
	inset: "font-regular",
	flush: "font-regular",
	header: "font-regular",
	band: "font-regular",
	entry: "font-regular",
	title: "font-medium",
	divider: "font-regular",
	fill: "font-regular",
	item: "font-regular",
	parent: "font-regular",
};

const SELECTED = "bg-selected-row";

const PRIMARY =
	"col-start-1 col-span-2 row-start-1 grid grid-cols-subgrid text-left";

const POINTERS: Record<RowVariant, string> = {
	inset: "rounded cursor-pointer overflow-hidden",
	flush: "cursor-default",
	header: "cursor-pointer",
	band: "cursor-pointer",
	entry: "rounded cursor-pointer",
	title: "cursor-pointer",
	divider: "cursor-pointer",
	fill: "cursor-pointer",
	item: "cursor-pointer",
	parent: "cursor-pointer",
};

const CONTENT = "flex items-center min-w-0";

const LEADS: Record<RowVariant, string> = {
	inset: "pl-2",
	flush: "pl-3 gap-2",
	header: "pl-3",
	band: "pl-2",
	entry: "pl-3 py-2",
	title: "px-2 gap-1",
	divider: "px-2 gap-1",
	fill: "",
	item: "gap-2",
	parent: "gap-1",
};

const ACTIONS = "col-start-2 row-start-1 flex items-center pointer-events-none";

const TRAILS: Record<RowVariant, string> = {
	inset: "min-w-2",
	flush: "pr-2",
	header: "pr-2",
	band: "pr-2",
	entry: "pr-3 py-2",
	title: "",
	divider: "",
	fill: "",
	item: "pr-2",
	parent: "pr-2",
};

const TARGETS = "items-center *:pointer-events-auto";

const GAPS: Record<RowVariant, string> = {
	inset: "ml-1",
	flush: "ml-2",
	header: "",
	band: "gap-1",
	entry: "ml-4",
	title: "",
	divider: "",
	fill: "",
	item: "ml-2",
	parent: "ml-1",
};

const REVEALS: Record<RowReveal, string> = {
	hover: "hidden group-hover:flex group-focus-within:flex",
	pointer: "hidden group-hover:flex",
	fade: "flex opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
	always: "flex",
};
</script>

{#snippet label()}
	<span class={[CONTENT, LEADS[variant]]} style:padding-left={indent}
		>{@render children?.()}</span
	>
{/snippet}

<!--
	One row of a list whose whole width is a control; docs/design-system.md
	lists the rows drawn through it.
	The primary button spans the row and its actions sit over its trailing edge
	as siblings, so no control nests in another. The action column lets the
	pointer through everywhere but on an action, so a click in a gap still lands
	on the row. Only the snippet's top-level elements take the pointer back, so
	a wrapper around two actions would swallow the click between them.
	Each role has its own branch, since the linter reads a role only where it
	is written out and rejects `aria-selected` on a button without one.
-->
<div
	class={[
		CONTAINER,
		SHAPES[variant],
		TONES[tone],
		tone !== "current" && WEIGHTS[variant],
		tone !== "current" && !selected && HOVERS[variant],
		selected && SELECTED,
	]}
>
	{#if role === "option"}
		<button
			{type}
			role="option"
			{tabindex}
			aria-selected={selected}
			class={[PRIMARY, POINTERS[variant]]}
			{...rest}
		>
			{@render label()}
		</button>
	{:else if role === "treeitem"}
		<button
			{type}
			role="treeitem"
			{tabindex}
			aria-selected={selected}
			class={[PRIMARY, POINTERS[variant]]}
			{...rest}
		>
			{@render label()}
		</button>
	{:else}
		<button {type} {tabindex} class={[PRIMARY, POINTERS[variant]]} {...rest}>
			{@render label()}
		</button>
	{/if}
	<div class={[ACTIONS, TRAILS[variant]]}>
		{#if actions}
			<div class={[TARGETS, GAPS[variant], REVEALS[reveal]]}
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
.row-ruled {
	box-shadow:
		inset 0 1px 0 var(--color-border),
		inset 0 -1px 0 var(--color-border);
}
.row-current {
	background: color-mix(in oklch, var(--color-accent) 10%, transparent);
	box-shadow: inset 0 0 0 1px
		color-mix(in oklch, var(--color-accent) 28%, transparent);
}
</style>

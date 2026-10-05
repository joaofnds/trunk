<script lang="ts" module>
export type ListOptionLayout = "row" | "stack";
export type ListOptionHighlight = "selection" | "hover" | "accent";
export type ListOptionRole = "option" | "menuitem";
</script>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

interface Props extends Omit<HTMLButtonAttributes, "class" | "style" | "role"> {
	/** `option` in a listbox, `menuitem` in a menu of actions. */
	role?: ListOptionRole;
	/** Whether the list's cursor is on it. A menu has none, so a menu item ignores it. */
	selected?: boolean;
	/** `row` lays its children on one line; `stack` puts each on its own. */
	layout?: ListOptionLayout;
	/** What marks it: `selection` paints the selected one like a selected row,
	 *  `hover` paints it like a hovered row, `accent` fills it under the pointer. */
	highlight?: ListOptionHighlight;
}

let {
	role = "option",
	selected,
	layout = "row",
	highlight = "selection",
	type = "button",
	children,
	...rest
}: Props = $props();

const BASE =
	"flex w-full cursor-pointer text-left text-text py-2 px-3 " +
	"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

const LAYOUTS: Record<ListOptionLayout, string> = {
	row: "items-center gap-2",
	stack: "flex-col gap-1",
};

const HIGHLIGHTS: Record<ListOptionHighlight, string> = {
	selection: "aria-selected:bg-selected-row",
	hover: "aria-selected:bg-hover",
	accent: "hover:bg-accent hover:text-on-accent",
};
</script>

<!--
	One row of a popup list: a file in the finder, a repository in the picker, a
	strategy in the pull menu. It takes its type from the list around it, so the
	caller sets the size on the listbox or menu.
-->
{#if role === "option"}
	<button
		{type}
		role="option"
		aria-selected={selected}
		class={[BASE, LAYOUTS[layout], HIGHLIGHTS[highlight]]}
		{...rest}
	>
		{@render children?.()}
	</button>
{:else}
	<button
		{type}
		role="menuitem"
		class={[BASE, LAYOUTS[layout], HIGHLIGHTS[highlight]]}
		{...rest}
	>
		{@render children?.()}
	</button>
{/if}

<script lang="ts" module>
export type ListOptionLayout = "row" | "stack";
export type ListOptionHighlight = "selection" | "hover";
</script>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

interface Shared
	extends Omit<
		HTMLButtonAttributes,
		"class" | "style" | "role" | "aria-selected"
	> {
	/** `row` lays its children on one line; `stack` puts each on its own. */
	layout?: ListOptionLayout;
}

interface Option extends Shared {
	role?: "option";
	/** Whether the list's cursor is on it. */
	selected?: boolean;
	/** What marks the selected one: `selection` paints it like a selected row,
	 *  `hover` like a hovered one. */
	highlight?: ListOptionHighlight;
}

/** A row in a menu of actions. A menu has no cursor, so it takes no selected
 *  state and fills with the accent under the pointer instead. */
interface MenuItem extends Shared {
	role: "menuitem";
	selected?: never;
	highlight?: never;
}

type Props = Option | MenuItem;

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
};

const MENU_ITEM = "hover:bg-accent hover:text-on-accent";
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
		class={[BASE, LAYOUTS[layout], MENU_ITEM]}
		{...rest}
	>
		{@render children?.()}
	</button>
{/if}

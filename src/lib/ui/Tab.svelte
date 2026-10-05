<script lang="ts" module>
export type TabVariant = "strip" | "framed";
</script>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

interface Props extends Omit<HTMLButtonAttributes, "class" | "style" | "role"> {
	/** `strip` is one tab of a TabStrip, an equal share of it with the accent
	 *  rule under the selected one; `framed` is the target of a tab its caller
	 *  frames and paints as a grid, whose one cell it fills, keeping its
	 *  trailing edge clear for a control the caller lays over it there. */
	variant?: TabVariant;
	/** Whether this is the tab its tablist has open. */
	selected?: boolean;
}

let {
	variant = "strip",
	selected = false,
	type = "button",
	tabindex,
	children,
	...rest
}: Props = $props();

const VARIANTS: Record<TabVariant, string> = {
	strip:
		"flex-1 p-0 text-callout cursor-pointer border-b-2 border-transparent text-text-subtle " +
		"aria-selected:border-accent aria-selected:text-text-strong disabled:cursor-default " +
		"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
	framed:
		"col-start-1 row-start-1 flex items-center gap-2 pl-3 pr-2 " +
		"after:w-control-xs after:shrink-0 rounded text-left cursor-pointer",
};

const TAB_ORDER: Record<TabVariant, number | undefined> = {
	strip: undefined,
	framed: 0,
};
</script>

<!--
	One tab of a tablist. In a TabStrip it takes an equal share of the strip,
	and the selected one carries the accent rule along its bottom edge. Framed,
	it is the whole target of a tab its caller draws, with the caller's other
	controls beside it and never inside it.
-->
<button
	{type}
	role="tab"
	aria-selected={selected}
	class={VARIANTS[variant]}
	tabindex={tabindex ?? TAB_ORDER[variant]}
	{...rest}
>
	{@render children?.()}
</button>

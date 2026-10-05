<script lang="ts" module>
export type TabVariant = "strip" | "chip";
</script>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

interface Props extends Omit<HTMLButtonAttributes, "class" | "style" | "role"> {
	/** `strip` is one tab of a TabStrip, an equal share of it with the accent
	 *  rule under the selected one; `chip` is the target of a chip its caller
	 *  frames and paints as a grid of two columns, which it spans so a control
	 *  in the second sits over its trailing edge. */
	variant?: TabVariant;
	/** Whether this is the tab the strip has open. */
	selected?: boolean;
}

let {
	variant = "strip",
	selected = false,
	type = "button",
	children,
	...rest
}: Props = $props();

const VARIANTS: Record<TabVariant, string> = {
	strip:
		"flex-1 p-0 text-callout cursor-pointer border-b-2 border-transparent text-text-subtle " +
		"aria-selected:border-accent aria-selected:text-text-strong disabled:cursor-default " +
		"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
	chip:
		"col-start-1 col-span-2 row-start-1 grid grid-cols-subgrid items-center " +
		"rounded text-left cursor-pointer",
};

const LABEL = "flex items-center gap-2 pl-3 min-w-0";
</script>

<!--
	One tab of a tablist. In a TabStrip it takes an equal share of the strip,
	and the selected one carries the accent rule along its bottom edge. As a
	chip it is the whole target of a tab its caller draws, with the caller's
	other controls beside it and never inside it.
-->
<button
	{type}
	role="tab"
	aria-selected={selected}
	class={VARIANTS[variant]}
	{...rest}
>
	{#if variant === "chip"}
		<span class={LABEL}>{@render children?.()}</span>
	{:else}
		{@render children?.()}
	{/if}
</button>

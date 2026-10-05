<script lang="ts" module>
export type TabVariant = "strip" | "framed";
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";

type Framing =
	| {
			/** One tab of a TabStrip, an equal share of it with the accent rule
			 *  under the selected one. */
			variant?: "strip";
			trailing?: never;
	  }
	| {
			/** The target of a tab its caller frames and paints as a grid, whose
			 *  one cell it fills. */
			variant: "framed";
			/** The control laid over the tab's trailing edge, in the room the tab
			 *  keeps clear after its label: one `xs` control, beside the tab and
			 *  never inside it. */
			trailing: Snippet;
	  };

type Props = Omit<HTMLButtonAttributes, "class" | "style" | "role"> &
	Framing & {
		/** Whether this is the tab its tablist has open. */
		selected?: boolean;
	};

let {
	variant = "strip",
	selected = false,
	type = "button",
	tabindex,
	children,
	trailing,
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

const TRAILING =
	"col-start-1 row-start-1 justify-self-end self-center flex mr-2";

const TAB_ORDER: Record<TabVariant, number | undefined> = {
	strip: undefined,
	framed: 0,
};
</script>

<!--
	One tab of a tablist. In a TabStrip it takes an equal share of the strip,
	and the selected one carries the accent rule along its bottom edge. Framed,
	it is the whole target of a tab its caller draws, with the trailing control
	over its trailing edge as a sibling.
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
{#if trailing}
	<div class={TRAILING}> {@render trailing()} </div>
{/if}

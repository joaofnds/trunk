<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

interface Props extends Omit<HTMLButtonAttributes, "class" | "style" | "role"> {
	/** Whether this is the tab the strip has open. */
	selected?: boolean;
}

let { selected = false, type = "button", children, ...rest }: Props = $props();

const BASE =
	"flex-1 p-0 text-callout cursor-pointer border-b-2 border-transparent text-text-subtle " +
	"aria-selected:border-accent aria-selected:text-text-strong disabled:cursor-default " +
	"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";
</script>

<!--
	One tab of a TabStrip. It takes an equal share of the strip, and the
	selected one carries the accent rule along its bottom edge.
-->
<button {type} role="tab" aria-selected={selected} class={BASE} {...rest}>
	{@render children?.()}
</button>

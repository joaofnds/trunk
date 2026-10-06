<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";

interface ButtonTag extends Omit<HTMLButtonAttributes, "class" | "style"> {
	variant?: "button";
	/** For a span that is the whole of something rather than a range of it. */
	dashed?: boolean;
}

interface LabelTag {
	variant: "label";
	dashed?: boolean;
	type?: never;
	children: Snippet;
}

let {
	variant = "button",
	dashed = false,
	type = "button",
	children,
	...rest
}: ButtonTag | LabelTag = $props();

const FRAME =
	"inline-flex items-center gap-1 h-control-xs px-2 rounded border border-border shrink-0 whitespace-nowrap text-small font-medium";

const RANGE = "border-solid font-mono text-text-strong";

const WHOLE = "border-dashed font-sans text-text";

const BUTTON =
	"cursor-pointer hover:border-accent-border hover:text-accent-strong " +
	"disabled:cursor-not-allowed disabled:text-text-subtle disabled:hover:border-border " +
	"focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
</script>

<!--
	A small bordered box naming a span of something: the lines a comment is on,
	or the whole commit it is about.
-->
{#if variant === "label"}
	<span class={[FRAME, dashed ? WHOLE : RANGE]}>{@render children?.()}</span>
{:else}
	<button {type} class={[FRAME, dashed ? WHOLE : RANGE, BUTTON]} {...rest}>
		{@render children?.()}
	</button>
{/if}

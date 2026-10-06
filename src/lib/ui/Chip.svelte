<script lang="ts" module>
export type ChipTone = "accent" | "neutral";
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";

interface ButtonChip extends Omit<HTMLButtonAttributes, "class" | "style"> {
	variant?: "button";
	/** `accent` for the chip a row leads with; `neutral` for the ones beside it. */
	tone?: ChipTone;
}

interface LabelChip {
	variant: "label";
	tone?: ChipTone;
	children: Snippet;
}

let {
	variant = "button",
	tone = "accent",
	children,
	...rest
}: ButtonChip | LabelChip = $props();

const FRAME =
	"inline-flex items-center gap-1 h-control-sm rounded-full border font-mono text-small";

const BUTTON =
	"pl-1 pr-2 cursor-pointer " +
	"focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

const LABEL = "px-2";

const TONES: Record<ChipTone, string> = {
	accent: "border-chip-accent-border bg-chip-accent-bg text-accent-strong",
	neutral: "border-border bg-muted-bg text-text",
};

const HOVERS: Record<ChipTone, string> = {
	accent: "hover:bg-chip-accent-bg-hover",
	neutral: "hover:bg-muted-bg-hover",
};
</script>

<!--
	A pill that names a commit and jumps to it: a parent or a child in the
	lineage row. Its children are a glyph and the short SHA. As a label it
	names a ref the user cannot act on from where it is drawn, by the name alone.
-->
{#if variant === "label"}
	<span class={[FRAME, LABEL, TONES[tone]]}>{@render children?.()}</span>
{:else}
	<button
		type="button"
		class={[FRAME, BUTTON, TONES[tone], HOVERS[tone]]}
		{...rest}
	>
		{@render children?.()}
	</button>
{/if}

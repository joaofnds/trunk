<script lang="ts" module>
export type ChipTone = "accent" | "neutral" | "lane";
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";

interface ButtonChip extends Omit<HTMLButtonAttributes, "class" | "style"> {
	variant?: "button";
	/** `accent` for the chip a row leads with; `neutral` for the ones beside it;
	 *  `lane` for a ref drawn in its graph lane's colour, read from `--lane`. */
	tone?: ChipTone;
	truncate?: boolean;
}

interface LabelChip {
	variant: "label";
	tone?: ChipTone;
	truncate?: never;
	type?: never;
	children: Snippet;
}

let {
	variant = "button",
	tone = "accent",
	truncate = false,
	type = "button",
	children,
	...rest
}: ButtonChip | LabelChip = $props();

const FRAME =
	"inline-flex items-center gap-1 h-control-sm rounded-full border font-mono text-small";

const BUTTON =
	"pl-1 pr-2 cursor-pointer " +
	"focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

const LABEL = "px-2";

const SHRINK = "chip-truncate min-w-0 flex-1 max-w-max";

const TONES: Record<ChipTone, string> = {
	accent: "border-chip-accent-border bg-chip-accent-bg text-accent-strong",
	neutral: "border-border bg-muted-bg text-text",
	lane: "chip-lane",
};

const HOVERS: Record<ChipTone, string> = {
	accent: "hover:bg-chip-accent-bg-hover",
	neutral: "hover:bg-muted-bg-hover",
	lane: "",
};
</script>

<!--
	A pill that names a ref or a commit and acts on it. Its children are a
	glyph and the name or short SHA.
-->
{#if variant === "label"}
	<span class={[FRAME, LABEL, TONES[tone]]}>{@render children?.()}</span>
{:else}
	<button
		{type}
		class={[
			FRAME,
			BUTTON,
			TONES[tone],
			HOVERS[tone],
			truncate ? SHRINK : null,
		]}
		{...rest}
	>
		{@render children?.()}
	</button>
{/if}

<style>
.chip-lane {
	color: var(--lane);
	border-color: color-mix(in oklch, var(--lane) 45%, transparent);
	background: color-mix(in oklch, var(--lane) 14%, transparent);
}

.chip-truncate > :global(svg) {
	flex-shrink: 0;
}

.chip-truncate > :global(:not(svg)) {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
</style>

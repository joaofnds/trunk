<script lang="ts" module>
export type ChipTone = "accent" | "neutral";
</script>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

interface Props extends Omit<HTMLButtonAttributes, "class" | "style"> {
	/** `accent` for the chip a row leads with; `neutral` for the ones beside it. */
	tone?: ChipTone;
}

let { tone = "accent", type = "button", children, ...rest }: Props = $props();

const BASE =
	"inline-flex items-center gap-1 h-control-sm pl-1 pr-2 rounded-full border " +
	"font-mono text-small cursor-pointer " +
	"focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

const TONES: Record<ChipTone, string> = {
	accent:
		"border-chip-accent-border bg-chip-accent-bg text-accent-strong hover:bg-chip-accent-bg-hover",
	neutral: "border-border bg-muted-bg text-text hover:bg-muted-bg-hover",
};
</script>

<!--
	A pill that names a commit and jumps to it: a parent or a child in the
	lineage row. Its children are a glyph and the short SHA.
-->
<button {type} class={[BASE, TONES[tone]]} {...rest}>
	{@render children?.()}
</button>

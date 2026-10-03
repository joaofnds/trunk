<script lang="ts" module>
export type RowActionTone = "subtle" | "muted" | "text" | "success" | "danger";
export type RowActionSize = "target" | "compact";
</script>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

interface Props extends Omit<HTMLButtonAttributes, "class" | "style"> {
	/** The text color the glyph takes; `subtle` for an action a row reveals. */
	tone?: RowActionTone;
	/** `target` fills the minimum hit target; `compact` hugs the glyph. */
	size?: RowActionSize;
}

let {
	tone = "subtle",
	size = "target",
	type = "button",
	children,
	...rest
}: Props = $props();

const BASE =
	"inline-flex shrink-0 items-center justify-center cursor-pointer " +
	"bg-transparent border-none p-0 " +
	"focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

const TONES: Record<RowActionTone, string> = {
	subtle: "text-text-subtle",
	muted: "text-text-muted",
	text: "text-text",
	success: "text-success",
	danger: "text-danger",
};

const SIZES: Record<RowActionSize, string> = {
	target: "min-w-target min-h-target",
	compact: "px-1 leading-none",
};
</script>

<!--
	An icon-only action on a row or a section header: the eye that hides a
	ref, the plus that stages a file. It draws no frame and no fill, so the
	glyph is the whole control, and its caller gives it an aria-label.
-->
<button {type} class={[BASE, TONES[tone], SIZES[size]]} {...rest}>
	{@render children?.()}
</button>

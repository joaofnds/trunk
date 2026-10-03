<script lang="ts" module>
export type LinkButtonTone = "inherit" | "muted";
</script>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

interface Props extends Omit<HTMLButtonAttributes, "class" | "style"> {
	/** `inherit` reads as the text around it; `muted` steps back from it. */
	tone?: LinkButtonTone;
	/** For a ref, a SHA or a path, set in the mono face. */
	mono?: boolean;
	/** Fills its parent's width and ends a label that overflows it with an ellipsis. */
	truncate?: boolean;
}

let {
	tone = "inherit",
	mono = false,
	truncate = false,
	type = "button",
	children,
	...rest
}: Props = $props();

const BASE =
	"cursor-pointer text-left " +
	"hover:text-accent hover:underline focus-visible:text-accent focus-visible:underline " +
	"focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
	"disabled:pointer-events-none disabled:opacity-50";

const TONES: Record<LinkButtonTone, string> = {
	inherit: "text-inherit",
	muted: "text-text-muted",
};

const FACES = { mono: "font-mono" };

const SHAPES = { truncate: "block w-full truncate" };
</script>

<!--
	A trigger that reads as text: a commit summary, a review title, a ref. It
	takes its size and weight from the text around it, so a caller sets those
	on the parent. Preflight already strips a button's frame, padding and
	default font, so the primitive adds only the pointer and the link look.
-->
<button
	{type}
	class={[
		BASE,
		TONES[tone],
		mono ? FACES.mono : null,
		truncate ? SHAPES.truncate : null,
	]}
	{...rest}
>
	{@render children?.()}
</button>

<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLButtonAttributes } from "svelte/elements";

type Tone = "plain" | "muted";

interface ButtonBadge extends Omit<HTMLButtonAttributes, "class" | "style"> {
	variant?: "button";
	/** `muted` for a count, `plain` for an id or a SHA. */
	tone?: Tone;
}

interface LabelBadge {
	variant: "label";
	tone?: Tone;
	title?: string;
	type?: never;
	children: Snippet;
}

let {
	variant = "button",
	tone = "plain",
	type = "button",
	title,
	children,
	...rest
}: ButtonBadge | LabelBadge = $props();

const FRAME =
	"inline-flex items-center h-control-xs px-1 rounded shrink-0 whitespace-nowrap bg-surface-chip font-mono text-caption";

const TONES: Record<Tone, string> = {
	plain: "font-medium text-text",
	muted: "font-regular text-text-muted",
};

const BUTTON =
	"cursor-pointer hover:text-accent-strong " +
	"focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
</script>

<!--
	A short id or count in a small filled box: a review's id, a commit's SHA, the
	number of reviews in a list.
-->
{#if variant === "label"}
	<span class={[FRAME, TONES[tone]]} {title}>{@render children?.()}</span>
{:else}
	<button {type} {title} class={[FRAME, TONES[tone], BUTTON]} {...rest}>
		{@render children?.()}
	</button>
{/if}

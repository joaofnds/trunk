<script lang="ts" module>
export type ButtonGroupTone = "neutral" | "accent";
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import type { ButtonSize } from "./Button.svelte";

interface Props {
	/** `accent` is the soft sleeve around a control that is switched on. */
	tone?: ButtonGroupTone;
	/** The size its joined buttons are set in, whose height they give up to it. */
	size?: ButtonSize;
	children: Snippet;
}

let { tone = "neutral", size = "md", children }: Props = $props();

const BASE =
	"inline-flex min-w-auto shrink-0 items-stretch rounded ring-1 ring-inset divide-x";

const TONES: Record<ButtonGroupTone, string> = {
	neutral: "ring-border divide-border",
	accent: "bg-accent-bg ring-accent-border divide-accent-border",
};

const HEIGHTS: Record<ButtonSize, string> = {
	xs: "h-control-xs",
	sm: "h-control-sm",
	md: "h-control",
	lg: "h-control-lg",
};
</script>

<!--
	One frame around joined buttons (`<Button joined>`), as a ring rather than a
	border so the buttons keep the height their token declares.
-->
<fieldset class="{BASE} {TONES[tone]} {HEIGHTS[size]}">
	{@render children()}
</fieldset>

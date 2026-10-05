<script lang="ts" module>
export type ButtonGroupTone = "neutral" | "accent";
</script>

<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	/** `accent` is the soft sleeve around a control that is switched on. */
	tone?: ButtonGroupTone;
	children: Snippet;
}

let { tone = "neutral", children }: Props = $props();

const BASE =
	"inline-flex h-control min-w-auto shrink-0 items-stretch rounded ring-1 ring-inset divide-x";

const TONES: Record<ButtonGroupTone, string> = {
	neutral: "ring-border divide-border",
	accent: "bg-accent-bg ring-accent-border divide-accent-border",
};
</script>

<!--
	One frame around joined buttons (`<Button joined>`), as a ring rather than a
	border so the buttons keep the height their token declares.
-->
<fieldset class="{BASE} {TONES[tone]}">{@render children()}</fieldset>

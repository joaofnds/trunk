<script lang="ts" module>
export type ToastTone = "neutral" | "danger";
</script>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

interface Props extends Omit<HTMLButtonAttributes, "class" | "style"> {
	/** `neutral` for news; `danger` for a failure. */
	tone?: ToastTone;
}

let { tone = "neutral", type = "button", children, ...rest }: Props = $props();

const BASE =
	"block w-full text-left px-4 py-2 rounded border text-body font-medium shadow-lg cursor-pointer " +
	"focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

const TONES: Record<ToastTone, string> = {
	neutral: "bg-surface border-border text-text",
	danger: "bg-toast-error-bg border-danger-border text-danger",
};
</script>

<!--
	A notice that dismisses itself when clicked. The whole card is the
	button, so the message is its accessible name.
-->
<button {type} class={[BASE, TONES[tone]]} {...rest}>
	{@render children?.()}
</button>

<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

interface ButtonRadio
	extends Omit<HTMLButtonAttributes, "class" | "style" | "aria-pressed"> {
	variant?: "button";
	/** Whether this is the one of its set that is chosen. */
	checked: boolean;
}

interface MarkRadio {
	/** The same mark drawn as decoration, for a legend that explains it. */
	variant: "mark";
	checked: boolean;
	type?: never;
}

let {
	variant = "button",
	checked,
	type = "button",
	...rest
}: ButtonRadio | MarkRadio = $props();

const FRAME =
	"radio inline-flex shrink-0 items-center justify-center rounded-full p-0";

const BUTTON =
	"cursor-pointer " +
	"focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";
</script>

<!--
	The round mark that says which one of a set is chosen: the active review,
	where new comments land. Pressing it chooses its own; it is a toggle button
	rather than a radio input, since choosing is the only thing it does and the
	set has no arrow-key travel of its own.
-->
{#if variant === "mark"}
	<span
		class={FRAME}
		data-checked={checked ? "" : undefined}
		aria-hidden="true"
	></span>
{:else}
	<button
		{type}
		class={[FRAME, BUTTON]}
		aria-pressed={checked}
		data-checked={checked ? "" : undefined}
		{...rest}
	></button>
{/if}

<style>
.radio {
	width: calc(7 * var(--u) / 2);
	height: calc(7 * var(--u) / 2);
	border: 1px solid var(--color-text-subtle);
	background: transparent;
}
.radio[data-checked],
button.radio:hover {
	border-color: var(--color-accent);
}
.radio[data-checked]::after {
	content: "";
	width: calc(3 * var(--u) / 2);
	height: calc(3 * var(--u) / 2);
	border-radius: 50%;
	background: var(--color-accent);
}
</style>

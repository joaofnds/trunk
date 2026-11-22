<script lang="ts" module>
export type DialogSize = "sm" | "md";
export type DialogVariant = "modal" | "anchored" | "palette";

export const paletteInputClass =
	"shrink-0 w-full px-3 py-2 bg-surface-raised border-b border-border text-body text-text " +
	"focus:outline-2 focus:-outline-offset-2 focus:outline-accent";
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLDialogAttributes } from "svelte/elements";

interface Common
	extends Omit<HTMLDialogAttributes, "class" | "style" | "open"> {
	/** The heading the dialog is named by for assistive tech. */
	title: string;
	children: Snippet;
}

interface Modal extends Common {
	/** Centred over the app, which turns inert behind it. */
	variant?: "modal";
	/** How wide the box may grow before its content wraps. */
	size?: DialogSize;
}

interface Anchored extends Omit<Common, "oncancel"> {
	/** Fills the width of the box its caller places; what is around it stays live. */
	variant: "anchored";
	size?: never;
}

interface Palette extends Common {
	variant: "palette";
	size?: never;
}

type Props = Modal | Anchored | Palette;

let {
	title,
	size = "sm",
	variant = "modal",
	children,
	...rest
}: Props = $props();

let el: HTMLDialogElement | undefined = $state();
const titleId = `dialog-title-${crypto.randomUUID()}`;

const FRAME = "rounded border border-border text-text shadow-lg";

const VARIANTS: Record<DialogVariant, string> = {
	modal:
		"fixed inset-0 m-auto h-fit w-fit p-4 bg-surface-raised backdrop:bg-backdrop",
	anchored: "static m-0 h-auto w-auto flex flex-col gap-3 p-4 bg-surface",
	palette:
		"palette fixed inset-x-0 top-0 mx-auto flex flex-col overflow-hidden h-fit w-dialog-max p-0 bg-surface-raised backdrop:bg-backdrop",
};

const SIZES: Record<DialogSize, string> = {
	sm: "min-w-dialog-min max-w-dialog-max",
	md: "min-w-dialog-lg-min max-w-dialog-lg-max",
};

const TITLES: Record<"modal" | "anchored", string> = {
	modal: "text-body font-semibold mb-3",
	anchored: "text-callout leading-normal font-semibold text-text-muted",
};

$effect(() => {
	if (!el || el.open) return;
	if (variant === "anchored") el.show();
	else el.showModal();
});
</script>

<!--
	The dialog is open for as long as it is mounted: a caller shows it with an
	{#if} and takes it down from the cancel or submit it reports.

	A modal is centred over the app and makes everything behind it inert. Escape
	reaches the caller as the element's own cancel event; a click on the backdrop
	closes nothing. The fixed, inset, auto-margin box re-states the UA's modal
	centering, which the preflight margin reset removes.

	An anchored dialog is not modal: it takes the width of the box its caller
	places, and what is around it stays live. Escape raises no cancel on a
	dialog that is not modal, so the caller closes it from its own Escape.
-->
<dialog
	bind:this={el}
	class={[FRAME, VARIANTS[variant], variant === "modal" && SIZES[size]]}
	aria-labelledby={variant === "palette" ? undefined : titleId}
	aria-label={variant === "palette" ? title : undefined}
	{...rest}
>
	{#if variant !== "palette"}
		<h3 id={titleId} class={TITLES[variant]}>{title}</h3>
	{/if}
	{@render children()}
</dialog>

<style>
.palette {
	margin-top: var(--dialog-drop);
	max-width: 90vw;
	max-height: 60vh;
}

.palette :global([role="option"][aria-selected="true"]) {
	box-shadow: inset 2px 0 var(--color-accent);
}
</style>

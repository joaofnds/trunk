<script lang="ts" module>
export type DialogSize = "sm" | "md";
export type DialogVariant = "modal" | "anchored";
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

type Props = Modal | Anchored;

let {
	title,
	size = "sm",
	variant = "modal",
	children,
	...rest
}: Props = $props();

let el: HTMLDialogElement | undefined = $state();
const titleId = `dialog-title-${crypto.randomUUID()}`;

const FRAME = "rounded border border-border p-4 text-text shadow-lg";

const VARIANTS: Record<DialogVariant, string> = {
	modal:
		"fixed inset-0 m-auto h-fit w-fit bg-surface-raised backdrop:bg-backdrop",
	anchored: "static m-0 h-auto w-auto flex flex-col gap-3 bg-surface",
};

const SIZES: Record<DialogSize, string> = {
	sm: "min-w-dialog-min max-w-dialog-max",
	md: "min-w-dialog-lg-min max-w-dialog-lg-max",
};

const TITLES: Record<DialogVariant, string> = {
	modal: "text-body font-semibold mb-3",
	anchored: "text-callout leading-normal font-semibold text-text-muted",
};

$effect(() => {
	if (!el || el.open) return;
	if (variant === "modal") el.showModal();
	else el.show();
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
	aria-labelledby={titleId}
	{...rest}
>
	<h3 id={titleId} class={TITLES[variant]}>{title}</h3>
	{@render children()}
</dialog>

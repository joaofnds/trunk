<script lang="ts" module>
export type DialogSize = "sm" | "md";
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import type { HTMLDialogAttributes } from "svelte/elements";

interface Props extends Omit<HTMLDialogAttributes, "class" | "style" | "open"> {
	/** The heading the dialog is named by for assistive tech. */
	title: string;
	/** How wide the box may grow before its content wraps. */
	size?: DialogSize;
	children: Snippet;
}

let { title, size = "sm", children, ...rest }: Props = $props();

let el: HTMLDialogElement | undefined = $state();
const titleId = `dialog-title-${crypto.randomUUID()}`;

const BASE =
	"fixed inset-0 m-auto h-fit w-fit rounded border border-border bg-surface-raised p-4 text-text shadow-lg backdrop:bg-backdrop";

const SIZES: Record<DialogSize, string> = {
	sm: "min-w-dialog-min max-w-dialog-max",
	md: "min-w-dialog-lg-min max-w-dialog-lg-max",
};

$effect(() => {
	if (el && !el.open) el.showModal();
});
</script>

<!--
	The modal is open for as long as it is mounted: a caller shows it with an
	{#if} and takes it down from the cancel or submit it reports. Escape reaches
	the caller as the element's own cancel event; a click on the backdrop closes
	nothing. The fixed, inset, auto-margin box re-states the UA's modal
	centering, which the preflight margin reset removes.
-->
<dialog
	bind:this={el}
	class={[BASE, SIZES[size]]}
	aria-labelledby={titleId}
	{...rest}
>
	<h3 id={titleId} class="text-body font-semibold mb-3">{title}</h3>
	{@render children()}
</dialog>

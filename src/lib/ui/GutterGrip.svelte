<script lang="ts">
import type { HTMLButtonAttributes } from "svelte/elements";

type Props = Omit<HTMLButtonAttributes, "class" | "style">;

let { type = "button", tabindex = 0, children, ...rest }: Props = $props();

const BASE = "inline-flex shrink-0 rounded cursor-pointer select-none";

const FOCUS =
	"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";
</script>

<!--
	The line numbers of a diff line that can be selected, as the control a press
	or a drag starts the selection from. Its children are the numbers, which the
	view sizes and paints. `data-gutter-grip` is what the view's row selects to
	tint itself under a hovered grip.
-->
<button {type} {tabindex} class={[BASE, FOCUS]} data-gutter-grip {...rest}>
	{@render children?.()}
</button>

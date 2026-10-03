<script lang="ts">
import type { HTMLAttributes } from "svelte/elements";

type Props = Omit<HTMLAttributes<HTMLDivElement>, "class" | "style" | "role">;

let { children, ...rest }: Props = $props();

const BASE = "flex h-bar shrink-0 shadow-hairline";
</script>

<!--
	The bar a set of Tabs sits on: one chrome-bar height, with the hairline
	rule painted inside its own box so the bar keeps the height its token
	declares.
-->
<div role="tablist" class={BASE} {...rest}> {@render children?.()} </div>

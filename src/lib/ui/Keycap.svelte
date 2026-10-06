<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	/** The key as it is printed on the keyboard: "J", "⌘", "↵". */
	children: Snippet;
}

let { children }: Props = $props();
</script>

<!-- One key of a shortcut, drawn as the key it names. -->
<kbd
	class="inline-flex items-center justify-center h-control-xs px-1 rounded border border-border bg-surface-raised font-sans text-caption font-medium text-text-muted"
	>{@render children()}</kbd
>

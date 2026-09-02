<script lang="ts">
import Eye from "@lucide/svelte/icons/eye";
import EyeOff from "@lucide/svelte/icons/eye-off";

/**
 * What a visibility eye looks like, in one place.
 *
 * Four toggles draw this icon — a branch row, a stash row, a section header and a remote
 * group — and they differ in layout, click handling and when they appear, but not in what
 * the eye means. That last part is the knowledge worth having once: a crossed-out eye says
 * the thing is hidden, and clicking will show it.
 */
interface Props {
	hidden: boolean;
	size?: number;
}

let { hidden, size = 12 }: Props = $props();
</script>

{#if hidden}<EyeOff {size} />{:else}<Eye {size} />{/if}

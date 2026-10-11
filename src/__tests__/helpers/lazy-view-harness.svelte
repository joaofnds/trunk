<script lang="ts">
import LazyView from "../../components/LazyView.svelte";
import type Button from "../../lib/ui/Button.svelte";

let { load }: { load: () => Promise<{ default: typeof Button }> } = $props();
</script>

<LazyView {load} label="editor">
	{#snippet children(View)}
		<View>Loaded editor</View>
	{/snippet}
</LazyView>

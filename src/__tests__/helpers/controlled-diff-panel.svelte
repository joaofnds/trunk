<script lang="ts">
import type { ComponentProps } from "svelte";
import DiffPanel from "../../components/DiffPanel.svelte";
import { DiffPreferences } from "../../lib/diff-preferences.svelte.js";
import type { ContentMode, Side } from "../../lib/types.js";

type DiffPanelProps = ComponentProps<typeof DiffPanel>;
type AppOwned = "contentMode" | "oncontentmodechange" | "diffPreferences";
type Props = Omit<DiffPanelProps, AppOwned> &
	Partial<Pick<DiffPanelProps, AppOwned>>;

let {
	contentMode: suppliedContentMode = "hunk",
	oncontentmodechange,
	diffPreferences: suppliedPreferences,
	...props
}: Props = $props();
// App mounts a diff only once the saved settings are read, so a panel given
// none waits for its own read the same way.
let diffPreferences = $state.raw<DiffPreferences | null>(null);
let contentMode = $state<ContentMode>("hunk");
let diffPanel = $state<{
	scrollToLine: (start: number, end: number, side: Side) => void;
}>();

$effect(() => {
	contentMode = suppliedContentMode;
});

$effect(() => {
	if (suppliedPreferences) {
		diffPreferences = suppliedPreferences;
		return;
	}
	void DiffPreferences.load().then((preferences) => {
		diffPreferences = preferences;
	});
});

function handleContentModeChange(mode: ContentMode) {
	contentMode = mode;
	oncontentmodechange?.(mode);
}

export function scrollToLine(start: number, end: number, side: Side) {
	if (!diffPanel) throw new Error("the panel mounts once its settings load");
	diffPanel.scrollToLine(start, end, side);
}
</script>

{#if diffPreferences}
	<DiffPanel
		bind:this={diffPanel}
		{...props}
		{contentMode}
		{diffPreferences}
		oncontentmodechange={handleContentModeChange}
	/>
{/if}

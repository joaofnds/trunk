<script lang="ts">
import type { ComponentProps } from "svelte";
import DiffPanel from "../../components/DiffPanel.svelte";
import type { ContentMode, Side } from "../../lib/types.js";

type DiffPanelProps = ComponentProps<typeof DiffPanel>;
type Props = Omit<DiffPanelProps, "contentMode" | "oncontentmodechange"> &
	Partial<Pick<DiffPanelProps, "contentMode" | "oncontentmodechange">>;

let {
	contentMode: suppliedContentMode = "hunk",
	oncontentmodechange,
	...props
}: Props = $props();
let contentMode = $state<ContentMode>("hunk");
let diffPanel: {
	scrollToLine: (start: number, end: number, side: Side) => void;
};

$effect(() => {
	contentMode = suppliedContentMode;
});

function handleContentModeChange(mode: ContentMode) {
	contentMode = mode;
	oncontentmodechange?.(mode);
}

export function scrollToLine(start: number, end: number, side: Side) {
	diffPanel.scrollToLine(start, end, side);
}
</script>

<DiffPanel
	bind:this={diffPanel}
	{...props}
	{contentMode}
	oncontentmodechange={handleContentModeChange}
/>

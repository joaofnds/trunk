<script lang="ts">
import type { ComponentProps } from "svelte";
import RepoView from "../../components/RepoView.svelte";
import type { ContentMode } from "../../lib/types.js";

type RepoViewProps = ComponentProps<typeof RepoView>;
type Props = Omit<RepoViewProps, "contentMode" | "oncontentmodechange"> &
	Partial<Pick<RepoViewProps, "contentMode" | "oncontentmodechange">>;

let {
	contentMode: suppliedContentMode = "hunk",
	oncontentmodechange,
	...props
}: Props = $props();
let contentMode = $state<ContentMode>("hunk");

$effect(() => {
	contentMode = suppliedContentMode;
});

function handleContentModeChange(mode: ContentMode) {
	contentMode = mode;
	oncontentmodechange?.(mode);
}
</script>

<RepoView
	{...props}
	{contentMode}
	oncontentmodechange={handleContentModeChange}
/>

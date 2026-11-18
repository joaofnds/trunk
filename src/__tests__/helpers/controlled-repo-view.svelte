<script lang="ts">
import type { ComponentProps } from "svelte";
import RepoView from "../../components/RepoView.svelte";
import { DiffPreferences } from "../../lib/diff-preferences.svelte.js";
import type { ContentMode } from "../../lib/types.js";

type RepoViewProps = ComponentProps<typeof RepoView>;
type AppOwned = "contentMode" | "oncontentmodechange" | "diffPreferences";
type Props = Omit<RepoViewProps, AppOwned> &
	Partial<Pick<RepoViewProps, AppOwned>>;

let {
	contentMode: suppliedContentMode = "hunk",
	oncontentmodechange,
	diffPreferences = DiffPreferences.defaults(),
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
	{diffPreferences}
	oncontentmodechange={handleContentModeChange}
/>

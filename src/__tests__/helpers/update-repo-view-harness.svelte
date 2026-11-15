<script lang="ts">
import { type ComponentProps, untrack } from "svelte";
import { provideUpdatePreparation } from "../../lib/updates-context.js";
import type { UpdatePreparation } from "../../lib/updates-lifecycle.js";
import RepoView from "./controlled-repo-view.svelte";

let {
	preparation,
	...props
}: ComponentProps<typeof RepoView> & { preparation: UpdatePreparation } =
	$props();
provideUpdatePreparation(untrack(() => preparation));
</script>

<RepoView {...props} />

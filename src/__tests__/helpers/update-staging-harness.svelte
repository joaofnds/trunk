<script lang="ts">
import { untrack } from "svelte";
import StagingPanel from "../../components/StagingPanel.svelte";
import { provideUpdatePreparation } from "../../lib/updates-context.js";
import type { UpdatePreparation } from "../../lib/updates-lifecycle.js";

let { preparation }: { preparation: UpdatePreparation } = $props();
provideUpdatePreparation(untrack(() => preparation));
</script>

<StagingPanel
	repoPath="/repo"
	commentCounts={new Map()}
	commentTallies={new Map()}
/>

<script lang="ts">
import BranchSidebar from "../../components/BranchSidebar.svelte";
import { createRemoteState } from "../../lib/remote-state.svelte.js";
import Button from "../../lib/ui/Button.svelte";

const remoteState = createRemoteState();
let refreshSignal = $state(0);
</script>

<Button
	onclick={() => {
		refreshSignal += 1;
	}}
	>Complete command</Button
>
<BranchSidebar
	repoPath="/repo"
	{remoteState}
	{refreshSignal}
	refreshImmediately={true}
/>

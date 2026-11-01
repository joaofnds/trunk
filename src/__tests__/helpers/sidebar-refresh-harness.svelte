<script lang="ts">
import BranchSidebar from "../../components/BranchSidebar.svelte";
import Button from "../../lib/ui/Button.svelte";

let refreshSignal = $state(0);
</script>

<Button
	onclick={() => {
		refreshSignal += 1;
	}}
	>Complete command</Button
>
<BranchSidebar repoPath="/repo" {refreshSignal} refreshImmediately={true} />

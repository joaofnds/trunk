<script lang="ts">
import GitBranch from "@lucide/svelte/icons/git-branch";
import { copyText } from "../lib/clipboard.js";
import Chip from "../lib/ui/Chip.svelte";

let { name }: { name: string } = $props();
</script>

<Chip truncate title="Copy {name}" onclick={() => copyText(name)}
	><GitBranch size={11} class="shrink-0" />
	<span class="min-w-0 truncate">{name}</span></Chip
>

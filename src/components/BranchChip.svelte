<script lang="ts">
import GitBranch from "@lucide/svelte/icons/git-branch";
import { copyText } from "../lib/clipboard.js";
import Chip from "../lib/ui/Chip.svelte";

interface Props {
	name: string;
}

let { name }: Props = $props();
</script>

<Chip truncate title="Copy {name}" onclick={() => copyText(name)}
	><GitBranch size={11} />
	<span>{name}</span></Chip
>

<script lang="ts">
import GitBranch from "@lucide/svelte/icons/git-branch";
import { copyText } from "../lib/clipboard.js";
import Chip, { type ChipTone } from "../lib/ui/Chip.svelte";

interface Props {
	name: string;
	tone?: ChipTone;
}

let { name, tone = "accent" }: Props = $props();
</script>

<Chip {tone} truncate title="Copy {name}" onclick={() => copyText(name)}
	><GitBranch size={11} />
	<span>{name}</span></Chip
>

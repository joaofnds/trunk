<script lang="ts">
import GitBranch from "@lucide/svelte/icons/git-branch";
import Laptop from "@lucide/svelte/icons/laptop";
import { copyText } from "../lib/clipboard.js";
import Chip, { type ChipTone } from "../lib/ui/Chip.svelte";

interface Props {
	name: string;
	tone?: ChipTone;
}

let { name, tone = "accent" }: Props = $props();

// A lane chip stands for the graph's pill, which marks a local branch with a laptop.
const Glyph = $derived(tone === "lane" ? Laptop : GitBranch);
</script>

<Chip {tone} truncate title="Copy {name}" onclick={() => copyText(name)}
	><Glyph size={11} />
	<span>{name}</span></Chip
>

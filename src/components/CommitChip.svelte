<script lang="ts">
import GitCommitHorizontal from "@lucide/svelte/icons/git-commit-horizontal";
import { copySha } from "../lib/clipboard.js";
import Chip from "../lib/ui/Chip.svelte";

interface Props {
	oid: string;
}

let { oid }: Props = $props();
</script>

<Chip title="Copy SHA" onclick={() => copySha(oid)}
	><GitCommitHorizontal size={11} />{oid.slice(0, 7)}</Chip
>

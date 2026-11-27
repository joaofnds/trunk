<script lang="ts">
import { onMount, tick } from "svelte";
import { errorMessage } from "../lib/error-report.js";
import { displayPath, gitPathArgument } from "../lib/file-status.js";
import { safeInvoke } from "../lib/invoke.js";
import Button from "../lib/ui/Button.svelte";
import Dialog from "../lib/ui/Dialog.svelte";
import Row from "../lib/ui/Row.svelte";

interface HistoryRow {
	oid: string;
	summary: string;
}
interface HistoryPage {
	commits: HistoryRow[];
	next: number | null;
	revision: number;
}
interface Props {
	repoPath: string;
	filePath: string;
	onselect: (oid: string) => void;
	onclose: () => void;
}

let { repoPath, filePath, onselect, onclose }: Props = $props();
let rows = $state.raw<HistoryRow[]>([]);
let next = $state<number | null>(0);
let revision: number | null = null;
let busy = $state(false);
let error = $state("");
let mounted = false;
let resultList: HTMLElement;

onMount(() => {
	mounted = true;
	void readMore();
	return () => {
		mounted = false;
	};
});

async function readMore() {
	busy = true;
	error = "";
	try {
		while (next !== null) {
			const page: HistoryPage = await safeInvoke("path_history", {
				path: repoPath,
				filePath: gitPathArgument(filePath),
				offset: next,
				revision,
			});
			if (!mounted) return;
			revision = page.revision;
			next = page.next;
			if (page.commits.length) {
				const firstNew = rows.length;
				rows = [...rows, ...page.commits];
				if (firstNew > 0) {
					await tick();
					resultList?.children[firstNew]?.querySelector("button")?.focus();
				}
				break;
			}
		}
	} catch (e) {
		error = errorMessage(e, "Could not read file history");
	} finally {
		busy = false;
	}
}
function reload() {
	rows = [];
	next = 0;
	revision = null;
	void readMore();
}
</script>

<Dialog size="md" title="Commits touching this path" oncancel={onclose}>
	<p class="font-mono text-callout break-all">{displayPath(filePath)}</p>
	<p class="mt-1 text-small text-text-muted"
		>Visible history at this exact path. Earlier names are separate.</p
	>
	<div bind:this={resultList} class="mt-2 max-h-dropdown-max overflow-y-auto">
		{#each rows as row (row.oid)}
			<Row variant="flush" onclick={() => onselect(row.oid)}>
				<span class="font-mono text-text-muted shrink-0"
					>{row.oid.slice(0, 7)}</span
				>
				<span data-testid="path-history-summary" class="truncate"
					>{row.summary}</span
				>
			</Row>
		{/each}
	</div>
	<div role="status" class="text-callout text-text-muted">
		{#if error}
			{error}
		{:else if busy}
			Searching history…
		{:else if rows.length === 0}
			No commits touched this path.
		{:else if next === null}
			{rows.length} {rows.length === 1 ? "commit" : "commits"} touched this
			path.
		{/if}
	</div>
	<div class="mt-2 flex justify-end gap-2">
		{#if error}
			<Button size="sm" onclick={reload}>Reload history</Button>
		{:else if next !== null && !busy}
			<Button size="sm" onclick={readMore}>Show older commits</Button>
		{/if}
		<Button size="sm" onclick={onclose}>Close</Button>
	</div>
</Dialog>

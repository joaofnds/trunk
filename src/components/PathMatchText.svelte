<script lang="ts">
let {
	text,
	positions,
	offset = 0,
}: {
	text: string;
	positions: readonly number[];
	offset?: number;
} = $props();

const ranges = $derived.by(() => {
	const runs: { start: number; end: number }[] = [];
	for (const position of positions) {
		const start = position - offset;
		if (start < 0) continue;
		if (start >= text.length) break;

		const last = runs.at(-1);
		if (last?.end === start) last.end++;
		else runs.push({ start, end: start + 1 });
	}
	return runs;
});
</script>

{#each ranges as range, i (range.start)}
	{text.slice(ranges[i - 1]?.end ?? 0, range.start)}<mark
		class="bg-transparent text-accent-strong font-semibold underline"
		>{text.slice(range.start, range.end)}</mark
	>
{/each}{text.slice(ranges.at(-1)?.end ?? 0)}

<script module lang="ts">
const spaceSeparator = /\p{Zs}/u;
let segmenter: Intl.Segmenter | undefined;
</script>

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
	const runs: { start: number; end: number; space: boolean }[] = [];
	// A space can carry a combining mark. Paint the whole grapheme together.
	let clusters: Intl.Segments | undefined;
	if (spaceSeparator.test(text) && /[^ -~]/.test(text)) {
		segmenter ??= new Intl.Segmenter();
		clusters = segmenter.segment(text);
	}
	for (const position of positions) {
		const start = position - offset;
		if (start < 0) continue;
		if (start >= text.length) break;

		const space = spaceSeparator.test(
			clusters?.containing(start)?.segment ?? text[start],
		);
		const last = runs.at(-1);
		if (last?.end === start && last.space === space) last.end++;
		else runs.push({ start, end: start + 1, space });
	}
	return runs;
});
</script>

{#each ranges as range, i (range.start)}
	{text.slice(ranges[i - 1]?.end ?? 0, range.start)}<mark
		class={[
			"text-accent-strong font-semibold",
			range.space ? "bg-current/45 whitespace-pre" : "bg-transparent",
		]}
		>{text.slice(range.start, range.end)}</mark
	>
{/each}{text.slice(ranges.at(-1)?.end ?? 0)}

<script lang="ts">
// The pane and metrics probe around the model the diff views build. The
// suite reads the factory's outputs through onready.
import { buildInlineRows, buildSplitRows } from "../diff-rows.js";
import { ALL_THREADS } from "../review-filter.js";
import { DIFF_ROW_FONT } from "../row-metrics.js";
import type { FileDiff, Thread } from "../types.js";
import {
	createVirtualizedDiff,
	type DiffListHandle,
	type InlineVirtualizedDiff,
	type SplitVirtualizedDiff,
	TAB_SIZE,
} from "../virtualized-diff.svelte.js";

interface Props {
	layout: "inline" | "split";
	fileDiffs: FileDiff[];
	wordWrap: boolean;
	comments?: Thread[];
	list?: DiffListHandle | null;
	numberColumns?: 1 | 2;
	onready: (vd: InlineVirtualizedDiff | SplitVirtualizedDiff) => void;
}

let {
	layout,
	fileDiffs,
	wordWrap,
	comments = [],
	list = null,
	numberColumns = 2,
	onready,
}: Props = $props();

const buildOptions = $derived({
	content: "full" as const,
	comments,
	reviewFilter: ALL_THREADS,
	collapsed: new Set<string>(),
	fileHeaders: false,
	tabSize: TAB_SIZE,
	invisibles: false,
});

const model = $derived(
	layout === "split"
		? buildSplitRows(fileDiffs, buildOptions)
		: buildInlineRows(fileDiffs, buildOptions),
);

const deps = {
	model: () => model,
	wordWrap: () => wordWrap,
	composer: () => undefined,
	list: () => list,
	startAt: () => null,
	content: () => buildOptions.content,
};

// The factory is created once, from the initial layout: a view states its
// layout as a literal, and this host mirrors that.
// svelte-ignore state_referenced_locally
const vd =
	layout === "split"
		? createVirtualizedDiff({ layout: "split", ...deps })
		: createVirtualizedDiff({
				layout: "inline",
				...deps,
				numberColumns: () => numberColumns,
			});

// svelte-ignore state_referenced_locally
onready(vd);
</script>

<div bind:this={vd.pane}>
	<div
		class="diff-line metrics-probe"
		bind:this={vd.metricsProbe}
		style:font-family={DIFF_ROW_FONT.fontFamily}
		style:font-size={DIFF_ROW_FONT.fontSize}
		style:line-height={DIFF_ROW_FONT.lineHeight}
	></div>
</div>

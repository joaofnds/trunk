<script lang="ts">
// Test host for createVirtualizedDiff: the pane, the metrics probe and the
// comment probe — the same three elements the views bind — around a model built
// the way the views build one. It renders no list; the suite asserts on the
// factory's outputs, which it receives through `onready` at init.
import { buildInlineRows, buildSplitRows } from "../diff-rows.js";
import { DIFF_ROW_FONT } from "../row-metrics.js";
import type { FileDiff, Thread } from "../types.js";
import {
	createVirtualizedDiff,
	type InlineVirtualizedDiff,
	type SplitVirtualizedDiff,
	TAB_SIZE,
} from "../virtualized-diff.svelte.js";

interface Props {
	layout: "inline" | "split";
	fileDiffs: FileDiff[];
	wordWrap: boolean;
	comments?: Thread[];
	list?: { topIndex(): number; anchorTo(index: number): void } | null;
	onready: (vd: InlineVirtualizedDiff | SplitVirtualizedDiff) => void;
}

let {
	layout,
	fileDiffs,
	wordWrap,
	comments = [],
	list = null,
	onready,
}: Props = $props();

const buildOptions = $derived({
	content: "full" as const,
	comments,
	showInlineComments: true,
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
	list: () => list,
};

// The factory is created once, from the initial layout: a view states its
// layout as a literal, and this host mirrors that.
// svelte-ignore state_referenced_locally
const vd =
	layout === "split"
		? createVirtualizedDiff({ layout: "split", ...deps })
		: createVirtualizedDiff({ layout: "inline", ...deps });

// svelte-ignore state_referenced_locally
onready(vd);
</script>

<div class="host-pane" bind:this={vd.pane}>
  <div
    class="diff-line metrics-probe"
    bind:this={vd.metricsProbe}
    style="{DIFF_ROW_FONT};"
  ></div>

  {#if vd.threadsToProbe.length > 0}
    <div class="comment-probe" bind:this={vd.commentProbe}>
      {#each vd.threadsToProbe as c (c.id)}
        <div data-thread-id={c.id}>{c.text}</div>
      {/each}
    </div>
  {/if}
</div>

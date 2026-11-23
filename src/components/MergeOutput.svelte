<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { createCoalescedTask } from "../lib/coalesced-task.js";
import { trailingWhitespaceStart } from "../lib/diff-utils.js";
import { safeInvoke } from "../lib/invoke.js";
import { availableCharsFor, measureRowMetrics } from "../lib/row-metrics.js";
import { getScheduler } from "../lib/scheduler.js";
import type { MergedSpan } from "../lib/types.js";
import MergeText from "./MergeText.svelte";
import MergeWhitespaceWindow, {
	MARKER_CHUNK,
} from "./MergeWhitespaceWindow.svelte";

interface Props {
	filePath: string;
	text: string;
	readonly: boolean;
	lineHeight: number;
	wordWrap?: boolean;
	showInvisibles?: boolean;
	wrapColumns?: number;
	element?: HTMLElement;
	oninput: (event: Event) => void;
	onscroll: () => void;
}

let {
	filePath,
	text,
	readonly,
	lineHeight,
	wordWrap = false,
	showInvisibles = false,
	wrapColumns = $bindable(0),
	element = $bindable(),
	oninput,
	onscroll,
}: Props = $props();
type LineSpans = Record<number, MergedSpan[]>;
let paint = $state.raw<{
	path: string;
	lines: string[];
	spans: LineSpans;
} | null>(null);
let mirror = $state<HTMLPreElement>();
let disposed = false;
let unsupportedPath: string | undefined;

// Keep large edit buffers out of the syntax parser and its span document.
const MAX_PAINT_LENGTH = 128 * 1024;
const MAX_PAINT_LINES = 1000;
// The native textarea normalizes CR and CRLF for display. The merge editor
// keeps the original line endings for saving picks.
let displayText = $derived(
	text.length <= MAX_PAINT_LENGTH ? text.replace(/\r\n?/g, "\n") : "",
);
let lines = $derived(displayText.split("\n", MAX_PAINT_LINES + 1));
let large = $derived(
	text.length > MAX_PAINT_LENGTH || lines.length > MAX_PAINT_LINES,
);
let markers = $derived(showInvisibles && !!text);
// Use the same visible surface from the first plain frame through syntax delivery.
// Oversized, unmarked buffers can be drawn directly by the native textarea.
let useMirror = $derived(!large || markers);
const refresh = createCoalescedTask(getScheduler(), async () => {
	const path = filePath;
	const value = displayText;
	const sourceLines = lines;
	if (
		path === unsupportedPath ||
		!value ||
		sourceLines.length > MAX_PAINT_LINES
	) {
		paint = null;
		return;
	}
	const spans = await safeInvoke<LineSpans | null>("highlight_merge_output", {
		filePath: path,
		text: value,
	});
	if (spans === null) unsupportedPath = path;
	if (!disposed && filePath === path && displayText === value) {
		paint =
			spans && Object.keys(spans).length
				? { path, lines: sourceLines, spans }
				: null;
	}
});
$effect(() => {
	void filePath;
	void displayText;
	untrack(refresh.invalidate);
});
onDestroy(() => {
	disposed = true;
	refresh.dispose();
});

// Keep matching lines painted while the parser catches up. Always draw the
// current text. The reply recomputes multiline syntax in the new context.
let current = $derived.by(() => {
	if (
		paint?.path !== filePath ||
		!displayText ||
		lines.length > MAX_PAINT_LINES
	)
		return null;
	const previous = paint.lines;
	if (previous === lines) return paint.spans;
	const spans: LineSpans = {};
	let first = 0;
	while (first < lines.length && lines[first] === previous[first]) {
		if (paint.spans[first + 1]) spans[first + 1] = paint.spans[first + 1];
		first++;
	}
	let old = previous.length - 1;
	let next = lines.length - 1;
	while (old >= first && next >= first && lines[next] === previous[old]) {
		if (paint.spans[old + 1]) spans[next + 1] = paint.spans[old + 1];
		old--;
		next--;
	}
	return spans;
});

function syncMirror() {
	if (mirror && element) {
		mirror.scrollTop = element.scrollTop;
		mirror.scrollLeft = element.scrollLeft;
	}
}
$effect(syncMirror);

$effect(() => {
	const editor = element;
	const container = editor?.parentElement;
	if (!wordWrap || !editor || !container) {
		wrapColumns = 0;
		return;
	}

	const measure = () => {
		const style = getComputedStyle(editor);
		const padding =
			parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
		wrapColumns = availableCharsFor(
			editor.clientWidth,
			0,
			padding,
			measureRowMetrics(container),
		);
	};
	const observer = new ResizeObserver(measure);
	observer.observe(editor);
	measure();
	return () => observer.disconnect();
});
</script>

{#snippet paintedLines()}
	{#each lines as line, i}
		{@const trailing = markers ? trailingWhitespaceStart(line) : line.length}
		{@const spans = current?.[i + 1] ?? []}
		{#snippet paint(start: number, end: number)}
			{#if spans.length}
				{#each spans.filter(
					(span) => span.end > start && span.start < end,
				) as span}
					{@const from = Math.max(start, span.start)}
					<span class={span.syntax_class}
						><MergeText
							text={line.slice(from, Math.min(end, span.end))}
							showInvisibles={markers}
							trailingStart={trailing - from}
						/></span
					>
				{/each}
			{:else}
				<MergeText
					text={line.slice(start, end)}
					showInvisibles={markers}
					trailingStart={trailing - start}
				/>
			{/if}
		{/snippet}
		{#if i > 0}
			{"\n"}
		{/if}{#if markers && displayText.length > MARKER_CHUNK}
			<MergeWhitespaceWindow text={line} children={paint} />
		{:else}
			{@render paint(0, line.length)}
		{/if}
	{/each}
{/snippet}

<div
	class="merge-output grid flex-1 min-w-0 min-h-0 bg-bg text-text font-mono text-callout"
	style:line-height="{lineHeight}px"
	class:wrapped={wordWrap}
>
	{#if useMirror}
		<pre
			bind:this={mirror}
			aria-hidden="true"
			class="syntax-highlight pointer-events-none select-none overflow-hidden py-1 px-2"
		>{#if large}<MergeText text={text.replace(/\r\n?/g, "\n")} showInvisibles={true} />{:else if current || markers}{@render paintedLines()}{:else}{displayText}{/if}{"\u200b"}</pre>
	{/if}
	<textarea
		aria-label="Merge output"
		{readonly}
		bind:this={element}
		value={text}
		wrap={wordWrap ? "soft" : "off"}
		spellcheck="false"
		{oninput}
		onscroll={() => {
			syncMirror();
			onscroll();
		}}
		class="relative w-full h-full resize-none border-none focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-accent text-text bg-transparent py-1 px-2"
		class:painted={useMirror}
	></textarea>
</div>

<style>
.merge-output {
	grid-template: minmax(0, 1fr) / minmax(0, 1fr);
}
.merge-output > * {
	grid-area: 1 / 1;
	font: inherit;
	tab-size: inherit;
	white-space: pre;
}
.merge-output.wrapped > * {
	white-space: break-spaces;
	word-break: break-all;
}
@media (forced-colors: none) {
	textarea.painted {
		color: transparent;
		caret-color: var(--color-text);
	}
	/* WebKit darkens opaque selection fills. An explicit alpha preserves the
	   accent's contrast with the ink in the native text control. */
	textarea::selection {
		color: var(--color-on-accent);
		background-color: color-mix(in oklch, var(--color-accent) 95%, transparent);
	}
}
@media (forced-colors: active) {
	pre {
		visibility: hidden;
	}
}
</style>

<script lang="ts" module>
export type SplitterVariant = "pane" | "column" | "bar";
</script>

<script lang="ts">
import type { HTMLAttributes } from "svelte/elements";

type Orientation = "horizontal" | "vertical";

interface Shared
	extends Omit<
		HTMLAttributes<HTMLDivElement>,
		| "class"
		| "style"
		| "role"
		| "tabindex"
		| "aria-orientation"
		| "aria-valuenow"
		| "aria-valuemin"
		| "aria-valuemax"
		| "onkeydown"
	> {
	/** `pane` is the strip between two panes laid side by side and `column`
	 *  the one over the trailing edge of a table's header cell, both moving
	 *  left and right; `bar` is the strip across a panel, between two parts
	 *  stacked in it, moving up and down. */
	variant: SplitterVariant;
}

interface Moving extends Shared {
	fixed?: false;
	"aria-label": string;
	/** The size in pixels of what it resizes, and the limits that size moves
	 *  between. Leave `max` unset where nothing caps it. */
	value: number;
	min: number;
	max?: number;
	/** An arrow key moved it by this many pixels along its axis, positive to
	 *  the right or down. The caller resizes through the limits its drag has. */
	onstep: (delta: number) => void;
}

/** The same strip where nothing can be resized for now: a line between two
 *  parts, and no control. */
interface Fixed extends Shared {
	fixed: true;
	value?: never;
	min?: never;
	max?: never;
	onstep?: never;
}

type Props = Moving | Fixed;

let {
	variant,
	fixed = false,
	value,
	min,
	max,
	onstep,
	...rest
}: Props = $props();

const STEP = 8;

const ORIENTATIONS: Record<SplitterVariant, Orientation> = {
	pane: "horizontal",
	column: "horizontal",
	bar: "vertical",
};

const DIRECTIONS: Record<Orientation, Partial<Record<string, number>>> = {
	horizontal: { ArrowLeft: -1, ArrowRight: 1 },
	vertical: { ArrowUp: -1, ArrowDown: 1 },
};

const VARIANTS: Record<SplitterVariant, string> = {
	pane: "splitter-pane w-1 shrink-0",
	column: "splitter-column absolute inset-y-0 right-0 w-1",
	bar: "splitter-bar h-1 shrink-0",
};

const CURSORS: Record<Orientation, string> = {
	horizontal: "cursor-col-resize",
	vertical: "cursor-row-resize",
};

const FOCUS =
	"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

function wholePixels(size: number | undefined) {
	return size === undefined ? undefined : Math.round(size);
}

function stepOnArrow(event: KeyboardEvent) {
	const direction = DIRECTIONS[ORIENTATIONS[variant]][event.key];
	if (direction === undefined) return;

	event.preventDefault();
	event.stopPropagation();
	onstep?.(direction * STEP);
}
</script>

<!--
	The handle between two things that share a width or a height. Its caller
	starts the drag from the press it passes through, and resizes by the step
	an arrow key reports. The focus ring is drawn inside the strip, since a
	header cell clips whatever leaves it.
-->
{#if fixed}
	<div class={VARIANTS[variant]} {...rest}></div>
{:else}
	<div
		role="slider"
		tabindex="0"
		aria-orientation={ORIENTATIONS[variant]}
		aria-valuenow={wholePixels(value)}
		aria-valuemin={wholePixels(min)}
		aria-valuemax={wholePixels(max)}
		class={[VARIANTS[variant], CURSORS[ORIENTATIONS[variant]], FOCUS]}
		onkeydown={stepOnArrow}
		{...rest}
	></div>
{/if}

<style>
.splitter-pane,
.splitter-column,
.splitter-bar {
	transition: background 0.15s;
}
@media (prefers-reduced-motion: reduce) {
	.splitter-pane,
	.splitter-column,
	.splitter-bar {
		transition: none;
	}
}
.splitter-pane {
	background: linear-gradient(
		to right,
		transparent 1.5px,
		var(--color-border-strong) 1.5px,
		var(--color-border-strong) 2.5px,
		transparent 2.5px
	);
}
.splitter-column {
	background: linear-gradient(
		to right,
		transparent 1.5px,
		var(--color-border) 1.5px,
		var(--color-border) 2.5px,
		transparent 2.5px
	);
}
.splitter-pane[role="slider"]:hover,
.splitter-column[role="slider"]:hover {
	background: linear-gradient(
		to right,
		transparent 1px,
		var(--color-accent) 1px,
		var(--color-accent) 3px,
		transparent 3px
	);
}
.splitter-bar {
	background: linear-gradient(
		to bottom,
		transparent 1px,
		var(--color-border) 1px,
		var(--color-border) 2px,
		transparent 2px
	);
}
</style>

import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	restoreLayout,
	setLayout,
	stubLayout,
} from "../__tests__/helpers/layout-stub";
import { aThread } from "../__tests__/helpers/thread-fixture";
import VirtualizedDiffHost from "./__tests__/VirtualizedDiffHost.svelte";
import { disablePerf, enablePerf, flushPerf, type PerfSink } from "./perf.js";
import type { FileDiff, Thread } from "./types.js";
import type {
	InlineVirtualizedDiff,
	SplitVirtualizedDiff,
} from "./virtualized-diff.svelte.js";

// jsdom reports a zero box for every element, so nothing measures. Every case
// here gives the pane a real box; the shared 900px width makes the metrics
// probe's "i", "W" and "0" runs measure equal, which reports a 9px monospace
// character — the same numbers the view suites lean on.
beforeEach(() => stubLayout({ width: 900, height: 400 }));
afterEach(() => {
	restoreLayout();
	vi.unstubAllGlobals();
});

// One hunk, five lines, widest content 14 columns ("context before"), line
// numbers up to two digits — so gutterChars is 3 and columns[0] is 14.
const modifiedFile: FileDiff = {
	path: "src/main.ts",
	old_path: null,
	status: "Modified",
	is_binary: false,
	hunks: [
		{
			header: "@@ -10,4 +10,4 @@",
			old_start: 10,
			old_lines: 4,
			new_start: 10,
			new_lines: 4,
			lines: [
				{
					origin: "Context",
					content: "context before",
					old_lineno: 10,
					new_lineno: 10,
					spans: [],
				},
				{
					origin: "Add",
					content: "added one",
					old_lineno: null,
					new_lineno: 11,
					spans: [],
				},
				{
					origin: "Delete",
					content: "removed",
					old_lineno: 11,
					new_lineno: null,
					spans: [],
				},
				{
					origin: "Context",
					content: "after",
					old_lineno: 12,
					new_lineno: 12,
					spans: [],
				},
				{
					origin: "Context",
					content: "last",
					old_lineno: 13,
					new_lineno: 13,
					spans: [],
				},
			],
		},
	],
};

/** A thread anchored to line 11's new side, which both row builders attach a
 *  comment row for. */
function anchoredThread(id = "t1"): Thread {
	return aThread({
		id,
		anchor: {
			commit_oid: "abc123",
			file_path: "src/main.ts",
			source: "FullFile",
			side: "New",
			start_line: 11,
			end_line: 11,
		},
	});
}

interface HostProps {
	layout: "inline" | "split";
	fileDiffs: FileDiff[];
	wordWrap: boolean;
	comments?: Thread[];
	list?: { topIndex(): number; anchorTo(index: number): void } | null;
	onready: (vd: InlineVirtualizedDiff | SplitVirtualizedDiff) => void;
}

function mount(overrides: Partial<HostProps> = {}) {
	let vd!: InlineVirtualizedDiff;
	const props: HostProps = {
		layout: "inline",
		fileDiffs: [modifiedFile],
		wordWrap: false,
		onready: (created) => {
			vd = created;
		},
		...overrides,
	};
	const rendered = render(VirtualizedDiffHost, { props });
	return { ...rendered, props, vd };
}

describe("createVirtualizedDiff", () => {
	it("withholds the list until metrics, a pane width and every probed thread height exist", async () => {
		// Every element measures zero-height, so the hidden comment probe cannot
		// report a height — the case the readiness gate exists for.
		stubLayout({ width: 900, height: 0 });
		const { container, rerender, props, vd } = mount({
			comments: [anchoredThread()],
		});

		expect(vd.ready).toBe(false);

		for (const probe of container.querySelectorAll("[data-thread-id]")) {
			setLayout(probe, { height: 80 });
		}
		await rerender(props);

		expect(vd.ready).toBe(true);
		expect(vd.probedHeights.get("t1")).toBe(80);
	});

	it("refuses to wrap on a proportional font", () => {
		// The "W" run measures wider than the "i" run, which is the condition
		// under which character-count arithmetic stops being exact.
		stubLayout({
			width: 900,
			height: 400,
			measure: (el) =>
				el.textContent?.startsWith("W") ? { width: 990 } : undefined,
		});

		const { vd } = mount({ wordWrap: true });

		expect(vd.metrics?.monospace).toBe(false);
		expect(vd.wrapActive).toBe(false);
	});

	it("gives the two layouts different column budgets for the same pane", () => {
		const { vd: inline } = mount({ layout: "inline" });
		const { vd: split } = mount({ layout: "split" });

		// Inline: the full 900px pane less 35px chrome and two 3-char gutters at
		// 9px. Split: half the pane less 28px chrome and one gutter.
		expect(inline.availableColumns).toBe(90);
		expect(split.availableColumns).toBe(43);
	});

	it("reports the gutter width in ch from the model's gutter columns", () => {
		const { vd } = mount();

		expect(vd.gutterW).toBe("3ch");
	});

	it("builds every height from character arithmetic and reports the build as a named observation", async () => {
		const observed: {
			name: string;
			attrs?: Record<string, string | number>;
		}[] = [];
		const sink: PerfSink = {
			async write(lines) {
				for (const line of lines) observed.push(JSON.parse(line));
			},
		};
		enablePerf({ sink, frames: false });

		const { vd } = mount();
		expect(vd.heights).toEqual([18, 18, 18, 18, 18]);

		await flushPerf();
		disablePerf();

		const byName = new Map(observed.map((s) => [s.name, s.attrs]));
		expect(byName.get("diff.rowHeights")).toEqual({ rows: 5, wrap: "false" });
	});

	it("re-probes comment heights when the pane resizes", async () => {
		// Milestone 1's defect: comment rows probed once and never again, so a
		// card that reflowed at a new pane width kept its stale height. The
		// narrower pane is what re-runs the probe effect; the flipped height is
		// how the re-probe becomes observable.
		let reflowed = false;
		const resizes: (() => void)[] = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: () => void) {
					resizes.push(callback);
				}
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
		stubLayout({
			width: 900,
			height: 400,
			measure: (el) =>
				el instanceof HTMLElement && el.dataset.threadId
					? { height: reflowed ? 120 : 80 }
					: undefined,
		});

		const { vd } = mount({ comments: [anchoredThread()] });
		expect(vd.probedHeights.get("t1")).toBe(80);

		setLayout(vd.pane as HTMLElement, { width: 450 });
		reflowed = true;
		for (const resize of resizes) resize();
		await tick();

		expect(vd.probedHeights.get("t1")).toBe(120);
	});

	it("expresses the content width in pixels, never ch", () => {
		// Milestone 1's other defect: a width in ch on a div outside the rows
		// resolves against the app's proportional font, not the diff row's.
		const { vd: inline } = mount();
		// Three gutter columns twice plus 14 content columns at 9px, plus 35px
		// of padding, border and gutter gaps.
		expect(inline.contentWidth).toBe("215px");
		expect(inline.contentWidth).not.toContain("ch");

		const { vd: split } = mount({ layout: "split" });
		expect(split.contentWidth).toMatch(/^calc\(\d+px \+ 50cqi\)$/);
	});

	it("gives each side its own pan ceiling from that side's full width", () => {
		// One pair row: a 27-column deleted line against a 5-column added one,
		// with a single-digit line number, so gutterChars is 2.
		const asymmetric: FileDiff = {
			path: "src/asym.ts",
			old_path: null,
			status: "Modified",
			is_binary: false,
			hunks: [
				{
					header: "@@ -1,1 +1,1 @@",
					old_start: 1,
					old_lines: 1,
					new_start: 1,
					new_lines: 1,
					lines: [
						{
							origin: "Delete",
							content: "a-deleted-line-that-is-long",
							old_lineno: 1,
							new_lineno: null,
							spans: [],
						},
						{
							origin: "Add",
							content: "short",
							old_lineno: null,
							new_lineno: 1,
							spans: [],
						},
					],
				},
			],
		};

		const { vd } = mount({ layout: "split", fileDiffs: [asymmetric] });
		const split = vd as SplitVirtualizedDiff;

		// Each ceiling is that side's gutter plus its widest content at 9px,
		// plus the half's 28px chrome — the full width the pan must reach.
		expect(split.maxLeftPx).toBe((2 + 27) * 9 + 28);
		expect(split.maxRightPx).toBe((2 + 5) * 9 + 28);
		expect(split.contentWidth).toBe(`calc(${(2 + 27) * 9 + 28}px + 50cqi)`);
	});

	it("re-anchors the list after a resize only when wrap is active", async () => {
		const resizes: (() => void)[] = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: () => void) {
					resizes.push(callback);
				}
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);

		const wrapped = { topIndex: () => 7, anchorTo: vi.fn() };
		mount({ wordWrap: true, list: wrapped });
		const unwrapped = { topIndex: () => 7, anchorTo: vi.fn() };
		mount({ wordWrap: false, list: unwrapped });

		for (const resize of resizes) resize();
		await tick();
		await tick();

		expect(wrapped.anchorTo).toHaveBeenCalledWith(7);
		expect(unwrapped.anchorTo).not.toHaveBeenCalled();
	});
});

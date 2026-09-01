import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	restoreLayout,
	setLayout,
	stubLayout,
} from "../../__tests__/helpers/layout-stub";
import { aThread } from "../../__tests__/helpers/thread-fixture";
import {
	disablePerf,
	enablePerf,
	flushPerf,
	type PerfSink,
} from "../../lib/perf.js";
import type { FileDiff } from "../../lib/types.js";
import FullFileView from "./FullFileView.svelte";

// jsdom reports a zero-height viewport, which renders no rows at all through a
// virtual list. Every case here needs a pane with a real box.
beforeEach(() => stubLayout({ width: 900, height: 400 }));
afterEach(restoreLayout);

// FullFileView renders the flat full-file line list and owns net-new contiguous
// click + shift-click selection state. It never calls IPC — it only bubbles the
// selected flat indices up via oncommentfullfile. No safeInvoke mock needed.

// A Modified file at a commit: context + add lines on the new side, plus one
// Delete line (new_lineno=null) that must NOT be a valid selection endpoint.
const modifiedFile: FileDiff = {
	path: "src/main.ts",
	old_path: null,
	status: "Modified",
	is_binary: false,
	hunks: [
		{
			header: "@@ -10,3 +10,4 @@",
			old_start: 10,
			old_lines: 3,
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
					origin: "Add",
					content: "added two",
					old_lineno: null,
					new_lineno: 12,
					spans: [],
				},
				{
					origin: "Delete",
					content: "removed one",
					old_lineno: 11,
					new_lineno: null,
					spans: [],
				},
				{
					origin: "Add",
					content: "added three",
					old_lineno: null,
					new_lineno: 13,
					spans: [],
				},
			],
		},
	],
};

const emptyFile: FileDiff = {
	path: "src/empty.ts",
	old_path: null,
	status: "Unknown",
	is_binary: false,
	hunks: [],
};

function defaultProps(overrides: Record<string, unknown> = {}) {
	return {
		fileDiffs: [modifiedFile],
		showInvisibles: false,
		wordWrap: false,
		commitOid: "abc123",
		repoPath: "/repo",
		diffKind: "commit" as const,
		isMerge: false,
		oncommentfullfile: vi.fn(),
		...overrides,
	};
}

// Selection now arms from the line-number gutter grip (which carries
// role="button"), not the code content. Query the grip via the line's content.
// mouseenter does not bubble, so fire it on the row div that carries the
// handler, not the content span getByText returns.
function lineRow(text: string): HTMLElement {
	const row = screen.getByText(text).closest(".diff-line");
	if (!row) throw new Error(`no diff line for "${text}"`);
	return row as HTMLElement;
}

function gutterGrip(text: string): HTMLElement {
	const grip = screen
		.getByText(text)
		.closest(".diff-line")
		?.querySelector(".gutter-grip") as HTMLElement | null;
	if (!grip) throw new Error(`no gutter grip for "${text}"`);
	return grip;
}

describe("FullFileView", () => {
	it("V5: an empty/zero-hunk file renders no Comment affordance and never throws", () => {
		expect(() =>
			render(FullFileView, {
				props: defaultProps({ fileDiffs: [emptyFile] }),
			}),
		).not.toThrow();

		expect(screen.queryByRole("button", { name: /comment/i })).toBeNull();
	});

	it("V6: a click sets a single-line selection and the affordance reports count 1", async () => {
		render(FullFileView, { props: defaultProps() });

		// No selection yet -> no affordance.
		expect(screen.queryByRole("button", { name: /comment/i })).toBeNull();

		await fireEvent.click(gutterGrip("added one"));
		await tick();

		expect(screen.getByRole("button", { name: /comment \(1\)/i })).toBeTruthy();
	});

	it("V6: shift-click extends a contiguous span and bubbles the flat indices", async () => {
		const oncommentfullfile = vi.fn();
		render(FullFileView, { props: defaultProps({ oncommentfullfile }) });

		await fireEvent.click(gutterGrip("added one")); // flat index 1
		await tick();
		// Shift-click "added three" (flat index 4); the contiguous span is 1..4.
		await fireEvent.click(gutterGrip("added three"), { shiftKey: true });
		await tick();

		const affordance = screen.getByRole("button", { name: /comment/i });
		await fireEvent.click(affordance);

		expect(oncommentfullfile).toHaveBeenCalledTimes(1);
		const [filePath, indices] = oncommentfullfile.mock.calls[0];
		expect(filePath).toBe("src/main.ts");
		// Indices are the flat line-list positions of the contiguous span (1..4).
		const sorted = Array.from(indices as Set<number>).sort((a, b) => a - b);
		expect(sorted).toEqual([1, 2, 3, 4]);
	});

	it("selects the span between the pressed row and the row the pointer reaches", async () => {
		const oncommentfullfile = vi.fn();
		render(FullFileView, {
			props: defaultProps({ oncommentfullfile }),
		});

		await fireEvent.mouseDown(gutterGrip("added one"));
		await tick();
		await fireEvent.mouseEnter(lineRow("added three"), {
			buttons: 1,
		});
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: /comment/i }));

		const indices = oncommentfullfile.mock.calls[0][1] as Set<number>;
		expect(Array.from(indices).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
	});

	it("leaves the span alone when the pointer crosses a row with no button held", async () => {
		render(FullFileView, { props: defaultProps() });

		await fireEvent.mouseDown(gutterGrip("added one"));
		await tick();
		await fireEvent.mouseEnter(lineRow("added three"), {
			buttons: 0,
		});
		await tick();

		expect(screen.getByRole("button", { name: /comment \(1\)/i })).toBeTruthy();
	});

	it("stops extending the span once the button is released", async () => {
		render(FullFileView, { props: defaultProps() });

		await fireEvent.mouseDown(gutterGrip("added one"));
		await tick();
		await fireEvent.mouseUp(window);
		await fireEvent.mouseEnter(lineRow("added three"), {
			buttons: 1,
		});
		await tick();

		expect(screen.getByRole("button", { name: /comment \(1\)/i })).toBeTruthy();
	});

	it("keeps the webview from starting its own text selection on a gutter press", async () => {
		render(FullFileView, { props: defaultProps() });

		const press = new MouseEvent("mousedown", {
			bubbles: true,
			cancelable: true,
		});
		gutterGrip("added one").dispatchEvent(press);

		expect(press.defaultPrevented).toBe(true);
	});

	it("V6/D-02: a Delete line (new_lineno=null) is not selectable and not an endpoint", async () => {
		render(FullFileView, { props: defaultProps() });

		// The Delete line renders, but is not a selectable row (no role="button").
		const deleteContent = screen.getByText("removed one");
		expect(deleteContent.closest('[role="button"]')).toBeNull();

		// Clicking its row directly must not open a selection / affordance.
		const deleteRow = deleteContent.closest(".diff-line") as HTMLElement;
		await fireEvent.click(deleteRow);
		await tick();

		expect(screen.queryByRole("button", { name: /comment/i })).toBeNull();
	});

	it("V10/L-05: with isMerge=true the Comment affordance is present and NOT disabled", async () => {
		render(FullFileView, { props: defaultProps({ isMerge: true }) });

		await fireEvent.click(gutterGrip("added one"));
		await tick();

		const affordance = screen.getByRole("button", {
			name: /comment/i,
		}) as HTMLButtonElement;
		expect(affordance).toBeTruthy();
		expect(affordance.disabled).toBe(false);
	});

	it("withholds the list until every comment row has a measured height", async () => {
		// Every element measures zero, so the hidden comment probe cannot report a
		// height — the case invariant 8 exists for.
		stubLayout({ width: 900, height: 0, replace: true });
		const commented = aThread({
			id: "t1",
			anchor: {
				commit_oid: "abc123",
				file_path: "src/main.ts",
				source: "FullFile",
				side: "New",
				start_line: 11,
				end_line: 11,
			},
		});
		const props = defaultProps({ viewComments: [commented] });
		const { container, rerender } = render(FullFileView, { props });

		expect(container.querySelectorAll(".exact-virtual-viewport").length).toBe(
			0,
		);

		for (const probe of container.querySelectorAll("[data-thread-id]")) {
			setLayout(probe, { height: 80 });
		}
		await rerender(props);

		expect(container.querySelectorAll(".exact-virtual-viewport").length).toBe(
			1,
		);
	});

	it("sizes the content from the column arithmetic plus the row chrome", () => {
		const { container } = render(FullFileView, { props: defaultProps() });

		// Three gutter columns for line 13 plus one, twice, and 14 columns for
		// "context before", at the measured 9px per column, plus 35px of padding,
		// border and gutter gaps.
		const content = container.querySelector(".exact-virtual-content");
		expect(content?.getAttribute("style")).toContain("width: 215px");
	});

	it("gives the content the pane's own width when rows wrap", () => {
		const { container } = render(FullFileView, {
			props: defaultProps({ wordWrap: true }),
		});

		const content = container.querySelector(".exact-virtual-content");
		expect(content?.getAttribute("style")).toContain("width: 100%");
	});

	it("renders rows unwrapped when the diff font is not fixed-pitch", () => {
		// measureRowMetrics compares a run of "i" against a run of "W"; different
		// widths mean the font advances per glyph, so column arithmetic — and with
		// it every wrapped row's height — stops being derivable.
		stubLayout({
			replace: true,
			width: 900,
			height: 400,
			measure: (el) =>
				el.textContent?.startsWith("W") ? { width: 1200 } : undefined,
		});

		const { container } = render(FullFileView, {
			props: defaultProps({ wordWrap: true }),
		});

		const row = container.querySelector(".diff-line:not(.metrics-probe)");
		expect(row?.getAttribute("style")).toContain("white-space: pre;");
	});

	it("breaks a wrapped row at the column limit rather than at a space", () => {
		const { container } = render(FullFileView, {
			props: defaultProps({ wordWrap: true }),
		});

		const row = container.querySelector(".diff-line:not(.metrics-probe)");
		const style = row?.getAttribute("style") ?? "";

		expect(style).toContain("white-space: pre-wrap;");
		expect(style).toContain("word-break: break-all;");
	});

	it("leaves word breaking alone when rows do not wrap", () => {
		const { container } = render(FullFileView, { props: defaultProps() });

		const row = container.querySelector(".diff-line:not(.metrics-probe)");

		expect(row?.getAttribute("style")).toContain("word-break: normal;");
	});

	it("recomputes wrapped heights and holds the reader's place when the pane narrows", async () => {
		// jsdom's ResizeObserver is a no-op, so the pane never reports a new width.
		// This fake hands the test the callback the component registered.
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
		stubLayout({ width: 900, height: 400, replace: true });
		const wide: FileDiff = {
			path: "src/wide.ts",
			old_path: null,
			status: "Modified",
			is_binary: false,
			hunks: [
				{
					header: "@@ -1,10 +1,10 @@",
					old_start: 1,
					old_lines: 10,
					new_start: 1,
					new_lines: 10,
					lines: Array.from({ length: 10 }, (_, index) => ({
						origin: "Context" as const,
						content: "x".repeat(180),
						old_lineno: index + 1,
						new_lineno: index + 1,
						spans: [],
					})),
				},
			],
		};

		const { container } = render(FullFileView, {
			props: defaultProps({ fileDiffs: [wide], wordWrap: true }),
		});
		const viewport = container.querySelector(
			".exact-virtual-viewport",
		) as HTMLElement;
		const content = container.querySelector(
			".exact-virtual-content",
		) as HTMLElement;

		// 9px per character over a 900px pane leaves 90 columns, so 180 columns is
		// two 18px lines; row 5 therefore starts at 180px.
		expect(content.getAttribute("style")).toContain("height: 360px");
		viewport.scrollTop = 180;
		viewport.dispatchEvent(new Event("scroll"));
		await tick();

		setLayout(container.querySelector(".list-area") as HTMLElement, {
			width: 450,
		});
		for (const resize of resizes) resize();
		await tick();
		await tick();

		// 40 columns now, so 180 columns is five lines and row 5 starts at 450px.
		expect(content.getAttribute("style")).toContain("height: 900px");
		expect(viewport.scrollTop).toBe(450);

		vi.unstubAllGlobals();
	});

	it("spans a selection across rows that were unmounted while scrolling", async () => {
		const oncommentfullfile = vi.fn();
		const lines = Array.from({ length: 3000 }, (_, index) => ({
			origin: "Context" as const,
			content: `line ${index}`,
			old_lineno: index + 1,
			new_lineno: index + 1,
			spans: [],
		}));
		const long: FileDiff = {
			path: "src/long.ts",
			old_path: null,
			status: "Modified",
			is_binary: false,
			hunks: [
				{
					header: "@@ -1,3000 +1,3000 @@",
					old_start: 1,
					old_lines: 3000,
					new_start: 1,
					new_lines: 3000,
					lines,
				},
			],
		};
		const { container } = render(FullFileView, {
			props: defaultProps({ fileDiffs: [long], oncommentfullfile }),
		});

		await fireEvent.click(gutterGrip("line 10"));
		await tick();

		const viewport = container.querySelector(
			".exact-virtual-viewport",
		) as HTMLElement;
		viewport.scrollTop = 2500 * 18;
		viewport.dispatchEvent(new Event("scroll"));
		await tick();
		expect(screen.queryAllByText("line 10").length).toBe(0);

		await fireEvent.click(gutterGrip("line 2500"), { shiftKey: true });
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: /comment/i }));

		const indices = oncommentfullfile.mock.calls[0][1] as Set<number>;
		expect(indices.size).toBe(2491);
		expect(indices.has(10) && indices.has(2500)).toBe(true);
	});

	it("drags a span across rows the list never mounted", async () => {
		const oncommentfullfile = vi.fn();
		const lines = Array.from({ length: 3000 }, (_, index) => ({
			origin: "Add" as const,
			content: `line ${index}`,
			old_lineno: null,
			new_lineno: index + 1,
			spans: [],
		}));
		const long: FileDiff = {
			path: "src/long.ts",
			old_path: null,
			status: "Modified",
			is_binary: false,
			hunks: [
				{
					header: "@@ -1,3000 +1,3000 @@",
					old_start: 1,
					old_lines: 3000,
					new_start: 1,
					new_lines: 3000,
					lines,
				},
			],
		};
		const { container } = render(FullFileView, {
			props: defaultProps({ fileDiffs: [long], oncommentfullfile }),
		});

		await fireEvent.mouseDown(gutterGrip("line 10"));
		await tick();

		const viewport = container.querySelector(
			".exact-virtual-viewport",
		) as HTMLElement;
		viewport.scrollTop = 2500 * 18;
		viewport.dispatchEvent(new Event("scroll"));
		await tick();
		expect(screen.queryAllByText("line 10").length).toBe(0);

		await fireEvent.mouseEnter(lineRow("line 2500"), {
			buttons: 1,
		});
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: /comment/i }));

		const indices = oncommentfullfile.mock.calls[0][1] as Set<number>;
		expect(indices.size).toBe(2491);
		expect(indices.has(10) && indices.has(2500)).toBe(true);
	});

	it("re-measures comment rows when the pane width changes", async () => {
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
		const commented = aThread({
			id: "t1",
			anchor: {
				commit_oid: "abc123",
				file_path: "src/main.ts",
				source: "FullFile",
				side: "New",
				start_line: 11,
				end_line: 11,
			},
		});
		const { container } = render(FullFileView, {
			props: defaultProps({ viewComments: [commented] }),
		});
		const content = container.querySelector(
			".exact-virtual-content",
		) as HTMLElement;
		const before = content.getAttribute("style") ?? "";

		// A narrower pane reflows the card taller; the stale height would leave
		// the rows below it overlapping.
		for (const probe of container.querySelectorAll("[data-thread-id]")) {
			setLayout(probe, { height: 900 });
		}
		setLayout(container.querySelector(".list-area") as HTMLElement, {
			width: 450,
		});
		for (const resize of resizes) resize();
		await tick();

		expect(before).toContain("height: 490px");
		expect(content.getAttribute("style")).toContain("height: 990px");

		vi.unstubAllGlobals();
	});

	it("reports the row build and the height build as named observations", async () => {
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

		render(FullFileView, { props: defaultProps() });
		await flushPerf();
		disablePerf();

		const byName = new Map(observed.map((s) => [s.name, s.attrs]));
		expect(byName.get("diff.buildRows")).toEqual({ lines: 5 });
		expect(byName.get("diff.rowHeights")).toEqual({ rows: 5, wrap: "false" });
	});

	it("keeps the Comment affordance outside the scrolling list", async () => {
		const { container } = render(FullFileView, { props: defaultProps() });

		await fireEvent.click(gutterGrip("added one"));
		await tick();

		const affordance = screen.getByRole("button", { name: /comment \(1\)/i });
		const row = container.querySelector(".diff-line");

		expect(row?.closest(".exact-virtual-viewport")).toBeTruthy();
		expect(affordance.closest(".exact-virtual-viewport")).toBeNull();
	});

	it("mounts a bounded number of rows for a file far larger than the viewport", () => {
		const lines = Array.from({ length: 5000 }, (_, index) => ({
			origin: "Context" as const,
			content: `line ${index}`,
			old_lineno: index + 1,
			new_lineno: index + 1,
			spans: [],
		}));
		const huge: FileDiff = {
			path: "src/huge.ts",
			old_path: null,
			status: "Modified",
			is_binary: false,
			hunks: [
				{
					header: "@@ -1,5000 +1,5000 @@",
					old_start: 1,
					old_lines: 5000,
					new_start: 1,
					new_lines: 5000,
					lines,
				},
			],
		};

		const { container } = render(FullFileView, {
			props: defaultProps({ fileDiffs: [huge] }),
		});

		expect(container.querySelectorAll(".diff-line").length).toBeLessThan(200);
	});

	it("WHSP: with invisibles on, the selectable text is the real whitespace and the glyph is presentational", () => {
		const wsFile: FileDiff = {
			path: "src/ws.ts",
			old_path: null,
			status: "Modified",
			is_binary: false,
			hunks: [
				{
					header: "@@ -1,0 +1,1 @@",
					old_start: 1,
					old_lines: 0,
					new_start: 1,
					new_lines: 1,
					lines: [
						{
							origin: "Add",
							content: "\t x",
							old_lineno: null,
							new_lineno: 1,
							spans: [],
						},
					],
				},
			],
		};
		const { container } = render(FullFileView, {
			props: defaultProps({ fileDiffs: [wsFile], showInvisibles: true }),
		});

		const invisible = container.querySelector(".invisible-char") as HTMLElement;
		// Copy fidelity: the text node holds the real tab+space, never the glyph.
		expect(invisible.textContent).toBe("\t ");
		// The ·/→ substitution is exposed only as a presentation glyph.
		expect(invisible.getAttribute("data-glyph")).toBe("→·");
	});
});

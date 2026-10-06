import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreLayout, stubLayout } from "../../__tests__/helpers/layout-stub";
import { aThread } from "../../__tests__/helpers/thread-fixture.js";
import { describeThreadedCommentActions } from "../../__tests__/helpers/threaded-comment-actions.js";
import { safeInvoke } from "../../lib/invoke.js";
import type { DiffLine, FileDiff } from "../../lib/types.js";
import SplitView from "./SplitView.svelte";

// Command-aware safeInvoke dispatcher, matching ReviewPanel.test.ts's pattern:
// the threaded comment actions route through safeInvoke via
// review-comment-actions.ts, so asserting on it exercises the real wiring
// instead of a mock on a module this project owns.
vi.mock("../../lib/invoke.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/invoke.js")>(
		"../../lib/invoke.js",
	);
	return { ...actual, safeInvoke: vi.fn() };
});

// jsdom reports a zero-height viewport, which renders no rows at all through a
// virtual list. Every case here needs a pane with a real box.
beforeEach(() => stubLayout({ width: 900, height: 400 }));
afterEach(restoreLayout);

function contextLines(count: number, from = 1): DiffLine[] {
	return Array.from({ length: count }, (_, index) => ({
		origin: "Context" as const,
		content: `line ${from + index}`,
		old_lineno: from + index,
		new_lineno: from + index,
		spans: [],
	}));
}

function fileOf(path: string, lines: DiffLine[]): FileDiff {
	return {
		path,
		old_path: null,
		status: "Modified",
		is_binary: false,
		hunks: [
			{
				header: `@@ -1,${lines.length} +1,${lines.length} @@`,
				old_start: 1,
				old_lines: lines.length,
				new_start: 1,
				new_lines: lines.length,
				lines,
			},
		],
	};
}

// Two deletes facing one add: the pairing leaves the second delete opposite a
// phantom, which is the row shape both halves have to survive.
const lopsided = fileOf("src/main.ts", [
	{
		origin: "Context",
		content: "context before",
		old_lineno: 10,
		new_lineno: 10,
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
		origin: "Delete",
		content: "removed two",
		old_lineno: 12,
		new_lineno: null,
		spans: [],
	},
	{
		origin: "Add",
		content: "added one",
		old_lineno: null,
		new_lineno: 11,
		spans: [],
	},
]);

function defaultProps(overrides: Record<string, unknown> = {}) {
	return {
		contentMode: "hunk" as const,
		fileDiffs: [lopsided],
		selectedPath: "src/main.ts",
		diffKind: "unstaged" as const,
		hunkOperationInFlight: false,
		ignoreWhitespace: false,
		showInvisibles: false,
		wordWrap: false,
		selectedHunkKey: null,
		selectedLineIndices: new Set<number>(),
		selectedCount: 0,
		isMerge: false,
		collapsedFiles: new Set<string>(),
		onfilecollapsetoggle: vi.fn(),
		onlineclick: vi.fn(),
		onlinemousedown: vi.fn(),
		onstagehunk: vi.fn(),
		onunstagehunk: vi.fn(),
		ondiscardhunk: vi.fn(),
		onstagelines: vi.fn(),
		onunstagelines: vi.fn(),
		ondiscardlines: vi.fn(),
		oncommentlines: vi.fn(),
		oncommenthunk: vi.fn(),
		repoPath: "/repo",
		reviewCommentsVisible: true,
		viewComments: [],
		...overrides,
	};
}

function scrollTo(container: Element, top: number): void {
	const viewport = container.querySelector(
		".exact-virtual-viewport",
	) as HTMLElement;
	viewport.scrollTop = top;
	viewport.dispatchEvent(new Event("scroll"));
}

describe("SplitView", () => {
	it("paints each hunk action in the tone its meaning carries", () => {
		render(SplitView, { props: defaultProps() });

		expect(screen.getByRole("button", { name: "Comment" })).toHaveClass(
			"bg-accent-bg",
		);
		expect(screen.getByRole("button", { name: "Discard Hunk" })).toHaveClass(
			"bg-danger-bg",
		);
		expect(screen.getByRole("button", { name: "Stage Hunk" })).toHaveClass(
			"bg-success-bg",
		);
	});

	it("paints the unstage action in the warning tone", () => {
		render(SplitView, { props: defaultProps({ diffKind: "staged" }) });

		expect(screen.getByRole("button", { name: "Unstage Hunk" })).toHaveClass(
			"bg-warning-bg",
		);
	});

	it("hides whole-hunk and selected-line comment actions under Hide all", async () => {
		const hidden = { reviewFilter: "none" as const };
		const view = render(SplitView, { props: defaultProps(hidden) });

		expect(screen.queryByRole("button", { name: /^Comment/ })).toBeNull();

		await view.rerender(
			defaultProps({
				...hidden,
				selectedHunkKey: "src/main.ts-0",
				selectedLineIndices: new Set([0]),
				selectedCount: 1,
			}),
		);

		expect(screen.queryByRole("button", { name: /^Comment/ })).toBeNull();
	});

	it("mounts a bounded number of pair rows for a file far larger than the viewport", () => {
		const { container } = render(SplitView, {
			props: defaultProps({
				fileDiffs: [fileOf("src/huge.ts", contextLines(5000))],
			}),
		});

		const rows = container.querySelectorAll(".split-row");

		expect(rows.length).toBeGreaterThan(0);
		expect(rows.length).toBeLessThan(200);
	});

	it("renders both halves of every row, phantom included", () => {
		const { container } = render(SplitView, { props: defaultProps() });

		const cellCounts = Array.from(
			container.querySelectorAll(".split-row"),
			(row) => row.querySelectorAll(".split-cell").length,
		);

		expect(cellCounts).toEqual([2, 2, 2]);
	});

	it("tints the empty half of a phantom pair", () => {
		const { container } = render(SplitView, { props: defaultProps() });

		expect(container.querySelectorAll(".split-phantom").length).toBe(1);
	});

	it("reports the row a gutter press landed on after the reader scrolled to it", async () => {
		const onlinemousedown = vi.fn();
		const lines = contextLines(3000).map((line, index) =>
			index === 2500
				? { ...line, origin: "Add" as const, old_lineno: null }
				: line,
		);
		const { container } = render(SplitView, {
			props: defaultProps({
				fileDiffs: [fileOf("src/long.ts", lines)],
				onlinemousedown,
			}),
		});

		scrollTo(container, 2500 * 18);
		await tick();

		const gutter = screen
			.getByText("line 2501")
			.closest(".split-cell")
			?.querySelector("[data-gutter-grip]") as HTMLElement;
		await fireEvent.mouseDown(gutter);

		expect(onlinemousedown.mock.calls[0].slice(0, 4)).toEqual([
			"src/long.ts",
			0,
			2500,
			"Add",
		]);
	});
});

describe("SplitView panning", () => {
	it("pins each pair row against the pan, one viewport wide", () => {
		const { container } = render(SplitView, { props: defaultProps() });

		const row = container.querySelector(".split-row");

		expect(row).toHaveStyle("position: sticky; left: 0; width: 100cqi");
	});

	it("clamps each half's translation against that side's own ceiling", () => {
		const { container } = render(SplitView, { props: defaultProps() });

		const pans = Array.from(
			container.querySelector(".split-row")?.querySelectorAll(".split-pan") ??
				[],
			// The formatter breaks the long calc across lines, which the engine
			// reads the same as one line, so the line breaks are folded before comparing.
			(el) => getComputedStyle(el).transform.replace(/\s*\n\s*/g, ""),
		);

		expect(pans[0]).toBe(
			"translateX(calc(-1 * min(var(--pan-x, 0px), max(0px, var(--max-l) - 50cqi))))",
		);
		expect(pans[1]).toBe(
			"translateX(calc(-1 * min(var(--pan-x, 0px), max(0px, var(--max-r) - 50cqi))))",
		);
	});

	it("translates inside the clipping window rather than translating the window", () => {
		const { container } = render(SplitView, { props: defaultProps() });

		const windows = [...container.querySelectorAll(".split-window")];

		expect(windows.length).toBeGreaterThan(0);
		for (const window of windows) {
			// Transforming the clipper moves its clip box too, which slides the
			// whole half out of the cell instead of panning the code within it.
			expect(getComputedStyle(window).transform).not.toContain("translateX");
			expect(window.querySelector(".split-pan")).not.toBeNull();
		}
	});

	it("publishes each side's full width, gutter and chrome included, as its ceiling", () => {
		// The layout stub gives the 100-character metrics probe a 900px box.
		const CHAR_WIDTH = 9;
		// "12" is the largest line number in the fixture, plus one.
		const GUTTER_CHARS = 3;
		// "context before", the widest content on either side.
		const WIDEST = 14;
		// One half's padding, accent border, gutter gap and divider.
		const CHROME = 28;
		const expected = (GUTTER_CHARS + WIDEST) * CHAR_WIDTH + CHROME;

		const { container } = render(SplitView, { props: defaultProps() });

		const style = container
			.querySelector(".split-view")
			?.getAttribute("style") as string;

		expect(style).toContain(`--max-l: ${expected}px`);
		expect(style).toContain(`--max-r: ${expected}px`);
		// The gutter sits outside the translated window, so a ceiling built from
		// text columns alone would stop short of the widest line's tail.
		expect(expected).toBeGreaterThan(WIDEST * CHAR_WIDTH + CHROME);
	});

	it("clips each half's window, so panned code cannot cross the pinned gutter", () => {
		const { container } = render(SplitView, { props: defaultProps() });

		const windows = [...container.querySelectorAll(".split-window")];

		expect(windows.length).toBeGreaterThan(0);
		for (const window of windows) {
			// The cell's own clip stops at the cell box, which the gutter sits
			// inside: without a clip on the window, content translated left paints
			// across the line numbers (doc-38 §4's "clipped window").
			expect(window).toHaveClass("overflow-clip");
		}
	});

	it("leaves the line-number gutters out of the translated window", () => {
		const { container } = render(SplitView, { props: defaultProps() });

		const gutters = Array.from(container.querySelectorAll(".split-gutter"));

		expect(gutters.length).toBeGreaterThan(0);
		for (const gutter of gutters) {
			expect(getComputedStyle(gutter).transform).not.toContain("translateX");
			expect(gutter.closest(".split-pan")).toBeNull();
		}
	});
});

describe("SplitView row shapes", () => {
	it("breaks a wrapped half mid-word, and leaves an unwrapped one alone", () => {
		const wrapped = render(SplitView, {
			props: defaultProps({ wordWrap: true }),
		});
		const unwrapped = render(SplitView, {
			props: defaultProps({ wordWrap: false }),
		});

		const contentOf = (root: Element) =>
			root.querySelector(".diff-line-content");

		expect(contentOf(wrapped.container)).toHaveClass(
			"break-all",
			"whitespace-pre-wrap",
		);
		expect(contentOf(unwrapped.container)).toHaveClass(
			"break-normal",
			"whitespace-pre",
		);
		expect(contentOf(unwrapped.container)).not.toHaveClass(
			"whitespace-pre-wrap",
		);
	});

	it("sizes the panned content to its text only when there is a pan", () => {
		const unwrapped = render(SplitView, {
			props: defaultProps({ wordWrap: false }),
		});
		const wrapped = render(SplitView, {
			props: defaultProps({ wordWrap: true }),
		});

		const panOf = (root: Element) => root.querySelector(".split-pan");

		expect(panOf(unwrapped.container)).toHaveClass("w-max");
		// A wrapped half has nothing to pan, and max-content there would let the
		// line run past the window instead of wrapping into the height
		// `rowHeights` predicted for it.
		expect(panOf(wrapped.container)).toHaveClass("w-full");
		expect(panOf(wrapped.container)).not.toHaveClass("w-max");
	});

	it("takes the hunk-header row's height from the declared token", () => {
		const { container } = render(SplitView, { props: defaultProps() });

		const header = container.querySelector(".split-hunk-header") as Element;

		expect(getComputedStyle(header).height).toBe(
			"var(--diff-hunk-header-height)",
		);
		expect(
			container.querySelector(".split-view")?.getAttribute("style"),
		).toContain("--diff-hunk-header-height:");
	});

	it("renders a comment row full width between its pair row and the next", () => {
		const { container } = render(SplitView, {
			props: defaultProps({
				viewComments: [
					aThread({
						id: "t1",
						review_id: "r1",
						text: "a note",
						anchor: {
							commit_oid: "oid",
							file_path: "src/main.ts",
							source: "FullFile",
							side: "New",
							start_line: 11,
							end_line: 11,
						},
					}),
				],
			}),
		});

		const rows = Array.from(
			container.querySelectorAll(".exact-virtual-rows > *"),
		);
		const commentIndex = rows.findIndex((row) =>
			row.classList.contains("split-comment-row"),
		);

		expect(commentIndex).toBeGreaterThan(0);
		expect(rows[commentIndex - 1].classList.contains("split-row")).toBe(true);
		expect(rows[commentIndex]).toHaveStyle("width: 100cqi");
	});

	it("renders a binary file's notice as one full-width row", () => {
		const { container } = render(SplitView, {
			props: defaultProps({
				selectedPath: null,
				fileDiffs: [
					{
						path: "assets/logo.png",
						status: "Modified" as const,
						is_binary: true,
						hunks: [],
					},
				],
			}),
		});

		const binary = container.querySelector(".binary-row");

		expect(binary?.textContent).toContain("Binary file");
		expect(binary).toHaveStyle("width: 100cqi");
		expect(container.querySelectorAll(".split-row").length).toBe(0);
	});
});

describe("threaded comment actions", () => {
	describeThreadedCommentActions(
		SplitView,
		defaultProps,
		".split-comment-row",
		safeInvoke,
	);
});

describe("SplitView gutter grip", () => {
	it("names the line it selects", () => {
		render(SplitView, { props: defaultProps() });

		const grip = screen
			.getByText("added one")
			.closest(".split-cell")
			?.querySelector("[data-gutter-grip]");

		expect(grip).toHaveAccessibleName("Select added line 11");
	});
});

describe("SplitView thread marker", () => {
	function threadOn(id: string, side: "Old" | "New", line: number) {
		return aThread({
			id,
			anchor: {
				commit_oid: "abc123",
				file_path: "src/main.ts",
				source: "FullFile",
				side,
				start_line: line,
				end_line: line,
			},
		});
	}

	function markerOn(text: string): Element | null | undefined {
		return screen
			.getByText(text)
			.closest(".diff-line")
			?.querySelector(".thread-marker");
	}

	function markerCellOn(text: string): Element | null | undefined {
		return screen
			.getByText(text)
			.closest(".diff-line")
			?.querySelector(".thread-marker-cell");
	}

	it("counts each side's threads in that side's gutter", () => {
		render(SplitView, {
			props: defaultProps({
				viewComments: [
					threadOn("tNew", "New", 11),
					threadOn("tOld", "Old", 12),
				],
			}),
		});

		expect(markerOn("added one")).toHaveTextContent("1");
		expect(markerOn("removed two")).toHaveTextContent("1");
		expect(markerOn("removed one")).toBeNull();
	});

	it("keeps the empty column on a line no thread hangs on, so the code stays aligned", () => {
		render(SplitView, {
			props: defaultProps({
				viewComments: [threadOn("tNew", "New", 11)],
			}),
		});

		expect(markerCellOn("removed one")).not.toBeNull();
	});

	it("reserves no marker column when no thread hangs in view", () => {
		const { container } = render(SplitView, { props: defaultProps() });

		expect(container.querySelector(".thread-marker-cell")).toBeNull();
	});
});

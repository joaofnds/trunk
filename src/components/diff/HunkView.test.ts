import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreLayout, stubLayout } from "../../__tests__/helpers/layout-stub";
import { commentingLeaf } from "../../__tests__/helpers/review-props.js";
import { aThread } from "../../__tests__/helpers/thread-fixture.js";
import { describeThreadedCommentActions } from "../../__tests__/helpers/threaded-comment-actions.js";
import { safeInvoke } from "../../lib/invoke.js";
import {
	disablePerf,
	enablePerf,
	flushPerf,
	type PerfSink,
} from "../../lib/perf.js";
import type { DiffLine, FileDiff } from "../../lib/types.js";
import HunkView from "./HunkView.svelte";

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

const oneHunk = fileOf("src/main.ts", [
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
]);

function defaultProps(overrides: Record<string, unknown> = {}) {
	return {
		...commentingLeaf,
		fileDiffs: [oneHunk],
		selectedPath: "src/main.ts",
		diffKind: "unstaged" as const,
		hunkOperationInFlight: false,
		ignoreWhitespace: false,
		showInvisibles: false,
		wordWrap: false,
		selectedHunkKey: null,
		selectedLineIndices: new Set<number>(),
		selectedCount: 0,
		selectedChangeCount: 0,
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
		selectionComment: null,
		oncommentselection: vi.fn(),
		repoPath: "/repo",
		takesComments: true,
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

describe("HunkView", () => {
	it("paints each hunk action in the tone its meaning carries", () => {
		render(HunkView, { props: defaultProps() });

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
		render(HunkView, { props: defaultProps({ diffKind: "staged" }) });

		expect(screen.getByRole("button", { name: "Unstage Hunk" })).toHaveClass(
			"bg-warning-bg",
		);
	});

	it("offers whole-hunk and selected-line comment actions while review threads are hidden", async () => {
		const hidden = { reviewFilter: "none" as const };
		const view = render(HunkView, { props: defaultProps(hidden) });

		expect(screen.getByRole("button", { name: "Comment" })).toBeInTheDocument();

		await view.rerender(
			defaultProps({
				...hidden,
				selectedHunkKey: "src/main.ts-0",
				selectedLineIndices: new Set([0]),
				selectedCount: 1,
			}),
		);

		expect(
			screen.getByRole("button", { name: /^Comment \(1\)/ }),
		).toBeInTheDocument();
	});

	it("reports the row a gutter press landed on after the reader scrolled to it", async () => {
		const onlinemousedown = vi.fn();
		const lines = contextLines(3000).map((line, index) =>
			index === 2500 ? { ...line, origin: "Add" as const } : line,
		);
		const { container } = render(HunkView, {
			props: defaultProps({
				fileDiffs: [fileOf("src/long.ts", lines)],
				onlinemousedown,
			}),
		});

		scrollTo(container, 2500 * 18);
		await tick();

		const grip = screen
			.getByText("line 2501")
			.closest(".diff-line")
			?.querySelector("[data-gutter-grip]") as HTMLElement;
		await fireEvent.mouseDown(grip);

		expect(onlinemousedown.mock.calls[0].slice(0, 3)).toEqual([
			"src/long.ts",
			0,
			2500,
		]);
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

		render(HunkView, { props: defaultProps() });
		await flushPerf();
		disablePerf();

		const byName = new Map(observed.map((s) => [s.name, s.attrs]));
		expect(byName.get("diff.buildRows")).toEqual({ lines: 2 });
		expect(byName.get("diff.rowHeights")).toEqual({ rows: 3, wrap: "false" });
	});

	it("mounts a bounded number of rows for a hunk far larger than the viewport", () => {
		const { container } = render(HunkView, {
			props: defaultProps({
				fileDiffs: [fileOf("src/huge.ts", contextLines(5000))],
			}),
		});

		expect(container.querySelectorAll(".diff-line").length).toBeLessThan(200);
	});

	describe("threaded comment actions", () => {
		describeThreadedCommentActions(
			HunkView,
			defaultProps,
			".inline-comment-row",
			safeInvoke,
		);
	});
});

describe("HunkView gutter grip", () => {
	it("offers none on a context line where comments are not taken", () => {
		render(HunkView, { props: defaultProps({ takesComments: false }) });

		const row = screen
			.getByText("context before")
			.closest(".diff-line") as HTMLElement;

		expect(within(row).queryByRole("button")).toBeNull();
	});

	it("offers one on a context line where comments are taken", () => {
		render(HunkView, { props: defaultProps() });

		const row = screen
			.getByText("context before")
			.closest(".diff-line") as HTMLElement;

		expect(row.querySelector("[data-gutter-grip]")).not.toBeNull();
	});

	it("names the line it selects", () => {
		render(HunkView, { props: defaultProps() });

		const grip = screen
			.getByText("added one")
			.closest(".diff-line")
			?.querySelector("[data-gutter-grip]");

		expect(grip).toHaveAccessibleName("Select added line 11");
	});
});

describe("HunkView thread marker", () => {
	const onAddedLine = (id: string) =>
		aThread({
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

	it("holds a thread's card at the pane's left edge while the code pans", () => {
		const { container } = render(HunkView, {
			props: defaultProps({ viewComments: [onAddedLine("t1")] }),
		});

		const row = container.querySelector(
			".exact-virtual-rows .inline-comment-row",
		);

		expect(row).toHaveStyle("position: sticky; left: 0");
	});

	it("counts the threads hanging on a line beside its numbers", () => {
		render(HunkView, {
			props: defaultProps({
				viewComments: [onAddedLine("t1"), onAddedLine("t2")],
			}),
		});

		expect(markerOn("added one")).toHaveTextContent("2");
		expect(markerOn("context before")).toBeNull();
	});

	it("draws the count in the most urgent state of the threads starting there", () => {
		render(HunkView, {
			props: defaultProps({
				viewComments: [
					{ ...onAddedLine("t1"), state: "done" },
					{ ...onAddedLine("t2"), state: "addressed" },
				],
			}),
		});

		expect(
			(markerOn("added one") as HTMLElement).style.getPropertyValue(
				"--thread-tone",
			),
		).toBe("var(--color-thread-addressed)");
	});

	it("keeps the empty column on a line no thread hangs on, so the code stays aligned", () => {
		render(HunkView, {
			props: defaultProps({
				viewComments: [onAddedLine("t1")],
			}),
		});

		expect(markerCellOn("context before")).not.toBeNull();
	});

	it("keeps the marker column while review threads are hidden and comments withheld", () => {
		render(HunkView, {
			props: defaultProps({
				viewComments: [onAddedLine("t1")],
				takesComments: false,
				reviewFilter: "none",
			}),
		});

		expect(markerCellOn("context before")).not.toBeNull();
	});

	it("reserves the marker column on a merge, where a whole-file thread can show", () => {
		const { container } = render(HunkView, {
			props: defaultProps({ isMerge: true }),
		});

		expect(container.querySelector(".thread-marker-cell")).not.toBeNull();
	});
});

describe("HunkView composer", () => {
	const card = createRawSnippet(() => ({
		render: () => "<p>the composer card</p>",
	}));

	it("holds the composer at the pane's left edge while the code pans", () => {
		render(HunkView, {
			props: defaultProps({
				composer: {
					place: { path: "src/main.ts", side: "New", endLine: 10 },
					card,
				},
			}),
		});

		const row = screen
			.getByText("the composer card")
			.closest(".inline-composer-row");

		expect(row).toHaveStyle("position: sticky; left: 0");
	});

	it("draws the composer under the line the comment ends on", () => {
		render(HunkView, {
			props: defaultProps({
				composer: {
					place: { path: "src/main.ts", side: "New", endLine: 10 },
					card,
				},
			}),
		});

		const row = screen
			.getByText("the composer card")
			.closest(".inline-composer-row");
		const lines = [
			...document.querySelectorAll(".diff-line, .inline-composer-row"),
		]
			.filter((el) => !el.classList.contains("metrics-probe"))
			.map((el) => el.textContent?.trim());

		expect(row).not.toBeNull();
		expect(lines).toEqual([
			expect.stringContaining("context before"),
			"the composer card",
			expect.stringContaining("added one"),
		]);
	});

	it("scrolls a composer that opens below the viewport into view", async () => {
		const props = defaultProps({
			fileDiffs: [fileOf("src/long.ts", contextLines(3000))],
			selectedPath: "src/long.ts",
		});
		const view = render(HunkView, { props });

		await view.rerender({
			...props,
			composer: {
				place: { path: "src/long.ts", side: "New", endLine: 2500 },
				card,
			},
		});

		expect(screen.getByText("the composer card")).toBeInTheDocument();
	});

	it("leaves the reader where they scrolled when the open composer is rebuilt in place", async () => {
		const props = defaultProps({
			fileDiffs: [fileOf("src/long.ts", contextLines(3000))],
			selectedPath: "src/long.ts",
		});
		const place = {
			path: "src/long.ts",
			side: "New" as const,
			endLine: 2500,
		};
		const view = render(HunkView, { props });
		await view.rerender({ ...props, composer: { place, card } });
		scrollTo(view.container, 0);
		await tick();

		await view.rerender({ ...props, composer: { place: { ...place }, card } });

		expect(screen.queryByText("the composer card")).toBeNull();
	});
});

describe("HunkView selection comment", () => {
	function rowOf(text: string): HTMLElement {
		return screen.getByText(text).closest(".diff-line") as HTMLElement;
	}

	function selecting(lineIndices: number[]) {
		return {
			selectedHunkKey: "src/main.ts-0",
			selectedLineIndices: new Set(lineIndices),
			selectedCount: lineIndices.length,
		};
	}

	it("draws the action on the line it is placed on", () => {
		render(HunkView, {
			props: defaultProps({
				...selecting([0, 1]),
				selectionComment: { hunkKey: "src/main.ts-0", lineIndex: 1 },
			}),
		});

		expect(rowOf("added one")).toContainElement(
			screen.getByRole("button", { name: "Comment on selected lines" }),
		);
	});

	it("comments on the selection from the action", async () => {
		const oncommentselection = vi.fn();
		render(HunkView, {
			props: defaultProps({
				...selecting([1]),
				selectionComment: { hunkKey: "src/main.ts-0", lineIndex: 1 },
				oncommentselection,
			}),
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Comment on selected lines" }),
		);

		expect(oncommentselection).toHaveBeenCalledTimes(1);
	});

	it("draws no action where none is placed", () => {
		render(HunkView, { props: defaultProps(selecting([1])) });

		expect(
			screen.queryByRole("button", { name: "Comment on selected lines" }),
		).toBeNull();
	});

	it("draws no comment control on a line", () => {
		render(HunkView, { props: defaultProps() });

		expect(
			screen.queryAllByRole("button", {
				name: /^Comment on (removed )?line/,
				hidden: true,
			}),
		).toEqual([]);
	});

	it("outlines a run of selected lines at its first and last line", () => {
		render(HunkView, { props: defaultProps(selecting([0, 1])) });

		expect(rowOf("context before")).toHaveClass(
			"in-selection",
			"selection-first",
		);
		expect(rowOf("added one")).toHaveClass("in-selection", "selection-last");
	});

	it("selects a context line from its line number where the diff takes comments", () => {
		render(HunkView, { props: defaultProps() });

		expect(
			rowOf("context before").querySelector("[data-gutter-grip]"),
		).not.toBeNull();
	});

	it("draws no line number control on a context line where the diff takes no comments", () => {
		render(HunkView, { props: defaultProps({ takesComments: false }) });

		expect(
			rowOf("context before").querySelector("[data-gutter-grip]"),
		).toBeNull();
	});
});

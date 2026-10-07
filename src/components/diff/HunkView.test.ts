import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreLayout, stubLayout } from "../../__tests__/helpers/layout-stub";
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

	it("hides whole-hunk and selected-line comment actions under Hide all", async () => {
		const hidden = { reviewFilter: "none" as const };
		const view = render(HunkView, { props: defaultProps(hidden) });

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

		expect(onlinemousedown.mock.calls[0].slice(0, 4)).toEqual([
			"src/long.ts",
			0,
			2500,
			"Add",
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
	it("offers none on a context line", () => {
		render(HunkView, { props: defaultProps() });

		const row = screen
			.getByText("context before")
			.closest(".diff-line") as HTMLElement;

		expect(within(row).queryByRole("button")).toBeNull();
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

	it("edges a covered line in its thread's state", () => {
		render(HunkView, {
			props: defaultProps({
				viewComments: [{ ...onAddedLine("t1"), state: "done" }],
			}),
		});

		const row = screen.getByText("added one").closest(".diff-line");

		expect((row as HTMLElement).style.getPropertyValue("--thread-tone")).toBe(
			"var(--color-thread-done)",
		);
	});

	it("keeps the empty column on a line no thread hangs on, so the code stays aligned", () => {
		render(HunkView, {
			props: defaultProps({
				viewComments: [onAddedLine("t1")],
			}),
		});

		expect(markerCellOn("context before")).not.toBeNull();
	});

	it("reserves no marker column when no thread hangs in view", () => {
		const { container } = render(HunkView, { props: defaultProps() });

		expect(container.querySelector(".thread-marker-cell")).toBeNull();
	});
});

describe("HunkView composer", () => {
	const card = createRawSnippet(() => ({
		render: () => "<p>the composer card</p>",
	}));

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

// The control shows only under the pointer, which jsdom cannot hover, so the
// queries look past the display rule that hides it at rest.
describe("HunkView one-click comment", () => {
	it("offers to comment on a changed line from its marker cell", async () => {
		const oncommentline = vi.fn();
		render(HunkView, { props: defaultProps({ oncommentline }) });

		await fireEvent.click(
			screen.getByRole("button", { name: "Comment on line 11", hidden: true }),
		);

		expect(oncommentline).toHaveBeenCalledWith("src/main.ts", 0, 1);
	});

	it("offers none on a context line", () => {
		render(HunkView, { props: defaultProps({ oncommentline: vi.fn() }) });

		expect(
			screen.queryByRole("button", {
				name: "Comment on line 10",
				hidden: true,
			}),
		).toBeNull();
	});

	it("offers none while the threads are hidden", () => {
		render(HunkView, {
			props: defaultProps({ oncommentline: vi.fn(), reviewFilter: "none" }),
		});

		expect(
			screen.queryByRole("button", { name: /^Comment on line/, hidden: true }),
		).toBeNull();
	});
});

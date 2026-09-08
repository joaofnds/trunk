import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreLayout, stubLayout } from "../../__tests__/helpers/layout-stub";
import { aThread } from "../../__tests__/helpers/thread-fixture.js";
import {
	disablePerf,
	enablePerf,
	flushPerf,
	type PerfSink,
} from "../../lib/perf.js";
import {
	addReply,
	deleteReply,
	editReply,
	setThreadState,
} from "../../lib/review-comment-actions.js";
import type { DiffLine, FileDiff } from "../../lib/types.js";
import HunkView from "./HunkView.svelte";

vi.mock("../../lib/review-comment-actions.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../lib/review-comment-actions.js")
	>()),
	addReply: vi.fn(),
	setThreadState: vi.fn(),
	editReply: vi.fn(),
	deleteReply: vi.fn(),
}));

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
		onlineenter: vi.fn(),
		onstagehunk: vi.fn(),
		onunstagehunk: vi.fn(),
		ondiscardhunk: vi.fn(),
		onstagelines: vi.fn(),
		onunstagelines: vi.fn(),
		ondiscardlines: vi.fn(),
		oncommentlines: vi.fn(),
		oncommenthunk: vi.fn(),
		repoPath: "/repo",
		showInlineComments: true,
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
			?.querySelector(".gutter-grip") as HTMLElement;
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
		// ThreadCard also renders inside HunkView's hidden measurement probe
		// (`.comment-probe`), so a query on the visible card must be scoped to
		// `.inline-comment-row` — an unscoped query finds both copies.
		function visibleCard(container: HTMLElement): HTMLElement {
			const card = container.querySelector(".inline-comment-row .comment-card");
			if (!card) throw new Error("no visible comment card");
			return card as HTMLElement;
		}

		function commentedProps() {
			const commented = aThread({
				id: "t1",
				anchor: {
					commit_oid: "oid",
					file_path: "src/main.ts",
					source: "FullFile",
					side: "New",
					start_line: 11,
					end_line: 11,
				},
			});
			return defaultProps({ viewComments: [commented] });
		}

		it("submits a reply via addReply with the repo path", async () => {
			const { container } = render(HunkView, { props: commentedProps() });
			const card = visibleCard(container);

			const textarea = within(card).getByLabelText(
				"Reply",
			) as HTMLTextAreaElement;
			await fireEvent.input(textarea, { target: { value: "reply text" } });
			await fireEvent.click(within(card).getByText("Reply"));

			expect(addReply).toHaveBeenCalledWith("/repo", "t1", "reply text");
		});

		it("changes the thread's state via setThreadState with the repo path", async () => {
			const { container } = render(HunkView, { props: commentedProps() });
			const card = visibleCard(container);

			await fireEvent.click(within(card).getByText("Mark done"));

			expect(setThreadState).toHaveBeenCalledWith("/repo", "t1", "done");
		});

		it("edits a reply via editReply with the repo path", async () => {
			const commented = aThread({
				id: "t1",
				anchor: {
					commit_oid: "oid",
					file_path: "src/main.ts",
					source: "FullFile",
					side: "New",
					start_line: 11,
					end_line: 11,
				},
				replies: [
					{
						id: "r1",
						text: "original",
						text_html: "",
						channel: "human",
						created_at: 1_000,
					},
				],
			});
			const { container } = render(HunkView, {
				props: defaultProps({ viewComments: [commented] }),
			});
			const card = visibleCard(container);

			await fireEvent.click(within(card).getByText("Edit reply"));
			const textarea = within(card).getByRole("textbox", {
				name: "Edit reply",
			}) as HTMLTextAreaElement;
			await fireEvent.input(textarea, { target: { value: "corrected" } });
			await fireEvent.click(within(card).getByText("Save"));

			expect(editReply).toHaveBeenCalledWith("/repo", "r1", "corrected");
		});

		it("deletes a reply via deleteReply with the repo path (no confirmation, inline confirmDelete=false)", async () => {
			const commented = aThread({
				id: "t1",
				anchor: {
					commit_oid: "oid",
					file_path: "src/main.ts",
					source: "FullFile",
					side: "New",
					start_line: 11,
					end_line: 11,
				},
				replies: [
					{
						id: "r1",
						text: "original",
						text_html: "",
						channel: "human",
						created_at: 1_000,
					},
				],
			});
			const { container } = render(HunkView, {
				props: defaultProps({ viewComments: [commented] }),
			});
			const card = visibleCard(container);

			await fireEvent.click(within(card).getByText("Delete reply"));

			expect(deleteReply).toHaveBeenCalledWith("/repo", "r1");
		});
	});
});

import { render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	restoreLayout,
	stubLayout,
} from "../../__tests__/helpers/layout-stub.js";
import type { FileDiff } from "../../lib/types.js";
import DiffViewer from "./DiffViewer.svelte";

// The rendered view fetches its rows through the shared IPC helper; keep the
// real error guard and answer with an empty diff.
const safeInvoke = vi.fn();
vi.mock("../../lib/invoke.js", async (importActual) => ({
	...(await importActual<typeof import("../../lib/invoke.js")>()),
	safeInvoke: (cmd: string, args: Record<string, unknown>) =>
		safeInvoke(cmd, args),
}));

const noop = () => {};

// The rendered view mounts only for a path the file list describes, so a test
// that wants the pane on screen puts the selected file in the list.
const selectedReadme: FileDiff = {
	path: "README.md",
	old_path: null,
	status: "Modified",
	is_binary: false,
	hunks: [],
};

const baseProps = {
	contentMode: "hunk" as const,
	contextLines: 3,
	layoutMode: "inline" as const,
	renderMode: "source" as const,
	fileDiffs: [],
	commitDetail: null,
	selectedPath: "README.md",
	diffKind: "unstaged" as const,
	loading: false,
	hunkOperationInFlight: false,
	ignoreWhitespace: false,
	showInvisibles: false,
	wordWrap: false,
	selectedHunkKey: null,
	selectedLineIndices: new Set<number>(),
	selectedCount: 0,
	isMerge: false,
	collapsedFiles: new Set<string>(),
	hunkElements: {},
	onfilecollapsetoggle: noop,
	onlineclick: noop,
	onlinemousedown: noop,
	onlineenter: noop,
	onstagehunk: noop,
	onunstagehunk: noop,
	ondiscardhunk: noop,
	onstagelines: noop,
	onunstagelines: noop,
	ondiscardlines: noop,
	oncommentlines: noop,
	oncommenthunk: noop,
	commitOid: "",
	repoPath: "/repo",
	oncommentfullfile: noop,
};

afterEach(() => safeInvoke.mockReset());

// Every view the viewer mounts owns its own scroller. The viewer's wrapper must
// therefore never be a scroll container itself: `hidden` still lets
// scrollIntoView and scroll chaining move it, and WebKit hands it a phantom
// scroll range the size of the rendered pane's content, so a reader who
// reaches the end of the rendered markdown pane then drags the whole pane up
// out of the window behind a second scrollbar (TRUNK-127). `clip` is the one
// value with nothing to scroll.
describe("DiffViewer's wrapper", () => {
	it("is clipped, never a scroll container, around the rendered markdown view", () => {
		safeInvoke.mockResolvedValue({ rows: [], whitespaceOnly: false });
		const { container } = render(DiffViewer, {
			props: {
				...baseProps,
				renderMode: "rendered",
				loading: true,
				fileDiffs: [selectedReadme],
			},
		});
		const pane = container.querySelector(".rendered-diff");
		expect(pane).not.toBeNull();
		const wrapper = pane?.parentElement as HTMLElement;
		expect(wrapper.getAttribute("style")).toContain("overflow: clip");
	});

	it("hands the selected file's old path to the rendered view", () => {
		safeInvoke.mockResolvedValue({ rows: [], whitespaceOnly: false });
		const renamed: FileDiff = {
			path: "docs/new.md",
			old_path: "docs/old.md",
			status: "Renamed",
			is_binary: false,
			hunks: [],
		};

		render(DiffViewer, {
			props: {
				...baseProps,
				renderMode: "rendered",
				fileDiffs: [renamed],
				selectedPath: "docs/new.md",
			},
		});

		expect(safeInvoke).toHaveBeenCalledWith(
			"render_markdown_diff",
			expect.objectContaining({
				filePath: "docs/new.md",
				oldPath: "docs/old.md",
			}),
		);
	});

	it("waits for the file list before rendering a path it does not describe", () => {
		safeInvoke.mockResolvedValue({ rows: [], whitespaceOnly: false });
		const stale: FileDiff = {
			path: "docs/other.md",
			old_path: null,
			status: "Modified",
			is_binary: false,
			hunks: [],
		};

		render(DiffViewer, {
			props: {
				...baseProps,
				renderMode: "rendered",
				diffKind: "staged",
				fileDiffs: [stale],
				selectedPath: "docs/new.md",
			},
		});

		expect(safeInvoke).not.toHaveBeenCalledWith(
			"render_markdown_diff",
			expect.anything(),
		);
	});

	it("is clipped around the source view too", () => {
		const { container } = render(DiffViewer, { props: baseProps });
		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.getAttribute("style")).toContain("overflow: clip");
	});
});

// A write anywhere under the repo refetches the open diff, and the placeholder
// branch used to sit ahead of the content branches, so the valid diff it was
// refreshing left the DOM for the length of the fetch (TRUNK-232).
describe("DiffViewer while a diff is loading", () => {
	const modifiedReadme: FileDiff = {
		path: "README.md",
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
						content: "STABLE CONTENT",
						old_lineno: null,
						new_lineno: 1,
						spans: [],
					},
				],
			},
		],
	};

	// The hunk view virtualizes its rows off the viewport's measured height,
	// which jsdom reports as zero, so the content needs a box to render into.
	beforeEach(() => stubLayout({ width: 900, height: 600 }));
	afterEach(restoreLayout);

	it("keeps the content it already has on screen", async () => {
		const { queryByText, findByText } = render(DiffViewer, {
			props: { ...baseProps, loading: true, fileDiffs: [modifiedReadme] },
		});

		expect(await findByText("STABLE CONTENT")).toBeTruthy();
		expect(queryByText("Loading diff…")).toBeNull();
	});

	it("shows the placeholder when there is nothing to show yet", () => {
		const { queryByText } = render(DiffViewer, {
			props: { ...baseProps, loading: true, fileDiffs: [] },
		});

		expect(queryByText("Loading diff…")).not.toBeNull();
	});

	// A commit's file list arrives as metadata, one hunkless entry per file, before
	// any file's diff is fetched. Reading that entry as content leaves an empty
	// pane where the placeholder belongs.
	it("shows the placeholder when the selected file holds only list metadata", () => {
		const metadataOnly: FileDiff = {
			path: "README.md",
			old_path: null,
			status: "Modified",
			is_binary: false,
			hunks: [],
		};

		const { queryByText } = render(DiffViewer, {
			props: { ...baseProps, loading: true, fileDiffs: [metadataOnly] },
		});

		expect(queryByText("Loading diff…")).not.toBeNull();
	});

	// A binary file carries no hunks of its own and is content all the same.
	it("keeps a binary file's row on screen while it refreshes", () => {
		const binary: FileDiff = {
			path: "README.md",
			old_path: null,
			status: "Modified",
			is_binary: true,
			hunks: [],
		};

		const { container, queryByText } = render(DiffViewer, {
			props: { ...baseProps, loading: true, fileDiffs: [binary] },
		});

		expect(queryByText("Loading diff…")).toBeNull();
		expect(container.querySelector(".binary-row")).not.toBeNull();
	});

	// Content the viewer keeps has to answer the path being asked for. The list
	// still holds the previous file's payload while the newly selected one is in
	// flight, and showing it would caption one file's hunks with another's name.
	it("shows the placeholder when the loaded diff is for another file", () => {
		const { queryByText } = render(DiffViewer, {
			props: {
				...baseProps,
				selectedPath: "docs/other.md",
				loading: true,
				fileDiffs: [modifiedReadme],
			},
		});

		expect(queryByText("STABLE CONTENT")).toBeNull();
		expect(queryByText("Loading diff…")).not.toBeNull();
	});
});

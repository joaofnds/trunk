import { fireEvent, render, screen } from "@testing-library/svelte";
import { createRawSnippet, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	restoreLayout,
	stubLayout,
} from "../../__tests__/helpers/layout-stub.js";
import { commentingDiff } from "../../__tests__/helpers/review-props.js";
import { aThread } from "../../__tests__/helpers/thread-fixture.js";
import { FIXED_ROW_HEIGHTS } from "../../lib/diff-rows.js";
import { ThreadFolds } from "../../lib/thread-folds.svelte.js";
import type { CommitDetail, FileDiff } from "../../lib/types.js";
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
	old_size: null,
	new_size: null,
	old_id: null,
	new_id: null,
	hunks: [],
};

const pureRename: FileDiff = {
	path: "docs/README.md",
	old_path: "README.md",
	status: "Renamed",
	is_binary: false,
	old_size: null,
	new_size: null,
	old_id: null,
	new_id: null,
	hunks: [],
};

const baseProps = {
	...commentingDiff,
	folds: new ThreadFolds(),
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
	selectedChangeCount: 0,
	isMerge: false,
	keysActive: true,
	collapsedFiles: new Set<string>(),
	onfilecollapsetoggle: noop,
	onlineclick: noop,
	onlinemousedown: noop,
	onstagehunk: noop,
	onunstagehunk: noop,
	ondiscardhunk: noop,
	onstagelines: noop,
	onunstagelines: noop,
	ondiscardlines: noop,
	oncommentlines: noop,
	selectionComment: null,
	oncommentselection: noop,
	oncommenthunk: noop,
	commitOid: "",
	repoPath: "/repo",
	oncommentfullfile: noop,
	onignorewhitespacechange: noop,
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
		expect(pane?.parentElement).toHaveClass("overflow-clip");
	});

	it("hands the selected file's old path to the rendered view", () => {
		safeInvoke.mockResolvedValue({ rows: [], whitespaceOnly: false });
		const renamed: FileDiff = {
			path: "docs/new.md",
			old_path: "docs/old.md",
			status: "Renamed",
			is_binary: false,
			old_size: null,
			new_size: null,
			old_id: null,
			new_id: null,
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
			old_size: null,
			new_size: null,
			old_id: null,
			new_id: null,
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
		expect(container.firstElementChild).toHaveClass("overflow-clip");
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
		old_size: null,
		new_size: null,
		old_id: null,
		new_id: null,
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
			old_size: null,
			new_size: null,
			old_id: null,
			new_id: null,
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
			old_size: null,
			new_size: null,
			old_id: null,
			new_id: null,
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

describe("DiffViewer on a binary image", () => {
	const logo: FileDiff = {
		path: "assets/logo.png",
		old_path: null,
		status: "Modified",
		is_binary: true,
		old_size: 1200,
		new_size: 3400,
		old_id: null,
		new_id: null,
		hunks: [],
	};

	const parentOf = (oid: string) => ({
		oid: "bbb",
		short_oid: "bbb",
		summary: "",
		body: null,
		message: "",
		author_name: "",
		author_email: "",
		author_timestamp: 0,
		committer_name: "",
		committer_email: "",
		committer_timestamp: 0,
		parent_oids: [oid],
	});

	beforeEach(() => stubLayout({ width: 900, height: 600 }));
	afterEach(restoreLayout);

	function sourceOf(name: string): string | null {
		return screen.getByRole("img", { name }).getAttribute("src");
	}

	it("shows a commit's image at its parent and at the commit", () => {
		render(DiffViewer, {
			props: {
				...baseProps,
				diffKind: "commit",
				commitOid: "bbb",
				commitDetail: parentOf("aaa"),
				selectedPath: logo.path,
				fileDiffs: [logo],
			},
		});

		expect([sourceOf("Before"), sourceOf("After")]).toEqual([
			"trunk-asset://asset/?repo=%2Frepo&rev=commit-aaa&path=assets%2Flogo.png",
			"trunk-asset://asset/?repo=%2Frepo&rev=commit-bbb&path=assets%2Flogo.png",
		]);
	});

	it.each([
		["staged", "head", "index"],
		["unstaged", "index", "working-tree"],
	] as const)(
		"shows a %s image on the two sides it compares",
		(diffKind, before, after) => {
			render(DiffViewer, {
				props: {
					...baseProps,
					diffKind,
					selectedPath: logo.path,
					fileDiffs: [logo],
					refreshToken: 2,
				},
			});

			expect([sourceOf("Before"), sourceOf("After")]).toEqual([
				`trunk-asset://asset/?repo=%2Frepo&rev=${before}&path=assets%2Flogo.png&v=2`,
				`trunk-asset://asset/?repo=%2Frepo&rev=${after}&path=assets%2Flogo.png&v=2`,
			]);
		},
	);

	it("shows an opened image once, as it is on disk, with its size", () => {
		const opened: FileDiff = {
			...logo,
			status: "Unknown",
			old_size: null,
			new_size: 3400,
		};

		render(DiffViewer, {
			props: {
				...baseProps,
				diffKind: "current_file",
				selectedPath: opened.path,
				fileDiffs: [opened],
			},
		});

		expect(
			screen.getAllByRole("img").map((img) => img.getAttribute("alt")),
		).toEqual(["Current"]);
		expect(screen.getByRole("figure", { name: /^Current/ })).toHaveTextContent(
			"3.4 KB",
		);
	});

	it("keeps the binary row for a binary file that is not an image", () => {
		const font = { ...logo, path: "assets/font.woff2" };

		const { container } = render(DiffViewer, {
			props: { ...baseProps, selectedPath: font.path, fileDiffs: [font] },
		});

		expect(screen.queryByRole("img")).toBeNull();
		expect(container.querySelector(".binary-row")).toHaveTextContent(
			"Binary file, 1.2 KB → 3.4 KB",
		);
	});

	it("keeps the binary row for an image among all of a commit's files", () => {
		const { container } = render(DiffViewer, {
			props: { ...baseProps, selectedPath: null, fileDiffs: [logo] },
		});

		expect(screen.queryByRole("img")).toBeNull();
		expect(container.querySelector(".binary-row")).not.toBeNull();
	});
});

describe("DiffViewer with a file that has no hunks", () => {
	beforeEach(() => stubLayout({ width: 900, height: 600 }));
	afterEach(restoreLayout);

	it("says there are no changes to show once the file has loaded", () => {
		render(DiffViewer, {
			props: { ...baseProps, fileDiffs: [selectedReadme] },
		});

		expect(
			screen.getByRole("region", { name: "No changes to show" }),
		).toHaveTextContent("This file has no diff here.");
	});

	it("says a file renamed with its content unchanged was renamed", () => {
		render(DiffViewer, {
			props: {
				...baseProps,
				selectedPath: "docs/README.md",
				fileDiffs: [pureRename],
			},
		});

		expect(
			screen.getByRole("region", { name: "Renamed without changes" }),
		).toHaveTextContent("This file's content matches README.md.");
	});

	describe("when whitespace is ignored", () => {
		it("says ignoring whitespace left nothing to show", () => {
			render(DiffViewer, {
				props: {
					...baseProps,
					ignoreWhitespace: true,
					fileDiffs: [selectedReadme],
				},
			});

			expect(
				screen.getByRole("region", { name: "No changes to show" }),
			).toHaveTextContent("Nothing is left to show with whitespace ignored.");
		});

		it("stops ignoring whitespace from the empty file", async () => {
			const asked: boolean[] = [];
			render(DiffViewer, {
				props: {
					...baseProps,
					ignoreWhitespace: true,
					fileDiffs: [selectedReadme],
					onignorewhitespacechange: (ignore: boolean) => asked.push(ignore),
				},
			});

			await fireEvent.click(
				screen.getByRole("button", { name: "Show whitespace changes" }),
			);

			expect(asked).toEqual([false]);
		});

		it("stops ignoring whitespace from a rename it made look unchanged", async () => {
			const asked: boolean[] = [];
			render(DiffViewer, {
				props: {
					...baseProps,
					ignoreWhitespace: true,
					selectedPath: "docs/README.md",
					fileDiffs: [pureRename],
					onignorewhitespacechange: (ignore: boolean) => asked.push(ignore),
				},
			});

			await fireEvent.click(
				screen.getByRole("button", { name: "Show whitespace changes" }),
			);

			expect(asked).toEqual([false]);
		});
	});

	it("offers no whitespace to show while whitespace counts", () => {
		render(DiffViewer, {
			props: { ...baseProps, fileDiffs: [selectedReadme] },
		});

		expect(
			screen.queryByRole("button", { name: "Show whitespace changes" }),
		).not.toBeInTheDocument();
	});

	it("says a rename matches its old content only once whitespace is ignored", () => {
		render(DiffViewer, {
			props: {
				...baseProps,
				ignoreWhitespace: true,
				selectedPath: "docs/README.md",
				fileDiffs: [pureRename],
			},
		});

		expect(
			screen.getByRole("region", { name: "Renamed without changes" }),
		).toHaveTextContent(
			"This file's content matches README.md once whitespace is ignored.",
		);
	});

	it("says nothing about changes while the file is still loading", () => {
		render(DiffViewer, {
			props: { ...baseProps, loading: true, fileDiffs: [selectedReadme] },
		});

		expect(screen.queryByText("No changes to show")).toBeNull();
	});
});

describe("DiffViewer on a file the selected commit does not change", () => {
	beforeEach(() => stubLayout({ width: 900, height: 600 }));
	afterEach(restoreLayout);

	const commit: CommitDetail = {
		oid: "6cca1d9",
		short_oid: "6cca1d9",
		summary: "touch two files",
		body: null,
		message: "touch two files",
		author_name: "A",
		author_email: "a@example.com",
		author_timestamp: 0,
		committer_name: "A",
		committer_email: "a@example.com",
		committer_timestamp: 0,
		parent_oids: [],
	};
	const onDroppedFile = aThread({
		id: "t-dropped",
		text: "a thread on a file the amend dropped",
		anchor: {
			commit_oid: "6cca1d9",
			file_path: "g.txt",
			source: "Diff",
			side: "New",
			start_line: 9,
			end_line: 9,
		},
	});
	const commitProps = {
		...baseProps,
		diffKind: "commit" as const,
		commitDetail: commit,
		fileDiffs: [],
		selectedPath: "g.txt",
	};

	it("says the file has no diff and draws its threads under that", () => {
		render(DiffViewer, {
			props: { ...commitProps, viewComments: [onDroppedFile] },
		});

		expect(
			screen.getByRole("region", { name: "No changes to show" }),
		).toHaveTextContent("This file has no diff here.");
		expect(
			screen.getByText("a thread on a file the amend dropped"),
		).toBeInTheDocument();
	});

	it("draws no thread the review filter hides", () => {
		render(DiffViewer, {
			props: {
				...commitProps,
				viewComments: [onDroppedFile],
				reviewFilter: "none" as const,
			},
		});

		expect(
			screen.queryByText("a thread on a file the amend dropped"),
		).toBeNull();
	});

	it("says nothing about changes while the commit's files are loading", () => {
		render(DiffViewer, { props: { ...commitProps, loading: true } });

		expect(screen.queryByText("No changes to show")).toBeNull();
	});
});

describe("DiffViewer's comment composer", () => {
	beforeEach(() => stubLayout({ width: 900, height: 400 }));
	afterEach(restoreLayout);

	const card = createRawSnippet(() => ({
		render: () => "<p>the composer card</p>",
	}));
	const mainTs: FileDiff = {
		path: "src/main.ts",
		old_path: null,
		status: "Modified",
		is_binary: false,
		old_size: null,
		new_size: null,
		old_id: null,
		new_id: null,
		hunks: [
			{
				header: "@@ -1,1 +1,1 @@",
				old_start: 1,
				old_lines: 1,
				new_start: 1,
				new_lines: 1,
				lines: [
					{
						origin: "Context",
						content: "only line",
						old_lineno: 1,
						new_lineno: 1,
						spans: [],
					},
				],
			},
		],
	};
	const onLine = (endLine: number) => ({
		...baseProps,
		fileDiffs: [mainTs],
		selectedPath: "src/main.ts",
		composer: {
			place: { path: "src/main.ts", side: "New" as const, endLine },
			card,
		},
	});

	it("draws it once, inside the diff, under the line it comments on", () => {
		const { container } = render(DiffViewer, { props: onLine(1) });

		expect(screen.getAllByText("the composer card")).toHaveLength(1);
		expect(container.querySelector(".hunk-view")).toContainElement(
			screen.getByText("the composer card"),
		);
	});

	it("draws it below the diff when no line in view holds it", () => {
		const { container } = render(DiffViewer, { props: onLine(40) });

		expect(screen.getAllByText("the composer card")).toHaveLength(1);
		expect(container.querySelector(".hunk-view")).not.toContainElement(
			screen.getByText("the composer card"),
		);
	});
});

// A reader who switches layout or content mode is reading a line, and the view
// that replaces the old one starts at that line rather than at the top. The
// line number carries the place, because the two content modes fetch different
// hunks and so put the same line at a different row.
describe("DiffViewer when the reader switches view", () => {
	beforeEach(() => stubLayout({ width: 900, height: 600 }));
	afterEach(restoreLayout);

	const contextLines = (from: number, to: number, tail: string) =>
		Array.from({ length: to - from + 1 }, (_, i) => ({
			origin: "Context" as const,
			content: `line ${from + i}${tail}`,
			old_lineno: from + i,
			new_lineno: from + i,
			spans: [],
		}));
	const hunkOf = (from: number, to: number, tail = "") => ({
		header: `@@ -${from},${to - from + 1} +${from},${to - from + 1} @@`,
		old_start: from,
		old_lines: to - from + 1,
		new_start: from,
		new_lines: to - from + 1,
		lines: contextLines(from, to, tail),
	});
	const bigFile = (hunks: ReturnType<typeof hunkOf>[]): FileDiff => ({
		path: "big.txt",
		old_path: null,
		status: "Modified",
		is_binary: false,
		old_size: null,
		new_size: null,
		old_id: null,
		new_id: null,
		hunks,
	});
	// Forty five-line hunks, a hundred lines apart, so the hunk headers above
	// the reading line are enough rows to move it out of view if they are lost.
	const hunks = bigFile(
		Array.from({ length: 40 }, (_, i) => hunkOf(i * 100 + 1, i * 100 + 5)),
	);
	const wholeFile = bigFile([hunkOf(1, 4000)]);
	const props = {
		...baseProps,
		selectedPath: "big.txt",
		fileDiffs: [hunks],
	};

	// Thirty hunks of a header and five 18px lines above the thirty-first,
	// whose own header and first two lines come next.
	const line3003InHunks = 31 * FIXED_ROW_HEIGHTS.hunkHeader + (30 * 5 + 2) * 18;

	const viewportOf = (container: Element) =>
		container.querySelector(".exact-virtual-viewport") as HTMLElement;

	async function scrollToLine(container: Element, line: string) {
		const viewport = viewportOf(container);
		viewport.scrollTop = line3003InHunks;
		viewport.dispatchEvent(new Event("scroll"));
		expect(await screen.findAllByText(line)).not.toHaveLength(0);
	}

	it("keeps the line at the top when the layout changes", async () => {
		const { container, rerender } = render(DiffViewer, { props });
		await scrollToLine(container, "line 3003");

		await rerender({ ...props, layoutMode: "split" });

		expect(await screen.findAllByText("line 3003")).not.toHaveLength(0);
		expect(viewportOf(container).scrollTop).toBe(line3003InHunks);
	});

	it("opens the same file in another commit at its top", async () => {
		const inCommit = { ...props, diffKind: "commit" as const };
		const { container, rerender } = render(DiffViewer, {
			props: { ...inCommit, commitOid: "aaaa" },
		});
		await scrollToLine(container, "line 3003");

		await rerender({ ...inCommit, commitOid: "bbbb", payloadStale: true });
		await rerender({
			...inCommit,
			commitOid: "bbbb",
			payloadStale: false,
			layoutMode: "split",
		});

		expect(await screen.findAllByText("line 1")).not.toHaveLength(0);
		expect(screen.queryAllByText("line 3003")).toHaveLength(0);
	});

	it("opens each cached file at the top of the reused viewport", async () => {
		const inBeta = {
			...props,
			diffKind: "commit" as const,
			commitOid: "aaaa",
			selectedPath: "beta.txt",
			fileDiffs: [{ ...hunks, path: "beta.txt" }],
		};
		const inAlpha = {
			...inBeta,
			selectedPath: "alpha.txt",
			fileDiffs: [{ ...hunks, path: "alpha.txt" }],
		};
		const { container, rerender } = render(DiffViewer, { props: inBeta });
		const viewport = viewportOf(container);
		await fireEvent.scroll(viewport, { target: { scrollTop: 4_800 } });

		await rerender(inAlpha);

		expect(viewportOf(container)).toBe(viewport);
		expect(viewport.scrollTop).toBe(0);

		await fireEvent.scroll(viewport, { target: { scrollTop: 2_400 } });
		await rerender(inBeta);

		expect(viewport.scrollTop).toBe(0);
	});

	it("keeps the viewport in place when the same file's payload is refreshed", async () => {
		const { container, rerender } = render(DiffViewer, { props });
		const viewport = viewportOf(container);
		await fireEvent.scroll(viewport, { target: { scrollTop: 2_400 } });

		await rerender({ ...props, loading: true });
		await rerender({ ...props, fileDiffs: [{ ...hunks }] });

		expect(viewportOf(container)).toBe(viewport);
		expect(viewport.scrollTop).toBe(2_400);
	});

	// The side-by-side view takes the content mode itself, so it sees the new
	// mode one render before the stale payload unmounts it.
	it.each([
		["inline", "inline" as const],
		["side-by-side", "split" as const],
	])(
		"keeps the line at the top when the %s hunks give way to the whole file",
		async (_, layoutMode) => {
			const { container, rerender } = render(DiffViewer, {
				props: { ...props, layoutMode },
			});
			await scrollToLine(container, "line 3003");

			await rerender({
				...props,
				layoutMode,
				contentMode: "full",
				payloadStale: true,
			});
			await rerender({
				...props,
				layoutMode,
				contentMode: "full",
				payloadStale: false,
				fileDiffs: [wholeFile],
			});

			expect(await screen.findAllByText("line 3003")).not.toHaveLength(0);
			// The whole file has no hunk headers, so 3002 lines sit above.
			expect(viewportOf(container).scrollTop).toBe(3002 * 18);
		},
	);

	it("keeps the line at the top when the inline whole file goes side by side", async () => {
		const whole = {
			...props,
			contentMode: "full" as const,
			fileDiffs: [wholeFile],
		};
		const { container, rerender } = render(DiffViewer, {
			props: { ...whole, layoutMode: "inline" },
		});
		const viewport = viewportOf(container);
		viewport.scrollTop = 3002 * 18;
		viewport.dispatchEvent(new Event("scroll"));
		expect(await screen.findAllByText("line 3003")).not.toHaveLength(0);

		await rerender({ ...whole, layoutMode: "split" });

		expect(await screen.findAllByText("line 3003")).not.toHaveLength(0);
		expect(viewportOf(container).scrollTop).toBe(3002 * 18);
	});

	it("opens hunks at the last displayed context when reading the unchanged tail", async () => {
		const whole = {
			...props,
			contentMode: "full" as const,
			fileDiffs: [wholeFile],
		};
		const changes = bigFile([
			hunkOf(97, 103),
			hunkOf(197, 203),
			hunkOf(297, 303),
		]);
		const { container, rerender } = render(DiffViewer, { props: whole });
		await fireEvent.scroll(viewportOf(container), {
			target: { scrollTop: 349 * 18 },
		});
		expect(screen.getByText("line 350")).toBeInTheDocument();

		await rerender({ ...props, fileDiffs: [changes] });

		expect(viewportOf(container).scrollTop).toBe(
			3 * FIXED_ROW_HEIGHTS.hunkHeader + 20 * 18,
		);
	});

	describe("when the reader turns word wrap on and off", () => {
		// Forty hunks of five lines, numbered from 1001 so every line has the same
		// length, and several times wider than the pane, so wrapping grows each of
		// the two hundred lines by the same height.
		const wide = " wide".repeat(80);
		const wideHunks = bigFile(
			Array.from({ length: 40 }, (_, i) =>
				hunkOf(i * 100 + 1001, i * 100 + 1005, wide),
			),
		);
		const wideProps = { ...props, fileDiffs: [wideHunks] };
		const header = FIXED_ROW_HEIGHTS.hunkHeader;
		const line = 18;

		const headerOffset = (hunk: number, lineHeight: number) =>
			hunk * (header + 5 * lineHeight);
		const lineOffset = (hunk: number, row: number, lineHeight: number) =>
			headerOffset(hunk, lineHeight) + header + row * lineHeight;

		const contentHeightOf = (container: Element) =>
			Number.parseFloat(
				(container.querySelector(".exact-virtual-content") as HTMLElement).style
					.height,
			);

		/** A wrapped line's height, from how much the content grew past its
		 *  `unwrapped` height. */
		const wrappedLineHeight = (container: Element, unwrapped: number) =>
			line + (contentHeightOf(container) - unwrapped) / 200;

		async function scrollTo(viewport: HTMLElement, top: number) {
			viewport.scrollTop = top;
			viewport.dispatchEvent(new Event("scroll"));
			await tick();
		}

		/** Renders the diff unwrapped, then wrapped, and returns the wrapped
		 *  height of one line. */
		async function renderWrapped(layoutMode: "inline" | "split") {
			const rendered = render(DiffViewer, {
				props: { ...wideProps, layoutMode },
			});
			const unwrapped = contentHeightOf(rendered.container);
			await rendered.rerender({ ...wideProps, layoutMode, wordWrap: true });
			return {
				...rendered,
				wrappedLine: wrappedLineHeight(rendered.container, unwrapped),
			};
		}

		const layouts: [string, "inline" | "split"][] = [
			["inline", "inline"],
			["side-by-side", "split"],
		];

		it.each(layouts)(
			"keeps the line at the top when the %s view wraps",
			async (_, layoutMode) => {
				const { container, rerender } = render(DiffViewer, {
					props: { ...wideProps, layoutMode },
				});
				const viewport = viewportOf(container);
				await scrollTo(viewport, lineOffset(30, 2, line));
				const unwrapped = contentHeightOf(container);

				await rerender({ ...wideProps, layoutMode, wordWrap: true });

				const wrappedLine = wrappedLineHeight(container, unwrapped);
				expect(viewport.scrollTop).toBe(lineOffset(30, 2, wrappedLine));
			},
		);

		it.each(layouts)(
			"keeps a hunk header at the top when the %s view wraps",
			async (_, layoutMode) => {
				const { container, rerender } = render(DiffViewer, {
					props: { ...wideProps, layoutMode },
				});
				const viewport = viewportOf(container);
				await scrollTo(viewport, headerOffset(30, line));
				const unwrapped = contentHeightOf(container);

				await rerender({ ...wideProps, layoutMode, wordWrap: true });

				const wrappedLine = wrappedLineHeight(container, unwrapped);
				expect(viewport.scrollTop).toBe(headerOffset(30, wrappedLine));
			},
		);

		it.each(layouts)(
			"keeps the line at the top when the %s view unwraps",
			async (_, layoutMode) => {
				const { container, rerender, wrappedLine } =
					await renderWrapped(layoutMode);
				const viewport = viewportOf(container);
				await scrollTo(viewport, lineOffset(30, 2, wrappedLine));

				await rerender({ ...wideProps, layoutMode, wordWrap: false });

				expect(viewport.scrollTop).toBe(lineOffset(30, 2, line));
				expect(screen.getAllByText(`line 4003${wide}`)).not.toHaveLength(0);
			},
		);
	});
});

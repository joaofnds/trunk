import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { type ComponentProps, tick } from "svelte";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";
import DiffPanel from "../__tests__/helpers/controlled-diff-panel.svelte";
import { restoreLayout, stubLayout } from "../__tests__/helpers/layout-stub";
import { aThread } from "../__tests__/helpers/thread-fixture.js";
import { DiffPreferences } from "../lib/diff-preferences.svelte.js";
import {
	pairLines,
	splitInvisibles,
	trailingWhitespaceStart,
} from "../lib/diff-utils.js";
import { safeInvoke } from "../lib/invoke.js";
import type { DiffRow as MarkdownRow } from "../lib/markdown.js";
import { createRemoteState } from "../lib/remote-state.svelte.js";
import { createReviewEditorStore } from "../lib/review-editors.svelte.js";
import type {
	CommitDetail,
	DiffLine,
	FileDiff,
	ReviewFilter,
	Thread,
} from "../lib/types.js";
import type { StagingAction } from "./DiffPanel.svelte";

// Shared Tauri mock
import "../__tests__/helpers/tauri-mock";
import { commentingDiff } from "../__tests__/helpers/review-props.js";
import PullDropdown from "./PullDropdown.svelte";

// Both inline views render through a virtual list, which mounts no rows at all
// against jsdom's zero-height viewport. The box is wide enough for the widest
// fixture line and tall enough that a two-hunk file mounts both toolbars.
beforeEach(() => stubLayout({ width: 900, height: 400 }));
afterEach(restoreLayout);

// The test host mounts the panel only once the store mock's settings promises
// resolve, the way App waits for the saved settings.
async function flushPrefs() {
	await Promise.resolve();
	await Promise.resolve();
	await tick();
}

function stagingCompletion(
	complete: (emptiedBy?: StagingAction) => Promise<void>,
) {
	return { isCurrent: () => true, complete };
}

// Selection now arms from the line-number gutter grip, not the code content, so
// press events must target the grip.
function gutterOf(text: string): HTMLElement {
	const grip = screen
		.getByText(text)
		.closest(".diff-line")
		?.querySelector("[data-gutter-grip]") as HTMLElement | null;
	if (!grip) throw new Error(`no gutter grip for "${text}"`);
	return grip;
}

// The full-file view's grip is a click target rather than a press one.
function fullFileGutterOf(text: string): HTMLElement {
	const grip = screen
		.getByText(text)
		.closest("[data-flat-index]")
		?.querySelector("[data-gutter-grip]") as HTMLElement | null;
	if (!grip) throw new Error(`no full-file gutter grip for "${text}"`);
	return grip;
}

// Mock invoke and toast for hunk staging operations. Every command resolves to
// undefined; tests that need a return value override safeInvoke per case.
const { backendReply } = vi.hoisted(() => {
	const lineActions = new Set([
		"stage_hunk",
		"unstage_hunk",
		"discard_hunk",
		"stage_lines",
		"unstage_lines",
		"discard_lines",
	]);
	return {
		backendReply: (command: string) =>
			Promise.resolve(
				lineActions.has(command) ? { file_still_changed: true } : undefined,
			),
	};
});

vi.mock("../lib/invoke.js", async () => {
	const actual =
		await vi.importActual<typeof import("../lib/invoke.js")>(
			"../lib/invoke.js",
		);
	return {
		...actual,
		safeInvoke: vi.fn(backendReply),
	};
});

vi.mock("../lib/toast.svelte.js", () => ({
	showToast: vi.fn(),
}));

vi.mock("../lib/store.js", () => {
	let currentContentMode = "hunk";
	let currentLayoutMode = "inline";
	let currentIgnoreWhitespace = false;
	let currentShowInvisibles = false;
	let currentWordWrap = false;
	let currentRenderMode = "source";
	let currentRenderedStyle = "copies";
	return {
		getRenderMode: vi.fn(() => Promise.resolve(currentRenderMode)),
		setRenderMode: vi.fn((mode: string) => {
			currentRenderMode = mode;
			return Promise.resolve(undefined);
		}),
		getRenderedDiffStyle: vi.fn(() => Promise.resolve(currentRenderedStyle)),
		setRenderedDiffStyle: vi.fn((style: string) => {
			currentRenderedStyle = style;
			return Promise.resolve(undefined);
		}),
		getDiffContextLines: vi.fn(() => Promise.resolve(3)),
		getDiffContentMode: vi.fn(() => Promise.resolve(currentContentMode)),
		setDiffContentMode: vi.fn((mode: string) => {
			currentContentMode = mode;
			return Promise.resolve(undefined);
		}),
		getDiffLayoutMode: vi.fn(() => Promise.resolve(currentLayoutMode)),
		setDiffLayoutMode: vi.fn((mode: string) => {
			currentLayoutMode = mode;
			return Promise.resolve(undefined);
		}),
		getDiffIgnoreWhitespace: vi.fn(() =>
			Promise.resolve(currentIgnoreWhitespace),
		),
		setDiffIgnoreWhitespace: vi.fn((v: boolean) => {
			currentIgnoreWhitespace = v;
			return Promise.resolve(undefined);
		}),
		getDiffShowInvisibles: vi.fn(() => Promise.resolve(currentShowInvisibles)),
		setDiffShowInvisibles: vi.fn((v: boolean) => {
			currentShowInvisibles = v;
			return Promise.resolve(undefined);
		}),
		getDiffWordWrap: vi.fn(() => Promise.resolve(currentWordWrap)),
		setDiffWordWrap: vi.fn((v: boolean) => {
			currentWordWrap = v;
			return Promise.resolve(undefined);
		}),
		addRecentRepo: vi.fn().mockResolvedValue(undefined),
		getRecentRepos: vi.fn().mockResolvedValue([]),
		removeRecentRepo: vi.fn().mockResolvedValue(undefined),
		getPersistedTabs: vi.fn().mockResolvedValue([]),
		setPersistedTabs: vi.fn().mockResolvedValue(undefined),
	};
});

const testDiff: FileDiff = {
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
			header: "@@ -1,3 +1,4 @@",
			old_start: 1,
			old_lines: 3,
			new_start: 1,
			new_lines: 4,
			lines: [
				{
					origin: "Context",
					content: "import { foo } from 'bar';",
					old_lineno: 1,
					new_lineno: 1,
					spans: [],
				},
				{
					origin: "Delete",
					content: "const x = 1;",
					old_lineno: 2,
					new_lineno: null,
					spans: [],
				},
				{
					origin: "Add",
					content: "const x = 2;",
					old_lineno: null,
					new_lineno: 2,
					spans: [],
				},
				{
					origin: "Add",
					content: "const y = 3;",
					old_lineno: null,
					new_lineno: 3,
					spans: [],
				},
				{
					origin: "Context",
					content: "export { x };",
					old_lineno: 3,
					new_lineno: 4,
					spans: [],
				},
			],
		},
	],
};

function shiftDiffLines(file: FileDiff, offset: number): FileDiff {
	return {
		...file,
		hunks: file.hunks.map((hunk) => ({
			...hunk,
			old_start: hunk.old_start + offset,
			new_start: hunk.new_start + offset,
			lines: hunk.lines.map((line) => ({
				...line,
				old_lineno: line.old_lineno === null ? null : line.old_lineno + offset,
				new_lineno: line.new_lineno === null ? null : line.new_lineno + offset,
			})),
		})),
	};
}

const binaryDiff: FileDiff = {
	path: "image.png",
	old_path: null,
	status: "Modified",
	is_binary: true,
	old_size: 1200,
	new_size: 3400,
	old_id: null,
	new_id: null,
	hunks: [],
};

const untrackedDiff: FileDiff = {
	path: "src/new.ts",
	old_path: null,
	status: "Untracked",
	is_binary: false,
	old_size: null,
	new_size: null,
	old_id: null,
	new_id: null,
	hunks: [
		{
			header: "@@ -0,0 +1,1 @@",
			old_start: 0,
			old_lines: 0,
			new_start: 1,
			new_lines: 1,
			lines: [
				{
					origin: "Add",
					content: "const fresh = true;",
					old_lineno: null,
					new_lineno: 1,
					spans: [],
				},
			],
		},
	],
};

const testDiffWithMergedSpans: FileDiff = {
	path: "src/main.rs",
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
					origin: "Delete",
					content: "hello world",
					old_lineno: 1,
					new_lineno: null,
					spans: [
						{
							start: 0,
							end: 6,
							syntax_class: "syn-keyword",
							emphasized: false,
						},
						{ start: 6, end: 11, syntax_class: "syn-string", emphasized: true },
					],
				},
				{
					origin: "Add",
					content: "hello mars",
					old_lineno: null,
					new_lineno: 1,
					spans: [
						{
							start: 0,
							end: 6,
							syntax_class: "syn-keyword",
							emphasized: false,
						},
						{ start: 6, end: 10, syntax_class: "syn-string", emphasized: true },
					],
				},
			],
		},
	],
};

describe("DiffPanel", () => {
	it("renders hunk header", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		expect(screen.getByText("@@ -1,3 +1,4 @@")).toBeInTheDocument();
	});

	it("renders added lines with + marker", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		expect(screen.getByText("const x = 2;")).toBeInTheDocument();
	});

	it("renders deleted lines with - marker", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		expect(screen.getByText("const x = 1;")).toBeInTheDocument();
	});

	it("renders context lines", async () => {
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		// Context lines rendered as " " + content (space marker + content)
		// Testing Library normalizes leading whitespace, so check raw textContent
		const bodyText = container.textContent ?? "";
		expect(bodyText).toContain("import { foo } from 'bar';");
		expect(bodyText).toContain("export { x };");
	});

	it("renders file path in multi-file view", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				selectedPath: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		// When selectedPath is null, file header bar shows the path
		expect(screen.getByText("src/main.ts")).toBeInTheDocument();
	});

	it("shows a binary file's size on each side", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [binaryDiff],
				commitDetail: null,
				selectedPath: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		expect(
			screen.getByText("Binary file, 1.2 KB → 3.4 KB"),
		).toBeInTheDocument();
	});

	describe.each([
		["Show full file"],
		["Side-by-side view"],
		["Ignore whitespace changes"],
		["Show invisible characters"],
		[/word wrap/i],
	])("the %s control", (title) => {
		function open(file: FileDiff) {
			render(DiffPanel, {
				props: {
					...commentingDiff,
					fileDiffs: [file],
					commitDetail: null,
					selectedPath: file.path,
					onclose: vi.fn(),
				},
			});
			return flushPrefs();
		}

		it("is not offered for a binary file, which has no lines to view", async () => {
			await open(binaryDiff);
			expect(screen.queryByTitle(title)).toBeNull();
		});

		it("is offered for a text file", async () => {
			await open(testDiff);
			expect(screen.getByTitle(title)).toBeInTheDocument();
		});
	});

	it("calls onclose when close button clicked", async () => {
		const onclose = vi.fn();
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose,
			},
		});
		await flushPrefs();
		const closeBtn = screen.getByLabelText("Close diff");
		await fireEvent.click(closeBtn);
		expect(onclose).toHaveBeenCalledOnce();
	});

	it("shows Stage Hunk button for unstaged diffs", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
			},
		});
		await flushPrefs();
		expect(screen.getByText("Stage Hunk")).toBeInTheDocument();
		expect(screen.getByText("Discard Hunk")).toBeInTheDocument();
	});

	it("names no change for a file opened whole, which shows no change", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [{ ...testDiff, status: "Unknown" }],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "current_file",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
			},
		});
		await flushPrefs();

		expect(screen.queryByTestId("diff-status-badge")).toBeNull();
	});

	it("shows a Comment File button for unstaged diffs", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
			},
		});
		await flushPrefs();
		expect(screen.getByText("Comment File")).toBeInTheDocument();
	});

	it("shows a Comment File button for staged diffs", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "staged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
			},
		});
		await flushPrefs();
		expect(screen.getByText("Comment File")).toBeInTheDocument();
	});

	it("shows a Comment File button for commit diffs", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
			},
		});
		await flushPrefs();
		expect(screen.getByText("Comment File")).toBeInTheDocument();
	});

	it("counts the selected file's threads by state in its header", async () => {
		const on = (id: string, path: string, state: "open" | "addressed") =>
			aThread({
				id,
				state,
				anchor: {
					commit_oid: "abc123",
					file_path: path,
					source: "Diff",
					side: "New",
					start_line: 2,
					end_line: 2,
				},
			});
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				viewComments: [
					on("t1", "src/main.ts", "open"),
					on("t2", "src/main.ts", "addressed"),
					on("t3", "src/other.ts", "open"),
				],
			},
		});
		await flushPrefs();

		expect(
			screen.getByRole("img", {
				name: "2 review comments, 1 open and 1 addressed",
			}),
		).toBeInTheDocument();
	});

	it("shows no count in the header while every thread is hidden", async () => {
		const open = aThread({
			id: "t1",
			state: "open",
			anchor: {
				commit_oid: "abc123",
				file_path: "src/main.ts",
				source: "Diff",
				side: "New",
				start_line: 2,
				end_line: 2,
			},
		});
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				viewComments: [open],
				reviewFilter: "none",
			},
		});
		await flushPrefs();

		expect(screen.queryByRole("img", { name: /review comment/ })).toBeNull();
	});

	// Comment File anchors the WHOLE file: every new-side line. testDiff's new side is
	// new_lineno 1,2,3,4 (Context 1, Add 2, Add 3, Context 4), so the composer opens
	// over lines 1-4 — not a single hunk's sub-range.
	it("opens the composer over the file's full new-side range on Comment File click", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				contentMode: "full",
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Comment File"));
		await flushPrefs();

		expect(screen.getByText("Comment on this file")).toHaveAttribute(
			"title",
			"Lines 1-4",
		);
	});

	// Which comes first in the diff: the composer or a line.
	function composerThenLines(): string[] {
		return [
			...document.querySelectorAll(
				".composer-row, .inline-composer-row, .diff-line",
			),
		]
			.filter((el) => !el.classList.contains("metrics-probe"))
			.map((el) => (el.classList.contains("diff-line") ? "line" : "composer"));
	}

	it("opens a comment on the whole file above the file's first line", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				contentMode: "full",
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Comment File"));
		await flushPrefs();

		expect(composerThenLines().slice(0, 2)).toEqual(["composer", "line"]);
	});

	it("opens a comment on the whole file above the hunks in hunk mode", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				onloadfullfile: async () => testDiff,
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Comment File"));
		await flushPrefs();

		expect(composerThenLines().slice(0, 2)).toEqual(["composer", "line"]);
	});

	it("loads the whole file before commenting from hunk mode", async () => {
		const hunkOnlyDiff = shiftDiffLines(testDiff, 39);
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [hunkOnlyDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				onloadfullfile: async (filePath) =>
					filePath === "src/main.ts" ? testDiff : null,
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Comment File"));
		await flushPrefs();

		expect(screen.getByText("Comment on this file")).toHaveAttribute(
			"title",
			"Lines 1-4",
		);
		expect(screen.getByTitle("Show full file")).toBeInTheDocument();
	});

	it("loads the whole file while a full-mode payload is still pending", async () => {
		const hunkOnlyDiff = shiftDiffLines(testDiff, 39);
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [hunkOnlyDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				contentMode: "full",
				loading: true,
				onloadfullfile: async () => testDiff,
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Comment File"));
		await flushPrefs();

		expect(screen.getByText("Comment on this file")).toHaveAttribute(
			"title",
			"Lines 1-4",
		);
	});

	it("stretches the comment composer across the diff panel", async () => {
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				contentMode: "full",
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Comment File"));
		await flushPrefs();
		const composer = container.querySelector(
			".comment-composer",
		) as HTMLElement;
		const style = getComputedStyle(composer);

		expect(style.width).toBe("100%");
		expect(style.boxSizing).toBe("border-box");
	});

	// Regression (260531-l02): opening a whole-hunk comment captures the anchor
	// up-front. A working-tree comment writes a snapshot commit, which fires a
	// repo-changed → diff refetch → clearSelection mid-compose. Previously the
	// composer re-derived its range from the now-empty selection → Math.min(...[])
	// = Infinity. The captured anchor must survive a fileDiffs reload.
	it("keeps the whole-hunk comment range finite when the diff reloads mid-compose", async () => {
		const baseProps = {
			...commentingDiff,
			commitDetail: null,
			onclose: vi.fn(),
			diffKind: "unstaged" as const,
			repoPath: "/test/repo",
		};
		const { rerender } = render(DiffPanel, {
			props: { ...baseProps, fileDiffs: [testDiff] },
		});
		await flushPrefs();

		// Whole-hunk comment with NO prior line selection.
		await fireEvent.click(screen.getByText("Comment"));
		await flushPrefs();

		// New-side lines of the hunk are new_lineno 2 and 3.
		expect(screen.getByText("Comments on lines 2-3")).toBeInTheDocument();

		// A fresh fileDiffs reference reproduces the repo-changed reload that fires
		// clearSelection. The captured range must be unaffected — never Infinity.
		await rerender({ ...baseProps, fileDiffs: [testDiff] });
		await flushPrefs();

		expect(screen.getByText("Comments on lines 2-3")).toBeInTheDocument();
		expect(screen.queryByText(/Infinity/)).not.toBeInTheDocument();
	});

	it("keeps the full-file comment anchor when the diff reloads mid-compose", async () => {
		const reloadedFile = shiftDiffLines(testDiff, 39);
		const baseProps = {
			...commentingDiff,
			commitDetail: null,
			onclose: vi.fn(),
			diffKind: "unstaged" as const,
			repoPath: "/test/repo",
			selectedPath: "src/main.ts",
			contentMode: "full" as const,
		};
		const view = render(DiffPanel, {
			props: { ...baseProps, fileDiffs: [testDiff] },
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Comment File"));
		await flushPrefs();
		expect(screen.getByTitle("Lines 1-4")).toBeInTheDocument();

		await view.rerender({ ...baseProps, fileDiffs: [reloadedFile] });
		await flushPrefs();

		expect(screen.getByTitle("Lines 1-4")).toBeInTheDocument();
		expect(screen.queryByTitle("Lines 40-43")).not.toBeInTheDocument();
	});

	it("blocks a retained composer after the active review changes", async () => {
		const editorStore = createReviewEditorStore();
		const composerSession = editorStore.composer();
		const baseProps = {
			...commentingDiff,
			fileDiffs: [testDiff],
			commitDetail: nonMergeCommit,
			onclose: vi.fn(),
			diffKind: "commit" as const,
			repoPath: "/repo",
			activeReviewId: "review-a",
			composerSession,
		};
		let view = render(DiffPanel, { props: baseProps });
		await flushPrefs();
		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: /^Comment \(/ }));
		await flushPrefs();

		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "comment from review A" },
		});
		view.unmount();
		view = render(DiffPanel, { props: baseProps });
		await flushPrefs();
		expect(screen.getByRole("textbox")).toHaveValue("comment from review A");

		await view.rerender({ ...baseProps, activeReviewId: "review-b" });

		const submit = screen.getByRole("button", { name: "Add comment" });
		expect(submit).toBeDisabled();
		await fireEvent.click(submit);
		expect(
			vi.mocked(safeInvoke).mock.calls.map((call) => call[0]),
		).not.toContain("add_thread");

		await view.rerender({ ...baseProps, activeReviewId: "review-a" });
		expect(screen.getByRole("button", { name: "Add comment" })).toBeEnabled();
		await fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
		await flushPrefs();
		expect(vi.mocked(safeInvoke).mock.calls.map((call) => call[0])).toContain(
			"add_thread",
		);
	});

	it("blocks a retained full-file composer when comments are unavailable", async () => {
		const editorStore = createReviewEditorStore();
		const target = {
			context: "normal" as const,
			kind: "commit" as const,
			commitOid: nonMergeCommit.oid,
			compareBaseOid: "compare-base",
			filePath: "src/main.ts",
		};
		const composerSession = editorStore.composer(target, "review-a");
		composerSession.openFullFile(
			"src/main.ts",
			{
				anchor: {
					commit_oid: nonMergeCommit.oid,
					file_path: "src/main.ts",
					source: "FullFile",
					side: "New",
					start_line: 2,
					end_line: 2,
				},
				cachedExcerpt: "+ const x = 2;",
			},
			"review-a",
			target,
		);
		const props = {
			...commentingDiff,
			fileDiffs: [testDiff],
			commitDetail: nonMergeCommit,
			compareBaseOid: "compare-base",
			selectedPath: "src/main.ts",
			onclose: vi.fn(),
			diffKind: "commit" as const,
			repoPath: "/repo",
			activeReviewId: "review-a",
			takesComments: false,
			contentMode: "full" as const,
			composerSession,
			composerTarget: target,
		};
		render(DiffPanel, { props });
		await flushPrefs();

		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "comment on a compare" },
		});
		const submit = screen.getByRole("button", { name: "Add comment" });
		vi.mocked(safeInvoke).mockClear();
		await fireEvent.click(submit);

		expect(submit).toBeDisabled();
		expect(
			vi.mocked(safeInvoke).mock.calls.map((call) => call[0]),
		).not.toContain("add_thread");
	});

	it("hides a retained composer after the diff target changes", async () => {
		const editorStore = createReviewEditorStore();
		const composerSession = editorStore.composer();
		const baseProps = {
			...commentingDiff,
			fileDiffs: [testDiff],
			commitDetail: nonMergeCommit,
			onclose: vi.fn(),
			diffKind: "commit" as const,
			repoPath: "/repo",
			activeReviewId: "review-a",
			composerSession,
		};
		const view = render(DiffPanel, { props: baseProps });
		await flushPrefs();
		await fireEvent.click(screen.getByText("Comment"));
		await flushPrefs();
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "comment for the first commit" },
		});

		await view.rerender({
			...baseProps,
			commitDetail: { ...nonMergeCommit, oid: "other-commit" },
		});
		await flushPrefs();

		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
		expect(composerSession.draft.text).toBe("comment for the first commit");
	});

	it("does not close a replacement target when an older submit resolves", async () => {
		const editorStore = createReviewEditorStore();
		const targetA = {
			context: "normal" as const,
			kind: "commit" as const,
			commitOid: nonMergeCommit.oid,
			compareBaseOid: null,
			filePath: null,
		};
		const targetB = { ...targetA, commitOid: "other-commit" };
		const sessionA = editorStore.composer(targetA);
		const sessionB = editorStore.composer(targetB);
		let releaseSubmit!: () => void;
		vi.mocked(safeInvoke).mockImplementation((command: string) =>
			command === "add_thread"
				? new Promise<void>((resolve) => {
						releaseSubmit = resolve;
					})
				: Promise.resolve(undefined),
		);
		const baseProps = {
			...commentingDiff,
			fileDiffs: [testDiff],
			commitDetail: nonMergeCommit,
			onclose: vi.fn(),
			diffKind: "commit" as const,
			repoPath: "/repo",
			activeReviewId: "review-a",
			composerSession: sessionA,
			composerTarget: targetA,
		};
		const view = render(DiffPanel, { props: baseProps });
		await flushPrefs();

		await fireEvent.click(screen.getByText("Comment"));
		await flushPrefs();
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "comment for target A" },
		});
		await fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
		await tick();

		sessionB.openDiff(
			{
				anchor: {
					commit_oid: "other-commit",
					file_path: "src/main.ts",
					source: "Diff",
					side: "New",
					start_line: 2,
					end_line: 2,
				},
				cachedExcerpt: "+ target B",
			},
			"review-a",
			targetB,
		);
		sessionB.draft.text = "draft for target B";
		await view.rerender({
			...baseProps,
			commitDetail: { ...nonMergeCommit, oid: "other-commit" },
			composerSession: sessionB,
			composerTarget: targetB,
		});
		await flushPrefs();

		expect(screen.getByRole("textbox")).toHaveValue("draft for target B");
		releaseSubmit();
		await flushPrefs();

		expect(screen.getByRole("textbox")).toHaveValue("draft for target B");
		expect(sessionB.draft.text).toBe("draft for target B");
		view.unmount();
	});

	it("shows Unstage Hunk button for staged diffs", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "staged",
				repoPath: "/test/repo",
			},
		});
		await flushPrefs();
		expect(screen.getByText("Unstage Hunk")).toBeInTheDocument();
	});

	it("does not show hunk action buttons for commit diffs", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "commit",
			},
		});
		await flushPrefs();
		expect(screen.queryByText("Stage Hunk")).toBeNull();
		expect(screen.queryByText("Unstage Hunk")).toBeNull();
		expect(screen.queryByText("Discard Hunk")).toBeNull();
	});

	it("renders word-span highlights for emphasized segments", async () => {
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiffWithMergedSpans],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		const deleteSpans = container.querySelectorAll(".word-delete");
		const addSpans = container.querySelectorAll(".word-add");
		expect(deleteSpans.length).toBeGreaterThanOrEqual(1);
		expect(addSpans.length).toBeGreaterThanOrEqual(1);
		const deleteTexts = Array.from(deleteSpans).map((el) => el.textContent);
		const addTexts = Array.from(addSpans).map((el) => el.textContent);
		expect(deleteTexts).toContain("world");
		expect(addTexts).toContain("mars");
	});

	it("renders non-emphasized spans without highlight class", async () => {
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiffWithMergedSpans],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		// "hello " text should not be inside a .word-add or .word-delete element
		const highlightedEls = container.querySelectorAll(
			".word-add, .word-delete",
		);
		const highlightedTexts = Array.from(highlightedEls).map(
			(el) => el.textContent,
		);
		// None of the highlighted spans should contain "hello "
		for (const text of highlightedTexts) {
			expect(text).not.toContain("hello ");
		}
		// But the container should still have "hello " in the rendered text
		expect(container.textContent).toContain("hello ");
	});

	it("falls back to plain rendering when spans is empty", async () => {
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		// No word-span highlight elements should exist
		expect(container.querySelectorAll(".word-add").length).toBe(0);
		expect(container.querySelectorAll(".word-delete").length).toBe(0);
		// Line content still renders with origin symbols
		expect(container.textContent).toContain("const x = 2;");
	});

	it("renders syntax class on span elements", async () => {
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiffWithMergedSpans],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		const keywordSpans = container.querySelectorAll(".syn-keyword");
		expect(keywordSpans.length).toBeGreaterThanOrEqual(1);
		const stringSpans = container.querySelectorAll(".syn-string");
		expect(stringSpans.length).toBeGreaterThanOrEqual(1);
	});

	it("applies opacity reduction class on add/delete lines", async () => {
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiffWithMergedSpans],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		// Verify diff-line-add and diff-line-delete classes exist on line containers
		const addLines = container.querySelectorAll(".diff-line-add");
		const deleteLines = container.querySelectorAll(".diff-line-delete");
		expect(addLines.length).toBeGreaterThanOrEqual(1);
		expect(deleteLines.length).toBeGreaterThanOrEqual(1);
	});

	it("renders syntax and word-diff classes simultaneously on emphasized spans", async () => {
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiffWithMergedSpans],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		// Emphasized spans on Delete lines should have both syn-string and word-delete
		const combinedSpans = container.querySelectorAll(".syn-string.word-delete");
		expect(combinedSpans.length).toBeGreaterThanOrEqual(1);
		// Emphasized spans on Add lines should have both syn-string and word-add
		const combinedAddSpans = container.querySelectorAll(".syn-string.word-add");
		expect(combinedAddSpans.length).toBeGreaterThanOrEqual(1);
	});

	// ---- VIEW-01: View mode toggle tests ----

	it("renders content mode and layout mode toggle buttons", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		// Content toggle shows "Show full file" in hunk mode (default)
		expect(screen.getByTitle("Show full file")).toBeInTheDocument();
		// Layout toggle shows "Side-by-side view" in inline mode (default)
		expect(screen.getByTitle("Side-by-side view")).toBeInTheDocument();
	});

	it("shows hunk view by default", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		expect(screen.getByText("@@ -1,3 +1,4 @@")).toBeInTheDocument();
	});

	it("shows full file view when content toggle clicked", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		// Let the initial $effect settle
		await flushPrefs();
		await fireEvent.click(screen.getByTitle("Show full file"));
		// Flush Svelte reactivity
		await flushPrefs();
		// Full file view renders diff content (no hunk headers)
		expect(screen.queryByText("@@ -1,3 +1,4 @@")).toBeNull();
	});

	it("shows split view with panels when Split mode selected", async () => {
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		// Let the persisted layout preference settle
		await flushPrefs();
		await fireEvent.click(screen.getByTitle("Side-by-side view"));
		// Flush Svelte reactivity
		await flushPrefs();
		// Split view should render paired rows with two cells each
		const rows = container.querySelectorAll(".split-row");
		expect(rows.length).toBeGreaterThan(0);
	});

	// ---- DISP-01: Line number gutter tests ----

	it("renders line numbers in gutter for context lines", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		// Context lines have both old_lineno and new_lineno set
		// The first context line has old_lineno: 1, new_lineno: 1
		// Each diff line div has two gutter spans as the first two children
		const contextLines = container.querySelectorAll(".diff-line-context");
		expect(contextLines.length).toBeGreaterThanOrEqual(1);
		// First context line: old=1, new=1
		const firstContext = contextLines[0];
		const gutterSpans = firstContext.querySelectorAll(".gutter-num");
		// At least 2 gutter spans (old + new) per line
		expect(gutterSpans.length).toBeGreaterThanOrEqual(2);
		// Both gutter spans should contain "1"
		expect(gutterSpans[0].textContent).toBe("1");
		expect(gutterSpans[1].textContent).toBe("1");
	});

	it("shows only new line number for Add lines", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		const addLines = container.querySelectorAll(".diff-line-add");
		expect(addLines.length).toBeGreaterThanOrEqual(1);
		for (const addLine of addLines) {
			const spans = addLine.querySelectorAll(".gutter-num");
			// First span is old gutter (should be empty), second is new gutter (should have number)
			expect(spans[0].textContent).toBe("");
			expect(spans[1].textContent?.trim()).not.toBe("");
		}
	});

	it("shows only old line number for Delete lines", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		const deleteLines = container.querySelectorAll(".diff-line-delete");
		expect(deleteLines.length).toBeGreaterThanOrEqual(1);
		for (const deleteLine of deleteLines) {
			const spans = deleteLine.querySelectorAll(".gutter-num");
			// First span is old gutter (should have number), second is new gutter (should be empty)
			expect(spans[0].textContent?.trim()).not.toBe("");
			expect(spans[1].textContent).toBe("");
		}
	});
});

// ---- diff-utils unit tests (WHSP-03) ----

describe("diff-utils", () => {
	describe("splitInvisibles", () => {
		it("keeps the real space and exposes a middle-dot glyph (WHSP-03)", () => {
			const result = splitInvisibles("a b", false);
			expect(result).toEqual([
				{ text: "a", glyph: "", isInvisible: false, isTrailing: false },
				{ text: " ", glyph: "\u00B7", isInvisible: true, isTrailing: false },
				{ text: "b", glyph: "", isInvisible: false, isTrailing: false },
			]);
		});

		it("keeps the real tab and exposes a rightwards-arrow glyph (WHSP-03)", () => {
			const result = splitInvisibles("a\tb", false);
			expect(result).toEqual([
				{ text: "a", glyph: "", isInvisible: false, isTrailing: false },
				{ text: "\t", glyph: "\u2192", isInvisible: true, isTrailing: false },
				{ text: "b", glyph: "", isInvisible: false, isTrailing: false },
			]);
		});

		it("marks trailing whitespace segments", () => {
			const result = splitInvisibles("  ", true);
			expect(result).toEqual([
				{
					text: "  ",
					glyph: "\u00B7\u00B7",
					isInvisible: true,
					isTrailing: true,
				},
			]);
		});

		it("returns empty array for empty string", () => {
			expect(splitInvisibles("", false)).toEqual([]);
		});

		it("handles mixed spaces and tabs", () => {
			const result = splitInvisibles(" \t", false);
			expect(result).toEqual([
				{
					text: " \t",
					glyph: "\u00B7\u2192",
					isInvisible: true,
					isTrailing: false,
				},
			]);
		});
	});

	describe("trailingWhitespaceStart", () => {
		it("returns index where trailing whitespace begins (WHSP-03)", () => {
			expect(trailingWhitespaceStart("hello   ")).toBe(5);
		});

		it("returns string length when no trailing whitespace", () => {
			expect(trailingWhitespaceStart("hello")).toBe(5);
		});

		it("returns 0 for all-whitespace string", () => {
			expect(trailingWhitespaceStart("   ")).toBe(0);
		});

		it("handles tabs in trailing whitespace", () => {
			expect(trailingWhitespaceStart("hello\t")).toBe(5);
		});
	});
});

// ---- VIEW-04: Full file view ----

describe("VIEW-04: Full file view", () => {
	it("renders all lines as continuous document without hunk headers", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		await fireEvent.click(screen.getByTitle("Show full file"));
		await flushPrefs();
		// Hunk header should not be present
		expect(screen.queryByText("@@ -1,3 +1,4 @@")).toBeNull();
		// But diff content should be present
		expect(container.textContent).toContain("const x = 2;");
	});

	it("shows line numbers in gutter for full file view", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		await fireEvent.click(screen.getByTitle("Show full file"));
		await flushPrefs();
		// Context lines should have gutter numbers
		const contextLines = container.querySelectorAll(".diff-line-context");
		expect(contextLines.length).toBeGreaterThanOrEqual(1);
		const gutterSpans = contextLines[0].querySelectorAll(".gutter-num");
		expect(gutterSpans.length).toBeGreaterThanOrEqual(2);
		// First context line: old=1, new=1
		expect(gutterSpans[0].textContent).toBe("1");
		expect(gutterSpans[1].textContent).toBe("1");
	});

	it("does not show staging buttons in full file view", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
			},
		});
		await flushPrefs();
		await fireEvent.click(screen.getByTitle("Show full file"));
		await flushPrefs();
		expect(screen.queryByText("Stage Hunk")).toBeNull();
		expect(screen.queryByText("Discard Hunk")).toBeNull();
	});
});

describe("VIEW-04: a large full-file payload", () => {
	it("keeps the rendered row window bounded", async () => {
		const bigFile: FileDiff = {
			path: "src/huge.ts",
			old_path: null,
			status: "Modified",
			is_binary: false,
			old_size: null,
			new_size: null,
			old_id: null,
			new_id: null,
			hunks: [
				{
					header: "@@ -1,5000 +1,5000 @@",
					old_start: 1,
					old_lines: 5000,
					new_start: 1,
					new_lines: 5000,
					lines: Array.from({ length: 5000 }, (_, index) => ({
						origin: "Context" as const,
						content: `line ${index}`,
						old_lineno: index + 1,
						new_lineno: index + 1,
						spans: [],
					})),
				},
			],
		};

		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				contentMode: "full",
				fileDiffs: [bigFile],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});

		await flushPrefs();

		expect(container.querySelectorAll(".diff-line").length).toBeLessThan(200);
	});
});

// ---- WHSP-02 / TRUNK-73: staging under the view's options ----

describe("TRUNK-73: staging carries the view's diff options", () => {
	async function renderWithIgnoreWhitespace() {
		const storeMock = await import("../lib/store.js");
		// Reset modes to inline+hunk (previous tests may have changed them)
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
		vi.mocked(storeMock.getDiffIgnoreWhitespace).mockImplementation(() =>
			Promise.resolve(true),
		);

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
			},
		});
		await flushPrefs();
		await flushPrefs();

		return () =>
			vi
				.mocked(storeMock.getDiffIgnoreWhitespace)
				.mockImplementation(() => Promise.resolve(false));
	}

	// Staging used to be blocked here, because the backend rebuilt the diff
	// without the view's options and could stage lines the view never showed.
	// It now receives those options, so the gesture is safe and available.
	it("keeps Stage Hunk usable while whitespace changes are ignored", async () => {
		const reset = await renderWithIgnoreWhitespace();

		const stageBtn = screen.getByText("Stage Hunk").closest("button");
		expect(stageBtn).not.toBeDisabled();

		reset();
	});

	it("sends the view's ignore-whitespace setting with the staging request", async () => {
		const reset = await renderWithIgnoreWhitespace();

		await fireEvent.click(screen.getByText("Stage Hunk"));
		await flushPrefs();

		const call = vi
			.mocked(safeInvoke)
			.mock.calls.find(([cmd]) => cmd === "stage_hunk");
		expect(call?.[1]).toMatchObject({
			options: expect.objectContaining({ ignoreWhitespace: true }),
		});

		reset();
	});
});

// ---- DISP-02: Word wrap toggle ----

describe("DISP-02: Word wrap toggle", () => {
	it("persists word wrap preference when toggle clicked", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
		vi.mocked(storeMock.getDiffWordWrap).mockImplementation(() =>
			Promise.resolve(false),
		);

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();

		// Click the word wrap toggle button
		const wrapBtn = screen.getByTitle("Toggle word wrap");
		await fireEvent.click(wrapBtn);
		await flushPrefs();

		// Verify that setDiffWordWrap was called with true
		expect(vi.mocked(storeMock.setDiffWordWrap)).toHaveBeenCalledWith(true);
	});

	it("word wrap toggle button becomes active when clicked", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
		vi.mocked(storeMock.getDiffWordWrap).mockImplementation(() =>
			Promise.resolve(false),
		);

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();

		const wrapBtn = screen.getByTitle("Toggle word wrap");
		expect(wrapBtn).toHaveAttribute("aria-pressed", "false");

		await fireEvent.click(wrapBtn);
		await flushPrefs();

		expect(wrapBtn).toHaveAttribute("aria-pressed", "true");
	});
});

// ---- pairLines unit tests ----

describe("pairLines", () => {
	it("pairs context lines on both sides", () => {
		const lines: DiffLine[] = [
			{
				origin: "Context",
				content: "hello",
				old_lineno: 1,
				new_lineno: 1,
				spans: [],
			},
		];
		const rows = pairLines(lines);
		expect(rows).toHaveLength(1);
		expect(rows[0].left?.line.content).toBe("hello");
		expect(rows[0].right?.line.content).toBe("hello");
	});

	it("pairs delete with add", () => {
		const lines: DiffLine[] = [
			{
				origin: "Delete",
				content: "old",
				old_lineno: 1,
				new_lineno: null,
				spans: [],
			},
			{
				origin: "Add",
				content: "new",
				old_lineno: null,
				new_lineno: 1,
				spans: [],
			},
		];
		const rows = pairLines(lines);
		expect(rows).toHaveLength(1);
		expect(rows[0].left?.line.content).toBe("old");
		expect(rows[0].right?.line.content).toBe("new");
	});

	it("creates phantom on right when more deletes than adds", () => {
		const lines: DiffLine[] = [
			{
				origin: "Delete",
				content: "a",
				old_lineno: 1,
				new_lineno: null,
				spans: [],
			},
			{
				origin: "Delete",
				content: "b",
				old_lineno: 2,
				new_lineno: null,
				spans: [],
			},
			{
				origin: "Add",
				content: "c",
				old_lineno: null,
				new_lineno: 1,
				spans: [],
			},
		];
		const rows = pairLines(lines);
		expect(rows).toHaveLength(2);
		expect(rows[0].left?.line.content).toBe("a");
		expect(rows[0].right?.line.content).toBe("c");
		expect(rows[1].left?.line.content).toBe("b");
		expect(rows[1].right).toBeNull(); // phantom
	});

	it("creates phantom on left when more adds than deletes", () => {
		const lines: DiffLine[] = [
			{
				origin: "Delete",
				content: "a",
				old_lineno: 1,
				new_lineno: null,
				spans: [],
			},
			{
				origin: "Add",
				content: "b",
				old_lineno: null,
				new_lineno: 1,
				spans: [],
			},
			{
				origin: "Add",
				content: "c",
				old_lineno: null,
				new_lineno: 2,
				spans: [],
			},
		];
		const rows = pairLines(lines);
		expect(rows).toHaveLength(2);
		expect(rows[0].left?.line.content).toBe("a");
		expect(rows[0].right?.line.content).toBe("b");
		expect(rows[1].left).toBeNull(); // phantom
		expect(rows[1].right?.line.content).toBe("c");
	});

	it("preserves original lineIdx for staging", () => {
		const lines: DiffLine[] = [
			{
				origin: "Context",
				content: "x",
				old_lineno: 1,
				new_lineno: 1,
				spans: [],
			},
			{
				origin: "Delete",
				content: "y",
				old_lineno: 2,
				new_lineno: null,
				spans: [],
			},
			{
				origin: "Add",
				content: "z",
				old_lineno: null,
				new_lineno: 2,
				spans: [],
			},
		];
		const rows = pairLines(lines);
		expect(rows[0].left?.lineIdx).toBe(0);
		expect(rows[1].left?.lineIdx).toBe(1);
		expect(rows[1].right?.lineIdx).toBe(2);
	});

	it("handles pure additions (no deletes)", () => {
		const lines: DiffLine[] = [
			{
				origin: "Add",
				content: "a",
				old_lineno: null,
				new_lineno: 1,
				spans: [],
			},
			{
				origin: "Add",
				content: "b",
				old_lineno: null,
				new_lineno: 2,
				spans: [],
			},
		];
		const rows = pairLines(lines);
		expect(rows).toHaveLength(2);
		expect(rows[0].left).toBeNull();
		expect(rows[0].right?.line.content).toBe("a");
		expect(rows[1].left).toBeNull();
		expect(rows[1].right?.line.content).toBe("b");
	});

	it("seats each line beside its partner when the word diff paired them", () => {
		const lines: DiffLine[] = [
			{
				origin: "Delete",
				content: "intro sentence",
				old_lineno: 1,
				new_lineno: null,
				spans: [],
				pairing: { kind: "alone" },
			},
			{
				origin: "Delete",
				content: "let total = sum(values);",
				old_lineno: 2,
				new_lineno: null,
				spans: [],
				pairing: { kind: "partner", line: 2 },
			},
			{
				origin: "Add",
				content: "let total = sum(values) + 1;",
				old_lineno: null,
				new_lineno: 1,
				spans: [],
				pairing: { kind: "partner", line: 1 },
			},
		];

		const rows = pairLines(lines);

		expect(rows).toHaveLength(2);
		expect(rows[0].left?.line.content).toBe("intro sentence");
		expect(rows[0].right).toBeNull();
		expect(rows[1].left?.line.content).toBe("let total = sum(values);");
		expect(rows[1].right?.line.content).toBe("let total = sum(values) + 1;");
		expect(rows[1].left?.lineIdx).toBe(1);
		expect(rows[1].right?.lineIdx).toBe(2);
	});

	it("never seats alone lines side by side", () => {
		const lines: DiffLine[] = [
			{
				origin: "Delete",
				content: "old prose, fully rewritten",
				old_lineno: 1,
				new_lineno: null,
				spans: [],
				pairing: { kind: "alone" },
			},
			{
				origin: "Add",
				content: "new prose, nothing shared",
				old_lineno: null,
				new_lineno: 1,
				spans: [],
				pairing: { kind: "alone" },
			},
		];

		const rows = pairLines(lines);

		expect(rows).toHaveLength(2);
		expect(rows[0].left?.line.content).toBe("old prose, fully rewritten");
		expect(rows[0].right).toBeNull();
		expect(rows[1].left).toBeNull();
		expect(rows[1].right?.line.content).toBe("new prose, nothing shared");
	});
});

// ---- VIEW-02: Split view layout ----

describe("VIEW-02: Split view layout", () => {
	it("folds a file's rows away when its header is clicked", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("split"),
		);
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				selectedPath: null,
				onclose: () => {},
			},
		});
		await flushPrefs();
		expect(container.querySelectorAll(".split-row")).not.toHaveLength(0);

		await fireEvent.click(
			screen.getByRole("button", { name: /src\/main\.ts/ }),
		);

		expect(container.querySelectorAll(".split-row")).toHaveLength(0);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
	});

	it("renders split view with paired rows when layout mode is split", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("split"),
		);

		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();

		// Split view should render paired rows with two cells each
		const rows = container.querySelectorAll(".split-row");
		expect(rows.length).toBeGreaterThan(0);
		// Each row should have two cells
		const firstRow = rows[0];
		expect(firstRow.querySelectorAll(".split-cell").length).toBe(2);

		// Reset
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
	});

	it("shows old line numbers only in left cell, new only in right", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("split"),
		);

		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();

		// One row per pair now, so both sides sit in the same row: the old number
		// belongs to the left cell and the new number to the right.
		const guttersOf = (text: string) => {
			const row = Array.from(container.querySelectorAll(".split-row")).find(
				(candidate) => candidate.textContent?.includes(text),
			) as Element;
			return Array.from(
				row.querySelectorAll(".split-gutter"),
				(gutter) => gutter.textContent,
			);
		};

		// A context line carries its own number on each side.
		expect(guttersOf("import { foo } from 'bar';")).toEqual(["1", "1"]);
		// The delete/add pair: old 2 on the left, new 2 on the right.
		expect(guttersOf("const x = 1;")).toEqual(["2", "2"]);
		// An add with nothing opposite it: the left half is a phantom with no
		// gutter at all, so the only number is the new-side one.
		expect(guttersOf("const y = 3;")).toEqual(["3"]);

		// Reset
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
	});

	it("does not show origin symbols in split view", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("split"),
		);

		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();

		// In split view, there should be no +/- origin symbols
		// The diff content "const x = 2;" should be present without the "+" prefix
		const bodyText = container.textContent ?? "";
		expect(bodyText).toContain("const x = 2;");
		// Verify paired rows rendered
		const rows = container.querySelectorAll(".split-row");
		expect(rows.length).toBeGreaterThan(0);

		// Reset
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
	});
});

// ---- VIEW-05: Staging in split view ----

describe("VIEW-05: Staging in split view", () => {
	it("shows Stage Hunk button in split view for unstaged diffs", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("split"),
		);

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
			},
		});
		await flushPrefs();

		expect(screen.getByText("Stage Hunk")).toBeInTheDocument();
		expect(screen.getByText("Discard Hunk")).toBeInTheDocument();

		// Reset
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
	});

	it("shows Unstage Hunk button in split view for staged diffs", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("split"),
		);

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "staged",
				repoPath: "/test/repo",
			},
		});
		await flushPrefs();

		expect(screen.getByText("Unstage Hunk")).toBeInTheDocument();

		// Reset
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
	});

	it("does not show staging buttons in split view for commit diffs", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("split"),
		);

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "commit",
			},
		});
		await flushPrefs();

		expect(screen.queryByText("Stage Hunk")).toBeNull();
		expect(screen.queryByText("Discard Hunk")).toBeNull();
		expect(screen.queryByText("Unstage Hunk")).toBeNull();

		// Reset
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
	});

	it("keeps staging buttons usable when whitespace ignore is active in split view", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("split"),
		);
		vi.mocked(storeMock.getDiffIgnoreWhitespace).mockImplementation(() =>
			Promise.resolve(true),
		);

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
			},
		});
		await flushPrefs();
		await flushPrefs();

		// Staging now rebuilds the diff with the view's own options, so ignoring
		// whitespace no longer has to block the gesture (TRUNK-73).
		const stageBtn = screen.getByText("Stage Hunk").closest("button");
		expect(stageBtn).not.toBeDisabled();

		// Reset
		vi.mocked(storeMock.getDiffIgnoreWhitespace).mockImplementation(() =>
			Promise.resolve(false),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
	});

	it("does not show staging buttons in split+full mode", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("full"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("split"),
		);

		render(DiffPanel, {
			props: {
				...commentingDiff,
				contentMode: "full",
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
			},
		});
		await flushPrefs();

		// Split+full mode has no hunk headers, so no staging buttons
		expect(screen.queryByText("Stage Hunk")).toBeNull();

		// Reset
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
	});

	// ---- Diff scroll layout regression tests ----
	// These verify the structural CSS properties that make horizontal scrolling work correctly:
	// - Hunk toolbars and file headers stay visible (sticky left)
	// - Diff line backgrounds extend the full content width (no gaps on short lines)

	describe("diff scroll layout", () => {
		// A virtualized view scrolls inside its own viewport, so the wrapper above
		// it no longer scrolls. What still has to sit above every row is the
		// container-query context the toolbar's `100cqi` width resolves against.
		function findContainerContext(el: Element): HTMLElement | null {
			let current = el.parentElement;
			while (current) {
				if (current.classList.contains("@container")) return current;
				current = current.parentElement;
			}
			return null;
		}

		it("a container query context sits above every row, so sticky sizing resolves", async () => {
			const { container } = render(DiffPanel, {
				props: {
					...commentingDiff,
					fileDiffs: [testDiff],
					commitDetail: null,
					onclose: vi.fn(),
				},
			});
			await flushPrefs();
			const line = container.querySelector(".diff-line");
			expect(line).toBeTruthy();
			const context = findContainerContext(line as Element);
			expect(context).toBeTruthy();
			expect(context).toHaveClass("overscroll-x-none");
		});

		it("hunk toolbar is horizontally sticky so buttons stay visible", async () => {
			render(DiffPanel, {
				props: {
					...commentingDiff,
					fileDiffs: [testDiff],
					commitDetail: null,
					onclose: vi.fn(),
				},
			});
			await flushPrefs();
			const hunkHeaderText = screen.getByText("@@ -1,3 +1,4 @@");
			const toolbar = hunkHeaderText.parentElement;
			expect(toolbar).toHaveStyle("position: sticky; left: 0");
		});

		it("file header is horizontally sticky in multi-file view", async () => {
			render(DiffPanel, {
				props: {
					...commentingDiff,
					fileDiffs: [testDiff],
					commitDetail: null,
					selectedPath: null,
					onclose: vi.fn(),
				},
			});
			await flushPrefs();
			const fileHeader = screen
				.getByRole("button", { name: /src\/main\.ts/ })
				.closest(".pan-pinned");
			expect(fileHeader).toHaveStyle("position: sticky; left: 0");
		});

		it("folds a file's rows away when its header is clicked", async () => {
			render(DiffPanel, {
				props: {
					...commentingDiff,
					fileDiffs: [testDiff],
					commitDetail: null,
					selectedPath: null,
					onclose: () => {},
				},
			});
			await flushPrefs();
			expect(screen.getByText("@@ -1,3 +1,4 @@")).toBeInTheDocument();

			await fireEvent.click(
				screen.getByRole("button", { name: /src\/main\.ts/ }),
			);

			expect(screen.queryByText("@@ -1,3 +1,4 @@")).not.toBeInTheDocument();
		});

		it("diff lines wrapper ensures full-width backgrounds via min-width", async () => {
			const { container } = render(DiffPanel, {
				props: {
					...commentingDiff,
					fileDiffs: [testDiff],
					commitDetail: null,
					onclose: vi.fn(),
				},
			});
			await flushPrefs();
			const line = container.querySelector(".diff-line");
			expect(line).toBeTruthy();
			const wrapper = line?.parentElement;
			expect(wrapper).toHaveClass("min-w-full");
		});
	});
});

const nonMergeCommit: CommitDetail = {
	oid: "abc123def456",
	short_oid: "abc123d",
	summary: "a normal commit",
	body: null,
	message: "a normal commit",
	author_name: "A",
	author_email: "a@example.com",
	author_timestamp: 0,
	committer_name: "A",
	committer_email: "a@example.com",
	committer_timestamp: 0,
	parent_oids: ["parent1"],
};

const mergeCommit: CommitDetail = {
	...nonMergeCommit,
	oid: "merge999",
	short_oid: "merge99",
	parent_oids: ["parent1", "parent2"],
};

const addedFileDiff: FileDiff = {
	path: "src/new-file.ts",
	old_path: null,
	status: "Added",
	is_binary: false,
	old_size: null,
	new_size: null,
	old_id: null,
	new_id: null,
	hunks: [
		{
			header: "@@ -0,0 +1,2 @@",
			old_start: 0,
			old_lines: 0,
			new_start: 1,
			new_lines: 2,
			lines: [
				{
					origin: "Add",
					content: "export const a = 1;",
					old_lineno: null,
					new_lineno: 1,
					spans: [],
				},
				{
					origin: "Add",
					content: "export const b = 2;",
					old_lineno: null,
					new_lineno: 2,
					spans: [],
				},
			],
		},
	],
};

const hunksOfDifferentLengths: FileDiff = {
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
			header: "@@ -1,0 +1,2 @@",
			old_start: 1,
			old_lines: 0,
			new_start: 1,
			new_lines: 2,
			lines: [
				{
					origin: "Add",
					content: "first hunk, pressed",
					old_lineno: null,
					new_lineno: 1,
					spans: [],
				},
				{
					origin: "Add",
					content: "first hunk, below it",
					old_lineno: null,
					new_lineno: 2,
					spans: [],
				},
			],
		},
		{
			header: "@@ -20,1 +22,2 @@",
			old_start: 20,
			old_lines: 1,
			new_start: 22,
			new_lines: 2,
			lines: [
				{
					origin: "Context",
					content: "second hunk, unchanged",
					old_lineno: 20,
					new_lineno: 22,
					spans: [],
				},
				{
					origin: "Add",
					content: "second hunk, added",
					old_lineno: null,
					new_lineno: 23,
					spans: [],
				},
			],
		},
	],
};

describe("DiffPanel drag-to-select", () => {
	afterEach(async () => {
		const store = await import("../lib/store.js");
		vi.mocked(store.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
	});

	async function renderCommitInSplitLayout() {
		const store = await import("../lib/store.js");
		vi.mocked(store.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("split"),
		);
		await renderCommit();
	}

	// testDiff hunk lines: Context(0), Delete(1), Add "const x = 2;"(2),
	// Add "const y = 3;"(3), Context(4). In commit mode the on-selection affordance
	// renders "Comment (N)" with N = the live selectedCount — the observable readout
	// these tests assert on (0 when nothing is selected: the label drops the count).
	function selectedCount(): number {
		const btn = screen.queryByRole("button", { name: /^Comment \(/ });
		const m = btn?.textContent?.match(/\((\d+)\)/);
		return m ? Number(m[1]) : 0;
	}

	function renderCommit() {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: nonMergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
			},
		});
		return flushPrefs();
	}

	it("paints the whole range when dragging across lines", async () => {
		await renderCommit();

		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.mouseOver(screen.getByText("const y = 3;"), { buttons: 1 });
		await tick();

		expect(selectedCount()).toBe(2);
	});

	it("paints the whole range when dragging across split rows", async () => {
		await renderCommitInSplitLayout();

		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.mouseOver(screen.getByText("const y = 3;"), { buttons: 1 });
		await tick();

		expect(selectedCount()).toBe(2);
	});

	it("keeps a split drag on the side it started from", async () => {
		await renderCommitInSplitLayout();

		await fireEvent.mouseDown(gutterOf("const x = 1;"));
		await tick();
		await fireEvent.mouseOver(screen.getByText("const y = 3;"), { buttons: 1 });
		await tick();

		expect(selectedCount()).toBe(1);
	});

	it("keeps a drag inside the hunk it started in", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [hunksOfDifferentLengths],
				commitDetail: nonMergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
			},
		});
		await flushPrefs();

		await fireEvent.mouseDown(gutterOf("first hunk, pressed"));
		await tick();
		await fireEvent.mouseOver(screen.getByText("second hunk, added"), {
			buttons: 1,
		});
		await tick();

		expect(selectedCount()).toBe(1);
	});

	it("selects a line from the keyboard", async () => {
		await renderCommit();

		await fireEvent.keyDown(gutterOf("const x = 2;"), { key: "Enter" });
		await tick();

		expect(selectedCount()).toBe(1);
	});

	it("extends the selection from the keyboard with Shift held", async () => {
		await renderCommit();

		await fireEvent.keyDown(gutterOf("const x = 2;"), { key: "Enter" });
		await fireEvent.keyDown(gutterOf("const y = 3;"), {
			key: " ",
			shiftKey: true,
		});
		await tick();

		expect(selectedCount()).toBe(2);
	});

	it("selects a split row from the keyboard", async () => {
		await renderCommitInSplitLayout();

		await fireEvent.keyDown(gutterOf("const x = 2;"), { key: "Enter" });
		await tick();

		expect(selectedCount()).toBe(1);
	});

	it("does not extend the selection on a hover with no button held", async () => {
		await renderCommit();

		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.mouseOver(screen.getByText("const y = 3;"), { buttons: 0 });
		await tick();

		expect(selectedCount()).toBe(1);
	});

	it("keeps the drag alive across a hover that reports no held button", async () => {
		await renderCommit();

		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.mouseOver(screen.getByText("const y = 3;"), { buttons: 0 });
		await tick();
		await fireEvent.mouseOver(screen.getByText("const y = 3;"), { buttons: 1 });
		await tick();

		expect(selectedCount()).toBe(2);
	});

	it("stops painting once the button is released", async () => {
		await renderCommit();

		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.mouseUp(window);
		await fireEvent.mouseOver(screen.getByText("const y = 3;"), { buttons: 1 });
		await tick();

		expect(selectedCount()).toBe(1);
	});

	it("ends the hunk drag when Escape clears its selection before release", async () => {
		await renderCommit();
		const first = screen.getByText("const x = 2;");
		const next = screen.getByText("const y = 3;");

		await fireEvent.mouseDown(gutterOf("const x = 2;"), { buttons: 1 });
		await fireEvent.mouseOver(next, { buttons: 1 });
		expect(next.closest("[data-line-index]")).toHaveClass("in-selection");
		await fireEvent.keyDown(document.body, { key: "Escape" });
		expect(next.closest("[data-line-index]")).not.toHaveClass("in-selection");
		await fireEvent.mouseOver(first, { buttons: 1 });
		await fireEvent.mouseUp(window);

		expect(selectedCount()).toBe(0);
	});

	it("deselects the range when the drag starts on an already-selected line", async () => {
		await renderCommit();

		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.mouseOver(screen.getByText("const y = 3;"), { buttons: 1 });
		await tick();
		expect(selectedCount()).toBe(2);

		// A fresh drag from a selected line deselects as it paints across the range.
		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.mouseOver(screen.getByText("const y = 3;"), { buttons: 1 });
		await tick();
		expect(selectedCount()).toBe(0);
	});

	it("paints a range whose anchor row was unmounted while scrolling", async () => {
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
			old_size: null,
			new_size: null,
			old_id: null,
			new_id: null,
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
		const { container } = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [long],
				commitDetail: nonMergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
			},
		});
		await flushPrefs();

		await fireEvent.mouseDown(gutterOf("line 10"));
		await tick();

		const viewport = container.querySelector(
			".exact-virtual-viewport",
		) as HTMLElement;
		viewport.scrollTop = 2500 * 18;
		viewport.dispatchEvent(new Event("scroll"));
		await tick();
		expect(screen.queryAllByText("line 10").length).toBe(0);

		await fireEvent.mouseOver(screen.getByText("line 2500"), { buttons: 1 });
		await tick();

		// The toolbar carrying the readout is itself a row, and a hunk this long
		// scrolls it out of the window — as it did before the list, since it was
		// only ever horizontally sticky. Scroll back to read the count.
		viewport.scrollTop = 0;
		viewport.dispatchEvent(new Event("scroll"));
		await tick();

		expect(selectedCount()).toBe(2491);
	});

	it("does not arm a selection when the press lands on code content", async () => {
		await renderCommit();

		// Mousedown on the code text (now freely selectable) must not stage a line.
		await fireEvent.mouseDown(screen.getByText("const x = 2;"));
		await tick();

		expect(selectedCount()).toBe(0);
	});

	it("keeps the gutter unselectable and the code content selectable", async () => {
		await renderCommit();

		expect(gutterOf("const x = 2;")).toHaveClass("select-none");
		expect(screen.getByText("const x = 2;")).toHaveClass("select-text");
	});

	it("drops the selection when the diff it was made on reloads with a shorter hunk", async () => {
		const props = {
			...commentingDiff,
			fileDiffs: [testDiff],
			commitDetail: null,
			onclose: vi.fn(),
			diffKind: "unstaged" as const,
			repoPath: "/repo",
		};
		const view = render(DiffPanel, { props });
		await flushPrefs();
		await fireEvent.mouseDown(gutterOf("const y = 3;"));
		await fireEvent.mouseUp(window);
		expect(
			screen.getByRole("button", { name: /^Stage Lines/ }),
		).toBeInTheDocument();
		const shorter: FileDiff = {
			...testDiff,
			hunks: [
				{ ...testDiff.hunks[0], lines: testDiff.hunks[0].lines.slice(1, 3) },
			],
		};

		await view.rerender({ ...props, fileDiffs: [shorter] });
		await flushPrefs();

		expect(screen.getByText("const x = 2;")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Stage Lines/ })).toBeNull();
	});
});

describe("DiffPanel comment affordance (commit diffs)", () => {
	it("shows an enabled Comment affordance on a non-merge commit selection", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: nonMergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
			},
		});
		await flushPrefs();

		// Select an Add line to surface the on-selection action row.
		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();

		const commentBtn = screen.getByRole("button", {
			name: /^Comment \(/,
		}) as HTMLButtonElement;
		expect(commentBtn).toBeTruthy();
		expect(commentBtn.disabled).toBe(false);
	});

	it("disables the Comment affordance with a tooltip on a merge commit", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: mergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
			},
		});
		await flushPrefs();

		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();

		const commentBtn = screen.getByRole("button", {
			name: /^Comment \(/,
		}) as HTMLButtonElement;
		expect(commentBtn.disabled).toBe(true);
		expect(commentBtn.getAttribute("title")).toBe(
			"Diff comments aren't available on merge commits",
		);
	});

	it("offers a comment on a full-file selection of a merge commit", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: mergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
				selectedPath: "src/main.ts",
				contentMode: "full",
			},
		});
		await flushPrefs();

		await fireEvent.click(fullFileGutterOf("const x = 2;"));
		await tick();

		const commentBtn = screen.getByRole("button", {
			name: "Comment on selected lines",
		}) as HTMLButtonElement;
		expect(commentBtn.disabled).toBe(false);
	});

	it("keeps the Comment affordance enabled on an Added file (status forces side, does not disable)", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [addedFileDiff],
				commitDetail: nonMergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
			},
		});
		await flushPrefs();

		await fireEvent.mouseDown(gutterOf("export const a = 1;"));
		await tick();

		const commentBtn = screen.getByRole("button", {
			name: /^Comment \(/,
		}) as HTMLButtonElement;
		expect(commentBtn.disabled).toBe(false);
	});

	it("confirms via plugin-dialog ask before switching to a new range with a dirty composer; cancel keeps the selection", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		const askMock = vi.mocked(ask);
		askMock.mockClear();
		askMock.mockResolvedValue(false);

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: nonMergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
			},
		});
		await flushPrefs();

		// Select a line, open the composer.
		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: /^Comment \(/ }));
		await tick();

		// Dirty the composer draft.
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: "unsaved note" } });
		await tick();

		// Attempt to switch to a different range -> ask must fire; false blocks it.
		// handleLineMouseDown is async (awaits a dynamic plugin-dialog import), so flush
		// microtasks before asserting.
		await fireEvent.mouseDown(gutterOf("const y = 3;"));
		await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));

		expect(askMock).toHaveBeenCalledTimes(1);
		// Composer stays open because the switch was cancelled.
		expect(screen.getByRole("textbox")).toBeTruthy();
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"unsaved note",
		);
	});

	it("keeps an open comment's draft while review threads are hidden", async () => {
		const props = {
			...commentingDiff,
			fileDiffs: [testDiff],
			commitDetail: nonMergeCommit,
			onclose: vi.fn(),
			diffKind: "commit" as const,
			repoPath: "/repo",
		};
		const view = render(DiffPanel, { props });
		await flushPrefs();
		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await fireEvent.mouseUp(window);
		await fireEvent.click(screen.getByRole("button", { name: /^Comment \(/ }));
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "unsaved note" },
		});

		await view.rerender({ ...props, reviewFilter: "none" });

		expect(screen.getByRole("textbox")).toHaveValue("unsaved note");
	});

	it("extends the comment's range on a shift-press, keeping the text", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		const askMock = vi.mocked(ask);
		askMock.mockClear();
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: nonMergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
			},
		});
		await flushPrefs();
		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await fireEvent.mouseUp(window);
		await fireEvent.click(screen.getByRole("button", { name: /^Comment \(/ }));
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "keep me" },
		});

		await fireEvent.mouseDown(gutterOf("const y = 3;"), { shiftKey: true });
		await fireEvent.mouseUp(window);

		expect(await screen.findByText("Comments on lines 2-3")).toBeTruthy();
		expect(screen.getByRole("textbox")).toHaveValue("keep me");
		expect(askMock).not.toHaveBeenCalled();
	});

	it("offers the shift extension only on a comment opened from selected lines", async () => {
		const props = {
			...commentingDiff,
			fileDiffs: [testDiff],
			commitDetail: nonMergeCommit,
			onclose: vi.fn(),
			diffKind: "commit" as const,
			repoPath: "/repo",
		};
		render(DiffPanel, { props });
		await flushPrefs();

		await fireEvent.click(screen.getByRole("button", { name: "Comment" }));
		expect(await screen.findByRole("textbox")).toBeTruthy();
		expect(screen.queryByText(/to extend/)).toBeNull();

		await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await fireEvent.mouseUp(window);
		await fireEvent.click(screen.getByRole("button", { name: /^Comment \(/ }));

		expect(await screen.findByText(/to extend/)).toBeTruthy();
	});

	it("extends a full-file comment's range on a shift-click, keeping the text", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				contentMode: "full",
			},
		});
		await flushPrefs();
		await fireEvent.click(fullFileGutterOf("const x = 2;"));
		await fireEvent.click(
			screen.getByRole("button", { name: "Comment on selected lines" }),
		);
		await fireEvent.input(await screen.findByRole("textbox"), {
			target: { value: "keep me" },
		});
		expect(screen.getByText(/to extend/)).toBeTruthy();

		await fireEvent.click(fullFileGutterOf("const y = 3;"), { shiftKey: true });

		expect(await screen.findByText("Comments on lines 2-3")).toBeTruthy();
		expect(screen.getByRole("textbox")).toHaveValue("keep me");
	});

	it("names a whole-file comment as on the file and offers no extension", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				contentMode: "full",
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Comment File"));
		await flushPrefs();

		expect(screen.getByText("Comment on this file")).toBeInTheDocument();
		expect(screen.queryByText(/to extend/)).toBeNull();
	});

	function selectionComment(): HTMLElement {
		return screen.getByRole("button", { name: "Comment on selected lines" });
	}

	function rowOf(text: string): HTMLElement {
		return screen.getByText(text).closest("[data-line-index]") as HTMLElement;
	}

	async function selectLines(from: string, to: string) {
		await fireEvent.mouseDown(gutterOf(from));
		await fireEvent.mouseOver(screen.getByText(to), { buttons: 1 });
		await fireEvent.mouseUp(window);
	}

	it("draws no comment control on a line", async () => {
		renderPanel();
		await flushPrefs();

		expect(
			screen.queryAllByRole("button", {
				name: /^Comment on (removed )?line/,
				hidden: true,
			}),
		).toEqual([]);
	});

	it("comments on the selection from the action on its last line", async () => {
		renderPanel();
		await flushPrefs();
		await selectLines("const x = 2;", "const y = 3;");

		await fireEvent.click(selectionComment());

		expect(await screen.findByText("Comments on lines 2-3")).toBeTruthy();
	});

	it("puts the selection's action on its last line", async () => {
		renderPanel();
		await flushPrefs();

		await selectLines("const x = 2;", "const y = 3;");

		expect(rowOf("const y = 3;")).toContainElement(selectionComment());
	});

	it("clears the selection on Escape and says the key is handled", async () => {
		renderPanel();
		await flushPrefs();
		await selectLines("const x = 2;", "const y = 3;");

		const handled = !(await fireEvent.keyDown(document.body, {
			key: "Escape",
		}));

		expect(handled).toBe(true);
		expect(
			screen.queryByRole("button", { name: "Comment on selected lines" }),
		).toBeNull();
	});

	it("leaves the selection alone on an Escape that closes a menu opened after it", async () => {
		renderPanel();
		await flushPrefs();
		await selectLines("const x = 2;", "const y = 3;");
		render(PullDropdown, {
			props: {
				repoPath: "/repo",
				disabled: false,
				remoteState: createRemoteState(),
				onpull: vi.fn(),
			},
		});
		await fireEvent.click(screen.getByRole("button", { name: "Pull options" }));

		await fireEvent.keyDown(document.body, { key: "Escape" });

		expect(screen.queryByRole("menu")).toBeNull();
		expect(selectionComment()).toBeTruthy();
	});

	it("leaves the selection alone on Escape while its tab is hidden", async () => {
		renderPanel({ keysActive: false });
		await flushPrefs();
		await selectLines("const x = 2;", "const y = 3;");

		const handled = !(await fireEvent.keyDown(document.body, {
			key: "Escape",
		}));

		expect(handled).toBe(false);
		expect(selectionComment()).toBeTruthy();
	});

	it("draws no selection action without a selection", async () => {
		renderPanel();
		await flushPrefs();

		expect(
			screen.queryByRole("button", { name: "Comment on selected lines" }),
		).toBeNull();
	});

	it("hides the selection action while the press that makes it is held", async () => {
		renderPanel();
		await flushPrefs();

		await fireEvent.mouseDown(gutterOf("const x = 2;"));

		expect(
			screen.queryByRole("button", { name: "Comment on selected lines" }),
		).toBeNull();
	});

	it("hides the selection action while the composer is open", async () => {
		renderPanel();
		await flushPrefs();
		await selectLines("const x = 2;", "const y = 3;");

		await fireEvent.click(selectionComment());
		await screen.findByRole("textbox");

		expect(
			screen.queryByRole("button", { name: "Comment on selected lines" }),
		).toBeNull();
	});

	it("draws no selection action on a merge commit", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: mergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
			},
		});
		await flushPrefs();

		await selectLines("const x = 2;", "const y = 3;");

		expect(
			screen.queryByRole("button", { name: "Comment on selected lines" }),
		).toBeNull();
	});

	it("opens a comment on the selection when C is pressed", async () => {
		renderPanel();
		await flushPrefs();
		await selectLines("const x = 2;", "const y = 3;");

		await fireEvent.keyDown(window, { key: "c" });

		expect(await screen.findByText("Comments on lines 2-3")).toBeTruthy();
	});

	it("opens no comment when C is pressed without a selection", async () => {
		renderPanel();
		await flushPrefs();

		await fireEvent.keyDown(window, { key: "c" });
		await tick();

		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("selects a context line from its line number", async () => {
		renderPanel();
		await flushPrefs();
		await fireEvent.mouseDown(gutterOf("export { x };"));
		await fireEvent.mouseUp(window);

		await fireEvent.click(selectionComment());

		expect(await screen.findByText("Comment on line 4")).toBeTruthy();
	});

	it("selects a context line from the keyboard", async () => {
		renderPanel();
		await flushPrefs();
		await fireEvent.keyDown(gutterOf("export { x };"), { key: "Enter" });

		await fireEvent.keyDown(window, { key: "c" });

		expect(await screen.findByText("Comment on line 4")).toBeTruthy();
	});

	it("extends a selection onto a context line from the keyboard with Shift held", async () => {
		renderPanel();
		await flushPrefs();
		await fireEvent.keyDown(gutterOf("const x = 2;"), { key: "Enter" });

		await fireEvent.keyDown(gutterOf("export { x };"), {
			key: " ",
			shiftKey: true,
		});

		expect(rowOf("const y = 3;")).toHaveClass("in-selection");
		expect(rowOf("export { x };")).toHaveClass("in-selection");
	});

	it("carries a drag from a changed line onto the context lines it crosses", async () => {
		renderPanel();
		await flushPrefs();
		await selectLines("const x = 2;", "export { x };");

		await fireEvent.click(selectionComment());

		expect(await screen.findByText("Comments on lines 2-4")).toBeTruthy();
	});

	it("marks a context line the selection takes", async () => {
		renderPanel();
		await flushPrefs();

		await fireEvent.mouseDown(gutterOf("export { x };"));
		await fireEvent.mouseUp(window);

		expect(rowOf("export { x };")).toHaveClass("in-selection");
	});

	it("extends the comment's range onto a context line on a shift-press, keeping the text", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockClear();
		renderPanel();
		await flushPrefs();
		await selectLines("const x = 2;", "const x = 2;");
		await fireEvent.click(selectionComment());
		await fireEvent.input(await screen.findByRole("textbox"), {
			target: { value: "keep me" },
		});

		await fireEvent.mouseDown(gutterOf("export { x };"), { shiftKey: true });
		await fireEvent.mouseUp(window);

		expect(await screen.findByText("Comments on lines 2-4")).toBeTruthy();
		expect(screen.getByRole("textbox")).toHaveValue("keep me");
		expect(ask).not.toHaveBeenCalled();
	});

	it("shrinks the comment's range on a shift-press of a line inside it, keeping the text", async () => {
		renderPanel();
		await flushPrefs();
		await selectLines("const x = 2;", "export { x };");
		await fireEvent.click(selectionComment());
		await fireEvent.input(await screen.findByRole("textbox"), {
			target: { value: "keep me" },
		});

		await fireEvent.mouseDown(gutterOf("const y = 3;"), { shiftKey: true });
		await fireEvent.mouseUp(window);

		expect(await screen.findByText("Comments on lines 2-3")).toBeTruthy();
		expect(screen.getByRole("textbox")).toHaveValue("keep me");
	});

	describe("in the split layout", () => {
		beforeEach(async () => {
			const store = await import("../lib/store.js");
			vi.mocked(store.getDiffLayoutMode).mockImplementation(() =>
				Promise.resolve("split"),
			);
		});

		afterEach(async () => {
			const store = await import("../lib/store.js");
			vi.mocked(store.getDiffLayoutMode).mockImplementation(() =>
				Promise.resolve("inline"),
			);
		});

		function cellsOf(text: string): HTMLElement[] {
			return screen
				.getAllByText(text)
				.map((el) => el.closest("[data-line-index]") as HTMLElement);
		}

		it("selects a context line from either side's line number", async () => {
			renderPanel();
			await flushPrefs();
			const [oldSide] = cellsOf("export { x };");

			await fireEvent.mouseDown(
				oldSide.querySelector("[data-gutter-grip]") as HTMLElement,
			);
			await fireEvent.mouseUp(window);

			expect(
				cellsOf("export { x };").map((cell) =>
					cell.classList.contains("in-selection"),
				),
			).toEqual([true, true]);
		});

		it("puts the selection's action on its last line's row", async () => {
			renderPanel();
			await flushPrefs();
			const [, newSide] = cellsOf("export { x };");

			await fireEvent.mouseDown(
				newSide.querySelector("[data-gutter-grip]") as HTMLElement,
			);
			await fireEvent.mouseUp(window);

			expect(newSide.closest(".split-row")).toContainElement(
				selectionComment(),
			);
		});

		it("carries a drag from a context line onto the added lines", async () => {
			renderPanel();
			await flushPrefs();
			const [, newSide] = cellsOf("export { x };");
			await fireEvent.mouseDown(
				newSide.querySelector("[data-gutter-grip]") as HTMLElement,
			);
			await fireEvent.mouseOver(screen.getByText("const x = 2;"), {
				buttons: 1,
			});
			await fireEvent.mouseUp(window);

			await fireEvent.click(selectionComment());

			expect(await screen.findByText("Comments on lines 2-4")).toBeTruthy();
		});
	});

	describe("when the selection holds context lines", () => {
		function renderWorkingDiff(
			diffKind: "unstaged" | "staged",
			takesComments = true,
		) {
			render(DiffPanel, {
				props: {
					...commentingDiff,
					takesComments,
					fileDiffs: [testDiff],
					commitDetail: null,
					onclose: vi.fn(),
					diffKind,
					repoPath: "/repo",
				},
			});
			return flushPrefs();
		}

		function sentLines(command: string): number[] | undefined {
			const call = vi
				.mocked(safeInvoke)
				.mock.calls.find((c) => c[0] === command);
			return (call?.[1] as { lineIndices?: number[] } | undefined)?.lineIndices;
		}

		it("draws no comment action when its changed lines are all removed ones on the working tree", async () => {
			await renderWorkingDiff("unstaged");

			await selectLines("import { foo } from 'bar';", "const x = 1;");

			expect(
				screen.queryByRole("button", { name: "Comment on selected lines" }),
			).toBeNull();
		});

		it("counts only the changed lines on its staging actions", async () => {
			await renderWorkingDiff("unstaged");

			await selectLines("const x = 2;", "export { x };");

			expect(
				screen.getByRole("button", { name: "Stage Lines (2)" }),
			).toBeTruthy();
			expect(
				screen.getByRole("button", { name: "Discard Lines (2)" }),
			).toBeTruthy();
		});

		it("stages only the changed lines", async () => {
			await renderWorkingDiff("unstaged");
			await selectLines("const x = 2;", "export { x };");
			vi.mocked(safeInvoke).mockClear();

			await fireEvent.click(
				screen.getByRole("button", { name: "Stage Lines (2)" }),
			);

			await waitFor(() => expect(sentLines("stage_lines")).toEqual([2, 3]));
		});

		it("discards only the changed lines", async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockClear();
			vi.mocked(ask).mockResolvedValue(true);
			onTestFinished(() => {
				vi.mocked(ask).mockResolvedValue(false);
			});
			await renderWorkingDiff("unstaged");
			await selectLines("const x = 2;", "export { x };");
			vi.mocked(safeInvoke).mockClear();

			await fireEvent.click(
				screen.getByRole("button", { name: "Discard Lines (2)" }),
			);

			await waitFor(() => expect(sentLines("discard_lines")).toEqual([2, 3]));
			expect(ask).toHaveBeenCalledWith(
				"Discard 2 selected lines? This cannot be undone.",
				expect.anything(),
			);
		});

		it("names one discarded line in the singular", async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockClear();
			await renderWorkingDiff("unstaged");
			await selectLines("const x = 2;", "const x = 2;");

			await fireEvent.click(
				screen.getByRole("button", { name: "Discard Lines (1)" }),
			);

			await waitFor(() =>
				expect(ask).toHaveBeenCalledWith(
					"Discard 1 selected line? This cannot be undone.",
					expect.anything(),
				),
			);
		});

		it("reports one discarded line in the singular", async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			const { showToast } = await import("../lib/toast.svelte.js");
			vi.mocked(ask).mockResolvedValueOnce(true);
			vi.mocked(showToast).mockClear();
			await renderWorkingDiff("unstaged");
			await selectLines("const x = 2;", "const x = 2;");

			await fireEvent.click(
				screen.getByRole("button", { name: "Discard Lines (1)" }),
			);

			await waitFor(() =>
				expect(showToast).toHaveBeenCalledWith("Discarded 1 line", "success"),
			);
		});

		it("unstages only the changed lines", async () => {
			await renderWorkingDiff("staged");
			await selectLines("const x = 2;", "export { x };");
			vi.mocked(safeInvoke).mockClear();

			await fireEvent.click(
				screen.getByRole("button", { name: "Unstage Lines (2)" }),
			);

			await waitFor(() => expect(sentLines("unstage_lines")).toEqual([2, 3]));
		});

		it.each([
			{ diffKind: "unstaged", action: "Stage Hunk", command: "stage_hunk" },
			{ diffKind: "staged", action: "Unstage Hunk", command: "unstage_hunk" },
		] as const)(
			"acts on the whole hunk from $diffKind changes while no changed line is selected",
			async ({ diffKind, action, command }) => {
				await renderWorkingDiff(diffKind);
				await selectLines("export { x };", "export { x };");
				vi.mocked(safeInvoke).mockClear();

				await fireEvent.click(screen.getByRole("button", { name: action }));

				await waitFor(() =>
					expect(vi.mocked(safeInvoke).mock.calls.map((c) => c[0])).toContain(
						command,
					),
				);
			},
		);

		it("draws no line number control on a context line where comments are not taken", async () => {
			await renderWorkingDiff("unstaged", false);

			expect(
				rowOf("export { x };").querySelector("[data-gutter-grip]"),
			).toBeNull();
		});
	});

	it("does not paint after a release that arrived while the discard prompt was open", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		const askMock = vi.mocked(ask);
		askMock.mockClear();
		let answer: (discard: boolean) => void = () => {};
		askMock.mockImplementation(
			() => new Promise<boolean>((resolve) => (answer = resolve)),
		);
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: nonMergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
			},
		});
		await flushPrefs();
		await fireEvent.mouseDown(gutterOf("const x = 1;"));
		await fireEvent.mouseUp(window);
		await fireEvent.click(screen.getByRole("button", { name: /^Comment \(/ }));
		await fireEvent.input(screen.getByRole("textbox"), {
			target: { value: "unsaved note" },
		});

		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
		await fireEvent.mouseUp(window);
		answer(true);
		await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
		await fireEvent.mouseOver(screen.getByText("const y = 3;"), { buttons: 1 });
		await tick();

		const count = screen
			.getByRole("button", { name: /^Comment \(/ })
			.textContent?.match(/\((\d+)\)/)?.[1];
		expect(count).toBe("2");
		askMock.mockResolvedValue(false);
	});

	// Opening the composer establishes NOTHING. The draft row has no review
	// foreign key, so autosave always has a home, and the review is created at
	// SUBMIT — which is what makes a cancelled composer strand nothing
	// (criterion 3; 260531-l02c's substance kept by D6).
	function mockStoreCommands() {
		vi.mocked(safeInvoke).mockClear();
		vi.mocked(safeInvoke).mockImplementation(() => Promise.resolve(undefined));
	}

	async function openComposerOnAddLine() {
		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: /^Comment \(/ }));
		await tick();
	}

	// Submit the open composer and settle the async resolve -> snapshot -> add_thread chain.
	async function submitComposer(note: string) {
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: note } });
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
		await flushPrefs();
	}

	function calledCommands(): string[] {
		return vi.mocked(safeInvoke).mock.calls.map((c) => c[0] as string);
	}

	function renderPanel(
		overrides: { reviewFilter?: ReviewFilter; keysActive?: boolean } = {},
	) {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: nonMergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
				...overrides,
			},
		});
	}

	it("opening the composer invokes no review-creating command", async () => {
		mockStoreCommands();
		renderPanel();
		await flushPrefs();

		await openComposerOnAddLine();

		expect(screen.getByRole("textbox")).toBeTruthy();
		expect(calledCommands()).toEqual(
			expect.not.arrayContaining([
				"create_review",
				"add_thread",
				"add_commit_thread",
			]),
		);
	});

	it("submitting reaches add_thread, which is what creates the review", async () => {
		mockStoreCommands();
		renderPanel();
		await flushPrefs();
		await openComposerOnAddLine();

		await submitComposer("first note");

		expect(calledCommands()).toContain("add_thread");
	});

	it("submits a comment while review threads are hidden", async () => {
		mockStoreCommands();
		renderPanel({ reviewFilter: "none" });
		await flushPrefs();
		await openComposerOnAddLine();

		await submitComposer("note while hidden");

		expect(calledCommands()).toContain("add_thread");
	});
});

describe("Discard File button", () => {
	// Without this reset, a discard flow that outlives its test steals the next
	// test's safeInvoke override and flakes it under load.
	afterEach(() => {
		vi.mocked(safeInvoke).mockReset();
		vi.mocked(safeInvoke).mockImplementation(backendReply);
	});

	it("shows the Discard File button for unstaged diffs", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
			},
		});
		await flushPrefs();

		expect(screen.getByText("Discard File")).toBeInTheDocument();
	});

	it("hides the Discard File button for staged diffs", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "staged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
			},
		});
		await flushPrefs();

		expect(screen.queryByText("Discard File")).toBeNull();
	});

	it("hides the Discard File button for commit diffs", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
			},
		});
		await flushPrefs();

		expect(screen.queryByText("Discard File")).toBeNull();
	});

	it("discards the file after the user confirms", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockResolvedValueOnce(true);
		vi.mocked(safeInvoke).mockClear();
		const completed = vi.fn(async () => {});

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				onstagingaction: () => stagingCompletion(completed),
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Discard File"));
		await waitFor(() =>
			expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("discard_file", {
				path: "/test/repo",
				filePath: "src/main.ts",
			}),
		);

		expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("discard_file", {
			path: "/test/repo",
			filePath: "src/main.ts",
		});
		expect(completed).toHaveBeenCalledWith("discard");
	});

	it("keeps the file when the user cancels the confirmation", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockClear();
		vi.mocked(ask).mockResolvedValueOnce(false);
		vi.mocked(safeInvoke).mockClear();
		const completed = vi.fn(async () => {});

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				onstagingaction: () => stagingCompletion(completed),
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Discard File"));
		await waitFor(() => expect(vi.mocked(ask)).toHaveBeenCalledTimes(1));

		expect(vi.mocked(safeInvoke)).not.toHaveBeenCalledWith(
			"discard_file",
			expect.anything(),
		);
		expect(completed).not.toHaveBeenCalled();
	});

	it("renders Discard File before Stage File", async () => {
		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
			},
		});
		await flushPrefs();

		const discard = screen.getByText("Discard File");
		const stage = screen.getByText("Stage File");

		expect(
			discard.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("warns the file will be permanently removed when it is untracked", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockClear();

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [untrackedDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: untrackedDiff.path,
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Discard File"));
		await waitFor(() =>
			expect(vi.mocked(ask)).toHaveBeenCalledWith(
				expect.stringContaining("untracked and will be permanently removed"),
				{
					title: "Delete File",
					kind: "warning",
					okLabel: "Delete",
					cancelLabel: "Cancel",
				},
			),
		);
	});

	it("warns changes will be discarded when the file is tracked", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockClear();

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Discard File"));
		await waitFor(() =>
			expect(vi.mocked(ask)).toHaveBeenCalledWith(
				expect.stringContaining("Discard changes to src/main.ts"),
				{
					title: "Discard Changes",
					kind: "warning",
					okLabel: "Discard",
					cancelLabel: "Cancel",
				},
			),
		);
	});

	it("reports an error and keeps the file when the discard fails", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		const { showToast } = await import("../lib/toast.svelte.js");
		vi.mocked(ask).mockResolvedValueOnce(true);
		vi.mocked(showToast).mockClear();
		// Command-scoped, not mockImplementationOnce: a leaked flow must not consume it.
		vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
			cmd === "discard_file"
				? Promise.reject({ code: "git_error", message: "discard exploded" })
				: Promise.resolve(undefined),
		);
		const completed = vi.fn(async () => {});

		render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				onstagingaction: () => stagingCompletion(completed),
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Discard File"));
		await waitFor(() =>
			expect(vi.mocked(showToast)).toHaveBeenCalledWith(
				"discard exploded",
				"error",
			),
		);

		expect(vi.mocked(showToast)).toHaveBeenCalledWith(
			"discard exploded",
			"error",
		);
		expect(completed).not.toHaveBeenCalled();
	});

	// The action buttons' only `disabled` binding is `hunkOperationInFlight`
	// (HunkActions.svelte). Clearing it in the `finally` reopens them while the
	// refetch is still in flight, so the second click acts from the stale render
	// against an already-updated worktree.
	describe("hunk operation in-flight guard", () => {
		const twoHunkDiff: FileDiff = {
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
							origin: "Add",
							content: "first hunk",
							old_lineno: null,
							new_lineno: 1,
							spans: [],
						},
					],
				},
				{
					header: "@@ -20,1 +20,1 @@",
					old_start: 20,
					old_lines: 1,
					new_start: 20,
					new_lines: 1,
					lines: [
						{
							origin: "Add",
							content: "second hunk",
							old_lineno: null,
							new_lineno: 20,
							spans: [],
						},
					],
				},
			],
		};

		function stageHunkCalls() {
			return vi
				.mocked(safeInvoke)
				.mock.calls.filter(([cmd]) => cmd === "stage_hunk").length;
		}

		it("stays closed until the refetch completes", async () => {
			let releaseRefetch: () => void = () => {};
			const reload = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						releaseRefetch = resolve;
					}),
			);
			render(DiffPanel, {
				props: {
					...commentingDiff,
					fileDiffs: [twoHunkDiff],
					commitDetail: null,
					onclose: vi.fn(),
					diffKind: "unstaged",
					repoPath: "/test/repo",
					selectedPath: "src/main.ts",
					onstagingaction: () => stagingCompletion(reload),
				},
			});
			await flushPrefs();

			await fireEvent.click(screen.getAllByText("Stage Hunk")[0]);
			await flushPrefs();
			expect(stageHunkCalls()).toBe(1);
			expect(reload).toHaveBeenCalledOnce();

			await fireEvent.click(screen.getAllByText("Stage Hunk")[1]);
			await flushPrefs();
			expect(stageHunkCalls()).toBe(1);

			releaseRefetch();
			await flushPrefs();

			await fireEvent.click(screen.getAllByText("Stage Hunk")[1]);
			await flushPrefs();
			expect(stageHunkCalls()).toBe(2);
		});

		// Discard and Unstage share the guard with Stage, and each sends the
		// hunk whose button was clicked.
		it.each([
			{ diffKind: "unstaged", label: "Discard Hunk", cmd: "discard_hunk" },
			{ diffKind: "staged", label: "Unstage Hunk", cmd: "unstage_hunk" },
		] as const)(
			"$label sends its own hunk and stays closed until the refetch completes",
			async ({ diffKind, label, cmd }) => {
				const { ask } = await import("@tauri-apps/plugin-dialog");
				vi.mocked(ask).mockResolvedValue(true);
				onTestFinished(() => {
					vi.mocked(ask).mockResolvedValue(false);
				});
				let releaseRefetch: () => void = () => {};
				const reload = vi.fn(
					() =>
						new Promise<void>((resolve) => {
							releaseRefetch = resolve;
						}),
				);
				render(DiffPanel, {
					props: {
						...commentingDiff,
						fileDiffs: [twoHunkDiff],
						commitDetail: null,
						onclose: vi.fn(),
						diffKind,
						repoPath: "/test/repo",
						selectedPath: "src/main.ts",
						onstagingaction: () => stagingCompletion(reload),
					},
				});
				await flushPrefs();
				const calls = () =>
					vi.mocked(safeInvoke).mock.calls.filter(([c]) => c === cmd);

				await fireEvent.click(screen.getAllByText(label)[1]);
				await waitFor(() => expect(calls()).toHaveLength(1));
				expect(calls()).toEqual([
					[
						cmd,
						expect.objectContaining({
							path: "/test/repo",
							filePath: "src/main.ts",
							hunk: {
								old_start: 20,
								lines: [{ origin: "Add", content: "second hunk" }],
							},
						}),
					],
				]);

				await fireEvent.click(screen.getAllByText(label)[0]);
				await vi.dynamicImportSettled();
				await flushPrefs();
				expect(calls()).toHaveLength(1);

				releaseRefetch();
				await flushPrefs();
			},
		);
	});
});

// ---- Hunk actions on a file that changed after its diff was shown ----

describe("DiffPanel hunk actions on a changed file", () => {
	afterEach(() => {
		vi.mocked(safeInvoke).mockReset();
		vi.mocked(safeInvoke).mockImplementation(backendReply);
	});

	const rewrite = {
		header: "@@ -20,1 +20,1 @@",
		old_start: 20,
		old_lines: 1,
		new_start: 20,
		new_lines: 1,
		lines: [
			{
				origin: "Delete" as const,
				content: "old twenty",
				old_lineno: 20,
				new_lineno: null,
				spans: [],
			},
			{
				origin: "Add" as const,
				content: "new twenty",
				old_lineno: null,
				new_lineno: 20,
				spans: [],
			},
		],
	};
	const shownDiff: FileDiff = {
		path: "src/main.ts",
		old_path: null,
		status: "Modified",
		is_binary: false,
		old_size: null,
		new_size: null,
		old_id: null,
		new_id: null,
		hunks: [rewrite],
	};
	// An editor inserted a line at the top while the confirmation was open, so
	// the hunk the user saw is now the second one, a line further down.
	const reloadedDiff: FileDiff = {
		...shownDiff,
		hunks: [
			{
				header: "@@ -0,0 +1,1 @@",
				old_start: 0,
				old_lines: 0,
				new_start: 1,
				new_lines: 1,
				lines: [
					{
						origin: "Add",
						content: "new one",
						old_lineno: null,
						new_lineno: 1,
						spans: [],
					},
				],
			},
			{
				...rewrite,
				header: "@@ -20,1 +21,1 @@",
				new_start: 21,
				lines: [rewrite.lines[0], { ...rewrite.lines[1], new_lineno: 21 }],
			},
		],
	};
	const shownHunk = {
		old_start: 20,
		lines: [
			{ origin: "Delete", content: "old twenty" },
			{ origin: "Add", content: "new twenty" },
		],
	};

	function sent(command: string) {
		return vi
			.mocked(safeInvoke)
			.mock.calls.find(([cmd]) => cmd === command)?.[1];
	}

	async function renderShown({
		diffKind = "unstaged",
		onstagingaction,
	}: Pick<
		ComponentProps<typeof DiffPanel>,
		"diffKind" | "onstagingaction"
	> = {}) {
		const props = {
			...commentingDiff,
			fileDiffs: [shownDiff],
			commitDetail: null,
			onclose: vi.fn(),
			diffKind,
			repoPath: "/test/repo",
			selectedPath: "src/main.ts",
			onstagingaction,
		};
		const view = render(DiffPanel, { props });
		await flushPrefs();
		return { view, props };
	}

	async function pendingConfirmation() {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		let opened: () => void = () => {};
		const entered = new Promise<void>((resolve) => {
			opened = resolve;
		});
		let confirm: (yes: boolean) => void = () => {};
		vi.mocked(ask).mockImplementationOnce(() => {
			opened();
			return new Promise<boolean>((resolve) => {
				confirm = resolve;
			});
		});
		return { entered, confirm: (yes: boolean) => confirm(yes) };
	}

	it("discards the hunk it showed when the diff reloads during the confirmation", async () => {
		const pending = await pendingConfirmation();
		const { view, props } = await renderShown();

		await fireEvent.click(screen.getByText("Discard Hunk"));
		await pending.entered;
		await view.rerender({ ...props, fileDiffs: [reloadedDiff] });
		pending.confirm(true);

		await waitFor(() =>
			expect(sent("discard_hunk")).toMatchObject({ hunk: shownHunk }),
		);
	});

	it("discards the lines it counted when the diff reloads during the confirmation", async () => {
		const pending = await pendingConfirmation();
		const discarded = vi.fn(async () => {});
		const onstagingaction = vi.fn(() => stagingCompletion(discarded));
		const { view, props } = await renderShown({ onstagingaction });
		await fireEvent.mouseDown(gutterOf("new twenty"));
		await fireEvent.mouseUp(window);

		await fireEvent.click(
			screen.getByRole("button", { name: "Discard Lines (1)" }),
		);
		await pending.entered;
		await view.rerender({
			...props,
			diffKind: "staged",
			fileDiffs: [reloadedDiff],
		});
		vi.mocked(safeInvoke).mockResolvedValueOnce({ file_still_changed: false });
		pending.confirm(true);

		await waitFor(() => expect(discarded).toHaveBeenCalledWith("discard"));
		expect(onstagingaction).toHaveBeenCalledExactlyOnceWith(
			"src/main.ts",
			"unstaged",
		);
		expect(sent("discard_lines")).toMatchObject({
			hunk: shownHunk,
			lineIndices: [1],
		});
	});

	describe("after an action on the only hunk shown", () => {
		beforeEach(async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockResolvedValue(true);
		});

		afterEach(async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockResolvedValue(false);
		});

		function reply(command: string, fileStillChanged: boolean) {
			vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
				cmd === command
					? Promise.resolve({ file_still_changed: fileStillChanged })
					: Promise.resolve(undefined),
			);
		}

		async function pressHunkAction(name: string) {
			await fireEvent.click(screen.getByText(name));
		}

		async function pressLinesAction(name: string) {
			await fireEvent.mouseDown(gutterOf("new twenty"));
			await fireEvent.mouseUp(window);
			await fireEvent.click(screen.getByRole("button", { name }));
		}

		const actions = [
			{
				action: "Stage Hunk",
				press: pressHunkAction,
				command: "stage_hunk",
				diffKind: "unstaged",
				emptied: "stage",
			},
			{
				action: "Unstage Hunk",
				press: pressHunkAction,
				command: "unstage_hunk",
				diffKind: "staged",
				emptied: "unstage",
			},
			{
				action: "Discard Hunk",
				press: pressHunkAction,
				command: "discard_hunk",
				diffKind: "unstaged",
				emptied: "discard",
			},
			{
				action: "Stage Lines (1)",
				press: pressLinesAction,
				command: "stage_lines",
				diffKind: "unstaged",
				emptied: "stage",
			},
			{
				action: "Unstage Lines (1)",
				press: pressLinesAction,
				command: "unstage_lines",
				diffKind: "staged",
				emptied: "unstage",
			},
			{
				action: "Discard Lines (1)",
				press: pressLinesAction,
				command: "discard_lines",
				diffKind: "unstaged",
				emptied: "discard",
			},
		] as const;

		it.each(actions)(
			"stays on a file $action leaves a change in",
			async ({ action, press, command, diffKind }) => {
				reply(command, true);
				const completed = vi.fn(async () => {});
				const onstagingaction = vi.fn(() => stagingCompletion(completed));
				await renderShown({ diffKind, onstagingaction });

				await press(action);

				await waitFor(() => expect(completed).toHaveBeenCalledWith(undefined));
				expect(onstagingaction).toHaveBeenCalledWith("src/main.ts", diffKind);
			},
		);

		it.each(actions)(
			"moves on from a file $action leaves no change in",
			async ({ action, press, command, diffKind, emptied }) => {
				reply(command, false);
				const completed = vi.fn(async () => {});
				const onstagingaction = vi.fn(() => stagingCompletion(completed));
				await renderShown({ diffKind, onstagingaction });

				await press(action);

				await waitFor(() => expect(completed).toHaveBeenCalledWith(emptied));
				expect(onstagingaction).toHaveBeenCalledWith("src/main.ts", diffKind);
			},
		);
	});

	describe("when the file changed since its diff was shown", () => {
		const staleToast =
			"src/main.ts changed since its diff was shown, so nothing was done. The diff now shows the file as it is.";

		beforeEach(async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockResolvedValue(true);
			const { showToast } = await import("../lib/toast.svelte.js");
			vi.mocked(showToast).mockClear();
		});

		afterEach(async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockResolvedValue(false);
		});

		function refuseAsStale(command: string) {
			vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
				cmd === command
					? Promise.reject({ code: "stale_hunk", message: "stale" })
					: Promise.resolve(undefined),
			);
		}

		function awaitReload() {
			let reloaded: (filePath: string) => void = () => {};
			const reload = new Promise<string>((resolve) => {
				reloaded = resolve;
			});
			return {
				reload,
				onstagingaction: (filePath: string) =>
					stagingCompletion(async () => reloaded(filePath)),
			};
		}

		it.each([
			{ action: "Stage Hunk", command: "stage_hunk", diffKind: "unstaged" },
			{ action: "Unstage Hunk", command: "unstage_hunk", diffKind: "staged" },
			{ action: "Discard Hunk", command: "discard_hunk", diffKind: "unstaged" },
		] as const)(
			"reloads the diff and says nothing was done after $action",
			async ({ action, command, diffKind }) => {
				const { showToast } = await import("../lib/toast.svelte.js");
				refuseAsStale(command);
				const reloads = awaitReload();
				await renderShown({
					diffKind,
					onstagingaction: reloads.onstagingaction,
				});

				await fireEvent.click(screen.getByText(action));

				expect(await reloads.reload).toBe("src/main.ts");
				expect(vi.mocked(showToast)).toHaveBeenCalledWith(staleToast, "error");
			},
		);

		it.each([
			{
				action: "Stage Lines (1)",
				command: "stage_lines",
				diffKind: "unstaged",
			},
			{
				action: "Unstage Lines (1)",
				command: "unstage_lines",
				diffKind: "staged",
			},
			{
				action: "Discard Lines (1)",
				command: "discard_lines",
				diffKind: "unstaged",
			},
		] as const)(
			"reloads the diff and says nothing was done after $action",
			async ({ action, command, diffKind }) => {
				const { showToast } = await import("../lib/toast.svelte.js");
				refuseAsStale(command);
				const reloads = awaitReload();
				await renderShown({
					diffKind,
					onstagingaction: reloads.onstagingaction,
				});
				await fireEvent.mouseDown(gutterOf("new twenty"));
				await fireEvent.mouseUp(window);

				await fireEvent.click(screen.getByRole("button", { name: action }));

				expect(await reloads.reload).toBe("src/main.ts");
				expect(vi.mocked(showToast)).toHaveBeenCalledWith(staleToast, "error");
				expect(screen.queryByRole("button", { name: action })).toBeNull();
			},
		);
	});

	describe("when a line action lands", () => {
		beforeEach(async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockResolvedValue(true);
		});

		afterEach(async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockResolvedValue(false);
		});

		it.each([
			{ action: "Stage Lines (1)", diffKind: "unstaged" },
			{ action: "Unstage Lines (1)", diffKind: "staged" },
			{ action: "Discard Lines (1)", diffKind: "unstaged" },
		] as const)(
			"lets go of the lines $action acted on",
			async ({ action, diffKind }) => {
				const refetched = vi.fn(async () => {});
				await renderShown({
					diffKind,
					onstagingaction: () => stagingCompletion(refetched),
				});
				await fireEvent.mouseDown(gutterOf("new twenty"));
				await fireEvent.mouseUp(window);

				await fireEvent.click(screen.getByRole("button", { name: action }));

				await waitFor(() => expect(refetched).toHaveBeenCalled());
				await waitFor(() =>
					expect(screen.queryByRole("button", { name: action })).toBeNull(),
				);
			},
		);
	});

	describe("when a line action fails", () => {
		beforeEach(async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockResolvedValue(true);
			const { showToast } = await import("../lib/toast.svelte.js");
			vi.mocked(showToast).mockClear();
		});

		afterEach(async () => {
			const { ask } = await import("@tauri-apps/plugin-dialog");
			vi.mocked(ask).mockResolvedValue(false);
		});

		it.each([
			{
				action: "Stage Lines (1)",
				command: "stage_lines",
				diffKind: "unstaged",
			},
			{
				action: "Unstage Lines (1)",
				command: "unstage_lines",
				diffKind: "staged",
			},
			{
				action: "Discard Lines (1)",
				command: "discard_lines",
				diffKind: "unstaged",
			},
		] as const)(
			"keeps the lines selected for another try after $action",
			async ({ action, command, diffKind }) => {
				const { showToast } = await import("../lib/toast.svelte.js");
				vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
					cmd === command
						? Promise.reject(new Error("index.lock exists"))
						: Promise.resolve(undefined),
				);
				await renderShown({ diffKind });
				await fireEvent.mouseDown(gutterOf("new twenty"));
				await fireEvent.mouseUp(window);

				await fireEvent.click(screen.getByRole("button", { name: action }));

				await waitFor(() =>
					expect(vi.mocked(showToast)).toHaveBeenCalledWith(
						"index.lock exists",
						"error",
					),
				);
				expect(screen.getByRole("button", { name: action })).toBeTruthy();
			},
		);
	});
});

// ---- Hunk navigation over a virtualized view ----

describe("DiffPanel hunk navigation", () => {
	// Rows in hunk mode, with their offsets: header(28) alpha(18) beta(18)
	// header(28) gamma(18) delta(18) epsilon(18) — so the second hunk's header
	// starts at 64 and its lines at 92, 110 and 128.
	const navDiff: FileDiff = {
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
				header: "@@ -1,2 +1,2 @@",
				old_start: 1,
				old_lines: 2,
				new_start: 1,
				new_lines: 2,
				lines: [
					{
						origin: "Context",
						content: "alpha",
						old_lineno: 1,
						new_lineno: 1,
						spans: [],
					},
					{
						origin: "Context",
						content: "beta",
						old_lineno: 2,
						new_lineno: 2,
						spans: [],
					},
				],
			},
			{
				// The old side declares one more line than the hunk carries, which
				// is the shape a jump to an unrepresented line number takes.
				header: "@@ -10,3 +10,2 @@",
				old_start: 10,
				old_lines: 3,
				new_start: 10,
				new_lines: 2,
				lines: [
					{
						origin: "Context",
						content: "gamma",
						old_lineno: 10,
						new_lineno: 10,
						spans: [],
					},
					{
						origin: "Delete",
						content: "delta",
						old_lineno: 11,
						new_lineno: null,
						spans: [],
					},
					{
						origin: "Add",
						content: "epsilon",
						old_lineno: null,
						new_lineno: 11,
						spans: [],
					},
				],
			},
		],
	};

	function renderNav(viewComments: Thread[] = [], keysActive = true) {
		const result = render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [navDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/repo",
				selectedPath: "src/main.ts",
				viewComments,
				keysActive,
			},
		});
		return { ...result, ready: flushPrefs() };
	}

	function viewportOf(container: Element): HTMLElement {
		return container.querySelector(".exact-virtual-viewport") as HTMLElement;
	}

	it("scrolls the list to the next hunk's row on ]", async () => {
		const { container, ready } = renderNav();
		await ready;

		await fireEvent.keyDown(window, { key: "]" });
		await tick();

		expect(viewportOf(container).scrollTop).toBe(64);
	});

	// Split view is virtualized too, and publishes the same handle: both of hunk
	// 0's lines are Context, so they pair one-to-one and the second hunk's header
	// lands at the same 64px offset the inline view puts it at.
	it("scrolls the split list to the next hunk's row on ]", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("split"),
		);
		try {
			const { container, ready } = renderNav();
			await ready;

			await fireEvent.keyDown(window, { key: "]" });
			await tick();

			expect(viewportOf(container).scrollTop).toBe(64);
			expect(
				screen.getByText("@@ -10,3 +10,2 @@").closest(".split-hunk-header")
					?.className,
			).toContain("hunk-highlight");
		} finally {
			vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
				Promise.resolve("inline"),
			);
		}
	});

	it.each([
		{ name: "Cmd+]", key: "]", metaKey: true },
		{ name: "Ctrl+]", key: "]", ctrlKey: true },
		{ name: "Alt+]", key: "]", altKey: true },
	])("stays put on $name", async ({ name: _, ...init }) => {
		const { container, ready } = renderNav();
		await ready;

		await fireEvent.keyDown(window, init);
		await tick();

		expect(viewportOf(container).scrollTop).toBe(0);
	});

	it("stays put on ] while its tab is hidden", async () => {
		const { container, ready } = renderNav([], false);
		await ready;

		await fireEvent.keyDown(window, { key: "]" });
		await tick();

		expect(viewportOf(container).scrollTop).toBe(0);
	});

	it("scrolls back to the previous hunk's row on [", async () => {
		const { container, ready } = renderNav();
		await ready;

		await fireEvent.keyDown(window, { key: "]" });
		await tick();
		await fireEvent.keyDown(window, { key: "[" });
		await tick();

		expect(viewportOf(container).scrollTop).toBe(0);
	});

	it("stays put on ] once the last hunk is focused", async () => {
		const { container, ready } = renderNav();
		await ready;

		await fireEvent.keyDown(window, { key: "]" });
		await tick();
		await fireEvent.keyDown(window, { key: "]" });
		await tick();

		expect(viewportOf(container).scrollTop).toBe(64);
	});

	// The reader's own scrolling moves where the next and previous hunks are,
	// so a step goes from what is on screen, not from the last hunk stepped to.
	it("scrolls back to the hunk above on [ after the reader scrolled past it", async () => {
		const { container, ready } = renderNav();
		await ready;
		const viewport = viewportOf(container);

		viewport.scrollTop = 100;
		await fireEvent.scroll(viewport);
		await fireEvent.keyDown(window, { key: "[" });
		await tick();

		expect(viewport.scrollTop).toBe(64);
	});

	it("scrolls to the hunk below on ] after the reader scrolled back above it", async () => {
		const { container, ready } = renderNav();
		await ready;
		const viewport = viewportOf(container);

		await fireEvent.keyDown(window, { key: "]" });
		await tick();
		viewport.scrollTop = 0;
		await fireEvent.scroll(viewport);
		await fireEvent.keyDown(window, { key: "]" });
		await tick();

		expect(viewport.scrollTop).toBe(64);
	});

	it("steps from the source viewport after it scrolls away and back to a clamped jump", async () => {
		vi.useFakeTimers();
		onTestFinished(() => {
			vi.useRealTimers();
		});
		stubLayout({ width: 900, height: 116, replace: true });
		const { container, ready } = renderNav();
		await ready;
		const viewport = viewportOf(container);
		const content = viewport.querySelector<HTMLElement>(
			".exact-virtual-content",
		);
		const lastHeader = screen
			.getByText("@@ -10,3 +10,2 @@")
			.closest(".hunk-toolbar");
		const contentHeight = Number.parseFloat(content?.style.height ?? "");
		clampScrollTop(viewport, contentHeight);
		const bottom = contentHeight - viewport.clientHeight;
		expect(bottom).toBeGreaterThan(0);
		expect(bottom).toBeLessThan(64);

		await fireEvent.keyDown(window, { key: "]" });
		await fireEvent.scroll(viewport);
		expect(viewport.scrollTop).toBe(bottom);
		expect(lastHeader).toHaveClass("hunk-highlight");
		vi.advanceTimersByTime(600);
		await tick();
		expect(lastHeader).not.toHaveClass("hunk-highlight");
		await fireEvent.scroll(viewport, { target: { scrollTop: bottom - 1 } });
		await fireEvent.scroll(viewport, { target: { scrollTop: bottom } });

		await fireEvent.keyDown(window, { key: "]" });

		expect(lastHeader).toHaveClass("hunk-highlight");
	});

	// A refetch moves the hunks under a scroll position the reader left alone,
	// so the step goes from the rows now on screen. Two more lines in the first
	// hunk put the second hunk's header at 100.
	it("scrolls to the hunk below on ] after a refetch moved the hunks", async () => {
		const { container, ready, rerender } = renderNav();
		await ready;
		const [first, second] = navDiff.hunks;
		const context = (content: string, lineno: number) => ({
			origin: "Context" as const,
			content,
			old_lineno: lineno,
			new_lineno: lineno,
			spans: [],
		});
		const refetched: FileDiff = {
			...navDiff,
			hunks: [
				{
					...first,
					header: "@@ -1,4 +1,4 @@",
					old_lines: 4,
					new_lines: 4,
					lines: [...first.lines, context("beta 2", 3), context("beta 3", 4)],
				},
				second,
			],
		};

		await fireEvent.keyDown(window, { key: "]" });
		await tick();
		await rerender({ fileDiffs: [refetched] });
		await fireEvent.keyDown(window, { key: "]" });
		await tick();

		expect(viewportOf(container).scrollTop).toBe(100);
	});

	// A file shown whole arrives as one hunk, so the steps are its runs of
	// changed lines: here delta and epsilon, the fourth and fifth rows.
	describe("with the whole file shown", () => {
		async function renderWhole(layout: "inline" | "split") {
			const storeMock = await import("../lib/store.js");
			vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
				Promise.resolve(layout),
			);
			const result = render(DiffPanel, {
				props: {
					...commentingDiff,
					fileDiffs: [navDiff],
					commitDetail: null,
					onclose: vi.fn(),
					diffKind: "unstaged",
					contentMode: "full",
					repoPath: "/repo",
					selectedPath: "src/main.ts",
					keysActive: true,
				},
			});
			await flushPrefs();
			return result;
		}

		afterEach(async () => {
			const storeMock = await import("../lib/store.js");
			vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
				Promise.resolve("inline"),
			);
		});

		it.each(["inline", "split"] as const)(
			"scrolls the %s view to the next run of changed lines on ]",
			async (layout) => {
				const { container } = await renderWhole(layout);

				await fireEvent.keyDown(window, { key: "]" });
				await tick();

				expect(viewportOf(container).scrollTop).toBe(3 * 18);
			},
		);

		it.each(["inline", "split"] as const)(
			"flashes the %s view's run of changed lines on ] and clears it when the flash ends",
			async (layout) => {
				const { container } = await renderWhole(layout);
				vi.useFakeTimers();
				try {
					await fireEvent.keyDown(window, { key: "]" });
					await tick();

					const lit = [...container.querySelectorAll(".run-flash")].map(
						(row) => row.textContent ?? "",
					);
					expect(lit.join(" ")).toMatch(/delta[\s\S]*epsilon/);
					expect(lit.join(" ")).not.toContain("gamma");

					vi.advanceTimersByTime(600);
					await tick();

					expect(container.querySelectorAll(".run-flash")).toHaveLength(0);
				} finally {
					vi.useRealTimers();
				}
			},
		);

		it("scrolls the inline view to the anchored line's own row", async () => {
			const { container, component } = await renderWhole("inline");

			component.scrollToLine(11, 11, "New");
			await tick();

			expect(viewportOf(container).scrollTop).toBe(4 * 18);
		});
	});

	it("scrolls to the anchored new-side line's own row, not to its hunk header", async () => {
		const { container, component, ready } = renderNav();
		await ready;

		component.scrollToLine(11, 11, "New");
		await tick();

		expect(viewportOf(container).scrollTop).toBe(128);
	});

	it("resolves an old-side anchor against the old line numbers", async () => {
		const { container, component, ready } = renderNav();
		await ready;

		component.scrollToLine(11, 11, "Old");
		await tick();

		expect(viewportOf(container).scrollTop).toBe(110);
	});

	it("falls back to the hunk's own row for a line number the hunk does not carry", async () => {
		const { container, component, ready } = renderNav();
		await ready;

		component.scrollToLine(12, 12, "Old");
		await tick();

		expect(viewportOf(container).scrollTop).toBe(64);
	});

	it("scrolls to a thread drawn between the hunks when no hunk covers its line", async () => {
		const between = aThread({
			id: "t-between",
			anchor: {
				commit_oid: "abc123",
				file_path: "src/main.ts",
				source: "Diff",
				side: "New",
				start_line: 5,
				end_line: 5,
			},
		});
		const { container, component, ready } = renderNav([between]);
		await ready;

		component.scrollToLine(5, 5, "New");
		await tick();
		await tick();

		expect(viewportOf(container).scrollTop).toBe(64);
	});

	it("scrolls the split list to a thread drawn between the hunks", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("split"),
		);
		try {
			const between = aThread({
				id: "t-between",
				anchor: {
					commit_oid: "abc123",
					file_path: "src/main.ts",
					source: "Diff",
					side: "Old",
					start_line: 5,
					end_line: 5,
				},
			});
			const { container, component, ready } = renderNav([between]);
			await ready;

			component.scrollToLine(5, 5, "Old");
			await tick();
			await tick();

			expect(viewportOf(container).scrollTop).toBe(64);
		} finally {
			vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
				Promise.resolve("inline"),
			);
		}
	});

	it("falls back to the first hunk when no hunk covers the line", async () => {
		const { container, component, ready } = renderNav();
		await ready;

		await fireEvent.keyDown(window, { key: "]" });
		await tick();
		component.scrollToLine(900, 900, "New");
		await tick();

		expect(viewportOf(container).scrollTop).toBe(0);
	});

	const changeLines = [3, 9, 17, 23];
	const paragraph = (text: string, top: number, height: number) =>
		`<p data-test-top="${top}" data-test-height="${height}">${text}</p>`;
	const renderedContentHeight = 330;
	const twoSidedChange = (line: number, nextTop: number): MarkdownRow => ({
		kind: "changed",
		beforeHtml: paragraph(`before ${line}`, line * 10, 10),
		afterHtml: paragraph(
			`after ${line}`,
			line * 10 + 10,
			nextTop - (line * 10 + 10),
		),
		afterStart: line,
		afterEnd: line,
	});
	const inlineChanges: MarkdownRow[] = [
		twoSidedChange(3, 90),
		twoSidedChange(9, 130),
		{
			kind: "unchanged",
			blockKind: "paragraph",
			html: paragraph("folded text", 130, 40),
			afterStart: 13,
			afterEnd: 13,
		},
		twoSidedChange(17, 230),
		twoSidedChange(23, renderedContentHeight),
	];
	function addedOrRemovedBlock(
		side: "added" | "removed",
		line: number,
		index: number,
	) {
		const nextLine = changeLines[index + 1];
		const nextTop =
			nextLine === undefined ? renderedContentHeight : nextLine * 10;
		return paragraph(`${side} ${line}`, line * 10, nextTop - line * 10);
	}

	const addedBlocks = changeLines.map(
		(line, index): MarkdownRow => ({
			kind: "added",
			html: addedOrRemovedBlock("added", line, index),
			afterStart: line,
			afterEnd: line,
		}),
	);
	const removedBlocks = changeLines.map(
		(line, index): MarkdownRow => ({
			kind: "removed",
			html: addedOrRemovedBlock("removed", line, index),
			beforeStart: line,
			beforeEnd: line,
			afterAnchor: 0,
		}),
	);

	async function openRendered(
		layoutMode: "inline" | "split",
		rows: MarkdownRow[],
		block: string,
		geometry = { contentHeight: renderedContentHeight, viewportHeight: 100 },
	) {
		vi.mocked(safeInvoke).mockResolvedValue({
			rows,
			whitespaceOnly: false,
			changedLines: changeLines,
		});
		const paneTop = 160;
		stubLayout({
			width: 900,
			height: 400,
			replace: true,
			measure(el) {
				if (el.matches(".rendered-diff")) {
					return { top: paneTop, height: geometry.viewportHeight };
				}
				if (!el.matches(".rendered-block")) return;
				const block = el.querySelector<HTMLElement>("[data-test-top]");
				const viewport = el.closest<HTMLElement>(".rendered-diff");
				if (!block || !viewport) return;

				return {
					top: paneTop + Number(block.dataset.testTop) - viewport.scrollTop,
					height: Number(block.dataset.testHeight),
				};
			},
		});
		render(DiffPanel, {
			props: {
				...commentingDiff,
				diffPreferences: new DiffPreferences({
					layoutMode,
					renderMode: "rendered",
					contextLines: 3,
					ignoreWhitespace: false,
					showInvisibles: false,
					wordWrap: false,
				}),
				fileDiffs: [{ ...navDiff, path: "README.md" }],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/repo",
				selectedPath: "README.md",
			},
		});
		const viewport = (await screen.findByText(block)).closest<HTMLElement>(
			".rendered-diff",
		);
		if (!viewport) throw new Error("rendered diff viewport missing");
		clampScrollTop(viewport, geometry.contentHeight);

		return viewport;
	}

	function clampScrollTop(viewport: HTMLElement, contentHeight: number) {
		let top = 0;
		Object.defineProperty(viewport, "scrollTop", {
			get: () => top,
			set(next: number) {
				top = Math.max(
					0,
					Math.min(next, contentHeight - viewport.clientHeight),
				);
			},
		});
	}

	function openRenderedWithClampedTail() {
		const blockHeight = 40;
		const rows = Array.from(
			{ length: 6 },
			(_, index): MarkdownRow => ({
				kind: "added",
				html: paragraph(`block ${index + 1}`, index * blockHeight, blockHeight),
				afterStart: index * 2 + 1,
				afterEnd: index * 2 + 1,
			}),
		);

		return openRendered("inline", rows, "block 1", {
			contentHeight: rows.length * blockHeight,
			viewportHeight: 110,
		});
	}

	it("continues through rendered changes that share a clamped scroll offset", async () => {
		const viewport = await openRenderedWithClampedTail();
		await fireEvent.scroll(viewport, { target: { scrollTop: 125 } });

		await fireEvent.keyDown(window, { key: "]" });
		await fireEvent.scroll(viewport);
		expect(viewport.scrollTop).toBe(130);
		expect(viewport.querySelector(".hunk-highlight")).toHaveTextContent(
			"block 5",
		);

		await fireEvent.keyDown(window, { key: "]" });

		expect(viewport.scrollTop).toBe(130);
		const landing = viewport.querySelector(".hunk-highlight");
		expect(landing).toHaveTextContent("block 6");
		expect(getComputedStyle(landing as Element).animation).toContain(
			"hunk-flash",
		);
	});

	it("steps from the rendered viewport after it scrolls away and back to a clamped jump", async () => {
		const viewport = await openRenderedWithClampedTail();
		await fireEvent.scroll(viewport, { target: { scrollTop: 125 } });
		await fireEvent.keyDown(window, { key: "]" });
		await fireEvent.scroll(viewport);
		await fireEvent.keyDown(window, { key: "]" });
		expect(viewport.querySelector(".hunk-highlight")).toHaveTextContent(
			"block 6",
		);
		await fireEvent.scroll(viewport, { target: { scrollTop: 110 } });
		await fireEvent.scroll(viewport, { target: { scrollTop: 130 } });

		await fireEvent.keyDown(window, { key: "]" });

		expect(viewport.scrollTop).toBe(130);
		expect(viewport.querySelector(".hunk-highlight")).toHaveTextContent(
			"block 5",
		);
	});

	it.each([
		{ key: "]", expected: 230 },
		{ key: "[", expected: 170 },
	])("steps from the rendered viewport on $key", async ({ key, expected }) => {
		const viewport = await openRendered("inline", inlineChanges, "before 3");
		await fireEvent.scroll(viewport, { target: { scrollTop: 200 } });

		await fireEvent.keyDown(window, { key });

		expect(viewport.scrollTop).toBe(expected);
	});

	it.each([
		{ side: "added", rows: addedBlocks, key: "]", expected: 230 },
		{ side: "removed", rows: removedBlocks, key: "[", expected: 170 },
	])(
		"steps through a split diff with only $side blocks on $key",
		async ({ side, rows, key, expected }) => {
			const viewport = await openRendered("split", rows, `${side} 3`);
			await fireEvent.scroll(viewport, { target: { scrollTop: 200 } });

			await fireEvent.keyDown(window, { key });

			expect(viewport.scrollTop).toBe(expected);
		},
	);

	it("scrolls to a later review anchor when rendered markdown was open", async () => {
		vi.mocked(safeInvoke).mockResolvedValue({
			rows: inlineChanges,
			whitespaceOnly: false,
			changedLines: changeLines,
		});
		const preferences = new DiffPreferences({
			layoutMode: "inline",
			renderMode: "rendered",
			contextLines: 3,
			ignoreWhitespace: false,
			showInvisibles: false,
			wordWrap: false,
		});
		const thread = aThread({
			id: "later-markdown-thread",
			state: "done",
			anchor: {
				commit_oid: "abc123",
				file_path: "README.md",
				source: "Diff",
				side: "New",
				start_line: 11,
				end_line: 11,
			},
		});
		const props = {
			...commentingDiff,
			diffPreferences: preferences,
			fileDiffs: [{ ...navDiff, path: "README.md" }],
			commitDetail: { ...nonMergeCommit, oid: "abc123" },
			onclose: vi.fn(),
			diffKind: "commit" as const,
			repoPath: "/repo",
			selectedPath: "README.md",
			viewComments: [thread],
		};
		const { component, container, rerender } = render(DiffPanel, {
			props: { ...props, loading: true, payloadStale: true },
		});
		await screen.findByText("before 3");

		component.jumpToThread(thread, 11, 11, "New");
		await tick();
		expect(screen.getByText("Loading diff…")).toBeVisible();
		await rerender({ ...props, loading: false, payloadStale: false });

		expect(viewportOf(container)?.scrollTop).toBe(128);
		expect(
			screen.getByRole("button", { name: "Collapse thread" }),
		).toBeVisible();
		expect(preferences.renderMode).toBe("rendered");
	});

	it("reprojects rendered markdown immediately while Source is loading", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getRenderMode).mockImplementation(() =>
			Promise.resolve("rendered"),
		);
		vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
			cmd === "render_markdown_diff"
				? Promise.resolve({
						rows: [
							{
								kind: "changed",
								beforeHtml: "<p>before</p>",
								afterHtml: "<p>after</p>",
								mergedHtml: "<p>full projection</p>",
								hunkMergedHtml: "<p>prior hunk projection</p>",
								afterStart: 1,
								afterEnd: 1,
							},
						],
						whitespaceOnly: false,
						changedLines: [1],
					})
				: Promise.resolve(undefined),
		);
		const props = {
			...commentingDiff,
			fileDiffs: [{ ...navDiff, path: "README.md" }],
			commitDetail: null,
			onclose: vi.fn(),
			diffKind: "unstaged" as const,
			repoPath: "/repo",
			selectedPath: "README.md",
			contentMode: "hunk" as const,
			loading: false,
		};
		try {
			const view = render(DiffPanel, { props });
			await flushPrefs();
			expect(await screen.findByText("prior hunk projection")).toBeTruthy();

			await view.rerender({
				...props,
				contentMode: "full",
				loading: true,
			});

			expect(await screen.findByText("full projection")).toBeTruthy();
			expect(screen.queryByText("prior hunk projection")).toBeFalsy();
		} finally {
			vi.mocked(storeMock.getRenderMode).mockImplementation(() =>
				Promise.resolve("source"),
			);
		}
	});

	it("keeps rendered markdown visible while the source reload has failed", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getRenderMode).mockImplementation(() =>
			Promise.resolve("rendered"),
		);
		vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
			cmd === "render_markdown_diff"
				? Promise.resolve({
						rows: [
							{
								kind: "changed",
								beforeHtml: "<p>before</p>",
								afterHtml: "<p>rendered full stays</p>",
								mergedHtml: "<p>rendered full stays</p>",
								hunkMergedHtml: "<p>stale hunk projection</p>",
								afterStart: 1,
								afterEnd: 1,
							},
						],
						whitespaceOnly: false,
						changedLines: [1],
					})
				: Promise.resolve(undefined),
		);
		try {
			render(DiffPanel, {
				props: {
					...commentingDiff,
					fileDiffs: [{ ...navDiff, path: "README.md" }],
					commitDetail: null,
					onclose: vi.fn(),
					diffKind: "unstaged",
					repoPath: "/repo",
					selectedPath: "README.md",
					contentMode: "full",
					loadError: "source failed",
					onretry: vi.fn(),
				},
			});
			await flushPrefs();

			expect(await screen.findByText("rendered full stays")).toBeTruthy();
			expect(screen.queryByText("stale hunk projection")).toBeFalsy();
			await fireEvent.click(screen.getByTitle("Show source"));
			expect(await screen.findByText("Could not load diff")).toBeTruthy();
			expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
		} finally {
			vi.mocked(storeMock.getRenderMode).mockImplementation(() =>
				Promise.resolve("source"),
			);
		}
	});

	// A compare selection pairs renames across the whole base-to-target range,
	// so the rendered before side must read at the compare base, not the
	// target's first parent — otherwise a rename earlier in the range reads a
	// path that's already gone there (TRUNK-163).
	it("reads the rendered before side at the compare base oid, not the commit's parent", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getRenderMode).mockImplementation(() =>
			Promise.resolve("rendered"),
		);
		vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
			cmd === "render_markdown_diff"
				? Promise.resolve({
						rows: [
							{
								kind: "unchanged",
								blockKind: "paragraph",
								html: "<p>alpha</p>",
								afterStart: 1,
								afterEnd: 1,
							},
						],
						whitespaceOnly: false,
						changedLines: [],
					})
				: Promise.resolve(undefined),
		);

		try {
			render(DiffPanel, {
				props: {
					...commentingDiff,
					fileDiffs: [{ ...navDiff, path: "README.md" }],
					commitDetail: {
						oid: "target",
						parent_oids: ["targetParent"],
					} as CommitDetail,
					compareBaseOid: "compareBase",
					onclose: vi.fn(),
					diffKind: "commit",
					repoPath: "/repo",
					selectedPath: "README.md",
				},
			});
			await flushPrefs();
			await screen.findByText("alpha");

			expect(safeInvoke).toHaveBeenCalledWith(
				"render_markdown_diff",
				expect.objectContaining({
					beforeRev: { type: "commit", oid: "compareBase" },
				}),
			);
		} finally {
			vi.mocked(storeMock.getRenderMode).mockImplementation(() =>
				Promise.resolve("source"),
			);
		}
	});

	it("flashes the target hunk's header row and clears it when the flash ends", async () => {
		const { ready } = renderNav();
		await ready;

		vi.useFakeTimers();
		try {
			await fireEvent.keyDown(window, { key: "]" });
			await tick();

			const toolbar = screen
				.getByText("@@ -10,3 +10,2 @@")
				.closest(".hunk-toolbar");
			expect(toolbar?.className).toContain("hunk-highlight");

			vi.advanceTimersByTime(600);
			await tick();

			expect(
				screen.getByText("@@ -10,3 +10,2 @@").closest(".hunk-toolbar")
					?.className,
			).not.toContain("hunk-highlight");
		} finally {
			vi.useRealTimers();
		}
	});

	describe("when a jump lands on a done thread", () => {
		const done = aThread({
			id: "t-done",
			state: "done",
			anchor: {
				commit_oid: "abc123",
				file_path: "src/main.ts",
				source: "Diff",
				side: "New",
				start_line: 11,
				end_line: 11,
			},
		});

		async function renderJumpTarget(props: {
			layout: "inline" | "split";
			contentMode: "hunk" | "full";
			fileDiff: FileDiff;
		}) {
			const storeMock = await import("../lib/store.js");
			vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
				Promise.resolve(props.layout),
			);
			const result = render(DiffPanel, {
				props: {
					...commentingDiff,
					fileDiffs: [props.fileDiff],
					commitDetail: null,
					onclose: vi.fn(),
					diffKind: "unstaged",
					contentMode: props.contentMode,
					repoPath: "/repo",
					selectedPath: "src/main.ts",
					viewComments: [done],
				},
			});
			await flushPrefs();
			return result;
		}

		afterEach(async () => {
			const storeMock = await import("../lib/store.js");
			vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
				Promise.resolve("inline"),
			);
		});

		it.each([
			{ layout: "inline", contentMode: "hunk" },
			{ layout: "split", contentMode: "hunk" },
			{ layout: "inline", contentMode: "full" },
			{ layout: "split", contentMode: "full" },
		] as const)(
			"opens it in the $layout layout in $contentMode mode",
			async ({ layout, contentMode }) => {
				const { component } = await renderJumpTarget({
					layout,
					contentMode,
					fileDiff: navDiff,
				});

				component.jumpToThread(done, 11, 11, "New");
				await tick();

				expect(
					screen.getByRole("button", { name: "Collapse thread" }),
				).toHaveAttribute("aria-expanded", "true");
			},
		);

		it("keeps it open through a switch to the side-by-side view", async () => {
			const { component, container } = await renderJumpTarget({
				layout: "inline",
				contentMode: "hunk",
				fileDiff: navDiff,
			});
			component.jumpToThread(done, 11, 11, "New");
			await tick();

			await fireEvent.click(screen.getByTitle("Side-by-side view"));
			await flushPrefs();

			expect(container.querySelectorAll(".split-row")).not.toHaveLength(0);
			expect(
				screen.getByRole("button", { name: "Collapse thread" }),
			).toHaveAttribute("aria-expanded", "true");
		});

		it("opens it under the note of a file with no changes", async () => {
			const { component } = await renderJumpTarget({
				layout: "inline",
				contentMode: "hunk",
				fileDiff: { ...navDiff, hunks: [] },
			});

			component.jumpToThread(done, 11, 11, "New");
			await tick();

			expect(
				screen.getByRole("button", { name: "Collapse thread" }),
			).toHaveAttribute("aria-expanded", "true");
		});
	});
});

describe("DiffPanel diff settings", () => {
	afterEach(async () => {
		const store = await import("../lib/store.js");
		await Promise.all([
			store.setDiffLayoutMode("inline"),
			store.setDiffIgnoreWhitespace(false),
			store.setDiffShowInvisibles(false),
			store.setDiffWordWrap(false),
			store.setRenderMode("source"),
		]);
	});

	function renderSharing(
		diffPreferences: DiffPreferences,
		path = testDiff.path,
	) {
		return render(DiffPanel, {
			props: {
				...commentingDiff,
				fileDiffs: [{ ...testDiff, path }],
				selectedPath: path,
				commitDetail: null,
				onclose: vi.fn(),
				diffPreferences,
			},
		});
	}

	it.each([
		"Ignore whitespace changes",
		"Show invisible characters",
		"Toggle word wrap",
	])(
		"shows %s turned on in one open diff in every other diff open at once",
		async (control) => {
			const diffPreferences = DiffPreferences.defaults();
			const changed = renderSharing(diffPreferences);
			const other = renderSharing(diffPreferences);

			await fireEvent.click(within(changed.container).getByTitle(control));

			expect(within(other.container).getByTitle(control)).toHaveAttribute(
				"aria-pressed",
				"true",
			);
		},
	);

	it("shows the layout chosen in one open diff in every other diff open at once", async () => {
		const diffPreferences = DiffPreferences.defaults();
		const changed = renderSharing(diffPreferences);
		const other = renderSharing(diffPreferences);

		await fireEvent.click(
			within(changed.container).getByTitle("Side-by-side view"),
		);

		expect(within(other.container).getByTitle("Inline view")).toBeTruthy();
	});

	it("shows the markdown view chosen in one open diff in every other diff open at once", async () => {
		vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
			cmd === "render_markdown_diff"
				? Promise.resolve({ rows: [], whitespaceOnly: false, changedLines: [] })
				: Promise.resolve(undefined),
		);
		onTestFinished(() => {
			vi.mocked(safeInvoke).mockImplementation(() =>
				Promise.resolve(undefined),
			);
		});
		const diffPreferences = DiffPreferences.defaults();
		const changed = renderSharing(diffPreferences, "README.md");
		const other = renderSharing(diffPreferences, "README.md");

		await fireEvent.click(
			within(changed.container).getByTitle("Show rendered markdown"),
		);

		expect(within(other.container).getByTitle("Show source")).toBeTruthy();
	});
});

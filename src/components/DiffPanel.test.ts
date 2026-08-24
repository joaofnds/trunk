import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restoreLayout, stubLayout } from "../__tests__/helpers/layout-stub";
import {
	pairLines,
	splitInvisibles,
	trailingWhitespaceStart,
} from "../lib/diff-utils.js";
import { safeInvoke } from "../lib/invoke.js";
import type { CommitDetail, DiffLine, FileDiff } from "../lib/types.js";
import DiffPanel from "./DiffPanel.svelte";

// Shared Tauri mock
import "../__tests__/helpers/tauri-mock";

// Both inline views render through a virtual list, which mounts no rows at all
// against jsdom's zero-height viewport. The box is wide enough for the widest
// fixture line and tall enough that a two-hunk file mounts both toolbars.
beforeEach(() => stubLayout({ width: 900, height: 400 }));
afterEach(restoreLayout);

// Helper: flush microtasks (Promise.resolve in store mocks) + Svelte update queue
// Needed because DiffPanel loads preferences via $effect Promise.all which resolves
// asynchronously. This ensures the component has processed the loaded values.
async function flushPrefs() {
	await new Promise((r) => setTimeout(r, 0));
	await tick();
}

// Selection now arms from the line-number gutter grip, not the code content, so
// press events must target the grip.
function gutterOf(text: string): HTMLElement {
	const grip = screen
		.getByText(text)
		.closest(".diff-line")
		?.querySelector(".gutter-grip") as HTMLElement | null;
	if (!grip) throw new Error(`no gutter grip for "${text}"`);
	return grip;
}

// Mock invoke and toast for hunk staging operations. Every command resolves to
// undefined; tests that need a return value override safeInvoke per case.
vi.mock("../lib/invoke.js", async () => {
	const actual =
		await vi.importActual<typeof import("../lib/invoke.js")>(
			"../lib/invoke.js",
		);
	return {
		...actual,
		safeInvoke: vi.fn(() => Promise.resolve(undefined)),
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
	return {
		getRenderMode: vi.fn(() => Promise.resolve(currentRenderMode)),
		setRenderMode: vi.fn((mode: string) => {
			currentRenderMode = mode;
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
		getDiffShowFullFile: vi.fn().mockResolvedValue(false),
		setDiffShowFullFile: vi.fn().mockResolvedValue(undefined),
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
	status: "Modified",
	is_binary: false,
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

const binaryDiff: FileDiff = {
	path: "image.png",
	status: "Modified",
	is_binary: true,
	hunks: [],
};

const untrackedDiff: FileDiff = {
	path: "src/new.ts",
	status: "Untracked",
	is_binary: false,
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

	it("shows binary file indicator", async () => {
		render(DiffPanel, {
			props: {
				fileDiffs: [binaryDiff],
				commitDetail: null,
				selectedPath: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();
		expect(
			screen.getByText(/Binary file.*no diff available/),
		).toBeInTheDocument();
	});

	it("calls onclose when close button clicked", async () => {
		const onclose = vi.fn();
		render(DiffPanel, {
			props: {
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

	it("shows a Comment File button for unstaged diffs", async () => {
		render(DiffPanel, {
			props: {
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

	// Comment File anchors the WHOLE file: every new-side line. testDiff's new side is
	// new_lineno 1,2,3,4 (Context 1, Add 2, Add 3, Context 4), so the composer opens
	// over lines 1-4 — not a single hunk's sub-range.
	it("opens the composer over the file's full new-side range on Comment File click", async () => {
		render(DiffPanel, {
			props: {
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Comment File"));
		await flushPrefs();

		expect(screen.getByText("Comments on lines 1-4")).toBeInTheDocument();
	});

	// Regression (260531-l02): opening a whole-hunk comment captures the anchor
	// up-front. A working-tree comment writes a snapshot commit, which fires a
	// repo-changed → diff refetch → clearSelection mid-compose. Previously the
	// composer re-derived its range from the now-empty selection → Math.min(...[])
	// = Infinity. The captured anchor must survive a fileDiffs reload.
	it("keeps the whole-hunk comment range finite when the diff reloads mid-compose", async () => {
		const baseProps = {
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

	it("shows Unstage Hunk button for staged diffs", async () => {
		render(DiffPanel, {
			props: {
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
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		// Let the initial $effect (getDiffContentMode/getDiffLayoutMode) settle
		await flushPrefs();
		await fireEvent.click(screen.getByTitle("Side-by-side view"));
		// Flush Svelte reactivity
		await flushPrefs();
		// Split view should render paired rows with two cells each
		const rows = container.querySelectorAll(".split-columns");
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

describe("VIEW-04: reopening a large file", () => {

	// Closing the diff leaves the fetched payload in RepoView's commitFileDiffs,
	// so a reopen mounts DiffPanel against the whole file. The persisted mode
	// arrives a microtask later, so the first frame renders whatever the
	// optimistic default routes to — and against a full-file payload that frame
	// is the freeze this milestone exists to remove.
	it("mounts no rows before the persisted diff mode has resolved", async () => {
		const storeMock = await import("../lib/store.js");
		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("full"),
		);
		vi.mocked(storeMock.getDiffLayoutMode).mockImplementation(() =>
			Promise.resolve("inline"),
		);
		const bigFile: FileDiff = {
			path: "src/huge.ts",
			status: "Modified",
			is_binary: false,
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
				fileDiffs: [bigFile],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});

		expect(container.querySelectorAll(".diff-line").length).toBe(0);

		await flushPrefs();

		expect(container.querySelectorAll(".diff-line").length).toBeLessThan(200);

		vi.mocked(storeMock.getDiffContentMode).mockImplementation(() =>
			Promise.resolve("hunk"),
		);
	});
});

// ---- WHSP-02: Staging disabled when whitespace ignore active ----

describe("WHSP-02: Staging disabled when whitespace ignore active", () => {
	it("disables Stage Hunk button when whitespace ignore is active", async () => {
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
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
			},
		});
		await flushPrefs();
		await flushPrefs();

		const stageBtn = screen.getByText("Stage Hunk");
		expect(stageBtn.closest("button")).toBeDisabled();

		// Reset mock
		vi.mocked(storeMock.getDiffIgnoreWhitespace).mockImplementation(() =>
			Promise.resolve(false),
		);
	});

	it("disables Stage File button when whitespace ignore is active", async () => {
		const storeMock = await import("../lib/store.js");
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
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
			},
		});
		await flushPrefs();
		await flushPrefs();

		const stageFileBtn = screen.getByText("Stage File");
		expect(stageFileBtn.closest("button")).toBeDisabled();

		vi.mocked(storeMock.getDiffIgnoreWhitespace).mockImplementation(() =>
			Promise.resolve(false),
		);
	});

	it("shows tooltip on disabled staging buttons", async () => {
		const storeMock = await import("../lib/store.js");
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
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
			},
		});
		await flushPrefs();
		await flushPrefs();

		const stageBtn = screen.getByText("Stage Hunk").closest("button");
		expect(stageBtn?.title).toBe(
			"Staging is disabled while whitespace changes are ignored",
		);

		vi.mocked(storeMock.getDiffIgnoreWhitespace).mockImplementation(() =>
			Promise.resolve(false),
		);
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
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();

		const wrapBtn = screen.getByTitle("Toggle word wrap");
		// Before click: should not have active class
		expect(wrapBtn.classList.contains("active")).toBe(false);

		await fireEvent.click(wrapBtn);
		await flushPrefs();

		// After click: should have active class
		expect(wrapBtn.classList.contains("active")).toBe(true);
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
});

// ---- VIEW-02: Split view layout ----

describe("VIEW-02: Split view layout", () => {
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
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();

		// Split view should render paired rows with two cells each
		const rows = container.querySelectorAll(".split-columns");
		expect(rows.length).toBeGreaterThan(0);
		// Each row should have two cells
		const firstRow = rows[0];
		expect(firstRow.querySelectorAll(".split-column").length).toBe(2);

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
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
			},
		});
		await flushPrefs();

		// The split view is rendered -- verify paired rows exist
		const rows = container.querySelectorAll(".split-columns");
		expect(rows.length).toBeGreaterThan(0);

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
		const rows = container.querySelectorAll(".split-columns");
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

	it("disables staging buttons when whitespace ignore is active in split view", async () => {
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
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
			},
		});
		await flushPrefs();
		await flushPrefs();

		const stageBtn = screen.getByText("Stage Hunk").closest("button");
		expect(stageBtn).toBeDisabled();
		expect(stageBtn?.title).toBe(
			"Staging is disabled while whitespace changes are ignored",
		);

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
				const style = current.getAttribute("style") || "";
				if (style.includes("container-type: inline-size")) return current;
				current = current.parentElement;
			}
			return null;
		}

		it("a container query context sits above every row, so sticky sizing resolves", async () => {
			const { container } = render(DiffPanel, {
				props: {
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
			const style = context?.getAttribute("style") ?? "";
			expect(style).toContain("overscroll-behavior-x: none");
		});

		it("hunk toolbar is horizontally sticky so buttons stay visible", async () => {
			render(DiffPanel, {
				props: {
					fileDiffs: [testDiff],
					commitDetail: null,
					onclose: vi.fn(),
				},
			});
			await flushPrefs();
			const hunkHeaderText = screen.getByText("@@ -1,3 +1,4 @@");
			const toolbar = hunkHeaderText.parentElement;
			expect(toolbar).toBeTruthy();
			const style = toolbar?.getAttribute("style") ?? "";
			expect(style).toContain("position: sticky");
			expect(style).toContain("left: 0");
		});

		it("file header is horizontally sticky in multi-file view", async () => {
			const { container } = render(DiffPanel, {
				props: {
					fileDiffs: [testDiff],
					commitDetail: null,
					selectedPath: null,
					onclose: vi.fn(),
				},
			});
			await flushPrefs();
			const headers = container.querySelectorAll('[role="button"]');
			const fileHeader = Array.from(headers).find((el) =>
				el.textContent?.includes("src/main.ts"),
			);
			expect(fileHeader).toBeTruthy();
			const style = fileHeader?.getAttribute("style") ?? "";
			expect(style).toContain("position: sticky");
			expect(style).toContain("left: 0");
		});

		it("diff lines wrapper ensures full-width backgrounds via min-width", async () => {
			const { container } = render(DiffPanel, {
				props: {
					fileDiffs: [testDiff],
					commitDetail: null,
					onclose: vi.fn(),
				},
			});
			await flushPrefs();
			const line = container.querySelector(".diff-line");
			expect(line).toBeTruthy();
			const wrapper = line?.parentElement;
			expect(wrapper).toBeTruthy();
			const style = wrapper?.getAttribute("style") ?? "";
			expect(style).toContain("min-width: 100%");
		});
	});
});

const nonMergeCommit: CommitDetail = {
	oid: "abc123def456",
	short_oid: "abc123d",
	summary: "a normal commit",
	body: null,
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
	status: "Added",
	is_binary: false,
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

describe("DiffPanel drag-to-select", () => {
	// testDiff hunk lines: Context(0), Delete(1), Add "const x = 2;"(2),
	// Add "const y = 3;"(3), Context(4). In commit mode the on-selection affordance
	// renders "Comment (N)" with N = the live selectedCount — the observable readout
	// these tests assert on (0 when nothing is selected: the label drops the count).
	function selectedCount(): number {
		const btn = screen.queryByRole("button", { name: /^Comment \(/ });
		const m = btn?.textContent?.match(/\((\d+)\)/);
		return m ? Number(m[1]) : 0;
	}

	// mouseenter does not bubble, so fire it on the line div (which holds the
	// handler), not the inner content span that getByText returns.
	function lineDiv(text: string): HTMLElement {
		const el = screen.getByText(text).closest(".diff-line");
		if (!el) throw new Error(`no diff line for "${text}"`);
		return el as HTMLElement;
	}

	function renderCommit() {
		render(DiffPanel, {
			props: {
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
		await fireEvent.mouseEnter(lineDiv("const y = 3;"), { buttons: 1 });
		await tick();

		expect(selectedCount()).toBe(2);
	});

	it("does not extend the selection on a hover with no button held", async () => {
		await renderCommit();

		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.mouseEnter(lineDiv("const y = 3;"), { buttons: 0 });
		await tick();

		expect(selectedCount()).toBe(1);
	});

	it("deselects the range when the drag starts on an already-selected line", async () => {
		await renderCommit();

		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.mouseEnter(lineDiv("const y = 3;"), { buttons: 1 });
		await tick();
		expect(selectedCount()).toBe(2);

		// A fresh drag from a selected line deselects as it paints across the range.
		await fireEvent.mouseDown(gutterOf("const x = 2;"));
		await tick();
		await fireEvent.mouseEnter(lineDiv("const y = 3;"), { buttons: 1 });
		await tick();
		expect(selectedCount()).toBe(0);
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

		expect(gutterOf("const x = 2;").style.userSelect).toBe("none");
		expect(screen.getByText("const x = 2;").style.userSelect).toBe("text");
	});
});

describe("DiffPanel comment affordance (commit diffs)", () => {
	it("shows an enabled Comment affordance on a non-merge commit selection", async () => {
		render(DiffPanel, {
			props: {
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

	it("keeps the Comment affordance enabled on an Added file (status forces side, does not disable)", async () => {
		render(DiffPanel, {
			props: {
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
		await new Promise((r) => setTimeout(r, 0));
		await tick();

		expect(askMock).toHaveBeenCalledTimes(1);
		// Composer stays open because the switch was cancelled.
		expect(screen.getByRole("textbox")).toBeTruthy();
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"unsaved note",
		);
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
		await new Promise((r) => setTimeout(r, 0));
		await tick();
	}

	// Submit the open composer and settle the async resolve -> snapshot -> add_thread chain.
	async function submitComposer(note: string) {
		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		await fireEvent.input(textarea, { target: { value: note } });
		await tick();
		await fireEvent.click(screen.getByRole("button", { name: /submit/i }));
		await new Promise((r) => setTimeout(r, 0));
		await tick();
	}

	function calledCommands(): string[] {
		return vi.mocked(safeInvoke).mock.calls.map((c) => c[0] as string);
	}

	function renderPanel() {
		render(DiffPanel, {
			props: {
				fileDiffs: [testDiff],
				commitDetail: nonMergeCommit,
				onclose: vi.fn(),
				diffKind: "commit",
				repoPath: "/repo",
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
});

describe("Discard File button", () => {
	// Without this reset, a discard flow that outlives its test steals the next
	// test's safeInvoke override and flakes it under load.
	afterEach(() => {
		vi.mocked(safeInvoke).mockReset();
		vi.mocked(safeInvoke).mockImplementation(() => Promise.resolve(undefined));
	});

	it("shows the Discard File button for unstaged diffs", async () => {
		render(DiffPanel, {
			props: {
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
		const onfileemptied = vi.fn();

		render(DiffPanel, {
			props: {
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				onfileemptied,
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Discard File"));
		await flushPrefs();

		expect(vi.mocked(safeInvoke)).toHaveBeenCalledWith("discard_file", {
			path: "/test/repo",
			filePath: "src/main.ts",
		});
		expect(onfileemptied).toHaveBeenCalledWith("src/main.ts", "discard");
	});

	it("keeps the file when the user cancels the confirmation", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockResolvedValueOnce(false);
		vi.mocked(safeInvoke).mockClear();
		const onfileemptied = vi.fn();

		render(DiffPanel, {
			props: {
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				onfileemptied,
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Discard File"));
		await flushPrefs();

		expect(vi.mocked(safeInvoke)).not.toHaveBeenCalledWith(
			"discard_file",
			expect.anything(),
		);
		expect(onfileemptied).not.toHaveBeenCalled();
	});

	it("renders Discard File before Stage File", async () => {
		render(DiffPanel, {
			props: {
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
		await flushPrefs();

		expect(vi.mocked(ask)).toHaveBeenCalledWith(
			expect.stringContaining("untracked and will be permanently removed"),
			{ title: "Delete File", kind: "warning" },
		);
	});

	it("warns changes will be discarded when the file is tracked", async () => {
		const { ask } = await import("@tauri-apps/plugin-dialog");
		vi.mocked(ask).mockClear();

		render(DiffPanel, {
			props: {
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
		await flushPrefs();

		expect(vi.mocked(ask)).toHaveBeenCalledWith(
			expect.stringContaining("Discard changes to src/main.ts"),
			{ title: "Discard Changes", kind: "warning" },
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
		const onfileemptied = vi.fn();

		render(DiffPanel, {
			props: {
				fileDiffs: [testDiff],
				commitDetail: null,
				onclose: vi.fn(),
				diffKind: "unstaged",
				repoPath: "/test/repo",
				selectedPath: "src/main.ts",
				onfileemptied,
			},
		});
		await flushPrefs();

		await fireEvent.click(screen.getByText("Discard File"));
		await flushPrefs();

		expect(vi.mocked(showToast)).toHaveBeenCalledWith(
			"discard exploded",
			"error",
		);
		expect(onfileemptied).not.toHaveBeenCalled();
	});

	// The action buttons' only `disabled` binding is `hunkOperationInFlight`
	// (HunkView.svelte:103). Clearing it in the `finally` reopens them while the
	// refetch is still in flight, so the second click carries a hunk index from
	// the stale render and the backend applies it positionally against an
	// already-updated worktree.
	describe("hunk operation in-flight guard", () => {
		const twoHunkDiff: FileDiff = {
			path: "src/main.ts",
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
			const onhunkaction = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						releaseRefetch = resolve;
					}),
			);
			render(DiffPanel, {
				props: {
					fileDiffs: [twoHunkDiff],
					commitDetail: null,
					onclose: vi.fn(),
					diffKind: "unstaged",
					repoPath: "/test/repo",
					selectedPath: "src/main.ts",
					onhunkaction,
				},
			});
			await flushPrefs();

			await fireEvent.click(screen.getAllByText("Stage Hunk")[0]);
			await flushPrefs();
			expect(stageHunkCalls()).toBe(1);
			expect(onhunkaction).toHaveBeenCalledOnce();

			await fireEvent.click(screen.getAllByText("Stage Hunk")[1]);
			await flushPrefs();
			expect(stageHunkCalls()).toBe(1);

			releaseRefetch();
			await flushPrefs();

			await fireEvent.click(screen.getAllByText("Stage Hunk")[1]);
			await flushPrefs();
			expect(stageHunkCalls()).toBe(2);
		});
	});
});

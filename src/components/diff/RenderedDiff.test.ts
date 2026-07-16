import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffRow } from "../../lib/markdown.js";
import RenderedDiff from "./RenderedDiff.svelte";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

// Mock the shared IPC helper (not `invoke`) per the project's test convention.
// Keep the real `isTrunkError` guard — RenderedDiff's catch depends on it.
const safeInvoke = vi.fn();
vi.mock("../../lib/invoke.js", async (importActual) => ({
	...(await importActual<typeof import("../../lib/invoke.js")>()),
	safeInvoke: (cmd: string, args: Record<string, unknown>) =>
		safeInvoke(cmd, args),
}));

const baseProps = {
	layoutMode: "inline" as const,
	selectedPath: "README.md",
	diffKind: "unstaged" as const,
	commitOid: "",
	repoPath: "/repo",
	commitDetail: null,
	contentMode: "full" as const,
	contextLines: 3,
	wordWrap: false,
};

// Isolate call counts + implementations between tests so a per-test mock can't
// leak into the next (the re-layout test asserts an exact fetch count).
afterEach(() => safeInvoke.mockReset());

describe("RenderedDiff", () => {
	it("renders a word-merged changed block as ONE block with inline del/ins (inline)", async () => {
		const rows: DiffRow[] = [
			{
				kind: "changed",
				beforeHtml: "<p>the quick fox</p>",
				afterHtml: "<p>the slow fox</p>",
				wordHtml:
					'<p>the <del class="md-word-delete">quick</del><ins class="md-word-add">slow</ins> fox</p>',
			},
		];
		safeInvoke.mockResolvedValue(rows);

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "inline" },
		});
		await screen.findByText(/slow/);

		// One merged block, no wrapper tint — the inline md-word-* marks carry it.
		const blocks = container.querySelectorAll(".rendered-block");
		expect(blocks).toHaveLength(1);
		expect(blocks[0].classList.contains("md-removed")).toBe(false);
		expect(blocks[0].classList.contains("md-added")).toBe(false);
		expect(blocks[0].querySelector("del.md-word-delete")?.textContent).toBe(
			"quick",
		);
		expect(blocks[0].querySelector("ins.md-word-add")?.textContent).toBe(
			"slow",
		);
	});

	it("renders a changed row WITHOUT wordHtml as removed-before then added-after (inline)", async () => {
		const rows: DiffRow[] = [
			{ kind: "unchanged", html: "<p>intro</p>", lines: 1 },
			{ kind: "removed", html: "<p>gone</p>" },
			{ kind: "added", html: "<p>fresh</p>" },
			{ kind: "changed", beforeHtml: "<p>old</p>", afterHtml: "<p>new</p>" },
		];
		safeInvoke.mockResolvedValue(rows);

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "inline" },
		});
		await screen.findByText("intro");

		const blocks = container.querySelectorAll(".rendered-block");
		expect(blocks).toHaveLength(5);
		expect(blocks[1].classList.contains("md-removed")).toBe(true);
		expect(blocks[1].textContent).toContain("gone");
		expect(blocks[2].classList.contains("md-added")).toBe(true);
		expect(blocks[2].textContent).toContain("fresh");
		// A container/code/dense changed row (no wordHtml) mirrors Source: removed
		// before-block, then added after-block — red then green.
		expect(blocks[3].classList.contains("md-removed")).toBe(true);
		expect(blocks[3].textContent).toContain("old");
		expect(blocks[4].classList.contains("md-added")).toBe(true);
		expect(blocks[4].textContent).toContain("new");
	});

	it("pairs each row as two side-by-side columns, ignoring wordHtml (split)", async () => {
		const rows: DiffRow[] = [
			{ kind: "unchanged", html: "<p>same</p>", lines: 1 },
			{ kind: "added", html: "<p>addition</p>" },
			{ kind: "removed", html: "<p>deletion</p>" },
			{
				kind: "changed",
				beforeHtml: "<p>bef</p>",
				afterHtml: "<p>aft</p>",
				// Even with a word merge available, split stays whole-block red/green.
				wordHtml: '<p><ins class="md-word-add">aft</ins></p>',
			},
		];
		safeInvoke.mockResolvedValue(rows);

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "split" },
		});
		await screen.findAllByText("same");

		// One flex pair per DiffRow (Source's .split-columns model): the row's
		// height is max(left, right) via flex stretch, and each column is its own
		// synced horizontal scroller.
		const rowEls = container.querySelectorAll(".split-columns");
		expect(rowEls).toHaveLength(4);
		const cols = (i: number) => [...rowEls[i].children] as HTMLElement[];

		// unchanged: same html both sides, untinted.
		expect(cols(0)[0].textContent).toContain("same");
		expect(cols(0)[1].textContent).toContain("same");
		expect(cols(0)[0].querySelector(".md-added, .md-removed")).toBeNull();
		// added: left phantom column, right added-tint.
		expect(cols(1)[0].classList.contains("rendered-phantom")).toBe(true);
		expect(cols(1)[1].querySelector(".md-added")).not.toBeNull();
		expect(cols(1)[1].textContent).toContain("addition");
		// removed: left removed-tint, right phantom column.
		expect(cols(2)[0].querySelector(".md-removed")).not.toBeNull();
		expect(cols(2)[0].textContent).toContain("deletion");
		expect(cols(2)[1].classList.contains("rendered-phantom")).toBe(true);
		// changed: whole before(red) left, after(green) right — NOT the word merge.
		expect(cols(3)[0].querySelector(".md-removed")).not.toBeNull();
		expect(cols(3)[0].textContent).toContain("bef");
		expect(cols(3)[1].querySelector(".md-added")).not.toBeNull();
		expect(cols(3)[1].textContent).toContain("aft");
		expect(cols(3)[1].querySelector("ins.md-word-add")).toBeNull();
	});

	it("shows one placeholder for the absent before column of an added file (split)", async () => {
		safeInvoke.mockResolvedValue([
			{ kind: "added", html: "<h1>Hello</h1>" },
			{ kind: "added", html: "<p>body</p>" },
		] satisfies DiffRow[]);

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "split" },
		});
		expect(await screen.findByText("Hello")).toBeInTheDocument();
		expect(screen.getByText("body")).toBeInTheDocument();

		expect(screen.getAllByText("Not present at this revision")).toHaveLength(1);
		expect(container.querySelectorAll(".rendered-phantom")).toHaveLength(0);

		const row = container.querySelector(".split-columns") as Element;
		expect(row.children[0].textContent).toContain(
			"Not present at this revision",
		);
	});

	it("shows one placeholder for the absent after column of a deleted file (split)", async () => {
		safeInvoke.mockResolvedValue([
			{ kind: "removed", html: "<h1>Bye</h1>" },
		] satisfies DiffRow[]);

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "split" },
		});
		expect(await screen.findByText("Bye")).toBeInTheDocument();
		expect(screen.getAllByText("Not present at this revision")).toHaveLength(1);

		const row = container.querySelector(".split-columns") as Element;
		const kids = row.children;
		expect(kids[kids.length - 1].textContent).toContain(
			"Not present at this revision",
		);
	});

	it("collapses an interior unchanged run to a separator, honoring contextLines (inline)", async () => {
		const rows: DiffRow[] = [
			{ kind: "changed", beforeHtml: "<p>ob</p>", afterHtml: "<p>nb</p>" },
		];
		for (let i = 0; i < 10; i++)
			rows.push({ kind: "unchanged", html: `<p>u${i}</p>`, lines: 1 });
		rows.push({
			kind: "changed",
			beforeHtml: "<p>oe</p>",
			afterHtml: "<p>ne</p>",
		});
		safeInvoke.mockResolvedValue(rows);

		const { container, rerender } = render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "inline",
				contentMode: "hunk",
				contextLines: 3,
			},
		});
		await screen.findByText("nb");

		// 3 context each side; middle 4 collapse. Each change (no wordHtml) is 2
		// inline blocks (removed+added): 2×2 + 3 + 3 = 10.
		expect(container.querySelectorAll(".rendered-block")).toHaveLength(10);
		expect(container.querySelector(".rendered-sep")?.textContent).toContain(
			"4",
		);

		await rerender({
			...baseProps,
			layoutMode: "inline",
			contentMode: "hunk",
			contextLines: 1,
		});
		expect(container.querySelectorAll(".rendered-block")).toHaveLength(6);
		expect(container.querySelector(".rendered-sep")?.textContent).toContain(
			"8",
		);
	});

	it("always keeps the adjacent block even when it alone exceeds the budget, never bare (hunk)", async () => {
		const rows: DiffRow[] = [
			{ kind: "changed", beforeHtml: "<p>ob</p>", afterHtml: "<p>nb</p>" },
			{ kind: "unchanged", html: "<p>big</p>", lines: 5 },
			{ kind: "changed", beforeHtml: "<p>oe</p>", afterHtml: "<p>ne</p>" },
		];
		safeInvoke.mockResolvedValue(rows);

		const { container } = render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "inline",
				contentMode: "hunk",
				contextLines: 3,
			},
		});
		await screen.findByText("nb");

		expect(container.querySelectorAll(".rendered-block")).toHaveLength(5);
		expect(screen.getByText("big")).toBeInTheDocument();
		expect(container.querySelectorAll(".rendered-sep")).toHaveLength(0);
	});

	it("drops leading and trailing unchanged runs without a separator (hunk)", async () => {
		const rows: DiffRow[] = [];
		for (let i = 0; i < 5; i++)
			rows.push({ kind: "unchanged", html: `<p>lead${i}</p>`, lines: 1 });
		rows.push({
			kind: "changed",
			beforeHtml: "<p>ob</p>",
			afterHtml: "<p>nb</p>",
		});
		for (let i = 0; i < 5; i++)
			rows.push({ kind: "unchanged", html: `<p>tail${i}</p>`, lines: 1 });
		safeInvoke.mockResolvedValue(rows);

		const { container } = render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "inline",
				contentMode: "hunk",
				contextLines: 1,
			},
		});
		await screen.findByText("nb");

		expect(container.querySelectorAll(".rendered-block")).toHaveLength(4);
		expect(container.querySelectorAll(".rendered-sep")).toHaveLength(0);
	});

	it("collapses an interior run identically in split, with one full-width separator", async () => {
		const rows: DiffRow[] = [
			{ kind: "changed", beforeHtml: "<p>ob</p>", afterHtml: "<p>nb</p>" },
		];
		for (let i = 0; i < 10; i++)
			rows.push({ kind: "unchanged", html: `<p>u${i}</p>`, lines: 1 });
		rows.push({
			kind: "changed",
			beforeHtml: "<p>oe</p>",
			afterHtml: "<p>ne</p>",
		});
		safeInvoke.mockResolvedValue(rows);

		const { container } = render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "split",
				contentMode: "hunk",
				contextLines: 3,
			},
		});
		await screen.findAllByText("nb");

		expect(container.querySelectorAll(".rendered-block")).toHaveLength(16);
		expect(container.querySelectorAll(".rendered-sep")).toHaveLength(1);
	});

	it("shows a No changes note in hunk mode when nothing changed, keeping the full doc", async () => {
		safeInvoke.mockResolvedValue([
			{ kind: "unchanged", html: "<p>alpha</p>", lines: 1 },
			{ kind: "unchanged", html: "<p>beta</p>", lines: 1 },
		] satisfies DiffRow[]);

		const { container } = render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "inline",
				contentMode: "hunk",
				contextLines: 3,
			},
		});
		await screen.findByText("alpha");

		expect(container.querySelectorAll(".rendered-block")).toHaveLength(2);
		expect(container.querySelector(".rendered-sep")).toBeNull();
		expect(screen.getByText("No changes")).toBeInTheDocument();
	});

	it("shows no note in full mode when nothing changed", async () => {
		safeInvoke.mockResolvedValue([
			{ kind: "unchanged", html: "<p>alpha</p>", lines: 1 },
		] satisfies DiffRow[]);

		render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "inline",
				contentMode: "full",
				contextLines: 3,
			},
		});
		await screen.findByText("alpha");
		expect(screen.queryByText("No changes")).toBeNull();
	});

	it("re-projects the same array across layout/content toggles without varying the fetch", async () => {
		safeInvoke.mockResolvedValue([
			{ kind: "changed", beforeHtml: "<p>bef</p>", afterHtml: "<p>aft</p>" },
			{ kind: "unchanged", html: "<p>ctx</p>", lines: 1 },
		] satisfies DiffRow[]);

		const { container, rerender } = render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "inline",
				contentMode: "full",
				contextLines: 3,
			},
		});
		await screen.findByText("aft");

		const toggles = [
			{ layoutMode: "split", contentMode: "full", contextLines: 3 },
			{ layoutMode: "split", contentMode: "hunk", contextLines: 3 },
			{ layoutMode: "inline", contentMode: "hunk", contextLines: 1 },
		] as const;
		for (const t of toggles) {
			await rerender({ ...baseProps, ...t });
		}

		const distinctFetches = new Set(
			safeInvoke.mock.calls.map((c) => JSON.stringify(c)),
		);
		expect(distinctFetches.size).toBe(1);
		expect(safeInvoke.mock.calls[0][0]).toBe("render_markdown_diff");

		expect(container.querySelector(".rendered-content.split")).toBeNull();
		expect(
			container.querySelectorAll(".rendered-block").length,
		).toBeGreaterThan(0);
	});

	it("sizes one shared content wrapper by the word-wrap toggle, like Source", async () => {
		safeInvoke.mockResolvedValue([
			{
				kind: "unchanged",
				html: "<pre><code>long line</code></pre>",
				lines: 1,
			},
		] satisfies DiffRow[]);

		const { container, rerender } = render(RenderedDiff, {
			props: { ...baseProps, wordWrap: true },
		});
		await screen.findByText("long line");

		// Wrap on: the wrap class (keys the pre-wrap CSS) + the shared wrapper at
		// 100%. The width is an inline style — the one seam jsdom can assert.
		expect(container.querySelector(".rendered-diff.wrap")).not.toBeNull();
		const wrapped = container.querySelector(".rendered-content") as HTMLElement;
		expect(wrapped.style.width).toBe("100%");

		// Wrap off: no wrap class; the ONE wrapper grows to the longest line so
		// every block, tint, and separator spans the same scrolled width.
		await rerender({ ...baseProps, wordWrap: false });
		expect(container.querySelector(".rendered-diff.wrap")).toBeNull();
		const unwrapped = container.querySelector(
			".rendered-content",
		) as HTMLElement;
		expect(unwrapped.style.width).toBe("max-content");
		expect(unwrapped.style.minWidth).toBe("100%");
	});

	it("pans split per column under wrap-off: outer stays panel width, column content grows (like Source)", async () => {
		// Source parity: the outer wrapper never widens in split — each half-panel
		// column is its own (synced) horizontal scroller whose inner content grows
		// to max-content, exactly SplitView's per-column wrappers.
		safeInvoke.mockResolvedValue([
			{ kind: "unchanged", html: "<p>same</p>", lines: 1 },
		] satisfies DiffRow[]);

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "split", wordWrap: false },
		});
		await screen.findAllByText("same");

		const wrapper = container.querySelector(
			".rendered-content.split",
		) as HTMLElement;
		expect(wrapper.style.width).toBe("100%");

		const colContents = [
			...container.querySelectorAll(".split-col-content"),
		] as HTMLElement[];
		expect(colContents).toHaveLength(2);
		for (const el of colContents) {
			expect(el.style.width).toBe("max-content");
			expect(el.style.minWidth).toBe("100%");
		}
	});

	it("ignores a stale in-flight render when the selected file changes mid-flight", async () => {
		const first = deferred<DiffRow[]>();
		const second = deferred<DiffRow[]>();
		safeInvoke.mockImplementation((_cmd: string, args: { filePath: string }) =>
			args.filePath === "A.md" ? first.promise : second.promise,
		);

		const { rerender } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "inline", selectedPath: "A.md" },
		});
		await rerender({
			...baseProps,
			layoutMode: "inline",
			selectedPath: "B.md",
		});

		second.resolve([{ kind: "unchanged", html: "<p>SECOND</p>", lines: 1 }]);
		expect(await screen.findByText("SECOND")).toBeInTheDocument();

		first.resolve([{ kind: "unchanged", html: "<p>FIRST</p>", lines: 1 }]);
		await tick();
		await Promise.resolve();

		expect(screen.queryByText("FIRST")).toBeNull();
		expect(screen.getByText("SECOND")).toBeInTheDocument();
	});
});

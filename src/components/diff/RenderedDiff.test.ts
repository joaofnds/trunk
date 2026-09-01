import { render, screen } from "@testing-library/svelte";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffRow, MarkdownDiff } from "../../lib/markdown.js";
import { reactiveProps } from "../../lib/reactive-props.svelte.js";
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
	ignoreWhitespace: false,
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
				mergedHtml:
					'<p>the <del class="md-word-delete">quick</del><ins class="md-word-add">slow</ins> fox</p>',
				afterStart: 1,
				afterEnd: 1,
			},
		];
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });

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

	it("renders one merged copy per changed block inline, pair when refused", async () => {
		const rows: DiffRow[] = [
			{
				kind: "changed",
				beforeHtml: "<ul><li>old third</li></ul>",
				afterHtml: "<ul><li>new third</li></ul>",
				mergedHtml:
					'<ul><li><del class="md-word-delete">old</del><ins class="md-word-add">new</ins> third</li></ul>',
				afterStart: 1,
				afterEnd: 1,
			},
			{
				kind: "changed",
				beforeHtml: "<pre>let x = 1;</pre>",
				afterHtml: "<pre>let x = 2;</pre>",
				afterStart: 3,
				afterEnd: 3,
			},
		];
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "inline" as const },
		});
		await screen.findByText(/third/);

		const blocks = container.querySelectorAll(".rendered-block");
		expect(blocks).toHaveLength(3);
		expect(blocks[0].querySelector("del.md-word-delete")?.textContent).toBe(
			"old",
		);
		expect(blocks[0].querySelector("ins.md-word-add")?.textContent).toBe("new");
		expect(blocks[0].classList.contains("md-removed")).toBe(false);
		expect(blocks[1].classList.contains("md-removed")).toBe(true);
		expect(blocks[2].classList.contains("md-added")).toBe(true);
	});

	// The merged copy is a single stream with no left and right, so it belongs to
	// the inline layout alone. Split keeps the before/after columns: that pair IS
	// what the two-column view is for, and collapsing it would leave markdown
	// with no side-by-side reading at all.
	it("keeps the before/after columns in split, ignoring the merged copy", async () => {
		const rows: DiffRow[] = [
			{
				kind: "changed",
				beforeHtml: "<p>old</p>",
				afterHtml: "<p>new</p>",
				mergedHtml:
					'<p><del class="md-word-delete">old</del><ins class="md-word-add">new</ins></p>',
				afterStart: 1,
				afterEnd: 1,
			},
		];
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "split" as const },
		});
		await screen.findByText(/new/);

		expect(container.querySelector(".rendered-content.split")).not.toBeNull();
		expect(container.querySelector("del.md-word-delete")).toBeNull();
	});

	it("renders a changed row WITHOUT a merged copy as removed-before then added-after (inline)", async () => {
		const rows: DiffRow[] = [
			{ kind: "unchanged", html: "<p>intro</p>", afterStart: 1, afterEnd: 1 },
			{
				kind: "removed",
				html: "<p>gone</p>",
				beforeStart: 3,
				beforeEnd: 3,
				afterAnchor: 1,
			},
			{ kind: "added", html: "<p>fresh</p>", afterStart: 3, afterEnd: 3 },
			{
				kind: "changed",
				beforeHtml: "<p>old</p>",
				afterHtml: "<p>new</p>",
				afterStart: 5,
				afterEnd: 5,
			},
		];
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });

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
		// A container/code/dense changed row (no merged copy) mirrors Source: removed
		// before-block, then added after-block — red then green.
		expect(blocks[3].classList.contains("md-removed")).toBe(true);
		expect(blocks[3].textContent).toContain("old");
		expect(blocks[4].classList.contains("md-added")).toBe(true);
		expect(blocks[4].textContent).toContain("new");
	});

	it("drops the block wash only from a changed row whose leaves are tinted (inline)", async () => {
		const rows: DiffRow[] = [
			{
				kind: "changed",
				beforeHtml: '<ul><li class="md-removed">one</li><li>two</li></ul>',
				afterHtml: '<ul><li class="md-added">uno</li><li>two</li></ul>',
				hasTints: true,
				afterStart: 1,
				afterEnd: 2,
			},
			{
				kind: "changed",
				beforeHtml: "<pre>before fence</pre>",
				afterHtml: "<pre>after fence</pre>",
				afterStart: 4,
				afterEnd: 4,
			},
		];
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "inline" },
		});
		await screen.findByText("uno");

		// The tinted <li> already points at the change, so its two copies keep the
		// rail and lose the background; a row with nothing to point at keeps both,
		// or it would render as two identical untinted copies.
		const washes = [...container.querySelectorAll(".rendered-block")].map(
			(b) => [
				b.classList.contains("md-removed") || b.classList.contains("md-added"),
				b.classList.contains("no-wash"),
			],
		);
		expect(washes).toEqual([
			[true, true],
			[true, true],
			[true, false],
			[true, false],
		]);
	});

	it("drops the block wash only from a changed row whose leaves are tinted (split)", async () => {
		const rows: DiffRow[] = [
			{
				kind: "changed",
				beforeHtml: '<ul><li class="md-removed">one</li></ul>',
				afterHtml: '<ul><li class="md-added">uno</li></ul>',
				hasTints: true,
				afterStart: 1,
				afterEnd: 1,
			},
			{
				kind: "changed",
				beforeHtml: "<pre>before fence</pre>",
				afterHtml: "<pre>after fence</pre>",
				afterStart: 3,
				afterEnd: 3,
			},
		];
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "split" },
		});
		await screen.findByText("uno");

		const washes = [...container.querySelectorAll(".rendered-block")].map(
			(b) => [
				b.classList.contains("md-removed") || b.classList.contains("md-added"),
				b.classList.contains("no-wash"),
			],
		);
		// Column-major: both left cells, then both right cells.
		expect(washes).toEqual([
			[true, true],
			[true, false],
			[true, true],
			[true, false],
		]);
	});

	it("stacks all rows of a run inside exactly two synced column scrollers (split)", async () => {
		const rows: DiffRow[] = [
			{ kind: "unchanged", html: "<p>same</p>", afterStart: 1, afterEnd: 1 },
			{ kind: "added", html: "<p>addition</p>", afterStart: 3, afterEnd: 3 },
			{
				kind: "removed",
				html: "<p>deletion</p>",
				beforeStart: 3,
				beforeEnd: 3,
				afterAnchor: 3,
			},
			{
				kind: "changed",
				beforeHtml: "<p>bef</p>",
				afterHtml: "<p>aft</p>",
				// Even with a word merge available, split stays whole-block red/green.
				mergedHtml: '<p><ins class="md-word-add">aft</ins></p>',
				afterStart: 5,
				afterEnd: 5,
			},
		];
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "split" },
		});
		await screen.findAllByText("same");

		// Source's column-level scroll model (d1c299f): ONE .split-columns for
		// the whole run with exactly TWO scrollers — never a scroller pair per
		// row. Rows whose content fits the pane must still pan with the run;
		// per-row scrollers cannot scroll at all (scrollWidth == clientWidth).
		expect(container.querySelectorAll(".split-columns")).toHaveLength(1);
		const columns = container.querySelectorAll(".split-column");
		expect(columns).toHaveLength(2);

		const cellsOf = (col: Element) =>
			[...col.querySelectorAll(".split-cell")] as HTMLElement[];
		const left = cellsOf(columns[0]);
		const right = cellsOf(columns[1]);
		expect(left).toHaveLength(4);
		expect(right).toHaveLength(4);

		// unchanged: same html both sides, untinted.
		expect(left[0].textContent).toContain("same");
		expect(right[0].textContent).toContain("same");
		expect(left[0].querySelector(".md-added, .md-removed")).toBeNull();
		// added: left phantom cell, right added-tint.
		expect(left[1].classList.contains("rendered-phantom")).toBe(true);
		expect(right[1].querySelector(".md-added")).not.toBeNull();
		expect(right[1].textContent).toContain("addition");
		// removed: left removed-tint, right phantom cell.
		expect(left[2].querySelector(".md-removed")).not.toBeNull();
		expect(left[2].textContent).toContain("deletion");
		expect(right[2].classList.contains("rendered-phantom")).toBe(true);
		// changed: whole before(red) left, after(green) right — NOT the word merge.
		expect(left[3].querySelector(".md-removed")).not.toBeNull();
		expect(left[3].textContent).toContain("bef");
		expect(right[3].querySelector(".md-added")).not.toBeNull();
		expect(right[3].textContent).toContain("aft");
		expect(right[3].querySelector("ins.md-word-add")).toBeNull();
	});

	it("shows one placeholder for the absent before column of an added file (split)", async () => {
		safeInvoke.mockResolvedValue({
			whitespaceOnly: false,
			rows: [
				{ kind: "added", html: "<h1>Hello</h1>", afterStart: 1, afterEnd: 1 },
				{ kind: "added", html: "<p>body</p>", afterStart: 3, afterEnd: 3 },
			] satisfies DiffRow[],
		});

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
		safeInvoke.mockResolvedValue({
			whitespaceOnly: false,
			rows: [
				{
					kind: "removed",
					html: "<h1>Bye</h1>",
					beforeStart: 1,
					beforeEnd: 1,
					afterAnchor: 0,
				},
			] satisfies DiffRow[],
		});

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

	// One unchanged one-line paragraph per line 2..11, flanked by a change on
	// line 1 and one on line 12 — contiguous lines, so contextLines maps exactly
	// onto visible rows (Source's semantics: N context lines each side).
	function changeSandwich(): DiffRow[] {
		const rows: DiffRow[] = [
			{
				kind: "changed",
				beforeHtml: "<p>ob</p>",
				afterHtml: "<p>nb</p>",
				afterStart: 1,
				afterEnd: 1,
			},
		];
		for (let i = 0; i < 10; i++)
			rows.push({
				kind: "unchanged",
				html: `<p>u${i}</p>`,
				afterStart: 2 + i,
				afterEnd: 2 + i,
			});
		rows.push({
			kind: "changed",
			beforeHtml: "<p>oe</p>",
			afterHtml: "<p>ne</p>",
			afterStart: 12,
			afterEnd: 12,
		});
		return rows;
	}

	// TRUNK-93: a container block (list/table) whose leaves are mostly unchanged
	// must not render whole in hunk mode. The backend ships the folded copy; the
	// frontend picks it only in hunk mode, and notes what it hid.
	const foldedRow: DiffRow = {
		kind: "changed",
		beforeHtml: "<ul><li>a</li><li>old</li><li>c</li></ul>",
		afterHtml: "<ul><li>a</li><li>new</li><li>c</li></ul>",
		mergedHtml: "<ul><li>a</li><li>new</li><li>c</li><li>tail</li></ul>",
		hunkMergedHtml: "<ul><li>a</li><li>new</li><li>c</li></ul>",
		hunkHiddenLeaves: 1,
		afterStart: 1,
		afterEnd: 4,
	};

	it("renders a container's folded copy in hunk mode and its full copy in full mode (inline)", async () => {
		safeInvoke.mockResolvedValue({
			rows: [foldedRow],
			whitespaceOnly: false,
		});

		const { container, rerender } = render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "inline",
				contentMode: "hunk",
			},
		});
		await screen.findByText("new");

		expect(container.querySelectorAll("li")).toHaveLength(3);
		expect(container.textContent).not.toContain("tail");
		expect(container.querySelector(".rendered-fold")?.textContent).toBe(
			"1 item hidden",
		);

		await rerender({
			...baseProps,
			layoutMode: "inline",
			contentMode: "full",
		});
		expect(container.querySelectorAll("li")).toHaveLength(4);
		expect(container.textContent).toContain("tail");
		expect(container.querySelector(".rendered-fold")).toBeNull();
	});

	it("renders a container's folded copy in hunk mode in split, on both columns", async () => {
		safeInvoke.mockResolvedValue({
			rows: [
				{
					...foldedRow,
					beforeHtml: "<ul><li>a</li><li>old</li><li>c</li><li>tail</li></ul>",
					afterHtml: "<ul><li>a</li><li>new</li><li>c</li><li>tail</li></ul>",
					hunkBeforeHtml: "<ul><li>a</li><li>old</li><li>c</li></ul>",
					hunkAfterHtml: "<ul><li>a</li><li>new</li><li>c</li></ul>",
				},
			],
			whitespaceOnly: false,
		});

		const { container } = render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "split",
				contentMode: "hunk",
			},
		});
		await screen.findByText("new");

		// Three items per column, not four: the fold applies to both sides.
		expect(container.querySelectorAll("li")).toHaveLength(6);
		expect(container.textContent).not.toContain("tail");
	});

	it("says a rewrapped block renders identically, instead of showing it untinted", async () => {
		safeInvoke.mockResolvedValue({
			rows: [
				{
					kind: "changed",
					beforeHtml: "<p>one two three four</p>",
					afterHtml: "<p>one two three four</p>",
					mergedHtml: "<p>one two three four</p>",
					rendersIdentically: true,
					afterStart: 1,
					afterEnd: 2,
				},
			],
			whitespaceOnly: false,
		});

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "inline" },
		});
		await screen.findByText(/one two three four/);

		expect(container.querySelector(".rendered-fold")?.textContent).toBe(
			"Reflowed — renders identically",
		);
	});

	it("keeps unchanged rows within contextLines of a change, folding the rest into a line-counted separator (inline)", async () => {
		safeInvoke.mockResolvedValue({
			rows: changeSandwich(),
			whitespaceOnly: false,
		});

		const { container, rerender } = render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "inline",
				contentMode: "hunk",
				contextLines: 3,
			},
		});
		await screen.findByText("nb");

		// Exactly 3 context lines each side, like Source: u0..u2 (lines 2-4)
		// after the top change, u7..u9 (lines 9-11) before the bottom one.
		// Each change (no merged copy) is 2 inline blocks: 2×2 + 6 = 10.
		// Hidden u3..u6 (lines 5-8): 9 − 4 − 1 = 4 lines.
		expect(container.querySelectorAll(".rendered-block")).toHaveLength(10);
		expect(container.querySelector(".rendered-sep")?.textContent).toBe(
			"4 lines hidden",
		);

		await rerender({
			...baseProps,
			layoutMode: "inline",
			contentMode: "hunk",
			contextLines: 1,
		});
		// One context line each side: u0 and u9. Hidden u1..u8 (lines 3-10):
		// 11 − 2 − 1 = 8 lines.
		expect(container.querySelectorAll(".rendered-block")).toHaveLength(6);
		expect(container.querySelector(".rendered-sep")?.textContent).toBe(
			"8 lines hidden",
		);
	});

	it("always keeps the immediately adjacent unchanged row even outside the line window, never bare (hunk)", async () => {
		const rows: DiffRow[] = [
			{
				kind: "changed",
				beforeHtml: "<p>ob</p>",
				afterHtml: "<p>nb</p>",
				afterStart: 1,
				afterEnd: 1,
			},
			// 8 lines from both changes: outside any contextLines=3 window.
			{ kind: "unchanged", html: "<p>far</p>", afterStart: 10, afterEnd: 10 },
			{
				kind: "changed",
				beforeHtml: "<p>oe</p>",
				afterHtml: "<p>ne</p>",
				afterStart: 20,
				afterEnd: 20,
			},
		];
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });

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
		expect(screen.getByText("far")).toBeInTheDocument();
		expect(container.querySelectorAll(".rendered-sep")).toHaveLength(0);
	});

	it("drops leading and trailing unchanged runs without a separator (hunk)", async () => {
		const rows: DiffRow[] = [];
		for (let i = 0; i < 5; i++)
			rows.push({
				kind: "unchanged",
				html: `<p>lead${i}</p>`,
				afterStart: 1 + 2 * i,
				afterEnd: 1 + 2 * i,
			});
		rows.push({
			kind: "changed",
			beforeHtml: "<p>ob</p>",
			afterHtml: "<p>nb</p>",
			afterStart: 11,
			afterEnd: 11,
		});
		for (let i = 0; i < 5; i++)
			rows.push({
				kind: "unchanged",
				html: `<p>tail${i}</p>`,
				afterStart: 13 + 2 * i,
				afterEnd: 13 + 2 * i,
			});
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });

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

	it("gives a deletion context on both sides via its after-side anchor (hunk)", async () => {
		const rows: DiffRow[] = [
			{
				kind: "changed",
				beforeHtml: "<p>ob</p>",
				afterHtml: "<p>nb</p>",
				afterStart: 1,
				afterEnd: 1,
			},
			{ kind: "unchanged", html: "<p>u1</p>", afterStart: 3, afterEnd: 3 },
			{ kind: "unchanged", html: "<p>u2</p>", afterStart: 5, afterEnd: 5 },
			{ kind: "unchanged", html: "<p>u3</p>", afterStart: 7, afterEnd: 7 },
			{ kind: "unchanged", html: "<p>u4</p>", afterStart: 9, afterEnd: 9 },
			// The deleted paragraph sat right after line 9 on the after axis.
			{
				kind: "removed",
				html: "<p>gone</p>",
				beforeStart: 11,
				beforeEnd: 11,
				afterAnchor: 9,
			},
			{ kind: "unchanged", html: "<p>u5</p>", afterStart: 11, afterEnd: 11 },
		];
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });

		const { container } = render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "inline",
				contentMode: "hunk",
				contextLines: 1,
			},
		});
		await screen.findByText("gone");

		// u1 (adjacent to the change) and u4 (distance 0 to the anchor at line 9)
		// stay; the deletion keeps context on BOTH sides (u4 above, u5 below).
		// Hidden u2, u3 (lines 5, 7): 9 − 3 − 1 = 5 lines.
		expect(screen.getByText("u4")).toBeInTheDocument();
		expect(screen.getByText("u5")).toBeInTheDocument();
		expect(screen.queryByText("u2")).toBeNull();
		expect(screen.queryByText("u3")).toBeNull();
		expect(container.querySelector(".rendered-sep")?.textContent).toBe(
			"5 lines hidden",
		);
	});

	it("labels a single hidden line in the singular", async () => {
		const rows: DiffRow[] = [
			{
				kind: "changed",
				beforeHtml: "<p>ob</p>",
				afterHtml: "<p>nb</p>",
				afterStart: 1,
				afterEnd: 1,
			},
			{ kind: "unchanged", html: "<p>u1</p>", afterStart: 2, afterEnd: 2 },
			{ kind: "unchanged", html: "<p>u2</p>", afterStart: 3, afterEnd: 3 },
			{ kind: "unchanged", html: "<p>u3</p>", afterStart: 4, afterEnd: 4 },
			{
				kind: "changed",
				beforeHtml: "<p>oe</p>",
				afterHtml: "<p>ne</p>",
				afterStart: 5,
				afterEnd: 5,
			},
		];
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });

		const { container } = render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "inline",
				contentMode: "hunk",
				contextLines: 0,
			},
		});
		await screen.findByText("nb");

		// contextLines=0 hides u2 (u1/u3 survive as the always-kept adjacent
		// rows): 4 − 2 − 1 = 1 line.
		expect(container.querySelector(".rendered-sep")?.textContent).toBe(
			"1 line hidden",
		);
	});

	it("collapses an interior run identically in split, splitting the column stacks at the separator", async () => {
		safeInvoke.mockResolvedValue({
			rows: changeSandwich(),
			whitespaceOnly: false,
		});

		const { container } = render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "split",
				contentMode: "hunk",
				contextLines: 3,
			},
		});
		await screen.findAllByText("nb");

		// 8 visible rows (2 changes + u0..u2, u7..u9) × 2 columns each.
		expect(container.querySelectorAll(".rendered-block")).toHaveLength(16);
		expect(container.querySelectorAll(".rendered-sep")).toHaveLength(1);
		// The separator splits the stacks into two runs — each its own column
		// pair (Source's run-splitting), so 2 .split-columns × 2 scrollers.
		expect(container.querySelectorAll(".split-columns")).toHaveLength(2);
		expect(container.querySelectorAll(".split-column")).toHaveLength(4);
	});

	it("shows a No changes note in hunk mode when nothing changed, keeping the full doc", async () => {
		safeInvoke.mockResolvedValue({
			whitespaceOnly: false,
			rows: [
				{ kind: "unchanged", html: "<p>alpha</p>", afterStart: 1, afterEnd: 1 },
				{ kind: "unchanged", html: "<p>beta</p>", afterStart: 3, afterEnd: 3 },
			] satisfies DiffRow[],
		});

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

	it("explains a whitespace-only diff instead of claiming No changes (hunk)", async () => {
		safeInvoke.mockResolvedValue({
			whitespaceOnly: true,
			rows: [
				{ kind: "unchanged", html: "<p>alpha</p>", afterStart: 1, afterEnd: 1 },
			] satisfies DiffRow[],
		});

		render(RenderedDiff, {
			props: {
				...baseProps,
				layoutMode: "inline",
				contentMode: "hunk",
				contextLines: 3,
			},
		});
		await screen.findByText("alpha");

		expect(
			screen.getByText(
				"Whitespace-only changes — not visible in rendered view",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("No changes")).toBeNull();
	});

	it("shows no note in full mode when nothing changed", async () => {
		safeInvoke.mockResolvedValue({
			whitespaceOnly: false,
			rows: [
				{ kind: "unchanged", html: "<p>alpha</p>", afterStart: 1, afterEnd: 1 },
			] satisfies DiffRow[],
		});

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
		safeInvoke.mockResolvedValue({
			whitespaceOnly: false,
			rows: [
				{
					kind: "changed",
					beforeHtml: "<p>bef</p>",
					afterHtml: "<p>aft</p>",
					afterStart: 1,
					afterEnd: 1,
				},
				{ kind: "unchanged", html: "<p>ctx</p>", afterStart: 3, afterEnd: 3 },
			] satisfies DiffRow[],
		});

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
		safeInvoke.mockResolvedValue({
			whitespaceOnly: false,
			rows: [
				{
					kind: "unchanged",
					html: "<pre><code>long line</code></pre>",
					afterStart: 1,
					afterEnd: 1,
				},
			] satisfies DiffRow[],
		});

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
		safeInvoke.mockResolvedValue({
			whitespaceOnly: false,
			rows: [
				{ kind: "unchanged", html: "<p>same</p>", afterStart: 1, afterEnd: 1 },
			] satisfies DiffRow[],
		});

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

	// These two use svelte's own mount + a fine-grained $state props object:
	// testing-library's rerender replaces its whole props object, re-running
	// EVERY effect on every call, so it cannot prove which props the fetch
	// effect depends on (memory: testing_library_rerender_reruns_effects).
	it("re-invokes the fetch with identical args when refreshToken bumps", async () => {
		safeInvoke.mockResolvedValue({
			whitespaceOnly: false,
			rows: [
				{ kind: "unchanged", html: "<p>alpha</p>", afterStart: 1, afterEnd: 1 },
			] satisfies DiffRow[],
		});
		const props = reactiveProps({ ...baseProps, refreshToken: 0 });
		const target = document.body.appendChild(document.createElement("div"));
		const app = mount(RenderedDiff, { target, props });
		try {
			flushSync();
			await screen.findByText("alpha");
			const before = safeInvoke.mock.calls.length;

			props.refreshToken = 1;
			flushSync();

			// A new fetch for the SAME diff: the token itself never reaches the
			// backend, so the re-invocation has identical args.
			expect(safeInvoke.mock.calls.length).toBe(before + 1);
			const distinct = new Set(
				safeInvoke.mock.calls.map((c) => JSON.stringify(c)),
			);
			expect(distinct.size).toBe(1);
		} finally {
			await unmount(app);
			target.remove();
		}
	});

	it("refetches with the flag in the invoke args when ignoreWhitespace toggles", async () => {
		safeInvoke.mockResolvedValue({
			whitespaceOnly: false,
			rows: [
				{ kind: "unchanged", html: "<p>alpha</p>", afterStart: 1, afterEnd: 1 },
			] satisfies DiffRow[],
		});
		const props = reactiveProps({ ...baseProps, refreshToken: 0 });
		const target = document.body.appendChild(document.createElement("div"));
		const app = mount(RenderedDiff, { target, props });
		try {
			flushSync();
			await screen.findByText("alpha");
			expect(safeInvoke).toHaveBeenLastCalledWith(
				"render_markdown_diff",
				expect.objectContaining({ ignoreWhitespace: false }),
			);

			props.ignoreWhitespace = true;
			flushSync();

			expect(safeInvoke).toHaveBeenLastCalledWith(
				"render_markdown_diff",
				expect.objectContaining({ ignoreWhitespace: true }),
			);
		} finally {
			await unmount(app);
			target.remove();
		}
	});

	it("does not refetch when a layout-only prop changes and refreshToken holds", async () => {
		safeInvoke.mockResolvedValue({
			whitespaceOnly: false,
			rows: [
				{ kind: "unchanged", html: "<p>alpha</p>", afterStart: 1, afterEnd: 1 },
			] satisfies DiffRow[],
		});
		const props = reactiveProps({ ...baseProps, refreshToken: 0 });
		const target = document.body.appendChild(document.createElement("div"));
		const app = mount(RenderedDiff, { target, props });
		try {
			flushSync();
			await screen.findByText("alpha");
			const before = safeInvoke.mock.calls.length;

			props.contextLines = 1;
			props.wordWrap = true;
			flushSync();

			expect(safeInvoke.mock.calls.length).toBe(before);
		} finally {
			await unmount(app);
			target.remove();
		}
	});

	it("registers one element per changed row into hunkElements in document order (inline)", async () => {
		const rows: DiffRow[] = [
			{ kind: "unchanged", html: "<p>intro</p>", afterStart: 1, afterEnd: 1 },
			{
				kind: "changed",
				beforeHtml: "<p>the quick fox</p>",
				afterHtml: "<p>the slow fox</p>",
				mergedHtml:
					'<p>the <del class="md-word-delete">quick</del><ins class="md-word-add">slow</ins> fox</p>',
				afterStart: 3,
				afterEnd: 3,
			},
			{
				kind: "removed",
				html: "<p>gone</p>",
				beforeStart: 5,
				beforeEnd: 5,
				afterAnchor: 3,
			},
			{ kind: "added", html: "<p>fresh</p>", afterStart: 5, afterEnd: 5 },
			{
				kind: "changed",
				beforeHtml: "<p>old block</p>",
				afterHtml: "<p>new block</p>",
				afterStart: 7,
				afterEnd: 7,
			},
			{ kind: "unchanged", html: "<p>outro</p>", afterStart: 9, afterEnd: 9 },
		];
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });
		const hunkElements: Record<string, HTMLDivElement> = {};

		render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "inline", hunkElements },
		});
		await screen.findByText("intro");

		// One jump target per changed row — a changed row with no merged copy renders two
		// blocks but registers only its first — keyed in document order.
		expect(Object.keys(hunkElements)).toEqual([
			"change-0",
			"change-1",
			"change-2",
			"change-3",
		]);
		expect(hunkElements["change-0"].textContent).toContain("fox");
		expect(hunkElements["change-1"].textContent).toContain("gone");
		expect(hunkElements["change-2"].textContent).toContain("fresh");
		expect(hunkElements["change-3"].textContent).toContain("old block");
	});

	it("registers the content-bearing cell per changed row in split", async () => {
		const rows: DiffRow[] = [
			{ kind: "added", html: "<p>addition</p>", afterStart: 1, afterEnd: 1 },
			{
				kind: "removed",
				html: "<p>deletion</p>",
				beforeStart: 3,
				beforeEnd: 3,
				afterAnchor: 1,
			},
			{ kind: "unchanged", html: "<p>same</p>", afterStart: 3, afterEnd: 3 },
		];
		safeInvoke.mockResolvedValue({ rows, whitespaceOnly: false });
		const hunkElements: Record<string, HTMLDivElement> = {};

		render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "split", hunkElements },
		});
		await screen.findAllByText("same");

		expect(Object.keys(hunkElements)).toEqual(["change-0", "change-1"]);
		expect(hunkElements["change-0"].textContent).toContain("addition");
		expect(hunkElements["change-1"].textContent).toContain("deletion");
	});

	it("removes its hunkElements entries on unmount so Source navigation starts clean", async () => {
		safeInvoke.mockResolvedValue({
			whitespaceOnly: false,
			rows: [
				{ kind: "added", html: "<p>fresh</p>", afterStart: 1, afterEnd: 1 },
				{ kind: "unchanged", html: "<p>ctx</p>", afterStart: 3, afterEnd: 3 },
			] satisfies DiffRow[],
		});
		const hunkElements: Record<string, HTMLDivElement> = {};

		const { unmount: unmountView } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "inline", hunkElements },
		});
		await screen.findByText("fresh");
		expect(Object.keys(hunkElements)).toEqual(["change-0"]);

		unmountView();

		expect(Object.keys(hunkElements)).toEqual([]);
	});

	it("ignores a stale in-flight render when the selected file changes mid-flight", async () => {
		const first = deferred<MarkdownDiff>();
		const second = deferred<MarkdownDiff>();
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

		second.resolve({
			rows: [
				{
					kind: "unchanged",
					html: "<p>SECOND</p>",
					afterStart: 1,
					afterEnd: 1,
				},
			],
			whitespaceOnly: false,
		});
		expect(await screen.findByText("SECOND")).toBeInTheDocument();

		first.resolve({
			rows: [
				{ kind: "unchanged", html: "<p>FIRST</p>", afterStart: 1, afterEnd: 1 },
			],
			whitespaceOnly: false,
		});
		await tick();
		await Promise.resolve();

		expect(screen.queryByText("FIRST")).toBeNull();
		expect(screen.getByText("SECOND")).toBeInTheDocument();
	});
});

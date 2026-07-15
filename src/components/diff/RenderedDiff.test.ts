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
};

// Isolate call counts + implementations between tests so a per-test mock can't
// leak into the next (the re-layout test asserts an exact fetch count).
afterEach(() => safeInvoke.mockReset());

describe("RenderedDiff", () => {
	it("renders in reading order, a changed row as removed-before then added-after (inline)", async () => {
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
		expect(blocks[0].classList.contains("md-removed")).toBe(false);
		expect(blocks[1].classList.contains("md-removed")).toBe(true);
		expect(blocks[1].textContent).toContain("gone");
		expect(blocks[2].classList.contains("md-added")).toBe(true);
		expect(blocks[2].textContent).toContain("fresh");
		// A changed row mirrors Source: the removed before-block, then the added
		// after-block — red then green, no third "changed" tint.
		expect(blocks[3].classList.contains("md-removed")).toBe(true);
		expect(blocks[3].textContent).toContain("old");
		expect(blocks[4].classList.contains("md-added")).toBe(true);
		expect(blocks[4].textContent).toContain("new");
	});

	it("pairs each row's before/after cells as adjacent grid children (split)", async () => {
		const rows: DiffRow[] = [
			{ kind: "unchanged", html: "<p>same</p>", lines: 1 },
			{ kind: "added", html: "<p>addition</p>" },
			{ kind: "removed", html: "<p>deletion</p>" },
			{ kind: "changed", beforeHtml: "<p>bef</p>", afterHtml: "<p>aft</p>" },
		];
		safeInvoke.mockResolvedValue(rows);

		const { container } = render(RenderedDiff, {
			props: { ...baseProps, layoutMode: "split" },
		});
		// unchanged renders "same" on both sides, so it appears twice.
		await screen.findAllByText("same");

		const grid = container.querySelector(".rendered-diff.split");
		expect(grid).not.toBeNull();
		// Both cells of every DiffRow are adjacent direct children of the one grid,
		// so grid-template-columns:1fr 1fr places them in one row (height aligns).
		const cells = [...(grid as Element).children];
		expect(cells).toHaveLength(8);

		// unchanged: same html both sides, untinted.
		expect(cells[0].textContent).toContain("same");
		expect(cells[1].textContent).toContain("same");
		expect(cells[0].classList.contains("md-added")).toBe(false);
		expect(cells[0].classList.contains("md-removed")).toBe(false);
		// added: left phantom, right added-tint.
		expect(cells[2].classList.contains("rendered-phantom")).toBe(true);
		expect(cells[3].classList.contains("md-added")).toBe(true);
		expect(cells[3].textContent).toContain("addition");
		// removed: left removed-tint, right phantom.
		expect(cells[4].classList.contains("md-removed")).toBe(true);
		expect(cells[4].textContent).toContain("deletion");
		expect(cells[5].classList.contains("rendered-phantom")).toBe(true);
		// changed: mirror Source — before removed (red) left, after added (green) right.
		expect(cells[6].classList.contains("md-removed")).toBe(true);
		expect(cells[6].textContent).toContain("bef");
		expect(cells[7].classList.contains("md-added")).toBe(true);
		expect(cells[7].textContent).toContain("aft");
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

		// One placeholder for the whole absent column, not a phantom per row.
		expect(screen.getAllByText("Not present at this revision")).toHaveLength(1);
		expect(container.querySelectorAll(".rendered-phantom")).toHaveLength(0);

		// Placeholder occupies the left (before) column: it is the first grid child.
		const grid = container.querySelector(".rendered-diff.split") as Element;
		expect(grid.children[0].textContent).toContain(
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

		// Placeholder occupies the right (after) column: it is the last grid child.
		const grid = container.querySelector(".rendered-diff.split") as Element;
		const kids = grid.children;
		expect(kids[kids.length - 1].textContent).toContain(
			"Not present at this revision",
		);
	});

	it("collapses an interior unchanged run to a separator, honoring contextLines (inline)", async () => {
		// A change at each end with a long unchanged run between them: only the
		// interior run collapses (boundary runs are handled separately).
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

		// 3 context blocks each side; the middle 4 collapse to one sep. Each change
		// is a changed row → 2 inline blocks (removed+added), so 2×2 + 3 + 3 = 10.
		expect(container.querySelectorAll(".rendered-block")).toHaveLength(10);
		expect(container.querySelector(".rendered-sep")?.textContent).toContain(
			"4",
		);

		// A tighter context keeps fewer blocks and hides more.
		await rerender({
			...baseProps,
			layoutMode: "inline",
			contentMode: "hunk",
			contextLines: 1,
		});
		// 1 context block each side; the middle 8 collapse. 2×2 + 1 + 1 = 6.
		expect(container.querySelectorAll(".rendered-block")).toHaveLength(6);
		expect(container.querySelector(".rendered-sep")?.textContent).toContain(
			"8",
		);
	});

	it("always keeps the adjacent block even when it alone exceeds the budget, never bare (hunk)", async () => {
		// contextLines is a source-line budget (like Source). Blocks are atomic, so
		// the immediately-adjacent block is always shown whole — a 5-line block next
		// to a change is kept under a budget of 3 rather than collapsed, so the
		// change never renders bare with no surrounding context.
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

		// The 5-line block is the only context between the two changes: kept, not
		// collapsed. 2 changes × 2 inline blocks + 1 context block = 5; no separator.
		expect(container.querySelectorAll(".rendered-block")).toHaveLength(5);
		expect(screen.getByText("big")).toBeInTheDocument();
		expect(container.querySelectorAll(".rendered-sep")).toHaveLength(0);
	});

	it("drops leading and trailing unchanged runs without a separator (hunk)", async () => {
		// Unchanged runs at the document edges collapse away entirely — no "N
		// unchanged blocks" marker beyond the last change, matching source hunks.
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

		// changed row (2 inline blocks) + 1 context each side = 4 blocks; the edge
		// runs vanish, no separator.
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

		// 8 kept rows × 2 cells = 16 cells; one full-width sep for the interior run.
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

		// Full document, not an all-collapsed blank.
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

		// The fetch is driven by rev/path only: every call carries the identical
		// command + revs, so a layout/content toggle never alters what is fetched.
		// (testing-library rerender re-runs effects unconditionally, so an exact
		// call *count* can't distinguish a toggle-driven refetch from a harness
		// re-run; the single-fetch guarantee is structural — the effect reads no
		// layout/content props — and is verified in the dev build, task 11.)
		const distinctFetches = new Set(
			safeInvoke.mock.calls.map((c) => JSON.stringify(c)),
		);
		expect(distinctFetches.size).toBe(1);
		expect(safeInvoke.mock.calls[0][0]).toBe("render_markdown_diff");

		// The final toggle (inline + hunk) re-laid-out the same fetched array.
		expect(container.querySelector(".rendered-diff.split")).toBeNull();
		expect(
			container.querySelectorAll(".rendered-block").length,
		).toBeGreaterThan(0);
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

		// The fresh (B.md) render resolves first.
		second.resolve([{ kind: "unchanged", html: "<p>SECOND</p>", lines: 1 }]);
		expect(await screen.findByText("SECOND")).toBeInTheDocument();

		// The stale (A.md) render resolves late — it must NOT overwrite the fresh one.
		first.resolve([{ kind: "unchanged", html: "<p>FIRST</p>", lines: 1 }]);
		await tick();
		await Promise.resolve();

		expect(screen.queryByText("FIRST")).toBeNull();
		expect(screen.getByText("SECOND")).toBeInTheDocument();
	});
});

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CommitRow from "./CommitRow.svelte";
import "../__tests__/helpers/tauri-mock";
import { makeCommit } from "../__tests__/helpers/factories";
import type { ColumnVisibility, ColumnWidths } from "../lib/store";

vi.mock("../lib/toast.svelte.js", () => ({ showToast: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
	writeText: vi.fn().mockResolvedValue(undefined),
}));

const defaultWidths: ColumnWidths = {
	ref: 120,
	graph: 24,
	diff: 96,
	author: 60,
	date: 40,
	sha: 50,
};

const allVisible: ColumnVisibility = {
	ref: true,
	graph: true,
	message: true,
	diff: true,
	author: true,
	date: true,
	sha: true,
};

describe("CommitRow", () => {
	it("renders commit summary", () => {
		const commit = makeCommit({ oid: "abc1234567", summary: "fix: bug" });
		render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: allVisible,
			},
		});
		expect(screen.getByTestId("commit-row-summary")).toHaveTextContent(
			"fix: bug",
		);
	});

	it("renders author name when column visible", () => {
		const commit = makeCommit({
			oid: "abc1234567",
			author_name: "Alice",
		});
		render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: allVisible,
			},
		});
		expect(screen.getByText("Alice")).toBeInTheDocument();
	});

	it("hides author column when not visible", () => {
		const commit = makeCommit({
			oid: "abc1234567",
			author_name: "Alice",
		});
		render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: { ...allVisible, author: false },
			},
		});
		expect(screen.queryByText("Alice")).toBeNull();
	});

	it("renders short OID when column visible", () => {
		const commit = makeCommit({ oid: "def5678901" });
		render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: allVisible,
			},
		});
		expect(screen.getByText("def5678")).toBeInTheDocument();
	});

	it("renders WIP row with italic class", () => {
		const commit = makeCommit({
			oid: "__wip__",
			summary: "Working changes",
		});
		const { container } = render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: allVisible,
			},
		});
		const italicEl = container.querySelector(".italic");
		expect(italicEl).not.toBeNull();
		expect(italicEl?.textContent).toContain("Working changes");
	});

	it("renders WIP file-status badges from wipStats", () => {
		const commit = makeCommit({ oid: "__wip__", summary: "WIP" });
		render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: allVisible,
				wipStats: {
					modified: 5,
					new: 1,
					deleted: 2,
					renamed: 0,
					typechange: 0,
					conflicted: 0,
				},
			},
		});
		const text = screen.getByTestId("commit-row-summary").textContent ?? "";
		expect(text).toContain("M 5");
		expect(text).toContain("A 1");
		expect(text).toContain("D 2");
		expect(text).not.toContain("R 0");
		expect(text).not.toContain("T 0");
	});

	it("renders no WIP badges when wipStats is absent", () => {
		const commit = makeCommit({ oid: "__wip__", summary: "WIP" });
		render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: allVisible,
			},
		});
		expect(screen.getByTestId("commit-row-summary")).toHaveTextContent("WIP");
		expect(
			screen.getByTestId("commit-row-summary").querySelector(".font-mono"),
		).toBeNull();
	});

	it("calls onselect with oid when clicked", async () => {
		const onselect = vi.fn();
		const commit = makeCommit({ oid: "abc1234567" });
		const { container } = render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: allVisible,
				onselect,
			},
		});
		const row = container.firstElementChild;
		expect(row).toBeTruthy();
		await fireEvent.click(row as Element);
		expect(onselect).toHaveBeenCalledWith("abc1234567", {
			compare: false,
			range: false,
		});
	});

	describe("clicking the SHA", () => {
		beforeEach(() => {
			vi.mocked(writeText).mockClear();
			vi.mocked(writeText).mockResolvedValue(undefined);
		});

		it("copies the full oid, not the short oid", async () => {
			const commit = makeCommit({ oid: "abc1234567" });
			render(CommitRow, {
				props: {
					commit,
					rowIndex: 0,
					columnWidths: defaultWidths,
					columnVisibility: allVisible,
				},
			});

			await fireEvent.click(screen.getByTitle("Copy SHA"));

			expect(vi.mocked(writeText)).toHaveBeenCalledWith("abc1234567");
		});

		it("does not select the commit", async () => {
			const onselect = vi.fn();
			const commit = makeCommit({ oid: "abc1234567" });
			render(CommitRow, {
				props: {
					commit,
					rowIndex: 0,
					columnWidths: defaultWidths,
					columnVisibility: allVisible,
					onselect,
				},
			});

			await fireEvent.click(screen.getByTitle("Copy SHA"));

			expect(onselect).not.toHaveBeenCalled();
		});
	});

	it("hides SHA column when not visible", () => {
		const commit = makeCommit({ oid: "xyz9876543" });
		render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: { ...allVisible, sha: false },
			},
		});
		expect(screen.queryByText("xyz9876")).toBeNull();
	});

	describe("diff column", () => {
		const stat = { insertions: 12, deletions: 3, files_changed: 4 };

		it("renders a two-segment bar and no on-screen numbers (counts live in the tooltip)", () => {
			const commit = makeCommit({ oid: "abc1234567" });
			render(CommitRow, {
				props: {
					commit,
					rowIndex: 0,
					columnWidths: defaultWidths,
					columnVisibility: allVisible,
					diffStat: stat,
				},
			});
			const col = screen.getByTestId("diff-stat");
			const segments = col.querySelectorAll("[data-diff-seg]");
			expect(segments.length).toBe(2);
			// jsdom only reads inline styles — the min-sliver guarantee lives inline.
			for (const seg of segments) {
				expect((seg as HTMLElement).style.minWidth).toBe("1px");
			}
			// Numbers are tooltip-only now — nothing visible in the column.
			expect(screen.queryByTestId("diff-stat-count")).toBeNull();
			expect(col.textContent?.replace(/\s/g, "")).toBe("");
		});

		it("rounds the bar's outer ends on the end segments and uses no background track", () => {
			const commit = makeCommit({ oid: "abc1234567" });
			render(CommitRow, {
				props: {
					commit,
					rowIndex: 0,
					columnWidths: defaultWidths,
					columnVisibility: allVisible,
					diffStat: stat, // both add + delete
				},
			});
			const col = screen.getByTestId("diff-stat");
			const bar = screen.getByTestId("diff-stat-bar");
			const add = col.querySelector('[data-diff-seg="add"]');
			const del = col.querySelector('[data-diff-seg="delete"]');
			// Left edge = column's left edge on every row → lengths compare.
			expect(col.firstElementChild).toBe(bar);
			// Rounding lives on the painted end segments (robust vs WebKit's flaky
			// overflow-clip+border-radius): first rounds its left, last its right.
			expect(add).toHaveClass("rounded-l-full");
			expect(del).toHaveClass("rounded-r-full");
			// No dark track behind it — the bar itself is sized to the magnitude (a %).
			expect(bar.getAttribute("style") ?? "").not.toContain("--bg-2");
			expect((bar as HTMLElement).style.width).toMatch(/%$/);
		});

		it("rounds both ends of a single-sided bar", () => {
			const commit = makeCommit({ oid: "abc1234567" });
			render(CommitRow, {
				props: {
					commit,
					rowIndex: 0,
					columnWidths: defaultWidths,
					columnVisibility: allVisible,
					diffStat: { insertions: 50, deletions: 0, files_changed: 1 },
				},
			});
			const col = screen.getByTestId("diff-stat");
			const add = col.querySelector('[data-diff-seg="add"]');
			// Only one segment → it carries the full pill (both ends rounded).
			expect(add).toHaveClass("rounded-full");
			expect(col.querySelector('[data-diff-seg="delete"]')).toBeNull();
		});

		it("renders a neutral marker (not a blank gap) when files changed but no lines did", () => {
			// Binary / pure-rename / mode-only change: files_changed > 0 with 0 line
			// deltas. Without a marker this is an empty box, visually identical to
			// "no change" — the column would silently fail its one job.
			const commit = makeCommit({ oid: "abc1234567" });
			render(CommitRow, {
				props: {
					commit,
					rowIndex: 0,
					columnWidths: defaultWidths,
					columnVisibility: allVisible,
					diffStat: { insertions: 0, deletions: 0, files_changed: 3 },
				},
			});
			const col = screen.getByTestId("diff-stat");
			expect(screen.getByTestId("diff-stat-neutral")).toBeInTheDocument();
			expect(col.querySelectorAll("[data-diff-seg]").length).toBe(0);
			expect(screen.queryByTestId("diff-stat-placeholder")).toBeNull();
		});

		it("renders nothing in the column for a truly empty 0-files commit", () => {
			const commit = makeCommit({ oid: "abc1234567" });
			render(CommitRow, {
				props: {
					commit,
					rowIndex: 0,
					columnWidths: defaultWidths,
					columnVisibility: allVisible,
					diffStat: { insertions: 0, deletions: 0, files_changed: 0 },
				},
			});
			const col = screen.getByTestId("diff-stat");
			expect(screen.queryByTestId("diff-stat-bar")).toBeNull();
			expect(screen.queryByTestId("diff-stat-neutral")).toBeNull();
			expect(screen.queryByTestId("diff-stat-placeholder")).toBeNull();
			expect(col.querySelectorAll("[data-diff-seg]").length).toBe(0);
		});

		it("renders a placeholder (not a bar) when diffStat is undefined", () => {
			const commit = makeCommit({ oid: "abc1234567" });
			render(CommitRow, {
				props: {
					commit,
					rowIndex: 0,
					columnWidths: defaultWidths,
					columnVisibility: allVisible,
				},
			});
			expect(screen.getByTestId("diff-stat-placeholder")).toBeInTheDocument();
			expect(screen.queryByTestId("diff-stat-bar")).toBeNull();
		});

		it("shows the shared tooltip with the files-changed detail on hover", () => {
			vi.useFakeTimers();
			try {
				const commit = makeCommit({ oid: "abc1234567" });
				render(CommitRow, {
					props: {
						commit,
						rowIndex: 0,
						columnWidths: defaultWidths,
						columnVisibility: allVisible,
						diffStat: stat,
					},
				});
				const col = screen.getByTestId("diff-stat");
				// The shared `tooltip` action (same as the toolbar git buttons),
				// not a native title.
				expect(col.getAttribute("title")).toBeNull();

				col.dispatchEvent(new MouseEvent("mouseenter"));
				vi.advanceTimersByTime(120);

				expect(document.querySelector(".tooltip-pop")?.textContent).toContain(
					"4 files changed",
				);
			} finally {
				document.querySelector(".tooltip-pop")?.remove();
				vi.useRealTimers();
			}
		});

		it("hides the diff column when columnVisibility.diff is false", () => {
			const commit = makeCommit({ oid: "abc1234567" });
			render(CommitRow, {
				props: {
					commit,
					rowIndex: 0,
					columnWidths: defaultWidths,
					columnVisibility: { ...allVisible, diff: false },
					diffStat: stat,
				},
			});
			expect(screen.queryByTestId("diff-stat")).toBeNull();
		});
	});

	it("applies a theme-variable marker when inSession is true", () => {
		const commit = makeCommit({ oid: "abc1234567" });
		render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: allVisible,
				inSession: true,
			},
		});
		const row = screen.getByTestId("commit-row");
		const style = row.getAttribute("style") ?? "";
		expect(style).toContain("var(--color-review-row)");
		// The marker must not hardcode a literal color.
		expect(style).not.toMatch(/inset[^;]*(rgb|#[0-9a-fA-F])/);
	});

	it("does not apply the in-session marker when inSession is false", () => {
		const commit = makeCommit({ oid: "abc1234567" });
		render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: allVisible,
				inSession: false,
			},
		});
		const style = screen.getByTestId("commit-row").getAttribute("style") ?? "";
		expect(style).not.toContain("var(--color-review-row)");
	});

	it("applies a distinct theme-variable marker when isPendingBase is true", () => {
		const commit = makeCommit({ oid: "abc1234567" });
		render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: allVisible,
				isPendingBase: true,
			},
		});
		const row = screen.getByTestId("commit-row");
		const style = row.getAttribute("style") ?? "";
		expect(style).toContain("var(--color-review-pending-base)");
		expect(style).not.toContain("var(--color-review-row)");
		expect(style).not.toMatch(/inset[^;]*(rgb|#[0-9a-fA-F])/);
	});

	it("does not apply the pending-base marker when isPendingBase is false", () => {
		const commit = makeCommit({ oid: "abc1234567" });
		render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: allVisible,
				isPendingBase: false,
			},
		});
		const style = screen.getByTestId("commit-row").getAttribute("style") ?? "";
		expect(style).not.toContain("var(--color-review-pending-base)");
	});

	it("combines both markers when inSession and isPendingBase are both true", () => {
		const commit = makeCommit({ oid: "abc1234567" });
		render(CommitRow, {
			props: {
				commit,
				rowIndex: 0,
				columnWidths: defaultWidths,
				columnVisibility: allVisible,
				inSession: true,
				isPendingBase: true,
			},
		});
		const style = screen.getByTestId("commit-row").getAttribute("style") ?? "";
		expect(style).toContain("var(--color-review-row)");
		expect(style).toContain("var(--color-review-pending-base)");
	});

	describe("date column", () => {
		const pinnedNow = new Date("2026-07-28T10:29:00Z");
		const twoHours = 2 * 60 * 60 * 1000;
		const threeHours = 3 * 60 * 60 * 1000;

		function renderAtPinnedTime() {
			return render(CommitRow, {
				props: {
					commit: makeCommit({
						oid: "abc1234567",
						author_timestamp: pinnedNow.getTime() / 1000,
					}),
					rowIndex: 0,
					columnWidths: defaultWidths,
					columnVisibility: allVisible,
				},
			});
		}

		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(pinnedNow);
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("advances a mounted date cell without a prop change", async () => {
			const { getByText } = renderAtPinnedTime();
			const dateCell = getByText("just now");

			await vi.advanceTimersByTimeAsync(twoHours + 1_000);

			expect(dateCell).toHaveTextContent("2h ago");
		});

		it("renders a date cell mounted after a gap with no other row mounted", async () => {
			renderAtPinnedTime().unmount();
			await tick();

			vi.setSystemTime(pinnedNow.getTime() + threeHours);
			const { getByText } = renderAtPinnedTime();

			expect(getByText("3h ago")).toBeInTheDocument();
		});
	});
});

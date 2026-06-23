import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
	author: 60,
	date: 40,
	sha: 50,
};

const allVisible: ColumnVisibility = {
	ref: true,
	graph: true,
	message: true,
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
		expect(onselect).toHaveBeenCalledWith("abc1234567");
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
});

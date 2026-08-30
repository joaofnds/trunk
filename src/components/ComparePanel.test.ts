import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { exactLabel } from "../lib/relative-time.js";
import type { CommitDetail, FileDiff } from "../lib/types.js";
import ComparePanel from "./ComparePanel.svelte";

import "../__tests__/helpers/tauri-mock";

function detail(oid: string, summary: string): CommitDetail {
	return {
		oid: oid.repeat(5).slice(0, 40),
		short_oid: oid.slice(0, 7),
		summary,
		body: null,
		author_name: "Test User",
		author_email: "test@test.com",
		author_timestamp: 1700000000,
		committer_name: "Test User",
		committer_email: "test@test.com",
		committer_timestamp: 1700000000,
		parent_oids: [],
	};
}

const base = detail("aaaa111a", "base commit");
const target = detail("bbbb222b", "target commit");

const fileDiffs: FileDiff[] = [
	{ path: "src/main.ts", status: "Modified", is_binary: false, hunks: [] },
];

const stat = { insertions: 48, deletions: 102, files_changed: 3 };

function renderPanel(overrides: Record<string, unknown> = {}) {
	const onswap = vi.fn();
	const onclose = vi.fn();
	const onfileselect = vi.fn();
	render(ComparePanel, {
		props: {
			base,
			target,
			fileDiffs,
			stat,
			selectedFile: null,
			onfileselect,
			onswap,
			onclose,
			...overrides,
		},
	});
	return { onswap, onclose, onfileselect };
}

describe("ComparePanel", () => {
	it("shows both short OIDs in Base → Target order", () => {
		renderPanel();
		const header = screen.getByTestId("compare-header");
		const text = header.textContent ?? "";
		expect(text).toContain("aaaa111");
		expect(text).toContain("bbbb222");
		expect(text.indexOf("aaaa111")).toBeLessThan(text.indexOf("bbbb222"));
	});

	it("swaps direction through the swap button", async () => {
		const { onswap } = renderPanel();
		await fireEvent.click(
			screen.getByRole("button", { name: "Swap comparison direction" }),
		);
		expect(onswap).toHaveBeenCalledOnce();
	});

	it("labels an empty-tree Base and disables the swap", () => {
		renderPanel({ base: null });
		expect(screen.getByTestId("compare-header").textContent).toContain(
			"empty tree",
		);
		const swap = screen.getByRole("button", {
			name: "Swap comparison direction",
		});
		expect(swap).toBeDisabled();
	});

	it("selects a file from the list", async () => {
		const { onfileselect } = renderPanel();
		await fireEvent.click(screen.getByText("src/main.ts"));
		expect(onfileselect).toHaveBeenCalledWith("src/main.ts");
	});

	it("closes through the close button", async () => {
		const { onclose } = renderPanel();
		await fireEvent.click(
			screen.getByRole("button", { name: "Close comparison" }),
		);
		expect(onclose).toHaveBeenCalledOnce();
	});

	it("shows each commit's author and age on its card", () => {
		renderPanel();
		expect(screen.getAllByText("Test User")).toHaveLength(2);
		expect(screen.getAllByText(/ago$/)).toHaveLength(2);
	});

	it("reveals the exact date on hover, and carries it as the accessible name", () => {
		vi.useFakeTimers();
		try {
			renderPanel();
			const exact = exactLabel(base.author_timestamp);
			const cell = screen.getAllByText(/ago$/)[0];

			expect(cell.getAttribute("title")).toBeNull();
			expect(cell.getAttribute("aria-label")).toBe(exact);

			cell.dispatchEvent(new MouseEvent("mouseenter"));
			vi.advanceTimersByTime(120);

			expect(document.querySelector(".tooltip-pop")?.textContent).toBe(exact);
		} finally {
			document.querySelector(".tooltip-pop")?.remove();
			vi.useRealTimers();
		}
	});

	it("counts files from the list and totals lines from the stat", () => {
		// files_changed: 3 collapses renames the file list splits into two
		// entries \u2014 the count must agree with the list the user sees below it.
		renderPanel();
		expect(screen.getByText("1 file changed")).toBeInTheDocument();
		expect(screen.getByText("+48")).toBeInTheDocument();
		expect(screen.getByText("\u2212102")).toBeInTheDocument();
	});

	it("counts from the file list and holds the totals while they load", () => {
		renderPanel({ stat: null });
		expect(screen.getByText("1 file changed")).toBeInTheDocument();
		expect(screen.queryByText("+48")).toBeNull();
	});
});

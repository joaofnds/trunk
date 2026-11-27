import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	restoreLayout,
	setLayout,
	stubLayout,
} from "../__tests__/helpers/layout-stub.js";
import { FILE_LABEL_STYLE } from "../lib/file-label-style.svelte.js";
import type { ReviewTally, TrackedFile } from "../lib/types.js";
import FileFinder from "./FileFinder.svelte";

const FILES: TrackedFile[] = [
	{ path: "src/alpha.ts", changed: false },
	{ path: "src/beta.ts", changed: true },
	{ path: "src/gamma.ts", changed: false },
];

const ROW_HEIGHT = 30;
const VIEWPORT_HEIGHT = 120;
const LARGE_LIST = Array.from({ length: 2000 }, (_, index) => ({
	path: `src/file-${String(index).padStart(4, "0")}.ts`,
	changed: false,
}));

function open(
	props: Partial<{
		files: TrackedFile[];
		commentCounts: Map<string, number>;
		commentTallies: Map<string, ReviewTally>;
	}> = {},
) {
	const onselect = vi.fn();
	const onclose = vi.fn();
	const result = render(FileFinder, {
		props: { files: FILES, onselect, onclose, ...props },
	});
	return { ...result, onselect, onclose };
}

beforeEach(() => {
	stubLayout({
		height: VIEWPORT_HEIGHT,
		measure: (el) =>
			el.matches(".finder-row-probe") ? { height: ROW_HEIGHT } : undefined,
	});
});

afterEach(() => {
	restoreLayout();
	vi.unstubAllGlobals();
});

function rowLabels(): string[] {
	return screen
		.getAllByRole("option")
		.map((el) => el.textContent?.trim() ?? "");
}

describe("FileFinder", () => {
	it("opens as a modal named for assistive tech", () => {
		open();

		expect(
			screen.getByRole("dialog", { name: "Comment on a file" }),
		).toHaveAttribute("open");
	});

	it("closes when the dialog is cancelled", async () => {
		const { onclose } = open();

		await fireEvent(screen.getByRole("dialog"), new Event("cancel"));

		expect(onclose).toHaveBeenCalled();
	});

	it("names the comment count as an image for assistive tech", () => {
		open({ commentCounts: new Map([["src/alpha.ts", 2]]) });

		expect(
			screen.getByRole("img", { name: "2 review comments" }),
		).toBeInTheDocument();
	});

	it("names the visible thread states on a file with mixed comments", () => {
		open({
			commentCounts: new Map([["src/alpha.ts", 3]]),
			commentTallies: new Map([["src/alpha.ts", { open: 2, addressed: 1 }]]),
		});

		const row = screen.getByRole("option", {
			name: "src/alpha.ts, 3 comments, 2 open and 1 addressed",
		});
		const badge = within(row).getByRole("img", {
			name: "3 review comments, 2 open and 1 addressed",
		});
		expect(within(badge).getByText("2")).toBeInTheDocument();
		expect(within(badge).getByText("1")).toBeInTheDocument();
	});

	it("shows no count on a file nothing is pinned to", () => {
		open({ commentCounts: new Map([["src/alpha.ts", 2]]) });

		const beta = screen.getByRole("option", { name: "src/beta.ts, changed" });

		expect(within(beta).queryByRole("img")).toBeNull();
	});

	it("shows filenames before their directory by default", () => {
		open();

		expect(rowLabels()).toEqual([
			"beta.ts src",
			"alpha.ts src",
			"gamma.ts src",
		]);
	});

	it("shows repository-relative paths when Full Path is selected", () => {
		render(FileFinder, {
			context: new Map([[FILE_LABEL_STYLE, { current: "full-path" }]]),
			props: { files: FILES, onselect: vi.fn(), onclose: vi.fn() },
		});

		expect(rowLabels()).toEqual([
			"src/beta.ts",
			"src/alpha.ts",
			"src/gamma.ts",
		]);
	});

	it("mounts only a viewport-sized window while keeping the last result clickable", async () => {
		const { onselect } = open({ files: LARGE_LIST });
		const list = screen.getByRole("listbox");
		const lastPath = LARGE_LIST[LARGE_LIST.length - 1].path;
		const mountedRows = rowLabels().length;

		list.scrollTop = LARGE_LIST.length * ROW_HEIGHT - VIEWPORT_HEIGHT;
		await fireEvent.scroll(list);
		await fireEvent.click(screen.getByRole("option", { name: lastPath }));

		expect(mountedRows).toBeLessThanOrEqual((2 * VIEWPORT_HEIGHT) / ROW_HEIGHT);
		expect(onselect).toHaveBeenCalledWith(lastPath);
	});

	it("mounts more results when the viewport grows", async () => {
		let resize = () => {};
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(measure: () => void) {
					resize = measure;
				}
				observe() {}
				disconnect() {}
			},
		);
		open({ files: LARGE_LIST });
		const list = screen.getByRole("listbox");
		const mountedRows = rowLabels().length;

		setLayout(list, { height: 2 * VIEWPORT_HEIGHT });
		resize();
		await tick();

		expect(rowLabels().length).toBeGreaterThan(mountedRows);
	});

	it("narrows the list and highlights the letters typed", async () => {
		open();

		await fireEvent.input(screen.getByRole("combobox"), {
			target: { value: "lph" },
		});

		const rows = screen.getAllByRole("option");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveAccessibleName("src/alpha.ts");
		expect(rows[0].querySelector("mark")).toHaveTextContent(/^lph$/);
	});

	it("selects the first row when it opens", () => {
		open();

		expect(screen.getByRole("option", { selected: true })).toHaveAccessibleName(
			"src/beta.ts, changed",
		);
	});

	it("moves the selection down with the arrow key", async () => {
		open();

		await fireEvent.keyDown(screen.getByRole("combobox"), {
			key: "ArrowDown",
		});

		expect(screen.getByRole("option", { selected: true })).toHaveAccessibleName(
			"src/alpha.ts",
		);
	});

	it.each([
		{ keys: ["Enter"], chosen: 13 },
		{ keys: ["ArrowDown", "Enter"], chosen: 14 },
	])(
		"opens row $chosen after wheel scrolling and pressing $keys",
		async ({ keys, chosen }) => {
			const { onselect } = open({ files: LARGE_LIST });
			const list = screen.getByRole("listbox");
			const input = screen.getByRole("combobox");

			list.scrollTop = 12.5 * ROW_HEIGHT;
			await fireEvent.scroll(list);
			for (const key of keys) await fireEvent.keyDown(input, { key });

			expect(onselect).toHaveBeenCalledWith(LARGE_LIST[chosen].path);
			expect(list.scrollTop).toBe(12.5 * ROW_HEIGHT);
		},
	);

	it("scrolls far enough to show the last row when paged down to it", async () => {
		const files = LARGE_LIST.slice(0, 9);
		open({ files });
		const input = screen.getByRole("combobox");

		await fireEvent.keyDown(input, { key: "PageDown" });
		await fireEvent.keyDown(input, { key: "PageDown" });

		const selected = screen.getByRole("option", { selected: true });
		expect(selected).toHaveAccessibleName(files[8].path);
		expect(screen.getByRole("listbox").scrollTop).toBe(
			files.length * ROW_HEIGHT - VIEWPORT_HEIGHT,
		);
		expect(selected).toHaveAttribute("aria-posinset", "9");
		expect(selected).toHaveAttribute("aria-setsize", "9");
		expect(input).toHaveAttribute("aria-activedescendant", selected.id);
		expect(input).toHaveFocus();
	});

	it("keeps the search input as the only tab stop", () => {
		open();
		const input = screen.getByRole("combobox");
		const list = screen.getByRole("listbox");
		const results = screen.getAllByRole<HTMLElement>("option");

		expect(input.tabIndex).toBe(0);
		expect(list.tabIndex).toBe(-1);
		expect(results.map((row) => row.tabIndex)).toEqual([-1, -1, -1]);
	});

	it("moves the selection up with the arrow key", async () => {
		open();
		const input = screen.getByRole("combobox");
		await fireEvent.keyDown(input, { key: "ArrowDown" });

		await fireEvent.keyDown(input, { key: "ArrowUp" });

		expect(screen.getByRole("option", { selected: true })).toHaveAccessibleName(
			"src/beta.ts, changed",
		);
	});

	it("holds the selection at the last row", async () => {
		open();
		const input = screen.getByRole("combobox");

		for (let i = 0; i < 5; i++) {
			await fireEvent.keyDown(input, { key: "ArrowDown" });
		}

		expect(screen.getByRole("option", { selected: true })).toHaveAccessibleName(
			"src/gamma.ts",
		);
	});

	it("reports the selected path on enter", async () => {
		const { onselect } = open();

		await fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

		expect(onselect).toHaveBeenCalledWith("src/beta.ts");
	});

	it("reports the clicked path", async () => {
		const { onselect } = open();

		await fireEvent.click(screen.getByRole("option", { name: "src/gamma.ts" }));

		expect(onselect).toHaveBeenCalledWith("src/gamma.ts");
	});

	it("closes on escape", async () => {
		const { onclose } = open();

		await fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

		expect(onclose).toHaveBeenCalled();
	});

	it("selects nothing on enter when no file matches", async () => {
		const { onselect } = open();
		await fireEvent.input(screen.getByRole("combobox"), {
			target: { value: "zzz" },
		});

		await fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

		expect(onselect).not.toHaveBeenCalled();
	});

	it("returns the selection to the top when the query narrows the list", async () => {
		const { onselect } = open();
		const input = screen.getByRole("combobox");
		await fireEvent.keyDown(input, { key: "ArrowDown" });

		await fireEvent.input(input, { target: { value: "gamma" } });
		await fireEvent.keyDown(input, { key: "Enter" });

		expect(onselect).toHaveBeenCalledWith("src/gamma.ts");
	});

	it("marks a changed file so it is not told apart by order alone", () => {
		open();

		expect(screen.getByLabelText("src/beta.ts, changed")).toBeInTheDocument();
	});
});

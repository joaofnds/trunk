import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import type { TrackedFile } from "../lib/types.js";
import FileFinder from "./FileFinder.svelte";

const FILES: TrackedFile[] = [
	{ path: "src/alpha.ts", changed: false },
	{ path: "src/beta.ts", changed: true },
	{ path: "src/gamma.ts", changed: false },
];

function open(
	props: Partial<{
		files: TrackedFile[];
		commentCounts: Map<string, number>;
	}> = {},
) {
	const onselect = vi.fn();
	const onclose = vi.fn();
	const result = render(FileFinder, {
		props: { files: FILES, onselect, onclose, ...props },
	});
	return { ...result, onselect, onclose };
}

function rowPaths(): string[] {
	return screen
		.getAllByRole("option")
		.map((el) => el.textContent?.trim() ?? "");
}

describe("FileFinder", () => {
	it("shows how many comments an unchanged file already carries", () => {
		open({ commentCounts: new Map([["src/alpha.ts", 2]]) });

		const alpha = screen
			.getAllByRole("option")
			.find((el) => el.textContent?.includes("src/alpha.ts"));

		expect(alpha?.textContent).toContain("2");
		expect(alpha?.getAttribute("aria-label")).toContain("2 comments");
	});

	it("shows no count on a file nothing is pinned to", () => {
		open({ commentCounts: new Map([["src/alpha.ts", 2]]) });

		const beta = screen
			.getAllByRole("option")
			.find((el) => el.textContent?.includes("src/beta.ts"));

		expect(beta?.querySelector(".finder-comment-count")).toBeNull();
	});

	it("lists changed files before unchanged ones", () => {
		open();

		expect(rowPaths()).toEqual(["src/beta.ts", "src/alpha.ts", "src/gamma.ts"]);
	});

	it("narrows the list as the query is typed", async () => {
		open();

		await fireEvent.input(screen.getByRole("combobox"), {
			target: { value: "alpha" },
		});

		expect(rowPaths()).toEqual(["src/alpha.ts"]);
	});

	it("selects the first row when it opens", () => {
		open();

		expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
			"src/beta.ts",
		);
	});

	it("moves the selection down with the arrow key", async () => {
		open();

		await fireEvent.keyDown(screen.getByRole("combobox"), {
			key: "ArrowDown",
		});

		expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
			"src/alpha.ts",
		);
	});

	it("moves the selection up with the arrow key", async () => {
		open();
		const input = screen.getByRole("combobox");
		await fireEvent.keyDown(input, { key: "ArrowDown" });

		await fireEvent.keyDown(input, { key: "ArrowUp" });

		expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
			"src/beta.ts",
		);
	});

	it("holds the selection at the last row", async () => {
		open();
		const input = screen.getByRole("combobox");

		for (let i = 0; i < 5; i++) {
			await fireEvent.keyDown(input, { key: "ArrowDown" });
		}

		expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
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

		await fireEvent.click(screen.getByText("src/gamma.ts"));

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

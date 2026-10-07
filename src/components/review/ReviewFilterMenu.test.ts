import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import ReviewFilterMenu from "./ReviewFilterMenu.svelte";

const counts = {
	all: 11,
	open: 6,
	addressed: 2,
	done: 1,
	dismissed: 1,
	stale: 1,
};

function renderMenu(overrides: Record<string, unknown> = {}) {
	const onchange = vi.fn();
	render(ReviewFilterMenu, {
		props: { value: "all", counts, onchange, ...overrides },
	});
	return {
		onchange,
		combobox: screen.getByRole("combobox", {
			name: "Review filter selection",
		}),
	};
}

function optionTexts(): string[] {
	return within(screen.getByRole("listbox"))
		.getAllByRole("option")
		.map((option) => option.textContent?.replace(/\s+/g, " ").trim() ?? "");
}

describe("ReviewFilterMenu", () => {
	it("shows the current filter as its value", () => {
		const { combobox } = renderMenu({ value: "addressed" });

		expect(combobox).toHaveTextContent("Addressed");
		expect(combobox).toHaveAttribute("aria-expanded", "false");
	});

	it("lists every filter with how many threads it holds", async () => {
		const { combobox } = renderMenu();

		await fireEvent.click(combobox);

		expect(optionTexts()).toEqual([
			"All threads 11",
			"Open 6",
			"Addressed 2",
			"Done 1",
			"Dismissed 1",
			"Stale 1",
		]);
	});

	it("marks the current filter as the selected option", async () => {
		const { combobox } = renderMenu({ value: "done" });

		await fireEvent.click(combobox);

		expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
			"Done",
		);
	});

	it("chooses a filter on click and closes", async () => {
		const { combobox, onchange } = renderMenu();

		await fireEvent.click(combobox);
		await fireEvent.click(screen.getByRole("option", { name: /^Done/ }));

		expect(onchange).toHaveBeenCalledWith("done");
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("moves through the filters with the arrow keys and chooses with Enter", async () => {
		const { combobox, onchange } = renderMenu({ value: "open" });

		await fireEvent.keyDown(combobox, { key: "ArrowDown" });
		expect(screen.getByRole("listbox")).toBeInTheDocument();
		expect(combobox).toHaveAttribute(
			"aria-activedescendant",
			screen.getByRole("option", { name: /^Open/ }).id,
		);

		await fireEvent.keyDown(combobox, { key: "ArrowDown" });
		await fireEvent.keyDown(combobox, { key: "Enter" });

		expect(onchange).toHaveBeenCalledWith("addressed");
		expect(screen.queryByRole("listbox")).toBeNull();
	});

	it("closes on Escape without changing the filter", async () => {
		const { combobox, onchange } = renderMenu();

		await fireEvent.click(combobox);
		await fireEvent.keyDown(combobox, { key: "Escape" });

		expect(screen.queryByRole("listbox")).toBeNull();
		expect(onchange).not.toHaveBeenCalled();
	});

	it("closes when the pointer goes down outside it", async () => {
		const { combobox } = renderMenu();

		await fireEvent.click(combobox);
		await fireEvent.pointerDown(document.body);

		expect(screen.queryByRole("listbox")).toBeNull();
	});
});

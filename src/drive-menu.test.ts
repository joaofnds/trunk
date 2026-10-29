import { afterEach, describe, expect, it, vi } from "vitest";
import {
	itemAt,
	type RecordedItem,
	ShowingMenu,
	shownAs,
} from "./drive-menu.js";

function item(label: string, props: Partial<RecordedItem> = {}): RecordedItem {
	return { id: `id-${label}`, label, enabled: true, submenu: null, ...props };
}

const branchMenu: RecordedItem[] = [
	item("Checkout", { enabled: false }),
	item("Reset", {
		submenu: [item("Soft"), item("Mixed"), item("Hard", { enabled: false })],
	}),
	item("Delete main"),
	item("Move", { enabled: false, submenu: [item("Up")] }),
];

describe("itemAt", () => {
	it("finds a top-level item by the label a user reads", () => {
		expect(itemAt(branchMenu, ["Delete main"])).toBe(branchMenu[2]);
	});

	it("walks into a submenu by each level's label", () => {
		expect(itemAt(branchMenu, ["Reset", "Soft"])).toBe(
			branchMenu[1].submenu?.[0],
		);
	});

	describe("when the path does not name an item a user could choose", () => {
		it.each([
			[["Rename"], 'no menu item labelled "Rename" is showing'],
			[["Reset", "Keep"], 'no menu item labelled "Keep" is showing in Reset'],
			[["Checkout"], 'the menu item labelled "Checkout" is disabled'],
			[["Reset", "Hard"], 'the menu item labelled "Hard" is disabled'],
			[["Move", "Up"], 'the menu item labelled "Move" is disabled'],
			[["Reset"], '"Reset" opens a submenu; name one of its items too'],
			[
				["Delete main", "Soft"],
				'"Delete main" has no submenu to find "Soft" in',
			],
			[[], "name the menu item to choose"],
		])("refuses %j", (path, message) => {
			expect(() => itemAt(branchMenu, path)).toThrow(message);
		});
	});
});

describe("shownAs", () => {
	it("lists each item's label and whether it is enabled, submenus nested", () => {
		expect(shownAs(branchMenu)).toEqual([
			{ label: "Checkout", enabled: false },
			{
				label: "Reset",
				enabled: true,
				submenu: [
					{ label: "Soft", enabled: true },
					{ label: "Mixed", enabled: true },
					{ label: "Hard", enabled: false },
				],
			},
			{ label: "Delete main", enabled: true },
			{
				label: "Move",
				enabled: false,
				submenu: [{ label: "Up", enabled: true }],
			},
		]);
	});
});

describe("ShowingMenu", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("gives a wait the menu the app pops up after it began", async () => {
		const showing = new ShowingMenu();
		const next = showing.next(1_000);

		await showing.record(async () => branchMenu);

		await expect(next).resolves.toBe(branchMenu);
	});

	it("holds a menu with no items the app chose to offer as showing", async () => {
		const showing = new ShowingMenu();

		await showing.record(async () => []);

		await expect(showing.next(1_000)).resolves.toEqual([]);
	});

	describe("when a press reaches the page", () => {
		it("drops the menu, as a real menu closes", async () => {
			vi.useFakeTimers();
			const showing = new ShowingMenu();
			await showing.record(async () => branchMenu);

			showing.close();
			const next = showing.next(1_000);
			vi.advanceTimersByTime(1_000);

			await expect(next).rejects.toThrow("no context menu showed in 1000ms");
		});

		it("drops a menu that was still being read when the press came", async () => {
			vi.useFakeTimers();
			const showing = new ShowingMenu();
			let finishReading = (_items: RecordedItem[]) => {};
			const recording = showing.record(
				() =>
					new Promise((read) => {
						finishReading = read;
					}),
			);

			showing.close();
			finishReading(branchMenu);
			await recording;
			const next = showing.next(1_000);
			vi.advanceTimersByTime(1_000);

			await expect(next).rejects.toThrow("no context menu showed in 1000ms");
		});
	});
});

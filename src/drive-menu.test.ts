import { describe, expect, it } from "vitest";
import { itemAt, type RecordedItem, shownAs } from "./drive-menu.js";

function item(label: string, props: Partial<RecordedItem> = {}): RecordedItem {
	return { id: label, label, enabled: true, submenu: null, ...props };
}

const branchMenu: RecordedItem[] = [
	item("Checkout", { enabled: false }),
	item("Reset", {
		submenu: [item("Soft"), item("Mixed"), item("Hard", { enabled: false })],
	}),
	item("Delete main"),
];

describe("itemAt", () => {
	it("finds a top-level item by the label a user reads", () => {
		expect(itemAt(branchMenu, ["Delete main"]).id).toBe("Delete main");
	});

	it("walks into a submenu by each level's label", () => {
		expect(itemAt(branchMenu, ["Reset", "Soft"]).id).toBe("Soft");
	});

	describe("when the path does not name an item a user could choose", () => {
		it.each([
			[["Rename"], 'no menu item labelled "Rename" is showing'],
			[["Reset", "Keep"], 'no menu item labelled "Keep" is showing in Reset'],
			[["Checkout"], 'the menu item labelled "Checkout" is disabled'],
			[["Reset", "Hard"], 'the menu item labelled "Hard" is disabled'],
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
		]);
	});
});

import { CheckMenuItem, MenuItem, Submenu } from "@tauri-apps/api/menu";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nativeMenu } from "./native-menu.js";

vi.mock("@tauri-apps/api/menu", () => ({
	Menu: { new: vi.fn().mockResolvedValue({}) },
	MenuItem: { new: vi.fn().mockResolvedValue({}) },
	CheckMenuItem: { new: vi.fn().mockResolvedValue({}) },
	Submenu: { new: vi.fn().mockResolvedValue({}) },
	PredefinedMenuItem: { new: vi.fn().mockResolvedValue({}) },
}));

const HOSTILE = "Push ‮niam‬ to origin Delete main";
const SHOWN = "Push �niam� to origin�Delete main";

function textGiven(made: { mock: { calls: unknown[][] } }): unknown {
	return (made.mock.calls[0]?.[0] as { text?: unknown } | undefined)?.text;
}

beforeEach(() => {
	vi.mocked(MenuItem.new).mockClear();
	vi.mocked(CheckMenuItem.new).mockClear();
	vi.mocked(Submenu.new).mockClear();
});

describe("nativeMenu", () => {
	it("shows an item's label with the characters that would change its layout replaced", async () => {
		const menu = await nativeMenu();

		await menu.MenuItem.new({ text: HOSTILE });

		expect(textGiven(vi.mocked(MenuItem.new))).toBe(SHOWN);
	});

	it("shows a submenu's label with the characters that would change its layout replaced", async () => {
		const menu = await nativeMenu();

		await menu.Submenu.new({ text: HOSTILE, items: [] });

		expect(textGiven(vi.mocked(Submenu.new))).toBe(SHOWN);
	});

	it("shows a check item's label with the characters that would change its layout replaced", async () => {
		const menu = await nativeMenu();

		await menu.CheckMenuItem.new({ text: HOSTILE, checked: true });

		expect(textGiven(vi.mocked(CheckMenuItem.new))).toBe(SHOWN);
	});

	it("keeps a long label whole, since cutting it could drop the remote it names", async () => {
		const menu = await nativeMenu();
		const label = `Delete ${"t".repeat(80)} from upstream`;

		await menu.MenuItem.new({ text: label });

		expect(textGiven(vi.mocked(MenuItem.new))).toBe(label);
	});

	it("keeps the item's action and state", async () => {
		const menu = await nativeMenu();
		const action = () => {};

		await menu.MenuItem.new({ text: "Pull", enabled: false, action });

		expect(vi.mocked(MenuItem.new)).toHaveBeenCalledWith({
			text: "Pull",
			enabled: false,
			action,
		});
	});
});

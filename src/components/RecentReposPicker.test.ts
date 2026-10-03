import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { getRecentRepos } from "../lib/store.js";
import RecentReposPicker from "./RecentReposPicker.svelte";
import "../__tests__/helpers/tauri-mock";

vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/store.js", () => ({
	getRecentRepos: vi.fn().mockResolvedValue([]),
	removeRecentRepo: vi.fn().mockResolvedValue(undefined),
}));

const twoRepos = [
	{ name: "trunk", path: "/Users/test/code/trunk" },
	{ name: "dotfiles", path: "/Users/test/code/dotfiles" },
];

function mount(
	props: Partial<{ onpick: () => void; onclose: () => void }> = {},
) {
	return render(RecentReposPicker, {
		props: { open: true, onpick: vi.fn(), onclose: vi.fn(), ...props },
	});
}

describe("RecentReposPicker", () => {
	it("offers Open Repository as the primary action when nothing is recent", async () => {
		vi.mocked(getRecentRepos).mockResolvedValue([]);
		mount();

		expect(await screen.findByText("Open Repository")).toHaveClass("bg-accent");
	});

	it("opens as a modal named for assistive tech", async () => {
		mount();

		expect(
			await screen.findByRole("dialog", { name: "Open a recent repository" }),
		).toHaveAttribute("open");
	});

	it("lists each recent repository as an option", async () => {
		vi.mocked(getRecentRepos).mockResolvedValue(twoRepos);
		vi.mocked(invoke).mockResolvedValue(true);
		mount();

		const options = await screen.findAllByRole("option");

		expect(options.map((o) => o.textContent?.trim().split(/\s+/)[0])).toEqual([
			"trunk",
			"dotfiles",
		]);
	});

	it("picks the option that is clicked", async () => {
		vi.mocked(getRecentRepos).mockResolvedValue(twoRepos);
		vi.mocked(invoke).mockResolvedValue(true);
		const onpick = vi.fn();
		mount({ onpick });

		await fireEvent.click(
			await screen.findByRole("option", { name: /dotfiles/ }),
		);

		expect(onpick).toHaveBeenCalledWith(
			"/Users/test/code/dotfiles",
			"dotfiles",
		);
	});

	it("closes when the dialog is cancelled", async () => {
		const onclose = vi.fn();
		mount({ onclose });

		await fireEvent(await screen.findByRole("dialog"), new Event("cancel"));

		expect(onclose).toHaveBeenCalled();
	});
});

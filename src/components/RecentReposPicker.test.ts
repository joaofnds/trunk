import { render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import RecentReposPicker from "./RecentReposPicker.svelte";
import "../__tests__/helpers/tauri-mock";

vi.mock("../lib/store.js", () => ({
	getRecentRepos: vi.fn().mockResolvedValue([]),
	removeRecentRepo: vi.fn().mockResolvedValue(undefined),
}));

describe("RecentReposPicker", () => {
	it("offers Open Repository as the primary action when nothing is recent", async () => {
		render(RecentReposPicker, {
			props: { open: true, onpick: vi.fn(), onclose: vi.fn() },
		});

		expect(await screen.findByText("Open Repository")).toHaveClass("bg-accent");
	});
});

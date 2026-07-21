import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import WelcomeScreen from "./WelcomeScreen.svelte";

// Shared Tauri mock (mocks invoke, dialog, clipboard, etc.)
import "../__tests__/helpers/tauri-mock";

// Explicitly mock @tauri-apps/api/path to prevent real homeDir call
vi.mock("@tauri-apps/api/path", () => ({
	homeDir: vi.fn().mockResolvedValue("/Users/test"),
}));

// Mock store module for getRecentRepos / addRecentRepo / removeRecentRepo
vi.mock("../lib/store.js", () => ({
	getRecentRepos: vi.fn().mockResolvedValue([]),
	addRecentRepo: vi.fn().mockResolvedValue(undefined),
	removeRecentRepo: vi.fn().mockResolvedValue(undefined),
}));

// Mock invoke module — safeInvoke resolves so openPath succeeds
vi.mock("../lib/invoke.js", () => ({
	safeInvoke: vi.fn().mockResolvedValue(undefined),
}));

describe("WelcomeScreen", () => {
	it("renders 'Open Repository' button", () => {
		render(WelcomeScreen, {
			props: { onopen: vi.fn() },
		});
		expect(screen.getByText("Open Repository")).toBeInTheDocument();
	});

	it("renders app title 'Trunk'", () => {
		render(WelcomeScreen, {
			props: { onopen: vi.fn() },
		});
		expect(screen.getByText("Trunk")).toBeInTheDocument();
	});

	it("renders tagline", () => {
		render(WelcomeScreen, {
			props: { onopen: vi.fn() },
		});
		expect(
			screen.getByText("Git history, beautifully visualized"),
		).toBeInTheDocument();
	});

	it("renders recent repos when available", async () => {
		const { getRecentRepos } = await import("../lib/store.js");
		vi.mocked(getRecentRepos).mockResolvedValue([
			{ name: "trunk", path: "/Users/test/code/trunk" },
			{ name: "other", path: "/Users/test/code/other" },
		]);

		render(WelcomeScreen, {
			props: { onopen: vi.fn() },
		});

		// Wait for $effect to run and populate recentRepos
		await vi.waitFor(() => {
			expect(screen.getByText("Recent")).toBeInTheDocument();
		});

		expect(screen.getByText("trunk")).toBeInTheDocument();
	});

	it("calls onopen when recent repo clicked", async () => {
		const storeModule = await import("../lib/store.js");
		vi.mocked(storeModule.getRecentRepos).mockResolvedValue([
			{ name: "trunk", path: "/Users/test/code/trunk" },
		]);
		vi.mocked(storeModule.addRecentRepo).mockResolvedValue(undefined);

		const onopen = vi.fn();
		render(WelcomeScreen, {
			props: { onopen },
		});

		// Wait for recent repos to load
		await vi.waitFor(() => {
			expect(screen.getByText("trunk")).toBeInTheDocument();
		});

		// Click the repo entry (the parent div with role="button")
		const repoButton = screen.getByText("trunk").closest('[role="button"]');
		expect(repoButton).toBeTruthy();
		await fireEvent.click(repoButton as Element);

		// openPath is async (calls safeInvoke then onopen)
		await vi.waitFor(() => {
			expect(onopen).toHaveBeenCalledWith("/Users/test/code/trunk", "trunk");
		});
	});
});

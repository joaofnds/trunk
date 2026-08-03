import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke } from "../lib/invoke.js";
import {
	addRecentRepo,
	getRecentRepos,
	removeRecentRepo,
} from "../lib/store.js";
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

vi.mock("../lib/invoke.js", async (importActual) => ({
	...(await importActual<typeof import("../lib/invoke.js")>()),
	safeInvoke: vi.fn(),
}));

describe("WelcomeScreen", () => {
	beforeEach(() => {
		vi.mocked(safeInvoke).mockReset();
		vi.mocked(safeInvoke).mockResolvedValue(undefined);
		vi.mocked(getRecentRepos).mockResolvedValue([]);
		vi.mocked(addRecentRepo).mockResolvedValue(undefined);
		vi.mocked(removeRecentRepo).mockResolvedValue(undefined);
	});

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

	it("shows the backend message when opening a repo fails", async () => {
		vi.mocked(getRecentRepos).mockResolvedValue([
			{ name: "trunk", path: "/Users/test/code/trunk" },
		]);
		// Command-scoped, not mockRejectedValueOnce: a leaked flow must not consume it.
		vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
			cmd === "open_repo"
				? Promise.reject({ code: "git_error", message: "not a git repository" })
				: Promise.resolve(undefined),
		);

		render(WelcomeScreen, { props: { onopen: vi.fn() } });
		const repoButton = (await screen.findByText("trunk")).closest(
			'[role="button"]',
		);
		expect(repoButton).toBeTruthy();
		await fireEvent.click(repoButton as Element);

		expect(await screen.findByText("not a git repository")).toBeInTheDocument();
	});
});

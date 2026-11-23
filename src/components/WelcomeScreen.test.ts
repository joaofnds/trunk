import { fireEvent, render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRecentRepos, removeRecentRepo } from "../lib/store.js";
import WelcomeScreen from "./WelcomeScreen.svelte";

// Shared Tauri mock (mocks invoke, dialog, clipboard, etc.)
import "../__tests__/helpers/tauri-mock";

// Explicitly mock @tauri-apps/api/path to prevent real homeDir call
vi.mock("@tauri-apps/api/path", () => ({
	homeDir: vi.fn().mockResolvedValue("/Users/test"),
}));

vi.mock("../lib/store.js", () => ({
	getRecentRepos: vi.fn().mockResolvedValue([]),
	removeRecentRepo: vi.fn().mockResolvedValue(undefined),
}));

describe("WelcomeScreen", () => {
	beforeEach(() => {
		vi.mocked(getRecentRepos).mockResolvedValue([]);
		vi.mocked(removeRecentRepo).mockResolvedValue(undefined);
	});

	// Renders with one recent repo seeded and returns its clickable row.
	async function renderWithRecentRepo(onopen = vi.fn()) {
		vi.mocked(getRecentRepos).mockResolvedValue([
			{ name: "trunk", path: "/Users/test/code/trunk" },
		]);

		render(WelcomeScreen, { props: { onopen } });
		const row = (await screen.findByText("trunk")).closest("button");

		expect(row).toBeTruthy();
		return { row: row as Element, onopen };
	}

	it("renders 'Open Repository' button", () => {
		render(WelcomeScreen, {
			props: { onopen: vi.fn() },
		});
		expect(screen.getByText("Open Repository")).toBeInTheDocument();
	});

	it("draws Open Repository as the large primary action", () => {
		render(WelcomeScreen, { props: { onopen: vi.fn() } });

		expect(screen.getByText("Open Repository")).toHaveClass(
			"bg-accent",
			"h-control-lg",
		);
	});

	it("keeps the remove control a small ghost icon that shows under the pointer", async () => {
		await renderWithRecentRepo();

		const remove = screen.getByLabelText("Remove from recent");
		expect(remove).toHaveClass("w-control-sm", "bg-transparent");
		expect(remove.parentElement).toHaveClass("group-hover:opacity-100");
	});

	it("identifies a recent repository by its name first and retains its full path", async () => {
		const { row } = await renderWithRecentRepo();
		expect(row.textContent?.trim()).toMatch(/^trunk\s*~?\//);
		expect(row).toHaveAttribute("title", "/Users/test/code/trunk");
	});

	it("lists every recent repo under a Recent heading", async () => {
		vi.mocked(getRecentRepos).mockResolvedValue([
			{ name: "trunk", path: "/Users/test/code/trunk" },
			{ name: "other", path: "/Users/test/code/other" },
		]);

		render(WelcomeScreen, { props: { onopen: vi.fn() } });

		expect(await screen.findByText("Recent")).toBeInTheDocument();
		expect(screen.getByText("trunk")).toBeInTheDocument();
		expect(screen.getByText("other")).toBeInTheDocument();
	});

	it("shows the folder and network parent of a recent Windows checkout", async () => {
		const path = "\\\\build\\repos\\trunk\\";
		vi.mocked(getRecentRepos).mockResolvedValue([{ name: "old", path }]);
		render(WelcomeScreen, { props: { onopen: vi.fn() } });

		expect(await screen.findByText("trunk")).toBeVisible();
		expect(screen.getByText("\\\\build\\repos")).toBeVisible();
		expect(
			screen.getByRole("button", { name: `trunk, ${path}` }),
		).toHaveAttribute("title", path);
	});

	it("opens the repo the operator clicked", async () => {
		const { row, onopen } = await renderWithRecentRepo();

		await fireEvent.click(row);

		await vi.waitFor(() => {
			expect(onopen).toHaveBeenCalledWith({
				path: "/Users/test/code/trunk",
				name: "trunk",
			});
		});
	});

	it("removes a recent repo without opening it", async () => {
		const onopen = vi.fn();
		vi.mocked(getRecentRepos).mockResolvedValueOnce([
			{ name: "trunk", path: "/Users/test/code/trunk" },
		]);
		render(WelcomeScreen, { props: { onopen } });
		await screen.findByText("trunk");

		await fireEvent.click(screen.getByLabelText("Remove from recent"));

		await vi.waitFor(() => {
			expect(screen.queryByText("trunk")).not.toBeInTheDocument();
		});
		expect(removeRecentRepo).toHaveBeenCalledWith("/Users/test/code/trunk");
		expect(onopen).not.toHaveBeenCalled();
	});

	it("offers to choose another folder while opening a repository", async () => {
		const onopen = vi.fn();
		render(WelcomeScreen, { props: { onopen, opening: true } });

		await fireEvent.click(
			screen.getByRole("button", { name: "Open Repository" }),
		);

		expect(onopen).toHaveBeenCalledWith();
		expect(screen.getByRole("status")).toHaveTextContent("Opening repository…");
	});
});

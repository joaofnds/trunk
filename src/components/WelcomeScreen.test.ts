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

	it("opens the repo the operator clicked", async () => {
		const { row, onopen } = await renderWithRecentRepo();

		await fireEvent.click(row);

		await vi.waitFor(() => {
			expect(onopen).toHaveBeenCalledWith("/Users/test/code/trunk", "trunk");
		});
	});

	it("removes a recent repo without opening it", async () => {
		const opened: string[] = [];
		vi.mocked(getRecentRepos).mockResolvedValueOnce([
			{ name: "trunk", path: "/Users/test/code/trunk" },
		]);
		render(WelcomeScreen, {
			props: { onopen: (path: string) => void opened.push(path) },
		});
		await screen.findByText("trunk");

		await fireEvent.click(screen.getByLabelText("Remove from recent"));

		await vi.waitFor(() => {
			expect(screen.queryByText("trunk")).not.toBeInTheDocument();
		});
		expect(removeRecentRepo).toHaveBeenCalledWith("/Users/test/code/trunk");
		expect(opened).toEqual([]);
	});

	it("shows the backend message when opening a repo fails", async () => {
		// Command-scoped, not mockRejectedValueOnce: a leaked flow must not consume it.
		vi.mocked(safeInvoke).mockImplementation((cmd: string) =>
			cmd === "open_repo"
				? Promise.reject({ code: "git_error", message: "not a git repository" })
				: Promise.resolve(undefined),
		);
		const { row } = await renderWithRecentRepo();

		await fireEvent.click(row);

		expect(await screen.findByText("not a git repository")).toBeInTheDocument();
	});
});

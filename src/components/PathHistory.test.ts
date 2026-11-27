import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { expect, it, vi } from "vitest";
import PathHistory from "./PathHistory.svelte";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("restarts at the first page when history changes between reads", async () => {
	const read = vi.mocked(invoke);
	read
		.mockResolvedValueOnce({
			commits: [{ oid: "aaaaaaa", summary: "old result" }],
			next: 128,
			revision: 1,
		})
		.mockRejectedValueOnce("History changed")
		.mockResolvedValueOnce({
			commits: [{ oid: "bbbbbbb", summary: "new result" }],
			next: null,
			revision: 2,
		});

	render(PathHistory, {
		repoPath: "/repo",
		filePath: "example.txt",
		onselect: vi.fn(),
		onclose: vi.fn(),
	});
	await fireEvent.click(
		await screen.findByRole("button", { name: "Show older commits" }),
	);
	expect(read).toHaveBeenLastCalledWith(
		"path_history",
		expect.objectContaining({ offset: 128, revision: 1 }),
	);
	await fireEvent.click(
		await screen.findByRole("button", { name: "Reload history" }),
	);

	expect(await screen.findByText("new result")).toBeVisible();
	expect(screen.queryByText("old result")).toBeNull();
	expect(read).toHaveBeenLastCalledWith(
		"path_history",
		expect.objectContaining({
			offset: 0,
			revision: null,
		}),
	);
});

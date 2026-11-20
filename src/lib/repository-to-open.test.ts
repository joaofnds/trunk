import { ask } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke } from "./invoke.js";
import { repositoryToOpen } from "./repository-to-open.js";

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

vi.mock("./invoke.js", async (importActual) => ({
	...(await importActual<typeof import("./invoke.js")>()),
	safeInvoke: vi.fn(),
}));

const mockAsk = vi.mocked(ask);
const mockInvoke = vi.mocked(safeInvoke);

beforeEach(() => {
	mockAsk.mockReset();
	mockInvoke.mockReset();
});

describe("repositoryToOpen", () => {
	it("opens a repository's root as chosen", async () => {
		mockInvoke.mockResolvedValue(null);

		expect(await repositoryToOpen("/code/trunk")).toBe("/code/trunk");
		expect(mockAsk).not.toHaveBeenCalled();
	});

	it("opens the repository a chosen folder lies inside once the user agrees", async () => {
		mockInvoke.mockResolvedValue("/code/trunk");
		mockAsk.mockResolvedValue(true);

		const opened = await repositoryToOpen("/code/trunk/src");

		expect(opened).toBe("/code/trunk");
		expect(mockAsk).toHaveBeenCalledWith(
			"/code/trunk/src is a folder inside the repository /code/trunk. Open that repository?",
			expect.objectContaining({ okLabel: "Open Repository" }),
		);
	});

	it("shows a line break in the folder's path as a mark, so the path cannot add lines to the question", async () => {
		mockInvoke.mockResolvedValue("/code/trunk");
		mockAsk.mockResolvedValue(false);

		await repositoryToOpen("/code/trunk/a\u2028b");

		expect(mockAsk).toHaveBeenCalledWith(
			"/code/trunk/a\ufffdb is a folder inside the repository /code/trunk. Open that repository?",
			expect.anything(),
		);
	});

	it("opens nothing when the user declines the repository above the folder", async () => {
		mockInvoke.mockResolvedValue("/code/trunk");
		mockAsk.mockResolvedValue(false);

		expect(await repositoryToOpen("/code/trunk/src")).toBeNull();
	});
});

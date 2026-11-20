import { ask } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke } from "./invoke.js";
import { deleteRemoteBranch, deleteTag, renameBranch } from "./ref-actions.js";
import { _resetToasts, toasts } from "./toast.svelte.js";

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

vi.mock("./invoke.js", async (importActual) => ({
	...(await importActual<typeof import("./invoke.js")>()),
	safeInvoke: vi.fn(),
}));

const mockAsk = vi.mocked(ask);
const mockInvoke = vi.mocked(safeInvoke);

function shown(): { kind: string; message: string }[] {
	return toasts.items.map(({ kind, message }) => ({ kind, message }));
}

beforeEach(() => {
	mockAsk.mockReset();
	mockAsk.mockResolvedValue(true);
	mockInvoke.mockReset();
	mockInvoke.mockResolvedValue(undefined);
	_resetToasts();
});

describe("deleteRemoteBranch", () => {
	it("deletes the branch once the user agrees and says so", async () => {
		const changed = await deleteRemoteBranch("/repo", "origin/topic");

		expect(changed).toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith("delete_remote_branch", {
			path: "/repo",
			branchName: "origin/topic",
		});
		expect(shown()).toEqual([
			{ kind: "success", message: "Deleted remote branch origin/topic" },
		]);
	});

	it("leaves the branch when the user declines", async () => {
		mockAsk.mockResolvedValue(false);

		const changed = await deleteRemoteBranch("/repo", "origin/topic");

		expect(changed).toBe(false);
		expect(mockInvoke).not.toHaveBeenCalled();
		expect(shown()).toEqual([]);
	});

	it("reports what git said in an error toast when the delete fails", async () => {
		mockInvoke.mockRejectedValue({
			code: "remote_error",
			message: "fatal: unable to access the remote",
		});

		const changed = await deleteRemoteBranch("/repo", "origin/topic");

		expect(changed).toBe(false);
		expect(shown()).toEqual([
			{ kind: "error", message: "fatal: unable to access the remote" },
		]);
	});
});

describe("deleteTag", () => {
	it("deletes the tag once the user agrees and says so", async () => {
		const changed = await deleteTag("/repo", "v1.0");

		expect(changed).toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith("delete_tag", {
			path: "/repo",
			tagName: "v1.0",
		});
		expect(shown()).toEqual([{ kind: "success", message: "Deleted tag v1.0" }]);
	});

	it("leaves the tag when the user declines", async () => {
		mockAsk.mockResolvedValue(false);

		const changed = await deleteTag("/repo", "v1.0");

		expect(changed).toBe(false);
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("reports what git said in an error toast when the delete fails", async () => {
		mockInvoke.mockRejectedValue({
			code: "git_error",
			message: "tag not found",
		});

		const changed = await deleteTag("/repo", "v1.0");

		expect(changed).toBe(false);
		expect(shown()).toEqual([{ kind: "error", message: "tag not found" }]);
	});
});

describe("renameBranch", () => {
	it("renames the branch to the trimmed name and says so", async () => {
		const changed = await renameBranch("/repo", "topic", "  feature  ");

		expect(changed).toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith("rename_branch", {
			path: "/repo",
			oldName: "topic",
			newName: "feature",
		});
		expect(shown()).toEqual([
			{ kind: "success", message: "Renamed branch to feature" },
		]);
	});

	it.each(["", "   ", "topic"])(
		"changes nothing when the name typed is %j",
		async (typed) => {
			const changed = await renameBranch("/repo", "topic", typed);

			expect(changed).toBe(false);
			expect(mockInvoke).not.toHaveBeenCalled();
		},
	);

	it("reports what git said in an error toast when the rename fails", async () => {
		mockInvoke.mockRejectedValue({
			code: "git_error",
			message: "a branch named 'feature' already exists",
		});

		const changed = await renameBranch("/repo", "topic", "feature");

		expect(changed).toBe(false);
		expect(shown()).toEqual([
			{ kind: "error", message: "a branch named 'feature' already exists" },
		]);
	});
});

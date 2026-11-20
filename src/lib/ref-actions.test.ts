import { ask } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke } from "./invoke.js";
import {
	deleteRemoteBranch,
	deleteTag,
	pushBranch,
	renameBranch,
	runTagAction,
} from "./ref-actions.js";
import { createRemoteState } from "./remote-state.svelte.js";
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
		const changed = await deleteRemoteBranch(
			"/repo",
			"origin/topic",
			createRemoteState(),
		);

		expect(changed).toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith("delete_remote_branch", {
			path: "/repo",
			branchName: "origin/topic",
		});
		expect(shown()).toEqual([
			{ kind: "success", message: "Deleted remote branch origin/topic" },
		]);
	});

	it("shows the delete as the tab's running push until the remote answers", async () => {
		const remoteState = createRemoteState();
		let busyDuring: unknown;
		mockInvoke.mockImplementation(async () => {
			busyDuring = { ...remoteState };
		});

		await deleteRemoteBranch("/repo", "origin/topic", remoteState);

		expect(busyDuring).toMatchObject({ isRunning: true, lastOp: "push" });
		expect(remoteState.isRunning).toBe(false);
	});

	it("leaves the branch alone while another remote operation runs", async () => {
		const remoteState = createRemoteState();
		remoteState.isRunning = true;

		const changed = await deleteRemoteBranch(
			"/repo",
			"origin/topic",
			remoteState,
		);

		expect(changed).toBe(false);
		expect(mockInvoke).not.toHaveBeenCalled();
		expect(remoteState.isRunning).toBe(true);
		expect(shown()).toEqual([
			{ kind: "error", message: "A remote operation is already running" },
		]);
	});

	it("asks nothing while another remote operation runs", async () => {
		const remoteState = createRemoteState();
		remoteState.isRunning = true;

		await deleteRemoteBranch("/repo", "origin/topic", remoteState);

		expect(mockAsk).not.toHaveBeenCalled();
	});

	it("leaves the branch when the user declines", async () => {
		mockAsk.mockResolvedValue(false);

		const changed = await deleteRemoteBranch(
			"/repo",
			"origin/topic",
			createRemoteState(),
		);

		expect(changed).toBe(false);
		expect(mockInvoke).not.toHaveBeenCalled();
		expect(shown()).toEqual([]);
	});

	it("asks with the name flattened, so it cannot add lines to the question", async () => {
		await deleteRemoteBranch("/repo", "origin/a\u2028b", createRemoteState());

		expect(mockAsk.mock.calls[0]?.[0]).toBe(
			"Delete remote branch 'origin/a\uFFFDb'? This will remove it from the remote.",
		);
	});

	it("reports in an error toast when the question cannot be asked", async () => {
		mockAsk.mockRejectedValue(new Error("dialog plugin unavailable"));

		const changed = await deleteRemoteBranch(
			"/repo",
			"origin/topic",
			createRemoteState(),
		);

		expect(changed).toBe(false);
		expect(mockInvoke).not.toHaveBeenCalled();
		expect(shown()).toEqual([
			{ kind: "error", message: "dialog plugin unavailable" },
		]);
	});

	it("reports what git said in an error toast when the delete fails", async () => {
		mockInvoke.mockRejectedValue({
			code: "remote_error",
			message: "fatal: unable to access the remote",
		});

		const changed = await deleteRemoteBranch(
			"/repo",
			"origin/topic",
			createRemoteState(),
		);

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
		expect(shown()).toEqual([]);
	});

	it("asks with the name flattened, so it cannot add lines to the question", async () => {
		await deleteTag("/repo", "v1\u202E0");

		expect(mockAsk.mock.calls[0]?.[0]).toBe(
			"Delete tag 'v1\uFFFD0'? This cannot be undone.",
		);
	});

	it("reports in an error toast when the question cannot be asked", async () => {
		mockAsk.mockRejectedValue(new Error("dialog plugin unavailable"));

		const changed = await deleteTag("/repo", "v1.0");

		expect(changed).toBe(false);
		expect(mockInvoke).not.toHaveBeenCalled();
		expect(shown()).toEqual([
			{ kind: "error", message: "dialog plugin unavailable" },
		]);
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

describe("pushBranch", () => {
	const untracked = {
		code: "no_upstream",
		message: "feature does not track a branch on origin yet.",
	};

	it("pushes a branch that tracks a remote branch without asking", async () => {
		await pushBranch("/repo", "feature", createRemoteState());

		expect(mockAsk).not.toHaveBeenCalled();
		expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("push_branch", {
			path: "/repo",
			branch: "feature",
			publish: false,
		});
		expect(shown()).toEqual([{ kind: "success", message: "Pushed feature" }]);
	});

	it("asks before publishing a branch that tracks nothing", async () => {
		mockInvoke.mockRejectedValueOnce(untracked);

		await pushBranch("/repo", "feature", createRemoteState());

		expect(mockAsk).toHaveBeenCalledWith(
			"feature does not track a branch on origin yet. Push it there and track it?",
			expect.objectContaining({ okLabel: "Push and Track" }),
		);
	});

	it("publishes the branch once the user agrees", async () => {
		mockInvoke.mockRejectedValueOnce(untracked);

		await pushBranch("/repo", "feature", createRemoteState());

		expect(mockInvoke).toHaveBeenLastCalledWith("push_branch", {
			path: "/repo",
			branch: "feature",
			publish: true,
		});
		expect(shown()).toEqual([{ kind: "success", message: "Pushed feature" }]);
	});

	it("publishes nothing once the user declines", async () => {
		mockInvoke.mockRejectedValueOnce(untracked);
		mockAsk.mockResolvedValue(false);

		await pushBranch("/repo", "feature", createRemoteState());

		expect(mockInvoke).toHaveBeenCalledOnce();
		expect(shown()).toEqual([]);
	});

	it("keeps a standing push banner while it pushes another branch", async () => {
		const remoteState = createRemoteState();
		const rejected = { code: "non_fast_forward", message: "rejected" };
		remoteState.error = rejected;

		await pushBranch("/repo", "feature", remoteState);

		expect(remoteState.error).toEqual(rejected);
	});
});

describe("renameBranch", () => {
	it("renames the branch to the trimmed name and says so", async () => {
		const changed = await renameBranch("/repo", {
			from: "topic",
			to: "  feature  ",
		});

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

	it.each(["", "   ", "topic", "  topic  "])(
		"changes nothing when the name typed is %j",
		async (typed) => {
			const changed = await renameBranch("/repo", { from: "topic", to: typed });

			expect(changed).toBe(false);
			expect(mockInvoke).not.toHaveBeenCalled();
		},
	);

	it("reports what git said in an error toast when the rename fails", async () => {
		mockInvoke.mockRejectedValue({
			code: "git_error",
			message: "a branch named 'feature' already exists",
		});

		const changed = await renameBranch("/repo", {
			from: "topic",
			to: "feature",
		});

		expect(changed).toBe(false);
		expect(shown()).toEqual([
			{ kind: "error", message: "a branch named 'feature' already exists" },
		]);
	});
});

describe("runTagAction", () => {
	it("pushes the tag to the remote as the tab's running push, and says so", async () => {
		const remoteState = createRemoteState();
		let busyDuring: unknown;
		mockInvoke.mockImplementation(async () => {
			busyDuring = { ...remoteState };
		});

		const changed = await runTagAction(
			"/repo",
			"v1.0",
			{ kind: "push", remote: "origin" },
			remoteState,
		);

		expect(changed).toBe(false);
		expect(mockInvoke).toHaveBeenCalledWith("push_tag", {
			path: "/repo",
			remote: "origin",
			tagName: "v1.0",
		});
		expect(busyDuring).toMatchObject({ isRunning: true, lastOp: "push" });
		expect(mockAsk).not.toHaveBeenCalled();
		expect(shown()).toEqual([
			{ kind: "success", message: "Pushed tag v1.0 to origin" },
		]);
	});

	it("says in the app's words that the remote has another tag of that name", async () => {
		mockInvoke.mockRejectedValue({
			code: "tag_exists",
			message: " ! [rejected] v1.0 -> v1.0 (already exists)",
		});

		await runTagAction(
			"/repo",
			"v1.0",
			{ kind: "push", remote: "origin" },
			createRemoteState(),
		);

		expect(shown()).toEqual([
			{
				kind: "error",
				message:
					"The remote already has a different tag of this name. Delete it from the remote first to replace it",
			},
		]);
	});

	it("deletes the tag from the remote once the user agrees", async () => {
		const changed = await runTagAction(
			"/repo",
			"v1.0",
			{ kind: "delete_remote", remote: "origin" },
			createRemoteState(),
		);

		expect(changed).toBe(false);
		expect(mockAsk.mock.calls[0]?.[0]).toBe(
			"Delete tag 'v1.0' from origin? This will remove it from the remote.",
		);
		expect(mockInvoke).toHaveBeenCalledWith("delete_remote_tag", {
			path: "/repo",
			remote: "origin",
			tagName: "v1.0",
		});
		expect(shown()).toEqual([
			{ kind: "success", message: "Deleted tag v1.0 from origin" },
		]);
	});

	it("asks nothing and leaves the remote's tag while another remote operation runs", async () => {
		const remoteState = createRemoteState();
		remoteState.isRunning = true;

		await runTagAction(
			"/repo",
			"v1.0",
			{ kind: "delete_remote", remote: "origin" },
			remoteState,
		);

		expect(mockAsk).not.toHaveBeenCalled();
		expect(mockInvoke).not.toHaveBeenCalled();
		expect(shown()).toEqual([
			{ kind: "error", message: "A remote operation is already running" },
		]);
	});

	it("leaves the remote's tag when the user declines", async () => {
		mockAsk.mockResolvedValue(false);

		await runTagAction(
			"/repo",
			"v1.0",
			{ kind: "delete_remote", remote: "origin" },
			createRemoteState(),
		);

		expect(mockInvoke).not.toHaveBeenCalled();
		expect(shown()).toEqual([]);
	});

	it("deletes the local tag and reports that a ref here changed", async () => {
		const changed = await runTagAction(
			"/repo",
			"v1.0",
			{ kind: "delete" },
			createRemoteState(),
		);

		expect(changed).toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith("delete_tag", {
			path: "/repo",
			tagName: "v1.0",
		});
	});
});

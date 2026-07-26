import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke } from "./invoke.js";
import { runRemoteOp } from "./remote-op.js";
import { createRemoteState } from "./remote-state.svelte.js";
import { showToast } from "./toast.svelte.js";

vi.mock("./invoke.js", () => ({ safeInvoke: vi.fn() }));
vi.mock("./toast.svelte.js", () => ({ showToast: vi.fn() }));

const mockInvoke = vi.mocked(safeInvoke);

beforeEach(() => {
	mockInvoke.mockReset();
	mockInvoke.mockResolvedValue(undefined);
	vi.mocked(showToast).mockReset();
});

describe("runRemoteOp", () => {
	it.each([
		["git_push", "push"],
		["git_push_force", "push"],
		["git_pull", "pull"],
		["git_fetch", "fetch"],
	])("records %s as a %s", async (cmd, expected) => {
		const remoteState = createRemoteState();

		await runRemoteOp(remoteState, "/repo", cmd, "done");

		expect(remoteState.lastOp).toBe(expected);
	});

	it("records no operation for a command it does not know", async () => {
		const remoteState = createRemoteState();
		remoteState.lastOp = "push";

		await runRemoteOp(remoteState, "/repo", "git_teleport", "done");

		expect(remoteState.lastOp).toBeNull();
	});

	it("records the operation even when it fails", async () => {
		mockInvoke.mockRejectedValue({ code: "non_fast_forward", message: "no" });
		const remoteState = createRemoteState();

		await runRemoteOp(remoteState, "/repo", "git_fetch", "done");

		expect(remoteState.lastOp).toBe("fetch");
	});
});

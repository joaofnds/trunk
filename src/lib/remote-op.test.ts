import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke } from "./invoke.js";
import { runRemoteOp, whileRemoteRuns } from "./remote-op.js";
import { createRemoteState } from "./remote-state.svelte.js";
import { showToast } from "./toast.svelte.js";

vi.mock("./invoke.js", async (importActual) => ({
	...(await importActual<typeof import("./invoke.js")>()),
	safeInvoke: vi.fn(),
}));
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
	] as const)("records %s as a %s", async (cmd, expected) => {
		const remoteState = createRemoteState();

		await runRemoteOp(remoteState, "/repo", cmd, "done");

		expect(remoteState.lastOp).toBe(expected);
	});

	it("clears a previous failure when a new operation starts", async () => {
		const remoteState = createRemoteState();
		remoteState.error = { code: "non_fast_forward", message: "rejected" };

		await runRemoteOp(remoteState, "/repo", "git_pull", "done");

		expect(remoteState.error).toBeNull();
	});

	it("keeps a non-TrunkError failure describable", async () => {
		mockInvoke.mockRejectedValue("a bare string, not a TrunkError");
		const remoteState = createRemoteState();

		await runRemoteOp(remoteState, "/repo", "git_pull", "done");

		expect(remoteState.error?.message).toContain("a bare string");
	});

	it("records the operation even when it fails", async () => {
		mockInvoke.mockRejectedValue({ code: "non_fast_forward", message: "no" });
		const remoteState = createRemoteState();

		await runRemoteOp(remoteState, "/repo", "git_fetch", "done");

		expect(remoteState.lastOp).toBe("fetch");
	});

	it.each([
		["git_push_publish", "push"],
		["git_pull", "pull"],
		["git_fetch", "fetch"],
	] as const)(
		"names %s as the %s its failure reports",
		async (cmd, expected) => {
			mockInvoke.mockRejectedValue({ code: "non_fast_forward", message: "no" });
			const remoteState = createRemoteState();

			await runRemoteOp(remoteState, "/repo", cmd, "done");

			expect(remoteState.failedOp).toBe(expected);
		},
	);
});

describe("whileRemoteRuns", () => {
	it("marks the tab busy with its operation until the operation ends", async () => {
		const remoteState = createRemoteState();
		let busyDuring: [boolean, string | null] | undefined;

		await whileRemoteRuns(remoteState, "push", async () => {
			busyDuring = [remoteState.isRunning, remoteState.lastOp];
		});

		expect(busyDuring).toEqual([true, "push"]);
		expect(remoteState.isRunning).toBe(false);
	});

	it("drops the busy mark when the operation fails, and passes the failure on", async () => {
		const remoteState = createRemoteState();
		const refused = { code: "push_declined", message: "no" };

		await expect(
			whileRemoteRuns(remoteState, "push", () => Promise.reject(refused)),
		).rejects.toBe(refused);
		expect(remoteState.isRunning).toBe(false);
	});

	it("refuses a second operation while one runs, and keeps the first one marked", async () => {
		const remoteState = createRemoteState();
		const second = vi.fn(() => Promise.resolve());
		let refusal: unknown;

		await whileRemoteRuns(remoteState, "pull", async () => {
			refusal = await whileRemoteRuns(remoteState, "push", second).catch(
				(e: unknown) => e,
			);
			expect(remoteState).toMatchObject({ isRunning: true, lastOp: "pull" });
		});

		expect(second).not.toHaveBeenCalled();
		expect(refusal).toMatchObject({ code: "op_in_progress" });
	});
});

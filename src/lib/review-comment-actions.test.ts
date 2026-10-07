import { beforeEach, describe, expect, it, vi } from "vitest";
import { safeInvoke } from "./invoke.js";
import {
	addReply,
	deleteReply,
	editReply,
	setThreadState,
} from "./review-comment-actions.js";
import { _resetToasts, toasts } from "./toast.svelte.js";

vi.mock("./invoke.js", async (importActual) => ({
	...(await importActual<typeof import("./invoke.js")>()),
	safeInvoke: vi.fn(),
}));

const mockInvoke = vi.mocked(safeInvoke);

function errorMessages(): string[] {
	return toasts.items.filter((t) => t.kind === "error").map((t) => t.message);
}

beforeEach(() => {
	mockInvoke.mockReset();
	mockInvoke.mockResolvedValue(undefined);
	_resetToasts();
});

describe("addReply", () => {
	it.each(["send", "hold"] as const)(
		"sends the repo path, thread id, text and %s to add_reply",
		async (delivery) => {
			await addReply("/repo", "thread-1", "looks good", delivery);

			expect(mockInvoke).toHaveBeenCalledWith("add_reply", {
				path: "/repo",
				threadId: "thread-1",
				text: "looks good",
				delivery,
			});
		},
	);

	it("raises a toast and resolves, rather than rejecting, when the backend refuses", async () => {
		mockInvoke.mockRejectedValue({
			code: "sqlite",
			message: "database is locked",
		});

		await expect(
			addReply("/repo", "thread-1", "too late", "send"),
		).resolves.toBe(false);
		expect(errorMessages()).toEqual(["database is locked"]);
	});
});

describe("editReply", () => {
	it("sends the repo path, reply id and text to edit_reply", async () => {
		await editReply("/repo", "reply-1", "corrected");

		expect(mockInvoke).toHaveBeenCalledWith("edit_reply", {
			path: "/repo",
			id: "reply-1",
			text: "corrected",
		});
	});

	it("raises a toast and returns false when the backend refuses", async () => {
		mockInvoke.mockRejectedValue({
			code: "sqlite",
			message: "database is locked",
		});

		await expect(editReply("/repo", "reply-1", "too late")).resolves.toBe(
			false,
		);
		expect(errorMessages()).toEqual(["database is locked"]);
	});
});

describe("deleteReply", () => {
	it("sends the repo path and reply id to delete_reply", async () => {
		await deleteReply("/repo", "reply-1");

		expect(mockInvoke).toHaveBeenCalledWith("delete_reply", {
			path: "/repo",
			id: "reply-1",
		});
	});

	it("raises a toast and resolves when the backend refuses the delete", async () => {
		mockInvoke.mockRejectedValue({
			code: "sqlite",
			message: "database is locked",
		});

		await expect(deleteReply("/repo", "reply-1")).resolves.toBeUndefined();
		expect(errorMessages()).toEqual(["database is locked"]);
	});
});

describe("setThreadState", () => {
	it("sends the repo path, id and target state to set_thread_state", async () => {
		await setThreadState("/repo", "thread-1", "done");

		expect(mockInvoke).toHaveBeenCalledWith("set_thread_state", {
			path: "/repo",
			id: "thread-1",
			next: "done",
		});
	});

	it("raises a toast and resolves when the transition is illegal", async () => {
		mockInvoke.mockRejectedValue({
			code: "illegal_transition",
			message: "addressed can only be claimed by an agent",
		});

		await expect(
			setThreadState("/repo", "thread-1", "done"),
		).resolves.toBeUndefined();
		expect(errorMessages()).toEqual([
			"addressed can only be claimed by an agent",
		]);
	});
});

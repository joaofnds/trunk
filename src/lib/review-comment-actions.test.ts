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
	it("sends the repo path, thread id and text to add_reply", async () => {
		await addReply("/repo", "thread-1", "looks good");

		expect(mockInvoke).toHaveBeenCalledWith("add_reply", {
			path: "/repo",
			threadId: "thread-1",
			text: "looks good",
		});
	});

	it("raises a toast and resolves, rather than rejecting, when the backend refuses", async () => {
		mockInvoke.mockRejectedValue({
			code: "review_published",
			message: "a published review's threads are permanent",
		});

		await expect(
			addReply("/repo", "thread-1", "too late"),
		).resolves.toBeUndefined();
		expect(errorMessages()).toEqual([
			"a published review's threads are permanent",
		]);
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
});

describe("deleteReply", () => {
	it("sends the repo path and reply id to delete_reply", async () => {
		await deleteReply("/repo", "reply-1");

		expect(mockInvoke).toHaveBeenCalledWith("delete_reply", {
			path: "/repo",
			id: "reply-1",
		});
	});

	// The finding's own Verify step: a stale render in a non-owning window
	// still offers Delete after the review is published elsewhere; the click
	// must surface a toast instead of an unhandled rejection.
	it("raises a toast and resolves when a published review refuses the delete", async () => {
		mockInvoke.mockRejectedValue({
			code: "review_published",
			message: "a published review's replies are permanent",
		});

		await expect(deleteReply("/repo", "reply-1")).resolves.toBeUndefined();
		expect(errorMessages()).toEqual([
			"a published review's replies are permanent",
		]);
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

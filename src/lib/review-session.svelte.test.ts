import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReviewSession } from "./review-session.svelte.js";

// safeInvoke is a thin wrapper around @tauri-apps/api/core::invoke (src/lib/invoke.ts).
// Mocking the underlying invoke (not safeInvoke itself) keeps the TrunkError-parsing
// path live in the test, matching the project's pattern (src/lib/invoke.test.ts:5-9).
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
	mockInvoke.mockReset();
});

describe("createReviewSession — generate", () => {
	it("generate returns the markdown string", async () => {
		mockInvoke.mockResolvedValueOnce("# generated markdown");
		const m = createReviewSession();
		const result = await m.generate("/some/path", "REVIEW01");
		expect(mockInvoke).toHaveBeenCalledWith("generate_review_doc", {
			path: "/some/path",
			reviewId: "REVIEW01",
		});
		expect(result).toBe("# generated markdown");
	});

	it("generate propagates rejection", async () => {
		mockInvoke.mockRejectedValueOnce(
			'{"code":"no_threads","message":"Generate requires at least one thread in the review"}',
		);
		const m = createReviewSession();
		await expect(m.generate("/repo", "REVIEW01")).rejects.toMatchObject({
			code: "no_threads",
		});
	});
});

import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { aPinnedThread, aThread } from "../__tests__/helpers/thread-fixture.js";
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
		const result = await m.generate("/some/path", "REVIEW01", ["t1", "t2"]);
		expect(mockInvoke).toHaveBeenCalledWith("generate_review_doc", {
			path: "/some/path",
			reviewId: "REVIEW01",
			threadIds: ["t1", "t2"],
		});
		expect(result).toBe("# generated markdown");
	});

	it("generate propagates rejection", async () => {
		mockInvoke.mockRejectedValueOnce(
			'{"code":"no_threads","message":"Generate requires at least one thread in the review"}',
		);
		const m = createReviewSession();
		await expect(m.generate("/repo", "REVIEW01", ["t1"])).rejects.toMatchObject(
			{
				code: "no_threads",
			},
		);
	});
});

describe("createReviewSession — jumpTo", () => {
	function recordingDeps() {
		const calls: string[] = [];
		return {
			calls,
			deps: {
				selectCommit: (oid: string) => {
					calls.push(`commit ${oid}`);
				},
				selectFile: (path: string) => {
					calls.push(`file ${path}`);
				},
				openCurrentFile: (path: string) => {
					calls.push(`current ${path}`);
				},
				scrollToRange: (start: number, end: number, side: string) => {
					calls.push(`scroll ${start}-${end} ${side}`);
				},
			},
		};
	}

	it("opens a current-file thread's file at the lines it last resolved to", async () => {
		const m = createReviewSession();
		const { calls, deps } = recordingDeps();

		await m.jumpTo(
			aPinnedThread({
				id: "pinned",
				filePath: "src/untouched.ts",
				startLine: 4,
				endLine: 5,
				resolvedStartLine: 9,
			}),
			deps,
		);

		expect(calls).toEqual(["current src/untouched.ts", "scroll 9-10 New"]);
		expect(m.state.rightPaneMode).toBe("diff");
	});

	it("goes nowhere for a thread on a whole commit", async () => {
		const m = createReviewSession();
		const { calls, deps } = recordingDeps();

		await m.jumpTo(aThread({ anchor: null, content_pin: null }), deps);

		expect(calls).toEqual([]);
	});
});

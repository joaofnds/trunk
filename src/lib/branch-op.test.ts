import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeBranch, rebaseBranch, resolveForkPoint } from "./branch-op.js";
import { safeInvoke } from "./invoke.js";
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

describe("mergeBranch", () => {
	it("sends the repo path and the branch to merge_branch_begin", async () => {
		mockInvoke.mockResolvedValue({ kind: "fast_forwarded" });

		await mergeBranch({ repoPath: "/repo", branch: "topic" });

		expect(mockInvoke).toHaveBeenCalledWith("merge_branch_begin", {
			path: "/repo",
			branch: "topic",
		});
	});

	it("opens no editor when the merge needs no commit message", async () => {
		mockInvoke.mockResolvedValue({ kind: "fast_forwarded" });
		const openMessageEditor = vi.fn();

		await mergeBranch({
			repoPath: "/repo",
			branch: "topic",
			openMessageEditor,
		});

		expect(openMessageEditor).not.toHaveBeenCalled();
	});

	it("routes the edited message to merge_continue when the merge is ready", async () => {
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "merge_branch_begin"
				? Promise.resolve({ kind: "ready", message: "Merge topic" })
				: Promise.resolve(undefined),
		);

		await mergeBranch({
			repoPath: "/repo",
			branch: "topic",
			openMessageEditor: () => Promise.resolve("edited message"),
		});

		expect(mockInvoke).toHaveBeenCalledWith("merge_continue", {
			path: "/repo",
			message: "edited message",
		});
	});

	it("leaves the merge in progress when the editor is cancelled", async () => {
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "merge_branch_begin"
				? Promise.resolve({ kind: "ready", message: "Merge topic" })
				: Promise.resolve(undefined),
		);
		const onDone = vi.fn();

		await mergeBranch({
			repoPath: "/repo",
			branch: "topic",
			openMessageEditor: () => Promise.resolve(null),
			onDone,
		});

		expect(mockInvoke).not.toHaveBeenCalledWith(
			"merge_continue",
			expect.anything(),
		);
		expect(onDone).not.toHaveBeenCalled();
	});

	it("runs onDone after a merge that needed no editor", async () => {
		mockInvoke.mockResolvedValue({ kind: "fast_forwarded" });
		const onDone = vi.fn();

		await mergeBranch({ repoPath: "/repo", branch: "topic", onDone });

		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it("reports the failure and skips onDone when the merge rejects", async () => {
		mockInvoke.mockRejectedValue({
			code: "git_conflict",
			message: "would overwrite",
		});
		const onDone = vi.fn();

		await mergeBranch({ repoPath: "/repo", branch: "topic", onDone });

		expect(errorMessages()).toEqual(["would overwrite"]);
		expect(onDone).not.toHaveBeenCalled();
	});
});

describe("rebaseBranch", () => {
	it("sends the repo path and the target branch to rebase_branch", async () => {
		await rebaseBranch({ repoPath: "/repo", ontoBranch: "main" });

		expect(mockInvoke).toHaveBeenCalledWith("rebase_branch", {
			path: "/repo",
			ontoBranch: "main",
		});
	});

	it("runs onDone after the rebase", async () => {
		const onDone = vi.fn();

		await rebaseBranch({ repoPath: "/repo", ontoBranch: "main", onDone });

		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it("reports the failure and skips onDone when the rebase rejects", async () => {
		mockInvoke.mockRejectedValue({
			code: "git_conflict",
			message: "unstaged changes",
		});
		const onDone = vi.fn();

		await rebaseBranch({ repoPath: "/repo", ontoBranch: "main", onDone });

		expect(errorMessages()).toEqual(["unstaged changes"]);
		expect(onDone).not.toHaveBeenCalled();
	});
});

describe("resolveForkPoint", () => {
	it("asks for the fork point of the named branch", async () => {
		mockInvoke.mockResolvedValue("abc123");

		await resolveForkPoint({ repoPath: "/repo", branch: "topic" });

		expect(mockInvoke).toHaveBeenCalledWith("get_fork_point", {
			path: "/repo",
			branch: "topic",
		});
	});

	it("returns the fork point it found", async () => {
		mockInvoke.mockResolvedValue("abc123");

		const forkPoint = await resolveForkPoint({
			repoPath: "/repo",
			branch: "topic",
		});

		expect(forkPoint).toBe("abc123");
	});

	it("reports the failure and returns null when the lookup rejects", async () => {
		mockInvoke.mockRejectedValue({
			code: "git_not_found",
			message: "no fork point",
		});

		const forkPoint = await resolveForkPoint({
			repoPath: "/repo",
			branch: "topic",
		});

		expect(forkPoint).toBeNull();
		expect(errorMessages()).toEqual(["no fork point"]);
	});
});

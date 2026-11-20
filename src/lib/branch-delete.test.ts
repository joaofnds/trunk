import { ask } from "@tauri-apps/plugin-dialog";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteBranch, deletePrompt } from "./branch-delete.js";
import { safeInvoke } from "./invoke.js";

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

vi.mock("./invoke.js", async (importActual) => ({
	...(await importActual<typeof import("./invoke.js")>()),
	safeInvoke: vi.fn(),
}));

const PATH = "/work/wt";

describe("deletePrompt", () => {
	it("asks the plain question when no worktree holds the branch", () => {
		expect(deletePrompt("topic", { kind: "not_held" }, 0)).toEqual({
			kind: "ask",
			message: "Delete branch 'topic'?",
		});
	});

	it("asks the plain question when the main worktree holds it", () => {
		expect(deletePrompt("topic", { kind: "held_by_main" }, 0)).toEqual({
			kind: "ask",
			message: "Delete branch 'topic'?",
		});
	});

	it.each([
		[
			1,
			"Delete branch 'topic' with the 1 commit no other branch or tag contains?",
		],
		[
			3,
			"Delete branch 'topic' with the 3 commits no other branch or tag contains?",
		],
	])("names how many commits only the branch holds (%i)", (lost, message) => {
		expect(deletePrompt("topic", { kind: "not_held" }, lost)).toEqual({
			kind: "ask",
			message,
		});
	});

	it("names the commits only the branch holds when it removes the worktree too", () => {
		expect(
			deletePrompt("topic", { kind: "offer", name: "wt", path: PATH }, 2)
				.message,
		).toBe(
			"'topic' is checked out in the worktree at /work/wt.\n\nRemove that worktree and delete the branch with the 2 commits no other branch or tag contains? This cannot be undone.",
		);
	});

	it("offers to remove the worktree that holds it", () => {
		expect(
			deletePrompt("topic", { kind: "offer", name: "wt", path: PATH }, 0),
		).toEqual({
			kind: "remove",
			message:
				"'topic' is checked out in the worktree at /work/wt.\n\nRemove that worktree and delete the branch? This cannot be undone.",
			okLabel: "Remove Worktree and Delete",
			removal: { name: "wt", path: PATH, go_ahead: false },
		});
	});

	it("warns with every reason before going ahead", () => {
		const prompt = deletePrompt(
			"topic",
			{
				kind: "warn",
				name: "wt",
				path: PATH,
				reasons: [
					{ kind: "changes" },
					{ kind: "unchecked" },
					{ kind: "locked", reason: "on a usb stick" },
					{ kind: "locked", reason: null },
					{ kind: "submodules" },
				],
			},
			0,
		);

		expect(prompt).toEqual({
			kind: "remove",
			message:
				"'topic' is checked out in the worktree at /work/wt, and removing it may lose work:\n\n" +
				"- It has uncommitted or untracked changes.\n" +
				"- Its changes could not be checked.\n" +
				"- It is locked: on a usb stick\n" +
				"- It is locked.\n" +
				"- It contains submodules, whose commits may exist only there.\n\n" +
				"Remove it anyway and delete the branch? This cannot be undone.",
			okLabel: "Remove Anyway and Delete",
			removal: { name: "wt", path: PATH, go_ahead: true },
		});
	});

	it("flattens line breaks a branch name or a lock reason carries", () => {
		const prompt = deletePrompt(
			"a\u2028b",
			{
				kind: "warn",
				name: "wt",
				path: PATH,
				reasons: [{ kind: "locked", reason: "x\ny" }],
			},
			0,
		);

		expect(prompt.message).toContain("'a�b'");
		expect(prompt.message).toContain("It is locked: x�y");
	});

	it("shows a long worktree path whole and flattens its line breaks", () => {
		const long = `/Users/someone/.t3/worktrees/${"rehearse/".repeat(12)}wt`;
		const broken = "/work/a\u2028b";

		expect(
			deletePrompt("topic", { kind: "offer", name: "wt", path: long }, 0)
				.message,
		).toContain(` ${long}.`);
		expect(
			deletePrompt("topic", { kind: "offer", name: "wt", path: broken }, 0)
				.message,
		).toContain(" /work/a�b.");
	});

	describe("when removing the worktree is refused", () => {
		it.each([
			[
				"mismatched",
				[PATH],
				"Cannot delete 'topic'. The worktree at /work/wt has it checked out, and its .git file does not point back at this repository, so Trunk will not remove it.",
			],
			[
				"several_holders",
				[PATH, "/work/wt2"],
				"Cannot delete 'topic'. More than one worktree uses it:\n\n- /work/wt\n- /work/wt2",
			],
			[
				"open_in_tab",
				[PATH],
				"Cannot delete 'topic' while the worktree at /work/wt, which has it checked out, is open in a tab. Close that tab, then delete again.",
			],
			[
				"rebasing",
				[PATH],
				"Cannot delete 'topic' while the worktree at /work/wt is rebasing it. Finish or abort the rebase there, then delete again.",
			],
			[
				"missing",
				[PATH],
				"Cannot delete 'topic'. Git still counts it as used by the worktree at /work/wt, whose directory is missing.",
			],
		] as const)("explains a %s refusal", (reason, paths, message) => {
			expect(
				deletePrompt("topic", { kind: "refuse", paths: [...paths], reason }, 0),
			).toEqual({ kind: "refuse", message });
		});
	});
});

describe("deleteBranch", () => {
	beforeEach(() => {
		vi.mocked(ask).mockReset();
		vi.mocked(safeInvoke).mockReset();
	});

	it("reports the tip it deleted, so the branch can be made again", async () => {
		vi.mocked(ask).mockResolvedValue(true);
		vi.mocked(safeInvoke).mockImplementation(async (command) => {
			if (command === "branch_hold") return { kind: "not_held" };
			if (command === "commits_only_on_branch") return 1;
			if (command === "delete_branch")
				return "5f3c2a1b9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b";
			throw new Error(`unexpected ${command}`);
		});

		const outcome = await deleteBranch("/repo", "topic");

		expect(outcome).toEqual({
			kind: "deleted",
			report: "Deleted branch topic (was 5f3c2a1)",
		});
	});

	it("deletes nothing once the user declines", async () => {
		vi.mocked(ask).mockResolvedValue(false);
		vi.mocked(safeInvoke).mockImplementation(async (command) => {
			if (command === "branch_hold") return { kind: "not_held" };
			if (command === "commits_only_on_branch") return 0;
			throw new Error(`unexpected ${command}`);
		});

		const outcome = await deleteBranch("/repo", "topic");

		expect(outcome).toEqual({ kind: "declined" });
	});

	describe("when Trunk refuses to remove the worktree", () => {
		it("rejects with the reason and asks nothing", async () => {
			vi.mocked(safeInvoke).mockImplementation(async (command) =>
				command === "branch_hold"
					? { kind: "refuse", paths: [PATH], reason: "rebasing" }
					: 0,
			);

			const deleting = deleteBranch("/repo", "topic");

			await expect(deleting).rejects.toEqual({
				code: "delete_refused",
				message:
					"Cannot delete 'topic' while the worktree at /work/wt is rebasing it. Finish or abort the rebase there, then delete again.",
			});
			expect(ask).not.toHaveBeenCalled();
		});
	});
});
